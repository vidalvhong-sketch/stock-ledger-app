const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db');
const { authRequired, adminRequired } = require('../middleware/auth');
const { logAudit } = require('../lib/audit');
const { nextInvoiceNumber, nextCreditMemoNumber } = require('../lib/counters');

const router = express.Router();
router.use(authRequired);

function pad(n) { return n < 10 ? '0' + n : '' + n; }
function todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}
function getSetting(key, fallback) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

const PAYMENT_METHODS = ['Cash', 'Card', 'GCash', 'Food Panda'];
const ORDER_TYPES = ['dine_in', 'takeout', 'delivery', 'food_panda'];

// Menu prices are treated as VAT-inclusive, matching PH retail convention.
// Senior/PWD: VAT is removed first, then 20% off the VAT-exclusive amount (per BIR rules).
function computeCheckout(items, discountType) {
  const vatRate = Number(getSetting('vat_rate', '12')) / 100;
  const discountRate = Number(getSetting('senior_pwd_discount', '20')) / 100;

  const subtotal = items.reduce((sum, it) => sum + it.price * it.qty, 0);
  const vatExclusive = subtotal / (1 + vatRate);
  const vatAmount = subtotal - vatExclusive;

  if (discountType === 'senior_pwd') {
    const discountAmount = vatExclusive * discountRate;
    const total = vatExclusive - discountAmount;
    return { subtotal, vatAmount: 0, discountAmount, total };
  }
  return { subtotal, vatAmount, discountAmount: 0, total: subtotal };
}

router.get('/checkout-preview', (req, res) => {
  res.json({ vatRate: getSetting('vat_rate', '12'), discountRate: getSetting('senior_pwd_discount', '20') });
});

router.post('/checkout', (req, res) => {
  const { items, discountType, paymentMethod, orderType, customerName } = req.body;
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'Cart is empty' });
  if (!PAYMENT_METHODS.includes(paymentMethod)) return res.status(400).json({ error: 'Invalid payment method' });
  const oType = ORDER_TYPES.includes(orderType) ? orderType : 'takeout';

  const resolved = [];
  for (const line of items) {
    const item = db.prepare('SELECT * FROM menu_items WHERE id = ? AND archived = 0').get(line.itemId);
    if (!item) return res.status(400).json({ error: `Item not found: ${line.itemId}` });
    const qty = Number(line.qty) || 0;
    if (qty <= 0) return res.status(400).json({ error: `Invalid quantity for ${item.name}` });

    let price = item.price;
    let displayName = item.name;
    if (line.variantId) {
      const variant = db.prepare('SELECT * FROM menu_item_variants WHERE id = ? AND menu_item_id = ?').get(line.variantId, item.id);
      if (!variant) return res.status(400).json({ error: `Size not found for ${item.name}` });
      price = variant.price;
      displayName = `${item.name} (${variant.name})`;
    }
    resolved.push({ itemId: item.id, variantId: line.variantId || null, name: displayName, price, qty });
  }

  const dType = discountType === 'senior_pwd' ? 'senior_pwd' : '';
  const { subtotal, vatAmount, discountAmount, total } = computeCheckout(resolved, dType);

  const id = uuidv4();
  const invoiceNo = nextInvoiceNumber(getSetting('invoice_prefix', 'OR'));
  const openShift = db.prepare(`SELECT id FROM cashier_shifts WHERE cashier_id = ? AND status = 'open' ORDER BY started_at DESC LIMIT 1`).get(req.user.id);
  db.prepare(`
    INSERT INTO sales (id, invoice_no, date, items_json, subtotal, vat_amount, discount_type, discount_amount, total, payment_method, order_type, status, customer_name, shift_id, cashier_id, cashier_name)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,'pending',?,?,?,?)
  `).run(
    id, invoiceNo, todayStr(), JSON.stringify(resolved), subtotal, vatAmount, dType, discountAmount, total,
    paymentMethod, oType, (customerName || '').trim() || null, openShift ? openShift.id : null, req.user.id, req.user.name
  );

  res.json(db.prepare('SELECT * FROM sales WHERE id = ?').get(id));
});

router.get('/', (req, res) => {
  const date = req.query.date || todayStr();
  const rows = db.prepare('SELECT * FROM sales WHERE date = ? ORDER BY created_at DESC').all(date);
  res.json(rows.map(r => Object.assign({}, r, { items: JSON.parse(r.items_json) })));
});

router.get('/kitchen', (req, res) => {
  const date = req.query.date || todayStr();
  const includeServed = req.query.includeServed === '1';
  const rows = includeServed
    ? db.prepare('SELECT * FROM sales WHERE date = ? AND voided = 0 ORDER BY created_at ASC').all(date)
    : db.prepare("SELECT * FROM sales WHERE date = ? AND voided = 0 AND status = 'pending' ORDER BY created_at ASC").all(date);
  res.json(rows.map(r => Object.assign({}, r, { items: JSON.parse(r.items_json) })));
});

router.post('/:id/serve', (req, res) => {
  const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(req.params.id);
  if (!sale) return res.status(404).json({ error: 'Order not found' });
  db.prepare(`UPDATE sales SET status = 'served', served_by = ?, served_at = datetime('now') WHERE id = ?`)
    .run(req.user.name, req.params.id);
  res.json(db.prepare('SELECT * FROM sales WHERE id = ?').get(req.params.id));
});

