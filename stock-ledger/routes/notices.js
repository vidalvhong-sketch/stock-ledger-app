const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { db, UPLOADS_DIR } = require('../db');
const { authRequired, adminRequired } = require('../middleware/auth');
const { requirePermission } = require('../lib/permissions');
const { sendMail, isConfigured } = require('../lib/mailer');
const { logAudit } = require('../lib/audit');

const router = express.Router();
router.use(authRequired);

const NOTICE_TYPES = ['schedule', 'contract', 'warning', 'penalty', 'memo'];

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => cb(null, uuidv4() + path.extname(file.originalname || ''))
  }),
  limits: { fileSize: 15 * 1024 * 1024 } // 15MB
});

function withAckInfo(notice, forUserId) {
  const acks = db.prepare('SELECT * FROM notice_acks WHERE notice_id = ?').all(notice.id);
  const myAck = acks.find(a => a.user_id === forUserId);
  let audienceCount = 1;
  if (notice.user_id === null) {
    audienceCount = db.prepare('SELECT COUNT(*) c FROM users WHERE active = 1').get().c;
  }
  return Object.assign({}, notice, {
    recipientName: notice.user_id ? (db.prepare('SELECT name FROM users WHERE id = ?').get(notice.user_id) || {}).name : 'All staff',
    ackCount: acks.length,
    audienceCount,
    myAcknowledgedAt: myAck ? myAck.acknowledged_at : null,
    hasAttachment: !!notice.attachment_stored_name,
    acks: acks.map(a => {
      const u = db.prepare('SELECT name FROM users WHERE id = ?').get(a.user_id);
      return { userName: u ? u.name : 'Unknown', acknowledgedAt: a.acknowledged_at };
    })
  });
}

router.get('/', (req, res) => {
  let rows;
  if (req.user.role === 'admin') {
    rows = db.prepare('SELECT * FROM notices ORDER BY created_at DESC').all();
  } else {
    rows = db.prepare('SELECT * FROM notices WHERE user_id = ? OR user_id IS NULL ORDER BY created_at DESC').all(req.user.id);
  }
  res.json(rows.map(n => withAckInfo(n, req.user.id)));
});

router.get('/email-status', requirePermission('manage_policies_notices'), (req, res) => {
  res.json({ configured: isConfigured() });
});

