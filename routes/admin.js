const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const XLSX = require('xlsx');
const { v4: uuidv4 } = require('uuid');
const { db, UPLOADS_DIR } = require('../db');
const { authRequired, adminRequired } = require('../middleware/auth');
const { requirePermission } = require('../lib/permissions');
const { logAudit } = require('../lib/audit');

const router = express.Router();

// Genuinely public — no auth at all. The login screen (cafe name, theme, attention
// note) needs this before any session exists, so it can't sit behind authRequired.
router.get('/public', (req, res) => {
  const keys = ['cafe_name', 'attention_note', 'business_name', 'business_address', 'business_tin', 'vat_registered', 'facebook_page', 'receipt_footer_note', 'theme'];
  const obj = {};
  keys.forEach(k => {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(k);
    obj[k] = row ? row.value : '';
  });
  res.json(obj);
});

router.use(authRequired);

const uploadLogo = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => cb(null, 'logo-' + uuidv4() + path.extname(file.originalname || ''))
  }),
  limits: { fileSize: 3 * 1024 * 1024 }, // 3MB — plenty for a logo, keeps things fast to load
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) return cb(new Error('Logo must be an image file'));
    cb(null, true);
  }
});

function pad(n) { return n < 10 ? '0' + n : '' + n; }
function todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

// Settings whose changes matter for tax/audit purposes — logged distinctly from
// cosmetic settings like cafe_name or the daily attention note.
const AUDITED_SETTINGS = ['vat_rate', 'senior_pwd_discount', 'business_tin', 'business_address', 'business_name', 'vat_registered', 'invoice_prefix'];

router.get('/settings', requirePermission('manage_settings'), (req, res) => {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const obj = {};
  rows.forEach(r => { obj[r.key] = r.value; });
  res.json(obj);
});

router.put('/settings', requirePermission('manage_settings'), (req, res) => {
  const upsert = db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);
  const changes = {};
  Object.entries(req.body || {}).forEach(([k, v]) => {
    if (AUDITED_SETTINGS.includes(k)) {
      const before = db.prepare('SELECT value FROM settings WHERE key = ?').get(k);
      if (!before || before.value !== String(v)) changes[k] = { from: before ? before.value : null, to: String(v) };
    }
    upsert.run(k, String(v));
  });
  if (Object.keys(changes).length > 0) {
    logAudit({ userId: req.user.id, userName: req.user.name, action: 'update_settings', targetType: 'settings', details: changes });
  }
  res.json({ ok: true });
});

router.post('/reset-today', requirePermission('manage_settings'), (req, res) => {
  db.prepare('DELETE FROM entries WHERE date = ?').run(todayStr());
  logAudit({ userId: req.user.id, userName: req.user.name, action: 'reset_today_inventory', targetType: 'entries' });
  res.json({ ok: true });
});

router.post('/reset-all', requirePermission('manage_settings'), (req, res) => {
  const { confirm } = req.body;
  if (confirm !== 'RESET') return res.status(400).json({ error: 'Type RESET to confirm' });
  db.prepare('DELETE FROM entries').run();
  logAudit({ userId: req.user.id, userName: req.user.name, action: 'reset_all_inventory', targetType: 'entries' });
  res.json({ ok: true });
});

// Audit log viewer — append-only trail of voids, refunds, setting changes, and resets.
router.get('/audit-log', requirePermission('view_reports'), (req, res) => {
  const { start, end, action } = req.query;
  let sql = 'SELECT * FROM audit_log WHERE 1=1';
  const params = [];
  if (start) { sql += ' AND date(created_at) >= date(?)'; params.push(start); }
  if (end) { sql += ' AND date(created_at) <= date(?)'; params.push(end); }
  if (action) { sql += ' AND action = ?'; params.push(action); }
  sql += ' ORDER BY created_at DESC LIMIT 500';
  const rows = db.prepare(sql).all(...params);
  res.json(rows.map(r => Object.assign({}, r, { details: r.details ? JSON.parse(r.details) : null })));
});

// Full database backup download — the whole SQLite file, since that's the entire
// system of record (inventory, sales, staff, everything) in one portable file.
router.get('/backup', requirePermission('export_data'), (req, res) => {
  const dbPath = process.env.DATABASE_PATH || path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'inventory.db');
  if (!fs.existsSync(dbPath)) return res.status(404).json({ error: 'Database file not found' });
  logAudit({ userId: req.user.id, userName: req.user.name, action: 'download_backup', targetType: 'database' });
  const stamp = new Date().toISOString().slice(0, 10);
  res.download(dbPath, `stock-ledger-backup-${stamp}.db`);
});