router.post('/:id/unserve', (req, res) => {
  const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(req.params.id);
  if (!sale) return res.status(404).json({ error: 'Order not found' });
  db.prepare(`UPDATE sales SET status = 'pending', served_by = NULL, served_at = NULL WHERE id = ?`).run(req.params.id);
  res.json(db.prepare('SELECT * FROM sales WHERE id = ?').get(req.params.id));
});

router.get('/summary', (req, res) => {
  const date = req.query.date;
  const month = req.query.month;
  const year = req.query.year;
  let rows;
  if (date) rows = db.prepare('SELECT * FROM sales WHERE date = ? AND voided = 0').all(date);
  else if (month) rows = db.prepare("SELECT * FROM sales WHERE date LIKE ? AND voided = 0").all(month + '%');
  else if (year) rows = db.prepare("SELECT * FROM sales WHERE date LIKE ? AND voided = 0").all(year + '%');
  else return res.status(400).json({ error: 'date, month, or year required' });

  const byMethod = {};
  PAYMENT_METHODS.forEach(m => { byMethod[m] = 0; });
  let grossTotal = 0, transactionCount = rows.length;
  const itemTotals = {};

  rows.forEach(r => {
    byMethod[r.payment_method] = (byMethod[r.payment_method] || 0) + r.total;
    grossTotal += r.total;
    const items = JSON.parse(r.items_json);
    items.forEach(it => {
      if (!itemTotals[it.name]) itemTotals[it.name] = { qty: 0, revenue: 0 };
      itemTotals[it.name].qty += it.qty;
      itemTotals[it.name].revenue += it.price * it.qty;
    });
  });

  const bestSellers = Object.entries(itemTotals)
    .map(([name, v]) => ({ name, qty: v.qty, revenue: v.revenue }))
    .sort((a, b) => b.qty - a.qty);

  res.json({ transactionCount, grossTotal, byMethod, bestSellers });
});

// Void — requires a reason, keeps the original sale row (never deleted, never
// altered beyond the void marker itself), and writes an audit entry.
router.delete('/:id', adminRequired, (req, res) => {
  const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(req.params.id);
  if (!sale) return res.status(404).json({ error: 'Sale not found' });
  const reason = (req.body && req.body.reason || '').trim();
  if (!reason) return res.status(400).json({ error: 'A reason is required to void a sale' });

  db.prepare(`UPDATE sales SET voided = 1, voided_by = ?, voided_at = datetime('now'), void_reason = ? WHERE id = ?`)
    .run(req.user.name, reason, req.params.id);

  logAudit({
    userId: req.user.id, userName: req.user.name, action: 'void_sale',
    targetType: 'sale', targetId: req.params.id,
    details: { invoiceNo: sale.invoice_no, total: sale.total, reason }
  });

  res.json({ ok: true });
});

// Refund — a separate credit-memo record referencing the original sale.
// The original sale is never edited; this is the immutable "money went back out" record.
router.post('/:id/refund', adminRequired, (req, res) => {
  const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(req.params.id);
  if (!sale) return res.status(404).json({ error: 'Sale not found' });
  const reason = (req.body && req.body.reason || '').trim();
  if (!reason) return res.status(400).json({ error: 'A reason is required to refund a sale' });

  const amount = req.body.amount !== undefined && req.body.amount !== null && req.body.amount !== ''
    ? Number(req.body.amount)
    : sale.total;
  if (isNaN(amount) || amount <= 0) return res.status(400).json({ error: 'Invalid refund amount' });
  if (amount > sale.total) return res.status(400).json({ error: 'Refund cannot exceed the original sale total' });

  const alreadyRefunded = db.prepare('SELECT COALESCE(SUM(amount),0) t FROM refunds WHERE sale_id = ?').get(req.params.id).t;
  if (alreadyRefunded + amount > sale.total) {
    return res.status(400).json({ error: `Only ${(sale.total - alreadyRefunded).toFixed(2)} remains refundable on this sale` });
  }

  const id = uuidv4();
  const invoiceNo = nextCreditMemoNumber();
  db.prepare(`
    INSERT INTO refunds (id, sale_id, invoice_no, amount, reason, refunded_by, refunded_by_id)
    VALUES (?,?,?,?,?,?,?)
  `).run(id, req.params.id, invoiceNo, amount, reason, req.user.name, req.user.id);

  logAudit({
    userId: req.user.id, userName: req.user.name, action: 'refund_sale',
    targetType: 'sale', targetId: req.params.id,
    details: { invoiceNo, originalInvoiceNo: sale.invoice_no, amount, reason }
  });

  res.json(db.prepare('SELECT * FROM refunds WHERE id = ?').get(id));
});

router.get('/refunds', adminRequired, (req, res) => {
  const date = req.query.date || todayStr();
  const rows = db.prepare(`
    SELECT r.*, s.invoice_no AS original_invoice_no, s.total AS original_total
    FROM refunds r JOIN sales s ON s.id = r.sale_id
    WHERE date(r.created_at) = date(?)
    ORDER BY r.created_at DESC
  `).all(date);
  res.json(rows);
});

module.exports = router;
