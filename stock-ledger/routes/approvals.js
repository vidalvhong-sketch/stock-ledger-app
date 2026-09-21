const express = require('express');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db');
const { authRequired } = require('../middleware/auth');
const { canApprove } = require('../lib/permissions');
const { logAudit } = require('../lib/audit');

const router = express.Router();

// Simple in-memory rate limiting per IP for the PIN-based discount approval,
// matching the same pattern used for kiosk clock in/out and shift verification.
const approveAttempts = {};
function tooManyAttempts(ip) {
  const rec = approveAttempts[ip];
  if (!rec) return false;
  if (Date.now() - rec.first > 5 * 60 * 1000) { delete approveAttempts[ip]; return false; }
  return rec.count >= 10;
}
function recordAttempt(ip, success) {
  if (success) { delete approveAttempts[ip]; return; }
  const rec = approveAttempts[ip] || { count: 0, first: Date.now() };
  rec.count += 1;
  approveAttempts[ip] = rec;
}

// Public — the approver identifies themselves by their own email + PIN, right
// at the register, same pattern as the Time Clock kiosk. Returns a short-lived
// single-use token the checkout call includes to prove a discount was approved.
router.post('/discount-approval', (req, res) => {
  const ip = req.ip;
  if (tooManyAttempts(ip)) return res.status(429).json({ error: 'Too many attempts. Wait a few minutes and try again.' });

  const { email, pin, cashierId } = req.body;
  if (!email || !pin) return res.status(400).json({ error: 'Email and PIN are required' });

  const normalizedEmail = String(email).trim().toLowerCase();
  const user = db.prepare('SELECT * FROM users WHERE active = 1 AND lower(email) = ?').get(normalizedEmail);
  if (!user || !bcrypt.compareSync(String(pin), user.pin_hash)) {
    recordAttempt(ip, false);
    return res.status(401).json({ error: 'Incorrect email or PIN' });
  }
  if (!canApprove(db, user.id)) {
    recordAttempt(ip, false);
    return res.status(403).json({ error: `${user.name} isn't able to approve discounts.` });
  }
  recordAttempt(ip, true);

  const id = uuidv4();
  db.prepare('INSERT INTO discount_approvals (id, approved_by, approved_by_name, cashier_id) VALUES (?,?,?,?)')
    .run(id, user.id, user.name, cashierId || null);

  res.json({ token: id, approvedBy: user.name });
});

router.use(authRequired);

router.post('/requests', (req, res) => {
  const { type, saleId, amount, reason } = req.body;
  if (!['void', 'refund'].includes(type)) return res.status(400).json({ error: 'Invalid request type' });
  const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(saleId);
  if (!sale) return res.status(404).json({ error: 'Sale not found' });
  if (!reason || !reason.trim()) return res.status(400).json({ error: 'A reason is required' });

  const id = uuidv4();
  db.prepare(`
    INSERT INTO approval_requests (id, type, sale_id, requested_by, requested_by_name, amount, reason)
    VALUES (?,?,?,?,?,?,?)
  `).run(id, type, saleId, req.user.id, req.user.name, amount != null ? Number(amount) : null, reason.trim());

  logAudit({ userId: req.user.id, userName: req.user.name, action: 'request_approval', targetType: 'approval_request', targetId: id, details: { type, saleId, invoiceNo: sale.invoice_no } });
  res.json(db.prepare('SELECT * FROM approval_requests WHERE id = ?').get(id));
});

router.get('/requests', (req, res) => {
  if (!canApprove(db, req.user.id)) return res.status(403).json({ error: 'You do not have access to this.' });
  const { status } = req.query;
  const sql = `
    SELECT ar.*, s.invoice_no, s.total AS sale_total, s.payment_method, s.customer_name
    FROM approval_requests ar LEFT JOIN sales s ON s.id = ar.sale_id
    WHERE 1=1 ${status ? 'AND ar.status = ?' : ''}
    ORDER BY ar.created_at DESC ${status ? '' : 'LIMIT 200'}
  `;
  const rows = status ? db.prepare(sql).all(status) : db.prepare(sql).all();
  res.json(rows);
});

router.get('/requests/mine', (req, res) => {
  const rows = db.prepare('SELECT * FROM approval_requests WHERE requested_by = ? ORDER BY created_at DESC LIMIT 50').all(req.user.id);
  res.json(rows);
});

router.put('/requests/:id/review', (req, res) => {
  if (!canApprove(db, req.user.id)) return res.status(403).json({ error: 'You do not have access to this.' });
  const request = db.prepare('SELECT * FROM approval_requests WHERE id = ?').get(req.params.id);
  if (!request) return res.status(404).json({ error: 'Request not found' });
  if (request.status !== 'pending') return res.status(400).json({ error: `Already ${request.status}.` });

  const { status, notes } = req.body;
  if (!['approved', 'denied'].includes(status)) return res.status(400).json({ error: 'Invalid status' });

  const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(request.sale_id);
  if (status === 'approved' && sale) {
    if (request.type === 'void') {
      db.prepare(`UPDATE sales SET voided = 1, voided_by = ?, voided_at = datetime('now'), void_reason = ? WHERE id = ?`)
        .run(req.user.name, request.reason, request.sale_id);
      logAudit({ userId: req.user.id, userName: req.user.name, action: 'void_sale', targetType: 'sale', targetId: request.sale_id, details: { invoiceNo: sale.invoice_no, total: sale.total, reason: request.reason, viaApproval: true, requestedBy: request.requested_by_name } });
    } else if (request.type === 'refund') {
      const amount = request.amount != null ? request.amount : sale.total;
      const alreadyRefunded = db.prepare('SELECT COALESCE(SUM(amount),0) t FROM refunds WHERE sale_id = ?').get(request.sale_id).t;
      if (alreadyRefunded + amount > sale.total) {
        return res.status(400).json({ error: `Only ${(sale.total - alreadyRefunded).toFixed(2)} remains refundable on this sale` });
      }
      const { nextCreditMemoNumber } = require('../lib/counters');
      const refundId = uuidv4();
      const invoiceNo = nextCreditMemoNumber();
      db.prepare(`
        INSERT INTO refunds (id, sale_id, invoice_no, amount, reason, refunded_by, refunded_by_id)
        VALUES (?,?,?,?,?,?,?)
      `).run(refundId, request.sale_id, invoiceNo, amount, request.reason, req.user.name, req.user.id);
      logAudit({ userId: req.user.id, userName: req.user.name, action: 'refund_sale', targetType: 'sale', targetId: request.sale_id, details: { invoiceNo: sale.invoice_no, amount, reason: request.reason, viaApproval: true, requestedBy: request.requested_by_name } });
    }
  }

  db.prepare(`UPDATE approval_requests SET status = ?, reviewed_by = ?, reviewed_at = datetime('now'), review_notes = ? WHERE id = ?`)
    .run(status, req.user.name, (notes || '').trim(), req.params.id);

  res.json(db.prepare('SELECT * FROM approval_requests WHERE id = ?').get(req.params.id));
});

module.exports = router;
