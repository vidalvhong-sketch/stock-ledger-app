const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { db, UPLOADS_DIR } = require('../db');
const { authRequired, adminRequired } = require('../middleware/auth');
const { requirePermission } = require('../lib/permissions');
const { logAudit } = require('../lib/audit');

const router = express.Router();
router.use(authRequired);

const uploadRecipeImage = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => cb(null, 'recipe-' + uuidv4() + path.extname(file.originalname || ''))
  }),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB — a finished-product photo, not a video
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) return cb(new Error('Recipe photo must be an image file'));
    cb(null, true);
  }
});

function withVariants(item) {
  const variants = db.prepare('SELECT id, name, price FROM menu_item_variants WHERE menu_item_id = ? ORDER BY sort_order ASC').all(item.id);
  return Object.assign({}, item, { variants });
}

// Replaces the full variant list for a menu item — simplest to reason about
// since the admin form always edits "the whole list of sizes", not one at a time.
function replaceVariants(menuItemId, variants) {
  db.prepare('DELETE FROM menu_item_variants WHERE menu_item_id = ?').run(menuItemId);
  if (!Array.isArray(variants)) return;
  variants.forEach((v, i) => {
    const name = (v.name || '').toString().trim();
    const price = Number(v.price);
    if (!name || isNaN(price) || price < 0) return; // silently skip incomplete rows rather than fail the whole save
    db.prepare('INSERT INTO menu_item_variants (id, menu_item_id, name, price, sort_order) VALUES (?,?,?,?,?)')
      .run(uuidv4(), menuItemId, name, price, i);
  });
}

router.get('/', (req, res) => {
  const items = db.prepare('SELECT * FROM menu_items WHERE archived = 0 ORDER BY category COLLATE NOCASE, name COLLATE NOCASE').all();
  res.json(items.map(withVariants));
});

router.get('/by-barcode/:code', (req, res) => {
  const item = db.prepare('SELECT * FROM menu_items WHERE barcode = ? AND archived = 0').get(req.params.code);
  if (!item) return res.status(404).json({ error: 'No menu item with that barcode' });
  res.json(withVariants(item));
});

router.post('/', requirePermission('manage_menu'), (req, res) => {
  const { name, category, price, barcode, recipe, variants } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Item name is required' });
  if (price === undefined || price === null || isNaN(Number(price)) || Number(price) < 0) {
    return res.status(400).json({ error: 'Valid price is required' });
  }
  const id = uuidv4();
  db.prepare(`
    INSERT INTO menu_items (id, name, category, price, barcode, recipe) VALUES (?,?,?,?,?,?)
  `).run(id, name.trim(), (category || '').trim(), Number(price), (barcode || '').trim() || null, (recipe || '').trim() || null);
  replaceVariants(id, variants);
  logAudit({ userId: req.user.id, userName: req.user.name, action: 'create_menu_item', targetType: 'menu_item', targetId: id, details: { name: name.trim(), price: Number(price), variantCount: (variants || []).length } });
  res.json(withVariants(db.prepare('SELECT * FROM menu_items WHERE id = ?').get(id)));
});

router.put('/:id', requirePermission('manage_menu'), (req, res) => {
  const item = db.prepare('SELECT * FROM menu_items WHERE id = ?').get(req.params.id);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  const { name, category, price, barcode, recipe, variants } = req.body;
  db.prepare(`
    UPDATE menu_items SET name=?, category=?, price=?, barcode=?, recipe=? WHERE id=?
  `).run(
    name !== undefined ? name.trim() : item.name,
    category !== undefined ? category.trim() : item.category,
    price !== undefined ? Number(price) : item.price,
    barcode !== undefined ? ((barcode || '').trim() || null) : item.barcode,
    recipe !== undefined ? ((recipe || '').trim() || null) : item.recipe,
    req.params.id
  );
  if (variants !== undefined) replaceVariants(req.params.id, variants);
  logAudit({ userId: req.user.id, userName: req.user.name, action: 'edit_menu_item', targetType: 'menu_item', targetId: req.params.id, details: { name: item.name, before: { name: item.name, price: item.price }, after: { name, price } } });
  res.json(withVariants(db.prepare('SELECT * FROM menu_items WHERE id = ?').get(req.params.id)));
});

router.delete('/:id', requirePermission('manage_menu'), (req, res) => {
  const item = db.prepare('SELECT * FROM menu_items WHERE id = ?').get(req.params.id);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  db.prepare('UPDATE menu_items SET archived = 1 WHERE id = ?').run(req.params.id);
  logAudit({ userId: req.user.id, userName: req.user.name, action: 'delete_menu_item', targetType: 'menu_item', targetId: req.params.id, details: { name: item.name } });
  res.json({ ok: true });
});

router.post('/:id/recipe-image', requirePermission('manage_menu'), uploadRecipeImage.single('image'), (req, res) => {
  const item = db.prepare('SELECT * FROM menu_items WHERE id = ?').get(req.params.id);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  if (!req.file) return res.status(400).json({ error: 'No image uploaded' });

  if (item.recipe_image) {
    fs.unlink(path.join(UPLOADS_DIR, item.recipe_image), () => {}); // best-effort cleanup of the old photo
  }
  db.prepare('UPDATE menu_items SET recipe_image = ? WHERE id = ?').run(req.file.filename, req.params.id);
  logAudit({ userId: req.user.id, userName: req.user.name, action: 'update_recipe_image', targetType: 'menu_item', targetId: req.params.id, details: { itemName: item.name } });
  res.json(withVariants(db.prepare('SELECT * FROM menu_items WHERE id = ?').get(req.params.id)));
});

router.delete('/:id/recipe-image', requirePermission('manage_menu'), (req, res) => {
  const item = db.prepare('SELECT * FROM menu_items WHERE id = ?').get(req.params.id);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  if (item.recipe_image) {
    fs.unlink(path.join(UPLOADS_DIR, item.recipe_image), () => {});
  }
  db.prepare('UPDATE menu_items SET recipe_image = NULL WHERE id = ?').run(req.params.id);
  res.json(withVariants(db.prepare('SELECT * FROM menu_items WHERE id = ?').get(req.params.id)));
});

module.exports = router;
