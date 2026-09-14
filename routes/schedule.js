const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db');
const { authRequired, adminRequired } = require('../middleware/auth');
const { logAudit } = require('../lib/audit');

const router = express.Router();
router.use(authRequired);

function pad(n) { return n < 10 ? '0' + n : '' + n; }
function todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}
function isValidTime(t) { return /^\d{2}:\d{2}$/.test(t); }
function timeToMinutes(t) { const [h, m] = t.split(':').map(Number); return h * 60 + m; }

function withUserName(row) {
  const u = db.prepare('SELECT name FROM users WHERE id = ?').get(row.user_id);
  return Object.assign({}, row, { user_name: u ? u.name : 'Unknown' });
}

// Everyone (staff included) can view the schedule — a shift board only admins can edit is useless to the crew.
router.get('/', (req, res) => {
  const { date, start, end, userId } = req.query;
  let rows;
  if (date) rows = db.prepare('SELECT * FROM shifts WHERE date = ? ORDER BY start_time ASC').all(date);
  else if (start && end) rows = db.prepare('SELECT * FROM shifts WHERE date >= ? AND date <= ? ORDER BY date ASC, start_time ASC').all(start, end);
  else rows = db.prepare('SELECT * FROM shifts WHERE date >= ? ORDER BY date ASC, start_time ASC').all(todayStr());

  if (userId) rows = rows.filter(r => String(r.user_id) === String(userId));
  res.json(rows.map(withUserName));
});

router.post('/', adminRequired, (req, res) => {
  const { userId, date, startTime, endTime, notes } = req.body;
  if (!userId || !date) return res.status(400).json({ error: 'userId and date are required' });
  if (!isValidTime(startTime) || !isValidTime(endTime)) return res.status(400).json({ error: 'startTime and endTime must be HH:MM' });
  if (timeToMinutes(endTime) <= timeToMinutes(startTime)) return res.status(400).json({ error: 'End time must be after start time' });

  const user = db.prepare('SELECT id, name FROM users WHERE id = ?').get(userId);
  if (!user) return res.status(404).json({ error: 'Staff member not found' });

  const id = uuidv4();
  db.prepare(`
    INSERT INTO shifts (id, user_id, date, start_time, end_time, notes, created_by)
    VALUES (?,?,?,?,?,?,?)
  `).run(id, userId, date, startTime, endTime, notes || '', req.user.name);

  logAudit({ userId: req.user.id, userName: req.user.name, action: 'create_shift', targetType: 'shift', targetId: id, details: { staffName: user.name, date, startTime, endTime } });
  res.json(withUserName(db.prepare('SELECT * FROM shifts WHERE id = ?').get(id)));
});

router.put('/:id', adminRequired, (req, res) => {
  const shift = db.prepare('SELECT * FROM shifts WHERE id = ?').get(req.params.id);
  if (!shift) return res.status(404).json({ error: 'Shift not found' });

  const { userId, date, startTime, endTime, notes } = req.body;
  const newStart = startTime !== undefined ? startTime : shift.start_time;
  const newEnd = endTime !== undefined ? endTime : shift.end_time;
  if (!isValidTime(newStart) || !isValidTime(newEnd)) return res.status(400).json({ error: 'startTime and endTime must be HH:MM' });
  if (timeToMinutes(newEnd) <= timeToMinutes(newStart)) return res.status(400).json({ error: 'End time must be after start time' });

  db.prepare(`
    UPDATE shifts SET user_id=?, date=?, start_time=?, end_time=?, notes=? WHERE id=?
  `).run(
    userId !== undefined ? userId : shift.user_id,
    date !== undefined ? date : shift.date,
    newStart, newEnd,
    notes !== undefined ? notes : shift.notes,
    req.params.id
  );

  const staffAfter = db.prepare('SELECT name FROM users WHERE id = ?').get(userId !== undefined ? userId : shift.user_id);
  logAudit({ userId: req.user.id, userName: req.user.name, action: 'edit_shift', targetType: 'shift', targetId: req.params.id, details: { staffName: staffAfter ? staffAfter.name : null, before: { date: shift.date, startTime: shift.start_time, endTime: shift.end_time }, after: { date: date !== undefined ? date : shift.date, startTime: newStart, endTime: newEnd } } });
  res.json(withUserName(db.prepare('SELECT * FROM shifts WHERE id = ?').get(req.params.id)));
});

router.delete('/:id', adminRequired, (req, res) => {
  const shift = db.prepare('SELECT * FROM shifts WHERE id = ?').get(req.params.id);
  if (!shift) return res.status(404).json({ error: 'Shift not found' });
  db.prepare('DELETE FROM shifts WHERE id = ?').run(req.params.id);
  const staff = db.prepare('SELECT name FROM users WHERE id = ?').get(shift.user_id);
  logAudit({ userId: req.user.id, userName: req.user.name, action: 'delete_shift', targetType: 'shift', targetId: req.params.id, details: { staffName: staff ? staff.name : null, date: shift.date, startTime: shift.start_time, endTime: shift.end_time } });
  res.json({ ok: true });
});

// Hourly headcount for a given date — "how many staff will be in an hour."
router.get('/coverage', (req, res) => {
  const date = req.query.date || todayStr();
  const shifts = db.prepare('SELECT * FROM shifts WHERE date = ?').all(date);

  const hours = [];
  for (let h = 0; h < 24; h++) {
    const count = shifts.filter(s => {
      const startH = timeToMinutes(s.start_time);
      const endH = timeToMinutes(s.end_time);
      const slotStart = h * 60;
      const slotEnd = slotStart + 60;
      return startH < slotEnd && endH > slotStart;
    }).length;
    hours.push({ hour: h, count });
  }

  res.json({ date, hours, totalShifts: shifts.length });
});

module.exports = router;
