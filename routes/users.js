const express = require('express');
const bcrypt = require('bcryptjs');
const { db } = require('../db');
const { authRequired, adminRequired } = require('../middleware/auth');
const { logAudit } = require('../lib/audit');

const router = express.Router();
router.use(authRequired, adminRequired);

// Extended HR profile fields — all plain text, all optional.
const HR_FIELDS = [
  'address', 'emergency_contact', 'date_of_birth', 'tin', 'sss_number',
  'philhealth_number', 'pagibig_number', 'contact_number', 'education',
  'date_hired', 'termination_date', 'hr_notes'
];
const POSITIONS = ['Cashier', 'Kitchen', 'Manager', 'Team Lead', 'Dining'];

router.get('/positions', (req, res) => res.json(POSITIONS));

router.get('/', (req, res) => {
  const cols = ['id', 'name', 'role', 'active', 'hourly_rate', 'email', 'position', 'created_at', ...HR_FIELDS].join(', ');
  const users = db.prepare(`SELECT ${cols} FROM users ORDER BY created_at`).all();
  res.json(users);
});

router.post('/', (req, res) => {
  const { name, role, pin, hourlyRate, email, position } = req.body;
  if (!name || !role || !pin) return res.status(400).json({ error: 'name, role, and pin are required' });
  if (!['admin', 'staff'].includes(role)) return res.status(400).json({ error: 'role must be admin or staff' });
  if (String(pin).length < 4) return res.status(400).json({ error: 'PIN must be at least 4 digits' });
  if (position && !POSITIONS.includes(position)) return res.status(400).json({ error: 'Invalid position' });

  const hash = bcrypt.hashSync(String(pin), 10);
  const hrValues = HR_FIELDS.map(f => (req.body[f] || '').toString().trim() || null);
  const info = db.prepare(`
    INSERT INTO users (name, role, pin_hash, hourly_rate, email, position, ${HR_FIELDS.join(', ')})
    VALUES (?,?,?,?,?,?,${HR_FIELDS.map(() => '?').join(',')})
  `).run(name.trim(), role, hash, Number(hourlyRate) || 0, (email || '').trim() || null, position || null, ...hrValues);

  logAudit({ userId: req.user.id, userName: req.user.name, action: 'create_user', targetType: 'user', targetId: String(info.lastInsertRowid), details: { name: name.trim(), role } });
  res.json(db.prepare(`SELECT id, name, role, active, hourly_rate, email, position, ${HR_FIELDS.join(', ')} FROM users WHERE id = ?`).get(info.lastInsertRowid));
});

router.put('/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'User not found' });

  const { name, role, pin, active, hourlyRate, email, position } = req.body;
  if (position && !POSITIONS.includes(position)) return res.status(400).json({ error: 'Invalid position' });

  if (existing.role === 'admin' && role === 'staff') {
    const adminCount = db.prepare("SELECT COUNT(*) c FROM users WHERE role='admin' AND active=1").get().c;
    if (adminCount <= 1) return res.status(400).json({ error: 'Cannot demote the last active admin' });
  }
  if (existing.role === 'admin' && active === false) {
    const adminCount = db.prepare("SELECT COUNT(*) c FROM users WHERE role='admin' AND active=1").get().c;
    if (adminCount <= 1) return res.status(400).json({ error: 'Cannot deactivate the last active admin' });
  }

  const newName = name !== undefined ? name.trim() : existing.name;
  const newRole = role !== undefined ? role : existing.role;
  const newActive = active !== undefined ? (active ? 1 : 0) : existing.active;
  const newHash = pin ? bcrypt.hashSync(String(pin), 10) : existing.pin_hash;
  const newRate = hourlyRate !== undefined ? Number(hourlyRate) || 0 : existing.hourly_rate;
  const newEmail = email !== undefined ? ((email || '').trim() || null) : existing.email;
  const newPosition = position !== undefined ? (position || null) : existing.position;

  const hrSets = HR_FIELDS.map(f => `${f} = ?`).join(', ');
  const hrValues = HR_FIELDS.map(f => req.body[f] !== undefined ? ((req.body[f] || '').toString().trim() || null) : existing[f]);

  db.prepare(`UPDATE users SET name=?, role=?, pin_hash=?, active=?, hourly_rate=?, email=?, position=?, ${hrSets} WHERE id=?`)
    .run(newName, newRole, newHash, newActive, newRate, newEmail, newPosition, ...hrValues, req.params.id);

  logAudit({
    userId: req.user.id, userName: req.user.name, action: 'edit_user', targetType: 'user', targetId: req.params.id,
    details: {
      name: newName,
      before: { name: existing.name, role: existing.role, active: !!existing.active, position: existing.position },
      after: { name: newName, role: newRole, active: !!newActive, position: newPosition },
      pinChanged: !!pin
    }
  });
  res.json({ ok: true });
});

router.delete('/:id', (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.role === 'admin') {
    const adminCount = db.prepare("SELECT COUNT(*) c FROM users WHERE role='admin' AND active=1").get().c;
    if (adminCount <= 1) return res.status(400).json({ error: 'Cannot delete the last admin' });
  }
  try {
    db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
    logAudit({ userId: req.user.id, userName: req.user.name, action: 'delete_user', targetType: 'user', targetId: req.params.id, details: { name: target.name } });
    res.json({ ok: true, action: 'deleted' });
  } catch (e) {
    // Foreign key constraint — this person has real history (sales, time entries, etc.).
    // Deleting them would corrupt those records, so deactivate instead: they can no
    // longer log in, but every past record still correctly shows their name.
    if (e.code === 'SQLITE_CONSTRAINT_FOREIGNKEY' || /FOREIGN KEY/i.test(e.message || '')) {
      db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(req.params.id);
      logAudit({ userId: req.user.id, userName: req.user.name, action: 'deactivate_user', targetType: 'user', targetId: req.params.id, details: { name: target.name, reason: 'has activity history' } });
      return res.json({ ok: true, action: 'deactivated' });
    }
    throw e;
  }
});

module.exports = router;
