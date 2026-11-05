'use strict';
const { getDb, nowIso } = require('../database');

const SENSITIVE = /pass|token|secret|hash/i;
function scrub(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = Array.isArray(obj) ? [] : {};
  for (const [k, v] of Object.entries(obj)) out[k] = SENSITIVE.test(k) ? '[redacted]' : scrub(v);
  return out;
}

// writeAudit(req, action, entity, entityId, details, {clinicId, staffId})
function writeAudit(req, action, entity = null, entityId = null, details = null, over = {}) {
  const clinicId = over.clinicId !== undefined ? over.clinicId : (req.staff ? req.staff.clinic_id : null);
  const staffId = over.staffId !== undefined ? over.staffId : (req.staff ? req.staff.id : null);
  getDb().prepare(
    `INSERT INTO audit_logs (clinic_id, staff_id, action, entity, entity_id, details, ip, created_at)
     VALUES (?,?,?,?,?,?,?,?)`
  ).run(clinicId, staffId, action, entity, entityId == null ? null : String(entityId),
    details == null ? null : JSON.stringify(scrub(details)), req.ip || null, nowIso());
}

// middleware form: logs after a successful (2xx) response
function auditLog(action, entity, idFrom = (req, res) => res.locals.auditEntityId) {
  return (req, res, next) => {
    res.on('finish', () => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        try { writeAudit(req, action, entity, idFrom(req, res) ?? req.params.id ?? null, res.locals.auditDetails || null); }
        catch (e) { console.error('[audit] failed', e.message); }
      }
    });
    next();
  };
}

module.exports = { writeAudit, auditLog };
