'use strict';
const { uuid, nowIso } = require('./queueDb');

// كلها تُستدعى داخل transaction الإجراء نفسه.

function addEvent(db, e) {
  const at = e.at || nowIso();
  db.prepare(`INSERT INTO ticket_events
    (event_uid, clinic_id, ticket_id, type, staff_id, counter_id, from_status, to_status, meta, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
    uuid(), e.clinicId, e.ticketId, e.type, e.staffId || null, e.counterId || null,
    e.from || null, e.to || null, e.meta ? JSON.stringify(e.meta) : null, at);
}

function addAudit(db, a) {
  db.prepare(`INSERT INTO audit_logs (clinic_id, staff_id, action, entity, entity_id, details, ip, created_at)
    VALUES (?,?,?,?,?,?,?,?)`).run(
    a.clinicId || null, a.staffId || null, a.action, a.entity || null,
    a.entityId == null ? null : String(a.entityId),
    a.details ? JSON.stringify(a.details) : null, a.ip || null, a.at || nowIso());
}

// UNIQUE(entity, entity_uid, created_at): إن تكرر نفس الميلي ثانية لنفس التذكرة نزيح 1ms
// ليبقى الترتيب محفوظاً بدل ضياع التحديث.
function enqueueSync(db, { clinicId, entity, entityUid, operation = 'upsert', payload, at }) {
  let t = new Date(at || nowIso());
  const last = db.prepare(
    'SELECT MAX(created_at) AS m FROM sync_outbox WHERE entity=? AND entity_uid=?').get(entity, entityUid);
  if (last && last.m && t.toISOString() <= last.m) t = new Date(new Date(last.m).getTime() + 1);
  db.prepare(`INSERT INTO sync_outbox (clinic_id, entity, entity_uid, operation, payload, status, created_at)
    VALUES (?,?,?,?,?, 'pending', ?)`).run(
    clinicId, entity, entityUid, operation, JSON.stringify(payload), t.toISOString());
}

// حمولة المزامنة: لا توكن ولا hash ولا هاتف.
function ticketSyncPayload(t, extra) {
  return Object.assign({
    publicId: t.public_id, clinicId: t.clinic_id, serviceId: t.service_id,
    businessDate: t.business_date, seq: t.seq_number, number: t.display_number,
    status: t.status, priority: t.priority, counterId: t.counter_id || null,
    issuedAt: t.issued_at, calledAt: t.called_at || null,
    servingAt: t.serving_at || null, completedAt: t.completed_at || null,
    updatedAt: t.updated_at,
  }, extra || {});
}

module.exports = { addEvent, addAudit, enqueueSync, ticketSyncPayload };
