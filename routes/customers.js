const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db');
const { authRequired } = require('../middleware/auth');
const { requirePermission } = require('../lib/permissions');
const { logAudit } = require('../lib/audit');

const router = express.Router();
router.use(authRequired);

// Any authenticated user can look customers up — needed at checkout to attach
// a sale to a profile, not just by whoever manages the customer list.
router.get('/', (req, res) => {
  const { search } = req.query;
  const rows = search
    ? db.prepare(`SELECT * FROM customers WHERE name LIKE ? OR phone LIKE ? ORDER BY name COLLATE NOCASE LIMIT 50`).all(`%${search}%`, `%${search}%`)
    : db.prepare(`SELECT * FROM customers ORDER BY name COLLATE NOCASE LIMIT 200`).all();
  res.json(rows);
});

router.get('/:id', (req, res) => {
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });
  const sales = db.prepare('SELECT * FROM sales WHERE customer_id = ? ORDER BY created_at DESC LIMIT 100').all(req.params.id);
  const totals = db.prepare('SELECT COUNT(*) c, COALESCE(SUM(total),0) t FROM sales WHERE customer_id = ? AND voided = 0').get(req.params.id);
  res.json({
    customer,
    orderCount: totals.c,
    totalSpent: totals.t,
    sales: sales.map(s => Object.assign({}, s, { items: JSON.parse(s.items_json) }))
  });
});

router.post('/', requirePermission('manage_menu'), (req, res) => {
  const { name, phone, email, notes } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Customer name is required' });
  const id = uuidv4();
  db.prepare('INSERT INTO customers (id, name, phone, email, notes) VALUES (?,?,?,?,?)')
    .run(id, name.trim(), (phone || '').trim() || null, (email || '').trim() || null, (notes || '').trim() || null);
  logAudit({ userId: req.user.id, userName: req.user.name, action: 'create_customer', targetType: 'customer', targetId: id, details: { name: name.trim() } });
  res.json(db.prepare('SELECT * FROM customers WHERE id = ?').get(id));
});

router.put('/:id', requirePermission('manage_menu'), (req, res) => {
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });
  const { name, phone, email, notes } = req.body;
  db.prepare('UPDATE customers SET name=?, phone=?, email=?, notes=? WHERE id=?').run(
    name !== undefined ? name.trim() : customer.name,
    phone !== undefined ? ((phone || '').trim() || null) : customer.phone,
    email !== undefined ? ((email || '').trim() || null) : customer.email,
    notes !== undefined ? ((notes || '').trim() || null) : customer.notes,
    req.params.id
  );
  logAudit({ userId: req.user.id, userName: req.user.name, action: 'edit_customer', targetType: 'customer', targetId: req.params.id, details: { name: customer.name } });
  res.json(db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id));
});

router.delete('/:id', requirePermission('manage_menu'), (req, res) => {
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });
  // No FK constraint on sales.customer_id (by design), so this is always a clean
  // delete — past sales keep their customer_name snapshot either way.
  db.prepare('DELETE FROM customers WHERE id = ?').run(req.params.id);
  logAudit({ userId: req.user.id, userName: req.user.name, action: 'delete_customer', targetType: 'customer', targetId: req.params.id, details: { name: customer.name } });
  res.json({ ok: true });
});

module.exports = router;
