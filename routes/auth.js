const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { db } = require('../db');
const { SECRET, authRequired } = require('../middleware/auth');

const router = express.Router();

// Simple in-memory rate limiting per IP to slow down PIN guessing.
const attempts = {};
function tooManyAttempts(ip) {
  const rec = attempts[ip];
  if (!rec) return false;
  if (Date.now() - rec.first > 5 * 60 * 1000) { delete attempts[ip]; return false; }
  return rec.count >= 10;
}
function recordAttempt(ip, success) {
  if (success) { delete attempts[ip]; return; }
  const rec = attempts[ip] || { count: 0, first: Date.now() };
  rec.count += 1;
  attempts[ip] = rec;
}

router.post('/login', (req, res) => {
  const ip = req.ip;
  if (tooManyAttempts(ip)) {
    return res.status(429).json({ error: 'Too many attempts. Wait a few minutes and try again.' });
  }
  const { pin } = req.body;
  if (!pin) return res.status(400).json({ error: 'PIN required' });

  const users = db.prepare('SELECT * FROM users WHERE active = 1').all();
  const match = users.find(u => bcrypt.compareSync(String(pin), u.pin_hash));

  if (!match) {
    recordAttempt(ip, false);
    return res.status(401).json({ error: 'Incorrect PIN' });
  }
  recordAttempt(ip, true);

  const token = jwt.sign(
    { id: match.id, name: match.name, role: match.role },
    SECRET,
    { expiresIn: '12h' }
  );
  res.json({ token, user: { id: match.id, name: match.name, role: match.role } });
});

router.get('/me', authRequired, (req, res) => {
  res.json({ user: req.user });
});

module.exports = router;
