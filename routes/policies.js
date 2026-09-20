const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db');
const { authRequired, adminRequired } = require('../middleware/auth');
const { logAudit } = require('../lib/audit');

const router = express.Router();
router.use(authRequired);

router.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM policies ORDER BY category COLLATE NOCASE, title COLLATE NOCASE').all();
  res.json(rows);
});

router.post('/', adminRequired, (req, res) => {
  const { title, body, category } = req.body;
  if (!title || !title.trim()) return res.status(400).json({ error: 'Title is required' });
  if (!body || !body.trim()) return res.status(400).json({ error: 'Policy content is required' });

  const id = uuidv4();
  db.prepare('INSERT INTO policies (id, title, body, category, created_by) VALUES (?,?,?,?,?)')
    .run(id, title.trim(), body.trim(), (category || '').trim(), req.user.name);
  logAudit({ userId: req.user.id, userName: req.user.name, action: 'create_policy', targetType: 'policy', targetId: id, details: { title: title.trim() } });
  res.json(db.prepare('SELECT * FROM policies WHERE id = ?').get(id));
});

router.put('/:id', adminRequired, (req, res) => {
  const p = db.prepare('SELECT * FROM policies WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Policy not found' });
  const { title, body, category } = req.body;
  db.prepare(`UPDATE policies SET title=?, body=?, category=?, updated_at=datetime('now') WHERE id=?`).run(
    title !== undefined ? title.trim() : p.title,
    body !== undefined ? body.trim() : p.body,
    category !== undefined ? category.trim() : p.category,
    req.params.id
  );
  logAudit({ userId: req.user.id, userName: req.user.name, action: 'edit_policy', targetType: 'policy', targetId: req.params.id, details: { title: p.title } });
  res.json(db.prepare('SELECT * FROM policies WHERE id = ?').get(req.params.id));
});

router.delete('/:id', adminRequired, (req, res) => {
  const p = db.prepare('SELECT * FROM policies WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Policy not found' });
  db.prepare('DELETE FROM policies WHERE id = ?').run(req.params.id);
  logAudit({ userId: req.user.id, userName: req.user.name, action: 'delete_policy', targetType: 'policy', targetId: req.params.id, details: { title: p.title } });
  res.json({ ok: true });
});

module.exports = router;
