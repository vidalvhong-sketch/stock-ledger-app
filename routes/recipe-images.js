const express = require('express');
const path = require('path');
const fs = require('fs');
const { db, UPLOADS_DIR } = require('../db');

const router = express.Router();

// Deliberately public — an <img> tag can't send an Authorization header, and
// this mirrors how the store logo already works. Filenames are random UUIDs,
// and the content is just a photo of a menu item, not sensitive data.
router.get('/:menuItemId', (req, res) => {
  const item = db.prepare('SELECT recipe_image FROM menu_items WHERE id = ?').get(req.params.menuItemId);
  if (!item || !item.recipe_image) return res.status(404).json({ error: 'No image for this item' });
  const filePath = path.join(UPLOADS_DIR, item.recipe_image);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Image file no longer available' });
  res.set('Cache-Control', 'no-cache');
  res.sendFile(filePath);
});

module.exports = router;
