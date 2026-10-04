const express = require('express');
const path = require('path');
const fs = require('fs');
const { db, UPLOADS_DIR } = require('../db');

const router = express.Router();

// Deliberately not behind authRequired — the login screen and printed receipts
// both need this before (or without) an active session.
router.get('/logo', (req, res) => {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'logo_filename'").get();
  const filename = row && row.value;
  res.set('Cache-Control', 'no-cache');

  if (filename) {
    const filePath = path.join(UPLOADS_DIR, filename);
    if (fs.existsSync(filePath)) return res.sendFile(filePath);
  }
  // No custom logo uploaded yet — fall back to the bundled default.
  res.sendFile(path.join(__dirname, '..', 'public', 'images', 'logo.png'));
});

module.exports = router;
