const express = require('express');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db');
const { authRequired, adminRequired } = require('../middleware/auth');
const { logAudit } = require('../lib/audit');

const router = express.Router();

function getOpenShift(userId) {
  return db.prepare(`SELECT * FROM cashier_shifts WHERE cashier_id = ? AND status = 'open' ORDER BY started_at DESC LIMIT 1`).get(userId);
}
// Only one person can be "the cashier" at a time — this is what makes "who's
// currently responsible for the drawer" an unambiguous question to answer.
function getAnyOpenShift() {
  return db.prepare(`SELECT * FROM cashier_shifts WHERE status = 'open' ORDER BY started_at DESC LIMIT 1`).get();
}

// Computes running (or final) totals for a shift from the sales actually tied to it.
function summarizeShift(shiftId, startingCash) {
  const sales = db.prepare(`SELECT * FROM sales WHERE shift_id = ? AND voided = 0`).all(shiftId);
  const byMethod = {};
  let total = 0;
  sales.forEach(s => {
    byMethod[s.payment_method] = (byMethod[s.payment_method] || 0) + s.total;
    total += s.total;
  });
  const cashSales = byMethod['Cash'] || 0;
  const cashRefunds = db.prepare(`
    SELECT COALESCE(SUM(r.amount), 0) t FROM refunds r
    JOIN sales s ON s.id = r.sale_id
    WHERE s.shift_id = ? AND s.payment_method = 'Cash'
  `).get(shiftId).t;
  const expectedCash = startingCash + cashSales - cashRefunds;
  return {
    salesTotal: total,
    salesCount: sales.length,
    byMethod,
    cashSales,
    cashRefunds,
    expectedCash
  };
}

// Simple in-memory rate limiting per IP for the PIN-based verify endpoint below,
// matching the same pattern used for kiosk clock in/out.
const verifyAttempts = {};
function verifyTooManyAttempts(ip) {
  const rec = verifyAttempts[ip];
  if (!rec) return false;
  if (Date.now() - rec.first > 5 * 60 * 1000) { delete verifyAttempts[ip]; return false; }
  return rec.count >= 10;
}
function verifyRecordAttempt(ip, success) {
  if (success) { delete verifyAttempts[ip]; return; }
  const rec = verifyAttempts[ip] || { count: 0, first: Date.now() };
  rec.count += 1;
  verifyAttempts[ip] = rec;
}

// Public — the verifying cashier identifies themselves by their own email +
// PIN, same as the Time Clock kiosk, rather than whoever's session happens to
// be active on the shared device (e.g. an admin checking the Shifts screen).
router.put('/:id/verify', (req, res) => {
  const ip = req.ip;
  if (verifyTooManyAttempts(ip)) return res.status(429).json({ error: 'Too many attempts. Wait a few minutes and try again.' });

  const shift = db.prepare('SELECT * FROM cashier_shifts WHERE id = ?').get(req.params.id);
  if (!shift) return res.status(404).json({ error: 'Shift not found' });
  if (shift.status !== 'closed') return res.status(400).json({ error: 'This shift has not been turned over yet.' });
  if (shift.verified_by) return res.status(400).json({ error: `Already verified by ${shift.verified_by}.` });

  const { email, pin, verifiedAmount } = req.body;
  if (!email || !pin) return res.status(400).json({ error: 'Email and PIN are required' });
  if (verifiedAmount === undefined || verifiedAmount === null || isNaN(Number(verifiedAmount)) || Number(verifiedAmount) < 0) {
    return res.status(400).json({ error: 'Enter the amount you actually counted.' });
  }

  const normalizedEmail = String(email).trim().toLowerCase();
  const user = db.prepare('SELECT * FROM users WHERE active = 1 AND lower(email) = ?').get(normalizedEmail);
  if (!user || !bcrypt.compareSync(String(pin), user.pin_hash)) {
    verifyRecordAttempt(ip, false);
    return res.status(401).json({ error: 'Incorrect email or PIN' });
  }
  verifyRecordAttempt(ip, true);

  db.prepare(`
    UPDATE cashier_shifts SET verified_by = ?, verified_by_id = ?, verified_at = datetime('now'), verified_amount = ? WHERE id = ?
  `).run(user.name, user.id, Number(verifiedAmount), req.params.id);

  logAudit({
    userId: user.id, userName: user.name, action: 'verify_shift_turnover',
    targetType: 'cashier_shift', targetId: req.params.id,
    details: { cashierName: shift.cashier_name, countedByOutgoing: shift.counted_cash, verifiedAmount: Number(verifiedAmount) }
  });

  res.json(db.prepare('SELECT * FROM cashier_shifts WHERE id = ?').get(req.params.id));
});

