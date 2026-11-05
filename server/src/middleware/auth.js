'use strict';
const { E } = require('../utils/errors');

const ROLE_RANK = { staff: 1, manager: 2, admin: 3 };
const PERMISSION_COLUMNS = { can_skip_return: 1, can_cancel: 1, can_transfer: 1 };

function requireAuth(req, res, next) {
  if (!req.staff) return next(E.unauthenticated());
  const url = req.originalUrl.split('?')[0];
  if (req.staff.must_change_password && !url.startsWith('/api/auth/')) {
    const err = E.forbidden('Password change required');
    err.code = 'PASSWORD_CHANGE_REQUIRED';
    return next(err);
  }
  return next();
}

// requireRole('manager') => manager or admin (minimum role). Multiple args => minimum of the lowest.
function requireRole(...roles) {
  const min = Math.min(...roles.map((r) => ROLE_RANK[r] || 99));
  return [requireAuth, (req, res, next) => {
    if ((ROLE_RANK[req.staff.role] || 0) < min) return next(E.forbidden('Insufficient role'));
    return next();
  }];
}

// admin always passes; others need the staff flag (can_skip_return | can_cancel | can_transfer)
function requirePermission(permission) {
  if (!PERMISSION_COLUMNS[permission]) throw new Error(`Unknown permission: ${permission}`);
  return [requireAuth, (req, res, next) => {
    if (req.staff.role === 'admin' || req.staff[permission] === 1) return next();
    return next(E.forbidden(`Missing permission: ${permission}`));
  }];
}

// sets req.clinicId from the session; every query must use it (clinic isolation)
function clinicScope(req, res, next) {
  if (!req.staff) return next(E.unauthenticated());
  req.clinicId = req.staff.clinic_id;
  return next();
}

module.exports = { requireAuth, requireRole, requirePermission, clinicScope, ROLE_RANK };
