const express = require('express');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db');
const { authRequired, adminRequired } = require('../middleware/auth');
const { requirePermission } = require('../lib/permissions');
const { logAudit } = require('../lib/audit');

const router = express.Router();

function pad(n) { return n < 10 ? '0' + n : '' + n; }
function todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

// Simple in-memory rate limiting per IP, same pattern as login — this endpoint
// checks a PIN without a session, so it needs its own brute-force protection.
const kioskAttempts = {};
function kioskTooManyAttempts(ip) {
  const rec = kioskAttempts[ip];
  if (!rec) return false;
  if (Date.now() - rec.first > 5 * 60 * 1000) { delete kioskAttempts[ip]; return false; }
  return rec.count >= 10;
}
function kioskRecordAttempt(ip, success) {
  if (success) { delete kioskAttempts[ip]; return; }
  const rec = kioskAttempts[ip] || { count: 0, first: Date.now() };
  rec.count += 1;
  kioskAttempts[ip] = rec;
}

// Public, no-session clock in/out — lets any staff member punch in or out from a
// shared kiosk screen using just their own PIN, without disturbing whoever else
// is currently logged into the app on that device.
function kioskFindUser(email, pin, ip) {
  if (kioskTooManyAttempts(ip)) return { error: 'Too many attempts. Wait a few minutes and try again.', status: 429 };
  if (!email || !pin) return { error: 'Email and PIN are required', status: 400 };
  const normalizedEmail = String(email).trim().toLowerCase();
  const user = db.prepare('SELECT * FROM users WHERE active = 1 AND lower(email) = ?').get(normalizedEmail);
  // Same generic error whether the email doesn't exist or the PIN is wrong — never reveal which one failed.
  if (!user || !bcrypt.compareSync(String(pin), user.pin_hash)) {
    kioskRecordAttempt(ip, false);
    return { error: 'Incorrect email or PIN', status: 401 };
  }
  kioskRecordAttempt(ip, true);
  return { user };
}

function kioskStatusFor(userId) {
  const open = db.prepare(`SELECT * FROM time_entries WHERE user_id = ? AND clock_out IS NULL ORDER BY clock_in DESC LIMIT 1`).get(userId);
  const openBreak = db.prepare(`SELECT * FROM break_entries WHERE user_id = ? AND end_time IS NULL`).get(userId);
  return {
    clockedIn: !!open,
    clockInSince: open ? open.clock_in : null,
    onBreak: !!openBreak,
    breakType: openBreak ? openBreak.type : null
  };
}

// Look up a person by PIN without performing any action — lets the kiosk screen
// show the right buttons (Clock In vs. Start Break vs. Clock Out) for whoever's PIN was entered.
router.post('/kiosk-lookup', (req, res) => {
  const result = kioskFindUser(req.body.email, req.body.pin, req.ip);
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.json({ userId: result.user.id, userName: result.user.name, role: result.user.role, position: result.user.position, ...kioskStatusFor(result.user.id) });
});

// Performs one action for whoever's PIN is entered — re-verifies the PIN fresh
// rather than trusting a prior lookup, and re-checks the same rules the
// authenticated endpoints use (can't clock out on a break, etc).
router.post('/kiosk-action', (req, res) => {
  const result = kioskFindUser(req.body.email, req.body.pin, req.ip);
  if (result.error) return res.status(result.status).json({ error: result.error });
  const user = result.user;
  const action = req.body.action;
  const status = kioskStatusFor(user.id);

  if (action === 'clock_in') {
    if (status.clockedIn) return res.status(400).json({ error: 'Already clocked in.', userName: user.name });
    const id = uuidv4();
    const now = db.prepare("SELECT datetime('now') t").get().t;
    db.prepare(`INSERT INTO time_entries (id, user_id, date, clock_in, notes) VALUES (?,?,?,?,'')`).run(id, user.id, todayStr(), now);
    const exception = checkAndRecordScheduleException(user.id, user.name, id, now);
    return res.json({ action: 'clocked_in', userName: user.name, scheduleException: exception });
  }
  if (action === 'clock_out') {
    if (!status.clockedIn) return res.status(400).json({ error: 'Not currently clocked in.', userName: user.name });
    if (status.onBreak) return res.status(400).json({ error: 'End your break/lunch first, then clock out.', userName: user.name });
    const open = db.prepare(`SELECT * FROM time_entries WHERE user_id = ? AND clock_out IS NULL ORDER BY clock_in DESC LIMIT 1`).get(user.id);
    db.prepare(`UPDATE time_entries SET clock_out = datetime('now') WHERE id = ?`).run(open.id);
    return res.json({ action: 'clocked_out', userName: user.name });
  }
  if (action === 'start_break' || action === 'start_lunch') {
    const type = action === 'start_lunch' ? 'lunch' : 'break';
    if (!status.clockedIn) return res.status(400).json({ error: 'Clock in first.', userName: user.name });
    if (status.onBreak) return res.status(400).json({ error: 'Already on a break/lunch.', userName: user.name });
    const id = uuidv4();
    db.prepare(`INSERT INTO break_entries (id, user_id, date, type, start_time) VALUES (?,?,?,?,datetime('now'))`).run(id, user.id, todayStr(), type);
    return res.json({ action: 'started_' + type, userName: user.name });
  }
  if (action === 'end_break') {
    if (!status.onBreak) return res.status(400).json({ error: 'Not currently on a break/lunch.', userName: user.name });
    const openBreak = db.prepare(`SELECT * FROM break_entries WHERE user_id = ? AND end_time IS NULL`).get(user.id);
    db.prepare(`UPDATE break_entries SET end_time = datetime('now') WHERE id = ?`).run(openBreak.id);
    return res.json({ action: 'ended_break', userName: user.name });
  }
  return res.status(400).json({ error: 'Unknown action' });
});

