'use strict';
const q = require('./queueDb');
const { QueueError } = require('./queueErrors');
const ev = require('./ticketEvents');
const stats = require('./queueStats');
const bus = require('./queueBus');

// ---------- مساعدات العيادة/الخدمة ----------
function getClinic(db, clinicId) {
  const c = db.prepare('SELECT * FROM clinics WHERE id=? AND is_active=1').get(clinicId);
  if (!c) throw new QueueError('NOT_FOUND', 'Clinic not found');
  return c;
}

function todayFor(clinic) { return q.businessDate(q.now(), clinic.timezone); }

// يحدد العيادة للمسارات العامة: slug (clinic_settings.slug) أو id رقمي أو العيادة الوحيدة.
function resolveClinic(db, param) {
  if (param != null && String(param).trim() !== '') {
    const p = String(param).trim();
    const bySlug = db.prepare(`SELECT c.* FROM clinics c JOIN clinic_settings s ON s.clinic_id=c.id AND s.key='slug'
      WHERE s.value=? AND c.is_active=1`).get(p);
    if (bySlug) return bySlug;
    if (/^\d+$/.test(p)) {
      const byId = db.prepare('SELECT * FROM clinics WHERE id=? AND is_active=1').get(Number(p));
      if (byId) return byId;
    }
    throw new QueueError('NOT_FOUND', 'Clinic not found');
  }
  const all = db.prepare('SELECT * FROM clinics WHERE is_active=1 ORDER BY id LIMIT 2').all();
  if (all.length === 1) return all[0];
  if (all.length === 0) throw new QueueError('NOT_FOUND', 'No active clinic');
  throw new QueueError('VALIDATION', 'clinic is required (multiple clinics)');
}

function findServiceByKey(db, clinicId, key) {
  const rows = db.prepare('SELECT * FROM services WHERE clinic_id=? AND is_active=1').all(clinicId);
  return rows.find((s) => q.serviceKey(s.id) === key) || null;
}

// يزيد التسلسل اليومي ذرياً (يُستدعى داخل transaction ممسوكة بـ IMMEDIATE).
function nextSequence(db, clinicId, serviceId, bdate) {
  return db.prepare(`INSERT INTO daily_sequences (clinic_id, service_id, business_date, last_number)
    VALUES (?,?,?,1)
    ON CONFLICT (clinic_id, service_id, business_date) DO UPDATE SET last_number = last_number + 1
    RETURNING last_number`).get(clinicId, serviceId, bdate).last_number;
}

// ---------- إصدار تذكرة ----------
function issueTicket({ clinicId, serviceId, serviceKey, priority = 0 }) {
  const db = q.getDb();
  const out = db.transaction(() => {
    const clinic = getClinic(db, clinicId);
    const svc = serviceKey != null
      ? findServiceByKey(db, clinicId, serviceKey)
      : db.prepare('SELECT * FROM services WHERE id=? AND clinic_id=? AND is_active=1').get(serviceId, clinicId);
    if (!svc) throw new QueueError('NOT_FOUND', 'Service not found');

    const nowD = q.now();
    const at = nowD.toISOString();
    const bdate = q.businessDate(nowD, clinic.timezone);
    const seq = nextSequence(db, clinicId, svc.id, bdate);
    const display = `${svc.prefix}-${q.pad(seq)}`;
    const token = q.newToken();
    const publicId = q.newPublicId();

    const info = db.prepare(`INSERT INTO tickets
      (public_id, clinic_id, service_id, business_date, seq_number, display_number, token_hash, status, priority,
       issued_at, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?, 'waiting', ?, ?,?,?)`).run(
      publicId, clinicId, svc.id, bdate, seq, display, q.hashToken(token), priority | 0, at, at, at);
    const t = db.prepare('SELECT * FROM tickets WHERE id=?').get(info.lastInsertRowid);

    ev.addEvent(db, { clinicId, ticketId: t.id, type: 'created', to: 'waiting', at, meta: { number: display } });
    ev.enqueueSync(db, { clinicId, entity: 'ticket', entityUid: publicId, payload: ev.ticketSyncPayload(t), at });

    const ahead = stats.aheadOf(db, t);
    return {
      token,
      ticket: {
        number: t.display_number, serviceName: svc.name_ar, serviceNameEn: svc.name_en || null,
        issuedAt: t.issued_at, status: t.status, ahead, estimatedWaitMin: stats.estimateWaitMin(db, t, ahead),
      },
      _internal: { clinic, publicId, brief: stats.brief(db, t), bdate },
    };
  }).immediate();

  // بعد commit فقط
  publishCreated(out._internal);
  const { _internal, ...result } = out;
  return result;
}

