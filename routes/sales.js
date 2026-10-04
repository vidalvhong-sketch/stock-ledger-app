const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db');
const { authRequired, adminRequired } = require('../middleware/auth');
const { logAudit } = require('../lib/audit');
const { canApprove } = require('../lib/permissions');
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

const PAYMENT_METHODS = ['Cash', 'Debit Card', 'Credit Card', 'GCash', 'Maya', 'Food Panda'];
const ORDER_TYPES = ['dine_in', 'takeout', 'delivery', 'food_panda'];

// Menu prices are treated as VAT-inclusive, matching PH retail convention.
// Senior/PWD: VAT is removed first, then 20% off the VAT-exclusive amount (per BIR rules).
// Senior/PWD gets the legally-required VAT-exempt treatment (discount applies
// to the VAT-exclusive amount, VAT itself drops to 0 on the receipt). Every
// other discount here is an ordinary promotional/employee discount — straight
// percentage (or a cashier-entered amount) off the VAT-inclusive subtotal,
// with VAT reported normally.
const SIMPLE_DISCOUNT_PERCENTS = { staff: 0.10, stub: 1.0, family: 1.0 };
const VALID_DISCOUNT_TYPES = ['senior_pwd', 'staff', 'stub', 'family', 'variable', 'loyalty_points'];

function computeCheckout(items, discountType, variableAmount) {
  const vatRate = Number(getSetting('vat_rate', '12')) / 100;
  const seniorRate = Number(getSetting('senior_pwd_discount', '20')) / 100;

  const subtotal = items.reduce((sum, it) => sum + it.price * it.qty, 0);
  const vatExclusive = subtotal / (1 + vatRate);
  const vatAmount = subtotal - vatExclusive;

  if (discountType === 'senior_pwd') {
    const discountAmount = vatExclusive * seniorRate;
    const total = vatExclusive - discountAmount;
    return { subtotal, vatAmount: 0, discountAmount, total };
  }
  if (SIMPLE_DISCOUNT_PERCENTS[discountType] !== undefined) {
    const discountAmount = subtotal * SIMPLE_DISCOUNT_PERCENTS[discountType];
    return { subtotal, vatAmount, discountAmount, total: subtotal - discountAmount };
  }
  if (discountType === 'variable' || discountType === 'loyalty_points') {
    const discountAmount = Math.min(Math.max(Number(variableAmount) || 0, 0), subtotal);
    return { subtotal, vatAmount, discountAmount, total: subtotal - discountAmount };
  }
  return { subtotal, vatAmount, discountAmount: 0, total: subtotal };
}

router.get('/checkout-preview', (req, res) => {
  res.json({
    vatRate: getSetting('vat_rate', '12'),
    discountRate: getSetting('senior_pwd_discount', '20'),
    discountOptions: [
      { key: 'senior_pwd', label: `Senior/PWD −${getSetting('senior_pwd_discount', '20')}%` },
      { key: 'staff', label: 'Staff Discount −10%' },
      { key: 'stub', label: 'Stub Discount −100%' },
      { key: 'family', label: 'Family Discount −100%' },
      { key: 'variable', label: 'Variable Discount' },
      { key: 'loyalty_points', label: 'Redeem Loyalty Points' }
    ],
    loyaltyPointsRate: getSetting('loyalty_points_rate', '100'),
    loyaltyPointValue: getSetting('loyalty_point_value', '1')
  });
});

