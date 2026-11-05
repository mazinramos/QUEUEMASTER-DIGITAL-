'use strict';
const { requireAuth, requireRole, requirePermission, clinicScope } = require('./auth');
const { validate } = require('./validate');
const { auditLog, writeAudit } = require('./audit');
module.exports = { requireAuth, requireRole, requirePermission, validate, clinicScope, auditLog, writeAudit };
