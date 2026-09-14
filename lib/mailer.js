const nodemailer = require('nodemailer');

let transporter = null;
let configured = false;

function getTransporter() {
  if (transporter) return transporter;
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    configured = false;
    return null;
  }
  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === 'true' || Number(SMTP_PORT) === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS }
  });
  configured = true;
  return transporter;
}

function isConfigured() {
  getTransporter();
  return configured;
}

// Returns { ok: true } | { ok: false, error, skipped } — never throws, so a failed
// email never breaks the thing that triggered it (e.g. sending a notice).
async function sendMail({ to, subject, text, attachmentPath, attachmentName, replyTo }) {
  const t = getTransporter();
  if (!t) return { ok: false, skipped: true, error: 'Email is not configured on this server.' };
  if (!to) return { ok: false, skipped: true, error: 'Recipient has no email address on file.' };

  try {
    const mail = {
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to,
      subject,
      text
    };
    if (replyTo) mail.replyTo = replyTo;
    if (attachmentPath) {
      mail.attachments = [{ filename: attachmentName || 'attachment', path: attachmentPath }];
    }
    await t.sendMail(mail);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message || 'Failed to send email' };
  }
}

module.exports = { sendMail, isConfigured };
