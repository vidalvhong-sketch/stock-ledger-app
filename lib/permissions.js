// The full set of individually-toggleable capabilities a Manager can be granted.
// Each key is what's stored (as a JSON object of booleans) in users.manager_permissions.
const PERMISSIONS = [
  { key: 'manage_team', label: 'Manage team (add/edit/remove Staff and Team Leads)' },
  { key: 'manage_menu', label: 'Manage menu (items, recipes, variants, modifiers)' },
  { key: 'manage_inventory', label: 'Manage inventory (products, entries)' },
  { key: 'manage_schedule', label: 'Manage schedule (shifts)' },
  { key: 'manage_policies_notices', label: 'Manage policies & notices' },
  { key: 'approve_discounts_refunds_voids', label: 'Approve discount/refund/void requests' },
  { key: 'approve_leave_availability', label: 'Approve leave & availability requests' },
  { key: 'review_schedule_exceptions', label: 'Review late/no-shift exceptions' },
  { key: 'view_payroll', label: 'View payroll' },
  { key: 'view_reports', label: 'View reports, audit log, and shift history' },
  { key: 'manage_settings', label: 'Manage business settings & branding' },
  { key: 'export_data', label: 'Export data & download backups' }
];
const PERMISSION_KEYS = PERMISSIONS.map(p => p.key);

function parsePermissions(json) {
  if (!json) return {};
  try {
    const parsed = JSON.parse(json);
    const clean = {};
    PERMISSION_KEYS.forEach(k => { clean[k] = !!parsed[k]; });
    return clean;
  } catch (e) { return {}; }
}

// Always re-reads role + permissions fresh from the database by user id — a
// JWT can stay valid for 12 hours, and a permission an admin just revoked
// must stop working immediately, not whenever that token happens to expire.
function hasPermission(db, userId, key) {
  if (!userId) return false;
  const row = db.prepare('SELECT role, manager_permissions FROM users WHERE id = ? AND active = 1').get(userId);
  if (!row) return false;
  if (row.role === 'admin') return true;
  if (row.role !== 'manager') return false;
  return !!parsePermissions(row.manager_permissions)[key];
}

// Express middleware factory — admin always passes; a manager passes only if
// currently granted this specific permission (checked live, not from the JWT);
// everyone else is rejected.
function requirePermission(key) {
  return (req, res, next) => {
    const { db } = require('../db');
    if (hasPermission(db, req.user && req.user.id, key)) return next();
    res.status(403).json({ error: 'You do not have access to this.' });
  };
}

module.exports = { PERMISSIONS, PERMISSION_KEYS, parsePermissions, hasPermission, requirePermission };