router.post('/checkout', (req, res) => {
  const { items, discountType, discountAmount: variableAmount, paymentMethod, orderType, customerName, orderNotes, customerId, redeemPoints } = req.body;
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'Cart is empty' });
  if (!PAYMENT_METHODS.includes(paymentMethod)) return res.status(400).json({ error: 'Invalid payment method' });
  const oType = ORDER_TYPES.includes(orderType) ? orderType : 'takeout';

  const customer = customerId ? db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId) : null;
  if (customerId && !customer) return res.status(400).json({ error: 'Customer not found' });

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

    // Modifier sets actually assigned to this item — used both to validate the
    // selection (required / single-vs-multiple) and to make sure a cashier
    // can't sneak in an option that belongs to some unrelated item.
    const assignedSets = db.prepare(`
      SELECT ms.* FROM modifier_sets ms
      JOIN menu_item_modifier_sets mims ON mims.modifier_set_id = ms.id
      WHERE mims.menu_item_id = ?
    `).all(item.id);

    const chosenIds = Array.isArray(line.modifierOptionIds) ? line.modifierOptionIds : [];
    const chosenOptions = [];
    if (chosenIds.length > 0) {
      for (const optId of chosenIds) {
        const opt = db.prepare(`
          SELECT mo.*, mo.modifier_set_id AS setId FROM modifier_options mo
          JOIN menu_item_modifier_sets mims ON mims.modifier_set_id = mo.modifier_set_id AND mims.menu_item_id = ?
          WHERE mo.id = ?
        `).get(item.id, optId);
        if (!opt) return res.status(400).json({ error: `A selected option for ${item.name} isn't valid for this item.` });
        chosenOptions.push(opt);
      }
    }
    for (const set of assignedSets) {
      const picked = chosenOptions.filter(o => o.modifier_set_id === set.id);
      if (set.required && picked.length === 0) return res.status(400).json({ error: `Pick ${set.name} for ${item.name}.` });
      if (!set.allow_multiple && picked.length > 1) return res.status(400).json({ error: `Only one ${set.name} option allowed for ${item.name}.` });
    }

    const modifierTotal = chosenOptions.reduce((s, o) => s + o.price, 0);
    price += modifierTotal;
    if (chosenOptions.length > 0) displayName += ` + ${chosenOptions.map(o => o.name).join(', ')}`;

    resolved.push({ itemId: item.id, variantId: line.variantId || null, modifierOptionIds: chosenIds, name: displayName, price, qty });
  }

  const dType = VALID_DISCOUNT_TYPES.includes(discountType) ? discountType : '';
  if (dType === 'variable' && (variableAmount === undefined || variableAmount === null || isNaN(Number(variableAmount)) || Number(variableAmount) <= 0)) {
    return res.status(400).json({ error: 'Enter a valid discount amount.' });
  }
  let pointsAmount = 0;
  if (dType === 'loyalty_points') {
    if (!customer) return res.status(400).json({ error: 'Select a customer to redeem points.' });
    const pts = Number(redeemPoints);
    if (!pts || pts <= 0) return res.status(400).json({ error: 'Enter how many points to redeem.' });
    if (pts > customer.loyalty_points) return res.status(400).json({ error: `${customer.name} only has ${customer.loyalty_points} points.` });
    pointsAmount = pts * Number(getSetting('loyalty_point_value', '1'));
  }
  if (dType && !canApprove(db, req.user.id)) {
    const token = req.body.discountApprovalToken;
    if (!token) return res.status(400).json({ error: 'This discount needs approval from a Team Lead, Manager, or Admin.', needsDiscountApproval: true });
    const approval = db.prepare('SELECT * FROM discount_approvals WHERE id = ? AND used = 0').get(token);
    if (!approval) return res.status(400).json({ error: 'That discount approval is invalid or already used.', needsDiscountApproval: true });
    const ageMinutes = (Date.now() - new Date(approval.created_at.replace(' ', 'T') + 'Z').getTime()) / 60000;
    if (ageMinutes > 15) return res.status(400).json({ error: 'That discount approval expired — please get it approved again.', needsDiscountApproval: true });
    db.prepare('UPDATE discount_approvals SET used = 1 WHERE id = ?').run(token);
  }
  const { subtotal, vatAmount, discountAmount, total } = computeCheckout(resolved, dType, dType === 'loyalty_points' ? pointsAmount : variableAmount);

  const id = uuidv4();
  const invoiceNo = nextInvoiceNumber(getSetting('invoice_prefix', 'OR'));
  const openShift = db.prepare(`SELECT id FROM cashier_shifts WHERE cashier_id = ? AND status = 'open' ORDER BY started_at DESC LIMIT 1`).get(req.user.id);
  const finalCustomerName = customer ? customer.name : (customerName || '').trim() || null;
  db.prepare(`
    INSERT INTO sales (id, invoice_no, date, items_json, subtotal, vat_amount, discount_type, discount_amount, total, payment_method, order_type, status, customer_name, customer_id, order_notes, shift_id, cashier_id, cashier_name)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,'pending',?,?,?,?,?,?)
  `).run(
    id, invoiceNo, todayStr(), JSON.stringify(resolved), subtotal, vatAmount, dType, discountAmount, total,
    paymentMethod, oType, finalCustomerName, customer ? customer.id : null, (orderNotes || '').trim() || null, openShift ? openShift.id : null, req.user.id, req.user.name
  );

  // Loyalty points: deduct what was just redeemed, then earn new points on
  // the final amount actually paid — both only when a customer is attached.
  if (customer) {
    let newBalance = customer.loyalty_points;
    if (dType === 'loyalty_points') newBalance -= Number(redeemPoints);
    const earnRate = Number(getSetting('loyalty_points_rate', '100'));
    if (earnRate > 0) newBalance += Math.floor(total / earnRate);
    db.prepare('UPDATE customers SET loyalty_points = ? WHERE id = ?').run(Math.max(0, newBalance), customer.id);
  }

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
router.delete('/:id', (req, res) => {
  const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(req.params.id);
  if (!sale) return res.status(404).json({ error: 'Sale not found' });
  const reason = (req.body && req.body.reason || '').trim();
  if (!reason) return res.status(400).json({ error: 'A reason is required to void a sale' });

  if (!canApprove(db, req.user.id)) {
    const id = uuidv4();
    db.prepare(`
      INSERT INTO approval_requests (id, type, sale_id, requested_by, requested_by_name, reason)
      VALUES (?,'void',?,?,?,?)
    `).run(id, req.params.id, req.user.id, req.user.name, reason);
    logAudit({ userId: req.user.id, userName: req.user.name, action: 'request_approval', targetType: 'approval_request', targetId: id, details: { type: 'void', invoiceNo: sale.invoice_no } });
    return res.json({ ok: true, pending: true, requestId: id });
  }

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
router.post('/:id/refund', (req, res) => {
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

  if (!canApprove(db, req.user.id)) {
    const reqId = uuidv4();
    db.prepare(`
      INSERT INTO approval_requests (id, type, sale_id, requested_by, requested_by_name, amount, reason)
      VALUES (?,'refund',?,?,?,?,?)
    `).run(reqId, req.params.id, req.user.id, req.user.name, amount, reason);
    logAudit({ userId: req.user.id, userName: req.user.name, action: 'request_approval', targetType: 'approval_request', targetId: reqId, details: { type: 'refund', invoiceNo: sale.invoice_no, amount } });
    return res.json({ pending: true, requestId: reqId });
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
