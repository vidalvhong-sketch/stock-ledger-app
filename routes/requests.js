const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db');
const { authRequired, adminRequired } = require('../middleware/auth');
const { logAudit } = require('../lib/audit');

const router = express.Router();
router.use(authRequired);

function pad(n) { return n < 10 ? '0' + n : '' + n; }
function toISO(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
function todayStr() { return toISO(new Date()); }

// Monday of next week, as an ISO date — the default week the availability form targets.
function nextMondayISO() {
  const d = new Date();
  const day = d.getDay(); // 0 = Sun
  const daysUntilNextMon = ((8 - day) % 7) || 7;
  d.setDate(d.getDate() + daysUntilNextMon);
  return toISO(d);
}

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

/* ---- Availability ---- */
router.get('/availability/mine', (req, res) => {
  const week = req.query.week || nextMondayISO();
  const row = db.prepare('SELECT * FROM availability_submissions WHERE user_id = ? AND week_start = ?').get(req.user.id, week);
  res.json(row ? Object.assign({}, row, { days: JSON.parse(row.days_json) }) : null);
});

router.post('/availability', (req, res) => {
  const { weekStart, days, notes } = req.body;
  const week = weekStart || nextMondayISO();
  if (!days || typeof days !== 'object') return res.status(400).json({ error: 'Day availability is required' });

  const existing = db.prepare('SELECT id FROM availability_submissions WHERE user_id = ? AND week_start = ?').get(req.user.id, week);
  if (existing) {
    db.prepare('UPDATE availability_submissions SET days_json = ?, notes = ?, submitted_at = datetime(\'now\') WHERE id = ?')
      .run(JSON.stringify(days), (notes || '').trim(), existing.id);
    return res.json({ ok: true, id: existing.id });
  }
  const id = uuidv4();
  db.prepare(`
    INSERT INTO availability_submissions (id, user_id, user_name, week_start, days_json, notes)
    VALUES (?,?,?,?,?,?)
  `).run(id, req.user.id, req.user.name, week, JSON.stringify(days), (notes || '').trim());
  res.json({ ok: true, id });
});

router.get('/availability', adminRequired, (req, res) => {
  const week = req.query.week || nextMondayISO();
  const rows = db.prepare('SELECT * FROM availability_submissions WHERE week_start = ? ORDER BY user_name COLLATE NOCASE').all(week);
  res.json(rows.map(r => Object.assign({}, r, { days: JSON.parse(r.days_json) })));
});

/* ---- Leave requests ---- */
router.post('/leave', (req, res) => {
  const { startDate, endDate, reason, notes } = req.body;
  if (!startDate || !endDate) return res.status(400).json({ error: 'Start and end date are required' });
  if (endDate < startDate) return res.status(400).json({ error: 'End date must be on or after the start date' });

  const id = uuidv4();
  db.prepare(`
    INSERT INTO leave_requests (id, user_id, user_name, start_date, end_date, reason, notes)
    VALUES (?,?,?,?,?,?,?)
  `).run(id, req.user.id, req.user.name, startDate, endDate, (reason || '').trim(), (notes || '').trim());
  res.json(db.prepare('SELECT * FROM leave_requests WHERE id = ?').get(id));
});

router.get('/leave/mine', (req, res) => {
  const rows = db.prepare('SELECT * FROM leave_requests WHERE user_id = ? ORDER BY submitted_at DESC').all(req.user.id);
  res.json(rows);
});

router.get('/leave', adminRequired, (req, res) => {
  const { status } = req.query;
  const rows = status
    ? db.prepare('SELECT * FROM leave_requests WHERE status = ? ORDER BY submitted_at DESC').all(status)
    : db.prepare('SELECT * FROM leave_requests ORDER BY submitted_at DESC').all();
  res.json(rows);
});

router.put('/leave/:id', adminRequired, (req, res) => {
  const request = db.prepare('SELECT * FROM leave_requests WHERE id = ?').get(req.params.id);
  if (!request) return res.status(404).json({ error: 'Leave request not found' });
  const { status, adminNotes } = req.body;
  if (!['approved', 'denied', 'pending'].includes(status)) return res.status(400).json({ error: 'Invalid status' });

  db.prepare(`
    UPDATE leave_requests SET status = ?, admin_notes = ?, reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ?
  `).run(status, (adminNotes || '').trim(), req.user.name, req.params.id);

  logAudit({
    userId: req.user.id, userName: req.user.name, action: 'review_leave_request',
    targetType: 'leave_request', targetId: req.params.id,
    details: { staffName: request.user_name, status, dates: `${request.start_date} to ${request.end_date}` }
  });

  res.json(db.prepare('SELECT * FROM leave_requests WHERE id = ?').get(req.params.id));
});

/* ---- Feedback & suggestions ---- */
router.post('/feedback', (req, res) => {
  const { category, message } = req.body;
  if (!message || !message.trim()) return res.status(400).json({ error: 'Message is required' });
  const cat = ['feedback', 'suggestion', 'complaint'].includes(category) ? category : 'feedback';

  const id = uuidv4();
  db.prepare(`INSERT INTO feedback_submissions (id, user_id, user_name, category, message) VALUES (?,?,?,?,?)`)
    .run(id, req.user.id, req.user.name, cat, message.trim());
  res.json({ ok: true });
});

router.get('/feedback', adminRequired, (req, res) => {
  const rows = db.prepare('SELECT * FROM feedback_submissions ORDER BY submitted_at DESC').all();
  res.json(rows);
});

router.get('/feedback/mine', (req, res) => {
  const rows = db.prepare('SELECT * FROM feedback_submissions WHERE user_id = ? ORDER BY submitted_at DESC').all(req.user.id);
  res.json(rows);
});

router.put('/feedback/:id', adminRequired, (req, res) => {
  const item = db.prepare('SELECT * FROM feedback_submissions WHERE id = ?').get(req.params.id);
  if (!item) return res.status(404).json({ error: 'Not found' });
  const reply = (req.body.adminReply || '').trim();
  if (!reply) return res.status(400).json({ error: 'Write a reply first' });

  db.prepare(`
    UPDATE feedback_submissions SET admin_reply = ?, replied_by = ?, replied_at = datetime('now'), status = 'replied' WHERE id = ?
  `).run(reply, req.user.name, req.params.id);

  logAudit({
    userId: req.user.id, userName: req.user.name, action: 'reply_feedback',
    targetType: 'feedback_submission', targetId: req.params.id,
    details: { staffName: item.user_name, category: item.category }
  });

  res.json(db.prepare('SELECT * FROM feedback_submissions WHERE id = ?').get(req.params.id));
});

module.exports = router;
