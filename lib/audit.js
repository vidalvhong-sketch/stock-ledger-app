const { v4: uuidv4 } = require('uuid');
const { db } = require('../db');

// Records an audit entry. Never throws — a logging failure should never block
// the actual action (a void/refund/setting-change) from completing.
function logAudit({ userId, userName, action, targetType, targetId, details }) {
  try {
    db.prepare(`
      INSERT INTO audit_log (id, user_id, user_name, action, target_type, target_id, details)
      VALUES (?,?,?,?,?,?,?)
    `).run(
      uuidv4(),
      userId || null,
      userName || null,
      action,
      targetType || null,
      targetId || null,
      details ? JSON.stringify(details) : null
    );
  } catch (err) {
    console.error('Audit log write failed:', err.message);
  }
}

module.exports = { logAudit };
