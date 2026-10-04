const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { db, UPLOADS_DIR } = require('../db');
const { authRequired, adminRequired } = require('../middleware/auth');
const { logAudit } = require('../lib/audit');

const router = express.Router();
router.use(authRequired, adminRequired); // HR documents are sensitive — admin only, no public access

const DOC_TYPES = ['photo', 'nbi', 'police', 'barangay'];

const uploadDoc = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => cb(null, 'staffdoc-' + uuidv4() + path.extname(file.originalname || ''))
  }),
  limits: { fileSize: 8 * 1024 * 1024 }, // 8MB — enough for a scanned clearance document
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/') && file.mimetype !== 'application/pdf') {
      return cb(new Error('Only images or PDFs are allowed'));
    }
    cb(null, true);
  }
});

router.get('/:userId', (req, res) => {
  const rows = db.prepare('SELECT * FROM staff_documents WHERE user_id = ?').all(req.params.userId);
  const byType = {};
  rows.forEach(r => { byType[r.doc_type] = r; });
  res.json(byType);
});

router.post('/:userId/:docType', uploadDoc.single('file'), (req, res) => {
  if (!DOC_TYPES.includes(req.params.docType)) return res.status(400).json({ error: 'Invalid document type' });
  const user = db.prepare('SELECT id, name FROM users WHERE id = ?').get(req.params.userId);
  if (!user) return res.status(404).json({ error: 'Staff member not found' });
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const existing = db.prepare('SELECT * FROM staff_documents WHERE user_id = ? AND doc_type = ?').get(req.params.userId, req.params.docType);
  if (existing) {
    fs.unlink(path.join(UPLOADS_DIR, existing.stored_filename), () => {});
    db.prepare('DELETE FROM staff_documents WHERE id = ?').run(existing.id);
  }

  const id = uuidv4();
  db.prepare(`
    INSERT INTO staff_documents (id, user_id, doc_type, original_filename, stored_filename, mimetype, uploaded_by)
    VALUES (?,?,?,?,?,?,?)
  `).run(id, req.params.userId, req.params.docType, req.file.originalname, req.file.filename, req.file.mimetype, req.user.name);

  logAudit({
    userId: req.user.id, userName: req.user.name, action: 'upload_staff_document',
    targetType: 'user', targetId: String(req.params.userId),
    details: { staffName: user.name, docType: req.params.docType }
  });

  res.json(db.prepare('SELECT * FROM staff_documents WHERE id = ?').get(id));
});

router.get('/:userId/:docType/file', (req, res) => {
  const doc = db.prepare('SELECT * FROM staff_documents WHERE user_id = ? AND doc_type = ?').get(req.params.userId, req.params.docType);
  if (!doc) return res.status(404).json({ error: 'No document on file' });
  const filePath = path.join(UPLOADS_DIR, doc.stored_filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File no longer available' });
  res.download(filePath, doc.original_filename || 'document');
});

router.delete('/:userId/:docType', (req, res) => {
  const doc = db.prepare('SELECT * FROM staff_documents WHERE user_id = ? AND doc_type = ?').get(req.params.userId, req.params.docType);
  if (!doc) return res.status(404).json({ error: 'No document on file' });
  fs.unlink(path.join(UPLOADS_DIR, doc.stored_filename), () => {});
  db.prepare('DELETE FROM staff_documents WHERE id = ?').run(doc.id);
  res.json({ ok: true });
});

module.exports = router;