router.use(authRequired);

router.get('/current', (req, res) => {
  const shift = getOpenShift(req.user.id);
  if (!shift) return res.json({ shift: null });
  const summary = summarizeShift(shift.id, shift.starting_cash);
  res.json({ shift, summary });
});

// Anyone logged in can see who's currently designated as the cashier — this
// answers "who's holding the drawer right now" without needing admin access.
router.get('/active', (req, res) => {
  const shift = getAnyOpenShift();
  if (!shift) return res.json({ shift: null });
  const summary = summarizeShift(shift.id, shift.starting_cash);
  res.json({ shift: { id: shift.id, cashier_id: shift.cashier_id, cashier_name: shift.cashier_name, started_at: shift.started_at }, summary: { salesCount: summary.salesCount, salesTotal: summary.salesTotal } });
});

router.post('/start', (req, res) => {
  const existing = getOpenShift(req.user.id);
  if (existing) return res.status(400).json({ error: 'You already have an open shift. Turn it over before starting a new one.' });

  const anyOpen = getAnyOpenShift();
  if (anyOpen) return res.status(400).json({ error: `${anyOpen.cashier_name} is currently the cashier — they need to turn over first.` });

  const startingCash = Number(req.body.startingCash);
  if (isNaN(startingCash) || startingCash < 0) return res.status(400).json({ error: 'Enter a valid starting cash amount (0 is fine if none).' });

  const id = uuidv4();
  db.prepare(`
    INSERT INTO cashier_shifts (id, cashier_id, cashier_name, starting_cash, status)
    VALUES (?,?,?,?,'open')
  `).run(id, req.user.id, req.user.name, startingCash);

  res.json(db.prepare('SELECT * FROM cashier_shifts WHERE id = ?').get(id));
});

router.post('/turnover', (req, res) => {
  const shift = getOpenShift(req.user.id);
  if (!shift) return res.status(400).json({ error: 'No open shift to turn over.' });

  const countedCash = Number(req.body.countedCash);
  if (isNaN(countedCash) || countedCash < 0) return res.status(400).json({ error: 'Enter the counted cash amount.' });
  const notes = (req.body.notes || '').trim();

  const summary = summarizeShift(shift.id, shift.starting_cash);
  const variance = countedCash - summary.expectedCash;

  db.prepare(`
    UPDATE cashier_shifts SET
      ended_at = datetime('now'), counted_cash = ?, expected_cash = ?, variance = ?,
      sales_total = ?, sales_count = ?, sales_by_method = ?, notes = ?, status = 'closed'
    WHERE id = ?
  `).run(countedCash, summary.expectedCash, variance, summary.salesTotal, summary.salesCount, JSON.stringify(summary.byMethod), notes, shift.id);

  logAudit({
    userId: req.user.id, userName: req.user.name, action: 'shift_turnover',
    targetType: 'cashier_shift', targetId: shift.id,
    details: { salesTotal: summary.salesTotal, countedCash, expectedCash: summary.expectedCash, variance }
  });

  res.json(db.prepare('SELECT * FROM cashier_shifts WHERE id = ?').get(shift.id));
});

// Admin: full turnover history for tracing counter issues, newest first.
router.get('/', adminRequired, (req, res) => {
  const { start, end } = req.query;
  let sql = 'SELECT * FROM cashier_shifts WHERE 1=1';
  const params = [];
  if (start) { sql += ' AND date(started_at) >= date(?)'; params.push(start); }
  if (end) { sql += ' AND date(started_at) <= date(?)'; params.push(end); }
  sql += ' ORDER BY started_at DESC LIMIT 200';
  const rows = db.prepare(sql).all(...params);
  res.json(rows.map(r => Object.assign({}, r, { sales_by_method: r.sales_by_method ? JSON.parse(r.sales_by_method) : null })));
});

router.get('/:id', adminRequired, (req, res) => {
  const shift = db.prepare('SELECT * FROM cashier_shifts WHERE id = ?').get(req.params.id);
  if (!shift) return res.status(404).json({ error: 'Shift not found' });
  const sales = db.prepare('SELECT * FROM sales WHERE shift_id = ? ORDER BY created_at ASC').all(req.params.id);
  res.json(Object.assign({}, shift, {
    sales_by_method: shift.sales_by_method ? JSON.parse(shift.sales_by_method) : null,
    sales: sales.map(s => Object.assign({}, s, { items: JSON.parse(s.items_json) }))
  }));
});

module.exports = router;