router.post('/', requirePermission('manage_policies_notices'), upload.single('attachment'), (req, res) => {
  const { type, title, body, userId, requiresAck, sendEmail } = req.body;
  if (!NOTICE_TYPES.includes(type)) return res.status(400).json({ error: 'Invalid notice type' });
  if (!title || !title.trim()) return res.status(400).json({ error: 'Title is required' });
  if (!body || !body.trim()) return res.status(400).json({ error: 'Message body is required' });

  const targetId = userId ? Number(userId) : null;
  if (targetId) {
    const u = db.prepare('SELECT id FROM users WHERE id = ?').get(targetId);
    if (!u) return res.status(404).json({ error: 'Recipient not found' });
  }

  const id = uuidv4();
  db.prepare(`
    INSERT INTO notices (id, type, title, body, user_id, requires_ack, issued_by, issued_by_id, attachment_filename, attachment_stored_name, attachment_mimetype)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    id, type, title.trim(), body.trim(), targetId, requiresAck === 'false' ? 0 : 1, req.user.name, req.user.id,
    req.file ? req.file.originalname : null,
    req.file ? req.file.filename : null,
    req.file ? req.file.mimetype : null
  );

  const wantsEmail = sendEmail !== 'false';
  if (wantsEmail) {
    sendNoticeEmails(id, targetId, type, title.trim(), body.trim(), req.file)
      .catch(() => { /* already logged inside */ });
  } else {
    db.prepare('UPDATE notices SET email_status = ? WHERE id = ?').run('not_requested', id);
  }

  const recipientLabel = targetId ? (db.prepare('SELECT name FROM users WHERE id = ?').get(targetId) || {}).name : 'all staff';
  logAudit({ userId: req.user.id, userName: req.user.name, action: 'create_notice', targetType: 'notice', targetId: id, details: { type, title: title.trim(), recipient: recipientLabel } });
  res.json(withAckInfo(db.prepare('SELECT * FROM notices WHERE id = ?').get(id), req.user.id));
});

async function sendNoticeEmails(noticeId, targetId, type, title, body, file) {
  if (!isConfigured()) {
    db.prepare('UPDATE notices SET email_status = ?, email_error = ? WHERE id = ?')
      .run('not_configured', 'No SMTP settings configured on this server.', noticeId);
    return;
  }

  const recipients = targetId
    ? [db.prepare('SELECT id, name, email FROM users WHERE id = ?').get(targetId)]
    : db.prepare('SELECT id, name, email FROM users WHERE active = 1').all();

  const withEmail = recipients.filter(r => r && r.email);
  if (withEmail.length === 0) {
    db.prepare('UPDATE notices SET email_status = ?, email_error = ? WHERE id = ?')
      .run('skipped', 'No email address on file for the recipient(s).', noticeId);
    return;
  }

  const attachmentPath = file ? file.path : null;
  const attachmentName = file ? file.originalname : null;
  const typeLabels = { schedule: 'Schedule', contract: 'Contract', warning: 'Warning', penalty: 'Penalty', memo: 'Memo' };
  const subject = `[${typeLabels[type] || type}] ${title}`;
  const replyToRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('notice_reply_to');
  const replyTo = (replyToRow && replyToRow.value) ? replyToRow.value : undefined;

  let sentCount = 0;
  let lastError = null;
  for (const r of withEmail) {
    const result = await sendMail({
      to: r.email,
      subject,
      text: `${body}\n\n— Sent via Stock Ledger`,
      attachmentPath,
      replyTo,
      attachmentName
    });
    if (result.ok) sentCount++;
    else lastError = result.error;
  }

  const status = sentCount === withEmail.length ? 'sent' : sentCount > 0 ? 'partial' : 'failed';
  db.prepare('UPDATE notices SET email_status = ?, email_error = ? WHERE id = ?').run(status, lastError, noticeId);
}

router.post('/:id/acknowledge', (req, res) => {
  const notice = db.prepare('SELECT * FROM notices WHERE id = ?').get(req.params.id);
  if (!notice) return res.status(404).json({ error: 'Notice not found' });
  if (notice.user_id && notice.user_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'This notice is not addressed to you' });
  }
  const existing = db.prepare('SELECT id FROM notice_acks WHERE notice_id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!existing) {
    db.prepare('INSERT INTO notice_acks (id, notice_id, user_id) VALUES (?,?,?)').run(uuidv4(), req.params.id, req.user.id);
  }
  res.json(withAckInfo(db.prepare('SELECT * FROM notices WHERE id = ?').get(req.params.id), req.user.id));
});

router.get('/:id/attachment', (req, res) => {
  const notice = db.prepare('SELECT * FROM notices WHERE id = ?').get(req.params.id);
  if (!notice || !notice.attachment_stored_name) return res.status(404).json({ error: 'No attachment' });
  if (notice.user_id && notice.user_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Not authorized' });
  }
  const filePath = path.join(UPLOADS_DIR, notice.attachment_stored_name);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File no longer available' });
  res.download(filePath, notice.attachment_filename || 'attachment');
});

router.delete('/:id', requirePermission('manage_policies_notices'), (req, res) => {
  const notice = db.prepare('SELECT * FROM notices WHERE id = ?').get(req.params.id);
  if (!notice) return res.status(404).json({ error: 'Notice not found' });
  if (notice.attachment_stored_name) {
    const filePath = path.join(UPLOADS_DIR, notice.attachment_stored_name);
    fs.unlink(filePath, () => {});
  }
  db.prepare('DELETE FROM notice_acks WHERE notice_id = ?').run(req.params.id);
  db.prepare('DELETE FROM notices WHERE id = ?').run(req.params.id);
  logAudit({ userId: req.user.id, userName: req.user.name, action: 'delete_notice', targetType: 'notice', targetId: req.params.id, details: { type: notice.type, title: notice.title } });
  res.json({ ok: true });
});

module.exports = router;