// Excel export — a human-readable spreadsheet of the core business data, opens
// cleanly in Excel or Google Sheets. Separate from the raw .db backup above,
// which is for restoring the app, not for reading in a spreadsheet.
router.get('/export-excel', requirePermission('export_data'), (req, res) => {
  const wb = XLSX.utils.book_new();

  // Inventory ledger
  const entries = db.prepare(`
    SELECT e.date, p.name AS product, e.type, e.qty, p.unit, e.reason, e.staff_name, e.created_at
    FROM entries e LEFT JOIN products p ON p.id = e.product_id
    ORDER BY e.date DESC, e.created_at DESC
  `).all();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(entries.map(e => ({
    Date: e.date, Product: e.product || 'Deleted product', Type: e.type, Qty: e.qty, Unit: e.unit || '',
    Reason: e.reason || '', 'Staff': e.staff_name, 'Logged at (UTC)': e.created_at
  }))), 'Inventory Ledger');

  // Products
  const products = db.prepare('SELECT * FROM products ORDER BY name COLLATE NOCASE').all();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(products.map(p => ({
    Name: p.name, Category: p.category || '', Unit: p.unit, 'Starting stock': p.initial_stock,
    'Reorder level': p.reorder_level === null ? '' : p.reorder_level, Barcode: p.barcode || '',
    Archived: p.archived ? 'Yes' : 'No'
  }))), 'Products');

  // Sales
  const sales = db.prepare('SELECT * FROM sales ORDER BY created_at DESC').all();
  const round2 = n => Math.round((n || 0) * 100) / 100;
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(sales.map(s => {
    let items = '';
    try { items = JSON.parse(s.items_json).map(i => `${i.name} x${i.qty}`).join(', '); } catch (e) { /* leave blank */ }
    return {
      Invoice: s.invoice_no || '', Date: s.date, Items: items, Subtotal: round2(s.subtotal), VAT: round2(s.vat_amount),
      Discount: round2(s.discount_amount), Total: round2(s.total), Payment: s.payment_method, 'Order type': s.order_type,
      Customer: s.customer_name || '', Cashier: s.cashier_name || '', Voided: s.voided ? 'Yes' : 'No',
      'Void reason': s.void_reason || '', 'Logged at (UTC)': s.created_at
    };
  })), 'Sales');

  // Time entries
  const timeEntries = db.prepare(`
    SELECT t.*, u.name AS staff_name FROM time_entries t LEFT JOIN users u ON u.id = t.user_id
    ORDER BY t.date DESC, t.clock_in DESC
  `).all();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(timeEntries.map(t => {
    let hours = '';
    if (t.clock_out) {
      const ms = new Date(t.clock_out.replace(' ', 'T') + 'Z') - new Date(t.clock_in.replace(' ', 'T') + 'Z');
      hours = Math.round((ms / 3600000) * 100) / 100;
    }
    return {
      Staff: t.staff_name || 'Unknown', Date: t.date, 'Clock in (UTC)': t.clock_in, 'Clock out (UTC)': t.clock_out || '',
      Hours: hours, Notes: t.notes || '', 'Edited by': t.edited_by || ''
    };
  })), 'Time Entries');

  // Team
  const users = db.prepare('SELECT * FROM users ORDER BY name COLLATE NOCASE').all();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(users.map(u => ({
    Name: u.name, Role: u.role, Position: u.position || '', Active: u.active ? 'Yes' : 'No',
    'Hourly rate': u.hourly_rate, Email: u.email || '', Contact: u.contact_number || '',
    'Date hired': u.date_hired || ''
  }))), 'Team');

  // Menu items
  const menuItems = db.prepare('SELECT * FROM menu_items ORDER BY category COLLATE NOCASE, name COLLATE NOCASE').all();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(menuItems.map(m => ({
    Name: m.name, Category: m.category || '', Price: m.price, Barcode: m.barcode || '', Archived: m.archived ? 'Yes' : 'No'
  }))), 'Menu Items');

  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  logAudit({ userId: req.user.id, userName: req.user.name, action: 'export_excel', targetType: 'database' });
  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="stock-ledger-export-${stamp}.xlsx"`);
  res.send(buffer);
});

// Logo upload — stored on the persistent volume (survives redeploys), swappable
// per deployment without touching any code, so this same app can be rebranded per client.
router.post('/logo', requirePermission('manage_settings'), uploadLogo.single('logo'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const old = db.prepare("SELECT value FROM settings WHERE key = 'logo_filename'").get();
  if (old && old.value) {
    fs.unlink(path.join(UPLOADS_DIR, old.value), () => {}); // best-effort cleanup of the previous logo
  }
  db.prepare(`
    INSERT INTO settings (key, value) VALUES ('logo_filename', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(req.file.filename);

  logAudit({ userId: req.user.id, userName: req.user.name, action: 'update_logo', targetType: 'settings' });
  res.json({ ok: true });
});

router.delete('/logo', requirePermission('manage_settings'), (req, res) => {
  const old = db.prepare("SELECT value FROM settings WHERE key = 'logo_filename'").get();
  if (old && old.value) {
    fs.unlink(path.join(UPLOADS_DIR, old.value), () => {});
  }
  db.prepare(`
    INSERT INTO settings (key, value) VALUES ('logo_filename', '')
    ON CONFLICT(key) DO UPDATE SET value = ''
  `).run();
  logAudit({ userId: req.user.id, userName: req.user.name, action: 'reset_logo', targetType: 'settings' });
  res.json({ ok: true });
});

module.exports = router;
