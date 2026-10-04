const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db');
const { authRequired, adminRequired } = require('../middleware/auth');
const { requirePermission } = require('../lib/permissions');
const { logAudit } = require('../lib/audit');

const router = express.Router();
router.use(authRequired);

function pad(n) { return n < 10 ? '0' + n : '' + n; }
function todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

router.get('/', (req, res) => {
  const date = req.query.date || todayStr();
  const entries = db.prepare('SELECT * FROM entries WHERE date = ? ORDER BY created_at DESC').all(date);
  res.json(entries);
});

// Log stock added or discarded for today. Staff and admin can both do this.
router.post('/', (req, res) => {
  const { productId, type, qty, reason } = req.body;
  if (!productId || !['add', 'discard'].includes(type)) {
    return res.status(400).json({ error: 'productId and a valid type (add/discard) are required' });
  }
  if (!qty || Number(qty) <= 0) return res.status(400).json({ error: 'Quantity must be greater than zero' });
  if (type === 'discard' && !reason) return res.status(400).json({ error: 'A reason is required to discard stock' });

  const product = db.prepare('SELECT id FROM products WHERE id = ? AND archived = 0').get(productId);
  if (!product) return res.status(404).json({ error: 'Product not found' });

  const id = uuidv4();
  const date = todayStr();
  db.prepare(`
    INSERT INTO entries (id, date, product_id, type, qty, reason, user_id, staff_name)
    VALUES (?,?,?,?,?,?,?,?)
  `).run(id, date, productId, type, Number(qty), reason || '', req.user.id, req.user.name);

  res.json(db.prepare('SELECT * FROM entries WHERE id = ?').get(id));
});

// Save (or update) today's physical count for a product — this is the "actual inventory" entry.
router.post('/count', (req, res) => {
  const { productId, qty } = req.body;
  if (!productId || qty === undefined || qty === null || isNaN(Number(qty))) {
    return res.status(400).json({ error: 'productId and a numeric qty are required' });
  }
  const date = todayStr();
  const existing = db.prepare("SELECT * FROM entries WHERE date=? AND product_id=? AND type='actual'").get(date, productId);

  if (existing) {
    db.prepare(`
      UPDATE entries SET qty=?, staff_name=?, user_id=?, edited_by=?, edited_at=datetime('now') WHERE id=?
    `).run(Number(qty), req.user.name, req.user.id, req.user.name, existing.id);
    return res.json(db.prepare('SELECT * FROM entries WHERE id = ?').get(existing.id));
  }

  const id = uuidv4();
  db.prepare(`
    INSERT INTO entries (id, date, product_id, type, qty, reason, user_id, staff_name)
    VALUES (?,?,?,'actual',?,?,?,?)
  `).run(id, date, productId, Number(qty), '', req.user.id, req.user.name);
  res.json(db.prepare('SELECT * FROM entries WHERE id = ?').get(id));
});

// Admin-only: edit any entry, for any date.
router.put('/:id', requirePermission('manage_inventory'), (req, res) => {
  const e = db.prepare('SELECT * FROM entries WHERE id = ?').get(req.params.id);
  if (!e) return res.status(404).json({ error: 'Entry not found' });
  const { qty, reason } = req.body;
  const newQty = qty !== undefined && qty !== null && qty !== '' ? Number(qty) : e.qty;
  db.prepare(`
    UPDATE entries SET qty=?, reason=?, edited_by=?, edited_at=datetime('now') WHERE id=?
  `).run(
    newQty,
    reason !== undefined ? reason : e.reason,
    req.user.name,
    req.params.id
  );
  const product = db.prepare('SELECT name FROM products WHERE id = ?').get(e.product_id);
  logAudit({ userId: req.user.id, userName: req.user.name, action: 'edit_entry', targetType: 'entry', targetId: req.params.id, details: { product: product ? product.name : e.product_id, type: e.type, before: { qty: e.qty }, after: { qty: newQty } } });
  res.json(db.prepare('SELECT * FROM entries WHERE id = ?').get(req.params.id));
});

// Admin-only: delete any entry.
router.delete('/:id', requirePermission('manage_inventory'), (req, res) => {
  const e = db.prepare('SELECT * FROM entries WHERE id = ?').get(req.params.id);
  if (!e) return res.status(404).json({ error: 'Entry not found' });
  db.prepare('DELETE FROM entries WHERE id = ?').run(req.params.id);
  const product = db.prepare('SELECT name FROM products WHERE id = ?').get(e.product_id);
  logAudit({ userId: req.user.id, userName: req.user.name, action: 'delete_entry', targetType: 'entry', targetId: req.params.id, details: { product: product ? product.name : e.product_id, type: e.type, qty: e.qty } });
  res.json({ ok: true });
});

module.exports = router;
