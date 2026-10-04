const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db');
const { authRequired } = require('../middleware/auth');
const { requirePermission } = require('../lib/permissions');
const { logAudit } = require('../lib/audit');

const router = express.Router();
router.use(authRequired);

function withOptions(set) {
  const options = db.prepare('SELECT id, name, price FROM modifier_options WHERE modifier_set_id = ? ORDER BY sort_order ASC').all(set.id);
  return Object.assign({}, set, { required: !!set.required, allow_multiple: !!set.allow_multiple, options });
}

function replaceOptions(setId, options) {
  db.prepare('DELETE FROM modifier_options WHERE modifier_set_id = ?').run(setId);
  if (!Array.isArray(options)) return;
  options.forEach((o, i) => {
    const name = (o.name || '').toString().trim();
    const price = o.price === undefined || o.price === null || o.price === '' ? 0 : Number(o.price);
    if (!name || isNaN(price) || price < 0) return; // skip incomplete rows rather than fail the whole save
    db.prepare('INSERT INTO modifier_options (id, modifier_set_id, name, price, sort_order) VALUES (?,?,?,?,?)')
      .run(uuidv4(), setId, name, price, i);
  });
}

router.get('/', (req, res) => {
  const sets = db.prepare('SELECT * FROM modifier_sets ORDER BY sort_order ASC, name COLLATE NOCASE').all();
  res.json(sets.map(withOptions));
});

router.post('/', requirePermission('manage_menu'), (req, res) => {
  const { name, required, allowMultiple, options } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Modifier set name is required' });
  const id = uuidv4();
  db.prepare('INSERT INTO modifier_sets (id, name, required, allow_multiple) VALUES (?,?,?,?)')
    .run(id, name.trim(), required ? 1 : 0, allowMultiple ? 1 : 0);
  replaceOptions(id, options);
  logAudit({ userId: req.user.id, userName: req.user.name, action: 'create_modifier_set', targetType: 'modifier_set', targetId: id, details: { name: name.trim(), optionCount: (options || []).length } });
  res.json(withOptions(db.prepare('SELECT * FROM modifier_sets WHERE id = ?').get(id)));
});

router.put('/:id', requirePermission('manage_menu'), (req, res) => {
  const set = db.prepare('SELECT * FROM modifier_sets WHERE id = ?').get(req.params.id);
  if (!set) return res.status(404).json({ error: 'Modifier set not found' });
  const { name, required, allowMultiple, options } = req.body;
  db.prepare('UPDATE modifier_sets SET name=?, required=?, allow_multiple=? WHERE id=?').run(
    name !== undefined ? name.trim() : set.name,
    required !== undefined ? (required ? 1 : 0) : set.required,
    allowMultiple !== undefined ? (allowMultiple ? 1 : 0) : set.allow_multiple,
    req.params.id
  );
  if (options !== undefined) replaceOptions(req.params.id, options);
  logAudit({ userId: req.user.id, userName: req.user.name, action: 'edit_modifier_set', targetType: 'modifier_set', targetId: req.params.id, details: { name: set.name } });
  res.json(withOptions(db.prepare('SELECT * FROM modifier_sets WHERE id = ?').get(req.params.id)));
});

router.delete('/:id', requirePermission('manage_menu'), (req, res) => {
  const set = db.prepare('SELECT * FROM modifier_sets WHERE id = ?').get(req.params.id);
  if (!set) return res.status(404).json({ error: 'Modifier set not found' });
  db.prepare('DELETE FROM menu_item_modifier_sets WHERE modifier_set_id = ?').run(req.params.id);
  db.prepare('DELETE FROM modifier_options WHERE modifier_set_id = ?').run(req.params.id);
  db.prepare('DELETE FROM modifier_sets WHERE id = ?').run(req.params.id);
  logAudit({ userId: req.user.id, userName: req.user.name, action: 'delete_modifier_set', targetType: 'modifier_set', targetId: req.params.id, details: { name: set.name } });
  res.json({ ok: true });
});

module.exports = router;