router.use(authRequired);

function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}
function getSetting(key, fallback) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}
function hoursBetween(startIso, endIso) {
  const start = new Date(startIso.replace(' ', 'T') + 'Z');
  const end = new Date(endIso.replace(' ', 'T') + 'Z');
  return Math.max(0, (end - start) / 3600000);
}

// Shift times are stored as plain HH:MM in business-local time (Asia/Manila, UTC+8, no DST).
// This converts a stored UTC clock-in timestamp into minutes-since-midnight in that same local time,
// so it can be compared against a shift's start_time.
function localMinutesOfDay(sqliteUtc) {
  const d = new Date(sqliteUtc.replace(' ', 'T') + 'Z');
  return (d.getUTCHours() * 60 + d.getUTCMinutes() + 8 * 60) % 1440;
}

// Called right after a clock-in is recorded. Flags it if there's no shift
// scheduled today, or if it's more than the grace period past the scheduled
// start — either way it becomes a pending exception needing a reason + admin sign-off.
function checkAndRecordScheduleException(userId, userName, timeEntryId, clockInUtc) {
  const date = todayStr();
  const shift = db.prepare('SELECT * FROM shifts WHERE user_id = ? AND date = ? ORDER BY start_time ASC LIMIT 1').get(userId, date);
  const graceMin = Number(getSetting('schedule_exception_minutes', '14'));

  let type = null, scheduledStart = null, minutesLate = null;
  if (!shift) {
    type = 'no_shift';
  } else {
    const clockInLocalMin = localMinutesOfDay(clockInUtc);
    const [h, m] = shift.start_time.split(':').map(Number);
    const scheduledMin = h * 60 + m;
    const lateBy = clockInLocalMin - scheduledMin;
    if (lateBy > graceMin) {
      type = 'late';
      scheduledStart = shift.start_time;
      minutesLate = lateBy;
    }
  }
  if (!type) return null;

  const id = uuidv4();
  db.prepare(`
    INSERT INTO schedule_exceptions (id, user_id, user_name, date, time_entry_id, type, scheduled_start, actual_clock_in, minutes_late)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run(id, userId, userName, date, timeEntryId, type, scheduledStart, clockInUtc, minutesLate);

  return db.prepare('SELECT * FROM schedule_exceptions WHERE id = ?').get(id);
}

// Is the current user currently clocked in?
router.get('/status', (req, res) => {
  const open = db.prepare(`
    SELECT * FROM time_entries WHERE user_id = ? AND clock_out IS NULL
    ORDER BY clock_in DESC LIMIT 1
  `).get(req.user.id);
  res.json({ clockedIn: !!open, entry: open || null });
});

router.post('/clock-in', (req, res) => {
  const open = db.prepare(`SELECT id FROM time_entries WHERE user_id = ? AND clock_out IS NULL`).get(req.user.id);
  if (open) return res.status(400).json({ error: 'Already clocked in' });

  const id = uuidv4();
  const now = db.prepare("SELECT datetime('now') t").get().t;
  db.prepare(`
    INSERT INTO time_entries (id, user_id, date, clock_in, notes)
    VALUES (?,?,?,?,?)
  `).run(id, req.user.id, todayStr(), now, req.body.notes || '');
  const exception = checkAndRecordScheduleException(req.user.id, req.user.name, id, now);
  res.json(Object.assign({}, db.prepare('SELECT * FROM time_entries WHERE id = ?').get(id), { scheduleException: exception }));
});

router.post('/clock-out', (req, res) => {
  const open = db.prepare(`
    SELECT * FROM time_entries WHERE user_id = ? AND clock_out IS NULL
    ORDER BY clock_in DESC LIMIT 1
  `).get(req.user.id);
  if (!open) return res.status(400).json({ error: 'Not currently clocked in' });

  const openBreak = db.prepare(`SELECT id FROM break_entries WHERE user_id = ? AND end_time IS NULL`).get(req.user.id);
  if (openBreak) return res.status(400).json({ error: 'End your break/lunch before clocking out' });

  db.prepare(`UPDATE time_entries SET clock_out = datetime('now') WHERE id = ?`).run(open.id);
  res.json(db.prepare('SELECT * FROM time_entries WHERE id = ?').get(open.id));
});

// ---- Breaks & lunch ----
router.get('/break-status', (req, res) => {
  const open = db.prepare(`SELECT * FROM break_entries WHERE user_id = ? AND end_time IS NULL`).get(req.user.id);
  res.json({ onBreak: !!open, entry: open || null });
});

router.post('/break-start', (req, res) => {
  const { type } = req.body;
  if (!['break', 'lunch'].includes(type)) return res.status(400).json({ error: 'type must be break or lunch' });

  const clockedIn = db.prepare(`SELECT id FROM time_entries WHERE user_id = ? AND clock_out IS NULL`).get(req.user.id);
  if (!clockedIn) return res.status(400).json({ error: 'Clock in first' });

  const openBreak = db.prepare(`SELECT id FROM break_entries WHERE user_id = ? AND end_time IS NULL`).get(req.user.id);
  if (openBreak) return res.status(400).json({ error: 'Already on a break/lunch' });

  const id = uuidv4();
  db.prepare(`INSERT INTO break_entries (id, user_id, date, type, start_time) VALUES (?,?,?,?,datetime('now'))`)
    .run(id, req.user.id, todayStr(), type);
  res.json(db.prepare('SELECT * FROM break_entries WHERE id = ?').get(id));
});

router.post('/break-end', (req, res) => {
  const open = db.prepare(`SELECT * FROM break_entries WHERE user_id = ? AND end_time IS NULL`).get(req.user.id);
  if (!open) return res.status(400).json({ error: 'Not currently on a break' });
  db.prepare(`UPDATE break_entries SET end_time = datetime('now') WHERE id = ?`).run(open.id);
  res.json(db.prepare('SELECT * FROM break_entries WHERE id = ?').get(open.id));
});

// Staff see only their own; admin can see anyone's (optional userId filter).
router.get('/breaks', (req, res) => {
  const date = req.query.date || todayStr();
  let rows;
  if (req.user.role === 'admin') {
    rows = req.query.userId
      ? db.prepare('SELECT * FROM break_entries WHERE date = ? AND user_id = ? ORDER BY start_time DESC').all(date, req.query.userId)
      : db.prepare('SELECT * FROM break_entries WHERE date = ? ORDER BY start_time DESC').all(date);
  } else {
    rows = db.prepare('SELECT * FROM break_entries WHERE date = ? AND user_id = ? ORDER BY start_time DESC').all(date, req.user.id);
  }
  const breakLimit = Number(getSetting('break_limit_minutes', '15'));
  const lunchLimit = Number(getSetting('lunch_limit_minutes', '60'));
  const withNames = rows.map(r => {
    const u = db.prepare('SELECT name FROM users WHERE id = ?').get(r.user_id);
    const limit = r.type === 'lunch' ? lunchLimit : breakLimit;
    const minutes = r.end_time ? hoursBetween(r.start_time, r.end_time) * 60 : null;
    return Object.assign({}, r, {
      user_name: u ? u.name : 'Unknown',
      limit_minutes: limit,
      minutes_used: minutes,
      over_by: minutes !== null ? Math.max(0, Math.round(minutes - limit)) : null
    });
  });
  res.json(withNames);
});

// Staff see only their own entries; admin can see anyone's (optional userId filter).
router.get('/entries', (req, res) => {
  const date = req.query.date || todayStr();
  let rows;
  if (req.user.role === 'admin') {
    if (req.query.userId) {
      rows = db.prepare('SELECT * FROM time_entries WHERE date = ? AND user_id = ? ORDER BY clock_in DESC').all(date, req.query.userId);
    } else {
      rows = db.prepare('SELECT * FROM time_entries WHERE date = ? ORDER BY clock_in DESC').all(date);
    }
  } else {
    rows = db.prepare('SELECT * FROM time_entries WHERE date = ? AND user_id = ? ORDER BY clock_in DESC').all(date, req.user.id);
  }
  const withNames = rows.map(r => {
    const u = db.prepare('SELECT name FROM users WHERE id = ?').get(r.user_id);
    return Object.assign({}, r, { user_name: u ? u.name : 'Unknown' });
  });
  res.json(withNames);
});

router.put('/entries/:id', requirePermission('manage_team'), (req, res) => {
  const e = db.prepare('SELECT * FROM time_entries WHERE id = ?').get(req.params.id);
  if (!e) return res.status(404).json({ error: 'Entry not found' });
  const { clockIn, clockOut, notes } = req.body;
  const newIn = clockIn || e.clock_in;
  const newOut = clockOut !== undefined ? (clockOut || null) : e.clock_out;
  db.prepare(`
    UPDATE time_entries SET clock_in=?, clock_out=?, notes=?, edited_by=?, edited_at=datetime('now') WHERE id=?
  `).run(
    newIn, newOut,
    notes !== undefined ? notes : e.notes,
    req.user.name,
    req.params.id
  );
  const staff = db.prepare('SELECT name FROM users WHERE id = ?').get(e.user_id);
  logAudit({ userId: req.user.id, userName: req.user.name, action: 'edit_time_entry', targetType: 'time_entry', targetId: req.params.id, details: { staffName: staff ? staff.name : null, before: { clockIn: e.clock_in, clockOut: e.clock_out }, after: { clockIn: newIn, clockOut: newOut } } });
  res.json(db.prepare('SELECT * FROM time_entries WHERE id = ?').get(req.params.id));
});

router.delete('/entries/:id', requirePermission('manage_team'), (req, res) => {
  const e = db.prepare('SELECT * FROM time_entries WHERE id = ?').get(req.params.id);
  db.prepare('DELETE FROM time_entries WHERE id = ?').run(req.params.id);
  if (e) {
    const staff = db.prepare('SELECT name FROM users WHERE id = ?').get(e.user_id);
    logAudit({ userId: req.user.id, userName: req.user.name, action: 'delete_time_entry', targetType: 'time_entry', targetId: req.params.id, details: { staffName: staff ? staff.name : null, clockIn: e.clock_in, clockOut: e.clock_out } });
  }
  res.json({ ok: true });
});

// Payroll summary for a date range — admin only.
router.get('/payroll', requirePermission('view_payroll'), (req, res) => {
  const start = req.query.start;
  const end = req.query.end;
  if (!start || !end) return res.status(400).json({ error: 'start and end (YYYY-MM-DD) required' });

  const standardHours = Number(getSetting('standard_hours', '8'));
  const otMultiplier = Number(getSetting('ot_multiplier', '1.25'));

  const users = db.prepare("SELECT id, name, hourly_rate FROM users WHERE active = 1").all();
  const entries = db.prepare('SELECT * FROM time_entries WHERE date >= ? AND date <= ? AND clock_out IS NOT NULL').all(start, end);

  const perUser = {};
  users.forEach(u => { perUser[u.id] = { user: u, days: {}, totalHours: 0, regularHours: 0, otHours: 0, grossPay: 0 }; });

  entries.forEach(e => {
    if (!perUser[e.user_id]) return;
    const hrs = hoursBetween(e.clock_in, e.clock_out);
    const bucket = perUser[e.user_id];
    bucket.days[e.date] = (bucket.days[e.date] || 0) + hrs;
  });

  Object.values(perUser).forEach(bucket => {
    Object.values(bucket.days).forEach(dayHours => {
      const reg = Math.min(dayHours, standardHours);
      const ot = Math.max(0, dayHours - standardHours);
      bucket.regularHours += reg;
      bucket.otHours += ot;
      bucket.totalHours += dayHours;
    });
    bucket.grossPay = bucket.regularHours * bucket.user.hourly_rate + bucket.otHours * bucket.user.hourly_rate * otMultiplier;
    delete bucket.days;
  });

  // Attach exception counts (late / no-shift clock-ins) for this range, split by review status,
  // so payroll review surfaces anything that needs a look before finalizing pay.
  const exceptions = db.prepare('SELECT * FROM schedule_exceptions WHERE date >= ? AND date <= ?').all(start, end);
  Object.values(perUser).forEach(bucket => {
    const mine = exceptions.filter(e => e.user_id === bucket.user.id);
    bucket.exceptions = {
      total: mine.length,
      pending: mine.filter(e => e.status === 'pending').length,
      approved: mine.filter(e => e.status === 'approved').length,
      denied: mine.filter(e => e.status === 'denied').length
    };
  });

  res.json({ start, end, standardHours, otMultiplier, payroll: Object.values(perUser) });
});

// ---- Attendance status: absent / AWOL / undertime ----
router.post('/status-marks', requirePermission('manage_team'), (req, res) => {
  const { userId, date, status, notes } = req.body;
  if (!userId || !date || !['absent', 'awol', 'undertime'].includes(status)) {
    return res.status(400).json({ error: 'userId, date, and a valid status (absent/awol/undertime) are required' });
  }
  const staff = db.prepare('SELECT name FROM users WHERE id = ?').get(userId);
  const existing = db.prepare('SELECT * FROM attendance_status WHERE user_id = ? AND date = ?').get(userId, date);
  if (existing) {
    db.prepare(`UPDATE attendance_status SET status=?, notes=?, marked_by=?, updated_at=datetime('now') WHERE id=?`)
      .run(status, notes || '', req.user.name, existing.id);
    logAudit({ userId: req.user.id, userName: req.user.name, action: 'edit_attendance_mark', targetType: 'attendance_status', targetId: existing.id, details: { staffName: staff ? staff.name : null, date, status } });
    return res.json(db.prepare('SELECT * FROM attendance_status WHERE id = ?').get(existing.id));
  }
  const id = uuidv4();
  db.prepare('INSERT INTO attendance_status (id, user_id, date, status, notes, marked_by) VALUES (?,?,?,?,?,?)')
    .run(id, userId, date, status, notes || '', req.user.name);
  logAudit({ userId: req.user.id, userName: req.user.name, action: 'create_attendance_mark', targetType: 'attendance_status', targetId: id, details: { staffName: staff ? staff.name : null, date, status } });
  res.json(db.prepare('SELECT * FROM attendance_status WHERE id = ?').get(id));
});

router.get('/status-marks', requirePermission('manage_team'), (req, res) => {
  const { date, start, end, userId } = req.query;
  let rows;
  if (date) rows = db.prepare('SELECT * FROM attendance_status WHERE date = ?').all(date);
  else if (start && end) rows = db.prepare('SELECT * FROM attendance_status WHERE date >= ? AND date <= ?').all(start, end);
  else rows = db.prepare('SELECT * FROM attendance_status').all();
  if (userId) rows = rows.filter(r => String(r.user_id) === String(userId));
  const withNames = rows.map(r => {
    const u = db.prepare('SELECT name FROM users WHERE id = ?').get(r.user_id);
    return Object.assign({}, r, { user_name: u ? u.name : 'Unknown' });
  });
  res.json(withNames);
});

router.delete('/status-marks/:id', requirePermission('manage_team'), (req, res) => {
  const mark = db.prepare('SELECT * FROM attendance_status WHERE id = ?').get(req.params.id);
  db.prepare('DELETE FROM attendance_status WHERE id = ?').run(req.params.id);
  if (mark) {
    const staff = db.prepare('SELECT name FROM users WHERE id = ?').get(mark.user_id);
    logAudit({ userId: req.user.id, userName: req.user.name, action: 'delete_attendance_mark', targetType: 'attendance_status', targetId: req.params.id, details: { staffName: staff ? staff.name : null, date: mark.date, status: mark.status } });
  }
  res.json({ ok: true });
});

// Day/month/year evaluation report — attendance + hours + pay in one view.
router.get('/attendance-summary', requirePermission('view_reports'), (req, res) => {
  const { start, end, userId } = req.query;
  if (!start || !end) return res.status(400).json({ error: 'start and end (YYYY-MM-DD) required' });

  let users = db.prepare('SELECT id, name, hourly_rate FROM users WHERE active = 1').all();
  if (userId) users = users.filter(u => String(u.id) === String(userId));

  const standardHours = Number(getSetting('standard_hours', '8'));
  const otMultiplier = Number(getSetting('ot_multiplier', '1.25'));
  const lateGraceMin = Number(getSetting('late_grace_minutes', '10'));
  const breakLimitMin = Number(getSetting('break_limit_minutes', '15'));
  const lunchLimitMin = Number(getSetting('lunch_limit_minutes', '60'));

  const entries = db.prepare('SELECT * FROM time_entries WHERE date >= ? AND date <= ? AND clock_out IS NOT NULL').all(start, end);
  const statuses = db.prepare('SELECT * FROM attendance_status WHERE date >= ? AND date <= ?').all(start, end);
  const shifts = db.prepare('SELECT * FROM shifts WHERE date >= ? AND date <= ?').all(start, end);
  const breaks = db.prepare('SELECT * FROM break_entries WHERE date >= ? AND date <= ? AND end_time IS NOT NULL').all(start, end);

  const result = users.map(u => {
    const hoursByDate = {};
    const firstClockInByDate = {};
    entries.filter(e => e.user_id === u.id).forEach(e => {
      hoursByDate[e.date] = (hoursByDate[e.date] || 0) + hoursBetween(e.clock_in, e.clock_out);
      if (!firstClockInByDate[e.date] || e.clock_in < firstClockInByDate[e.date]) firstClockInByDate[e.date] = e.clock_in;
    });
    const statusByDate = {};
    statuses.filter(s => s.user_id === u.id).forEach(s => { statusByDate[s.date] = s; });
    const shiftByDate = {};
    shifts.filter(s => s.user_id === u.id).forEach(s => { if (!shiftByDate[s.date]) shiftByDate[s.date] = s; });

    let presentDays = 0, absentDays = 0, awolDays = 0, undertimeDays = 0, lateDays = 0;
    let totalHours = 0, regularHours = 0, otHours = 0;
    const days = [];
    let cursor = start;
    while (cursor <= end) {
      const hrs = hoursByDate[cursor] || 0;
      const statusRow = statusByDate[cursor];
      const shift = shiftByDate[cursor];
      let dayStatus = null;
      let isLate = false;
      if (hrs > 0) {
        presentDays++;
        dayStatus = 'present';
        totalHours += hrs;
        regularHours += Math.min(hrs, standardHours);
        otHours += Math.max(0, hrs - standardHours);
        if (shift && firstClockInByDate[cursor]) {
          const localMin = localMinutesOfDay(firstClockInByDate[cursor]);
          const [sh, sm] = shift.start_time.split(':').map(Number);
          if (localMin > (sh * 60 + sm) + lateGraceMin) { isLate = true; lateDays++; }
        }
      }
      if (statusRow) {
        dayStatus = statusRow.status;
        if (statusRow.status === 'absent') absentDays++;
        else if (statusRow.status === 'awol') awolDays++;
        else if (statusRow.status === 'undertime') undertimeDays++;
      }
      days.push({ date: cursor, hours: Math.round(hrs * 100) / 100, status: dayStatus, late: isLate, notes: statusRow ? statusRow.notes : '' });
      cursor = addDays(cursor, 1);
    }

    const overBreaks = breaks.filter(b => {
      if (b.user_id !== u.id) return false;
      const limit = b.type === 'lunch' ? lunchLimitMin : breakLimitMin;
      return hoursBetween(b.start_time, b.end_time) * 60 > limit;
    });

    const grossPay = regularHours * u.hourly_rate + otHours * u.hourly_rate * otMultiplier;
    return { user: u, presentDays, absentDays, awolDays, undertimeDays, lateDays, overBreakCount: overBreaks.length, totalHours, regularHours, otHours, grossPay, days };
  });

  res.json({ start, end, standardHours, otMultiplier, lateGraceMin, result });
});

// Real-time staff status for the admin dashboard: who's working, on break, on lunch, or off.
// Lateness is left for the client to compute against today's schedule using local wall-clock time,
// since shift times are stored as plain HH:MM (business-local) rather than UTC instants.
router.get('/live-status', (req, res) => {
  const today = todayStr();
  const users = db.prepare('SELECT id, name, role, position FROM users WHERE active = 1').all();

  const openEntries = db.prepare('SELECT * FROM time_entries WHERE date = ? AND clock_out IS NULL').all(today);
  const openBreaks = db.prepare('SELECT * FROM break_entries WHERE date = ? AND end_time IS NULL').all(today);
  const todaysShifts = db.prepare('SELECT * FROM shifts WHERE date = ? ORDER BY start_time ASC').all(today);
  const anyEntryToday = db.prepare('SELECT DISTINCT user_id FROM time_entries WHERE date = ?').all(today).map(r => r.user_id);
  const todaysExceptions = db.prepare('SELECT * FROM schedule_exceptions WHERE date = ? ORDER BY created_at DESC').all(today);

  const entryByUser = {};
  openEntries.forEach(e => { entryByUser[e.user_id] = e; });
  const breakByUser = {};
  openBreaks.forEach(b => { breakByUser[b.user_id] = b; });
  const shiftByUser = {};
  todaysShifts.forEach(s => { if (!shiftByUser[s.user_id]) shiftByUser[s.user_id] = s; });
  const exceptionByUser = {};
  todaysExceptions.forEach(e => { if (!exceptionByUser[e.user_id]) exceptionByUser[e.user_id] = e; }); // most recent per user

  const result = users.map(u => {
    let status = 'off';
    let since = null;
    if (breakByUser[u.id]) { status = breakByUser[u.id].type === 'lunch' ? 'lunch' : 'break'; since = breakByUser[u.id].start_time; }
    else if (entryByUser[u.id]) { status = 'working'; since = entryByUser[u.id].clock_in; }
    return {
      user: { id: u.id, name: u.name, role: u.role, position: u.position },
      status,
      since,
      hasClockedInToday: anyEntryToday.includes(u.id),
      shiftToday: shiftByUser[u.id] || null,
      exceptionToday: exceptionByUser[u.id] || null
    };
  });

  res.json({ date: today, staff: result });
});

/* ---- Schedule exceptions (late / no-shift clock-ins needing a reason + approval) ---- */
router.get('/schedule-exceptions/mine', (req, res) => {
  const rows = db.prepare('SELECT * FROM schedule_exceptions WHERE user_id = ? ORDER BY created_at DESC LIMIT 30').all(req.user.id);
  res.json(rows);
});

router.put('/schedule-exceptions/:id/reason', (req, res) => {
  const exc = db.prepare('SELECT * FROM schedule_exceptions WHERE id = ?').get(req.params.id);
  if (!exc) return res.status(404).json({ error: 'Not found' });
  if (exc.user_id !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'Not your exception to explain' });
  const reason = (req.body.reason || '').trim();
  if (!reason) return res.status(400).json({ error: 'Reason is required' });
  db.prepare('UPDATE schedule_exceptions SET reason = ? WHERE id = ?').run(reason, req.params.id);
  res.json(db.prepare('SELECT * FROM schedule_exceptions WHERE id = ?').get(req.params.id));
});

router.get('/schedule-exceptions', requirePermission('review_schedule_exceptions'), (req, res) => {
  const { status, start, end } = req.query;
  let sql = 'SELECT * FROM schedule_exceptions WHERE 1=1';
  const params = [];
  if (status) { sql += ' AND status = ?'; params.push(status); }
  if (start) { sql += ' AND date >= ?'; params.push(start); }
  if (end) { sql += ' AND date <= ?'; params.push(end); }
  sql += ' ORDER BY created_at DESC LIMIT 300';
  res.json(db.prepare(sql).all(...params));
});

router.put('/schedule-exceptions/:id/review', requirePermission('review_schedule_exceptions'), (req, res) => {
  const exc = db.prepare('SELECT * FROM schedule_exceptions WHERE id = ?').get(req.params.id);
  if (!exc) return res.status(404).json({ error: 'Not found' });
  const { status, adminNotes } = req.body;
  if (!['approved', 'denied', 'pending'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
  db.prepare(`
    UPDATE schedule_exceptions SET status = ?, admin_notes = ?, reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ?
  `).run(status, (adminNotes || '').trim(), req.user.name, req.params.id);

  logAudit({
    userId: req.user.id, userName: req.user.name, action: 'review_schedule_exception',
    targetType: 'schedule_exception', targetId: req.params.id,
    details: { staffName: exc.user_name, type: exc.type, status, date: exc.date }
  });

  res.json(db.prepare('SELECT * FROM schedule_exceptions WHERE id = ?').get(req.params.id));
});

module.exports = router;