function publishCreated({ clinic, publicId, brief, bdate }) {
  bus.publish({ clinicId: clinic.id, event: 'ticket:created', rooms: ['staff', 'display'], ticketPublicId: publicId, data: { ticket: brief } });
  publishQueueUpdated(clinic.id);
}

function publishQueueUpdated(clinicId) {
  const db = q.getDb();
  const clinic = db.prepare('SELECT * FROM clinics WHERE id=?').get(clinicId);
  if (!clinic) return;
  const snap = stats.snapshot(db, clinic, q.serviceKey, todayFor(clinic));
  bus.publish({ clinicId, event: 'queue:updated', rooms: ['staff', 'display'], data: snap });
}

// ---------- قراءة بالتوكن (المريض) ----------
function getTicketByToken(token) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 100) throw new QueueError('NOT_FOUND', 'Ticket not found');
  const db = q.getDb();
  const t = db.prepare('SELECT * FROM tickets WHERE token_hash=?').get(q.hashToken(token));
  if (!t) throw new QueueError('NOT_FOUND', 'Ticket not found');
  return t;
}

function publicStatus(token) {
  const db = q.getDb();
  const t = getTicketByToken(token);
  const clinic = db.prepare('SELECT * FROM clinics WHERE id=?').get(t.clinic_id);
  const svc = stats.serviceOf(db, t);
  const active = ['waiting', 'called', 'serving'].includes(t.status);
  // تذكرة من يوم سابق ما زالت نشطة: حالة افتراضية "expired" للعرض فقط (لا تُنادى أبداً)
  const expired = active && clinic && t.business_date !== todayFor(clinic);
  const ahead = expired ? 0 : stats.aheadOf(db, t);
  const c = stats.counterOf(db, t.counter_id);
  return {
    number: t.display_number,
    service: svc ? { ar: svc.name_ar, en: svc.name_en || null } : null,
    status: expired ? 'expired' : t.status,
    ahead,
    estimatedWaitMin: expired || t.status !== 'waiting' ? null : stats.estimateWaitMin(db, t, ahead),
    counter: t.status === 'called' || t.status === 'serving' ? stats.counterBrief(c) : null,
    issuedAt: t.issued_at,
    _publicId: t.public_id,
  };
}

// ---------- استرجاع التذكرة (آمن) ----------
// التوكن الخام غير قابل للاسترجاع (نخزن hash فقط). الاسترجاع = تدوير التوكن (الجديد يلغي القديم).
// الشروط: ticket_recovery_enabled، تطابق آخر 4 أرقام من هاتف أُرسلت له SMS لهذه التذكرة (ما زال محفوظاً)،
// ورسالة خطأ موحدة NOT_FOUND في كل حالات الفشل (لا تسريب لوجود التذكرة). المعدّل يحدّه الراوتر.
function recoverTicket({ clinicId, number, phoneLast4 }) {
  const db = q.getDb();
  const fail = () => new QueueError('NOT_FOUND', 'Ticket not found');
  if (!/^\d{4}$/.test(String(phoneLast4 || ''))) throw fail();
  const clinic = getClinic(db, clinicId);
  const enabled = db.prepare(`SELECT value FROM clinic_settings WHERE clinic_id=? AND key='ticket_recovery_enabled'`).get(clinicId);
  if (!enabled || !['1', 'true'].includes(String(enabled.value).toLowerCase())) throw fail();
  const norm = normalizeNumber(number);
  if (!norm) throw fail();
  const bdate = todayFor(clinic);
  const sms = require('./sms/smsStore');
  return db.transaction(() => {
    const t = db.prepare(`SELECT * FROM tickets WHERE clinic_id=? AND business_date=? AND display_number=?
      AND status IN ('waiting','called','serving')`).get(clinicId, bdate, norm);
    if (!t) throw fail();
    if (!sms.phoneLast4Matches(db, t.id, String(phoneLast4))) throw fail();
    const token = q.newToken();
    const at = q.nowIso();
    db.prepare('UPDATE tickets SET token_hash=?, updated_at=? WHERE id=?').run(q.hashToken(token), at, t.id);
    ev.addEvent(db, { clinicId, ticketId: t.id, type: 'recovered', at, meta: {} });
    ev.addAudit(db, { clinicId, action: 'ticket.recover', entity: 'ticket', entityId: t.public_id, at });
    return { token };
  }).immediate();
}

function normalizeNumber(input) {
  const m = /^\s*([A-Za-z]{1,3})\s*-?\s*(\d{1,4})\s*$/.exec(String(input || ''));
  if (!m) return null;
  return `${m[1].toUpperCase()}-${q.pad(Number(m[2]))}`;
}

module.exports = {
  issueTicket, publicStatus, getTicketByToken, recoverTicket, normalizeNumber,
  resolveClinic, getClinic, todayFor, findServiceByKey, nextSequence, publishQueueUpdated,
};
