const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db');
const { authRequired, adminRequired } = require('../middleware/auth');
const { logAudit } = require('../lib/audit');

const router = express.Router();
router.use(authRequired);

router.get('/', (req, res) => {
  const products = db.prepare('SELECT * FROM products WHERE archived = 0 ORDER BY name COLLATE NOCASE').all();
  res.json(products);
});

// Barcode scan lookup — used by the Add/Discard stock scanner input.
router.get('/by-barcode/:code', (req, res) => {
  const product = db.prepare('SELECT * FROM products WHERE barcode = ? AND archived = 0').get(req.params.code);
  if (!product) return res.status(404).json({ error: 'No product with that barcode' });
  res.json(product);
});

router.post('/', adminRequired, (req, res) => {
  const { name, category, unit, initialStock, reorderLevel, barcode } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Product name is required' });

  const id = uuidv4();
  db.prepare(`
    INSERT INTO products (id, name, category, unit, initial_stock, reorder_level, barcode)
    VALUES (?,?,?,?,?,?,?)
  `).run(
    id,
    name.trim(),
    (category || '').trim(),
    (unit || 'pcs').trim(),
    Number(initialStock) || 0,
    reorderLevel === '' || reorderLevel === null || reorderLevel === undefined ? null : Number(reorderLevel),
    (barcode || '').trim() || null
  );
  logAudit({ userId: req.user.id, userName: req.user.name, action: 'create_product', targetType: 'product', targetId: id, details: { name: name.trim() } });
  res.json(db.prepare('SELECT * FROM products WHERE id = ?').get(id));
});

router.put('/:id', adminRequired, (req, res) => {
  const p = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Product not found' });

  const { name, category, unit, initialStock, reorderLevel, barcode } = req.body;
  db.prepare(`
    UPDATE products SET name=?, category=?, unit=?, initial_stock=?, reorder_level=?, barcode=? WHERE id=?
  `).run(
    name !== undefined ? name.trim() : p.name,
    category !== undefined ? category.trim() : p.category,
    unit !== undefined ? unit.trim() : p.unit,
    initialStock !== undefined ? Number(initialStock) : p.initial_stock,
    reorderLevel === '' ? null : (reorderLevel !== undefined ? Number(reorderLevel) : p.reorder_level),
    barcode !== undefined ? ((barcode || '').trim() || null) : p.barcode,
    req.params.id
  );
  logAudit({ userId: req.user.id, userName: req.user.name, action: 'edit_product', targetType: 'product', targetId: req.params.id, details: { name: p.name, before: { name: p.name, category: p.category, unit: p.unit, reorder_level: p.reorder_level }, after: { name, category, unit, reorderLevel } } });
  res.json(db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id));
});

router.delete('/:id', adminRequired, (req, res) => {
  const p = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Product not found' });
  db.prepare('UPDATE products SET archived = 1 WHERE id = ?').run(req.params.id);
  logAudit({ userId: req.user.id, userName: req.user.name, action: 'delete_product', targetType: 'product', targetId: req.params.id, details: { name: p.name } });
  res.json({ ok: true });
});

module.exports = router;
