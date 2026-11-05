'use strict';
const crypto = require('crypto');
const { encrypt, decrypt } = require('./smsCrypto');
const q = require('../queueDb');

const MAX_PER_TICKET = 3;

function normalizePhone(input) {
  const s = String(input == null ? '' : input).replace(/[\s\-().]/g, '');
  const m = /^(\+|00)?(\d{8,15})$/.exec(s);
  if (!m) return null;
  return (m[1] ? '+' : '') + m[2];
}

function retentionDays(db, clinicId) {
  const r = db.prepare(`SELECT value FROM clinic_settings WHERE clinic_id=? AND key='sms_retention_days'`).get(clinicId);
  const n = r ? Number(r.value) : NaN;
  return Number.isFinite(n) && n >= 0 && n <= 365 ? n : 1; // الافتراضي يوم واحد (أقل احتفاظ ممكن)
}

function enqueue(db, { clinicId, ticketId, phone, body }) {
  const at = q.nowIso();
  const purgeAfter = new Date(q.now().getTime() + retentionDays(db, clinicId) * 86400000).toISOString();
  const r = db.prepare(`INSERT INTO sms_outbox (clinic_id, ticket_id, phone_encrypted, body, status, attempts, next_attempt_at, purge_after, created_at, updated_at)
    VALUES (?,?,?,?, 'pending', 0, ?, ?, ?, ?)`).run(clinicId, ticketId, encrypt(phone), body, at, purgeAfter, at, at);
  return r.lastInsertRowid;
}

function countForTicket(db, ticketId) {
  return db.prepare('SELECT COUNT(*) c FROM sms_outbox WHERE ticket_id=?').get(ticketId).c;
}

// هل آخر 4 أرقام تطابق هاتفاً أُرسلت له رسالة لهذه التذكرة (ما زال محفوظاً)؟
function phoneLast4Matches(db, ticketId, last4) {
  const rows = db.prepare(`SELECT phone_encrypted FROM sms_outbox WHERE ticket_id=? AND phone_encrypted<>''`).all(ticketId);
  const want = Buffer.from(String(last4));
  let ok = false;
  for (const r of rows) {
    try {
      const digits = decrypt(r.phone_encrypted).replace(/\D/g, '');
      const got = Buffer.from(digits.slice(-4).padStart(4, '0'));
      if (got.length === want.length && crypto.timingSafeEqual(got, want)) ok = true;
    } catch (_) { /* صف تالف: تجاهل */ }
  }
  return ok;
}

// حذف الأرقام بعد purge_after (الصف يبقى للتدقيق بلا رقم). المعلّق يصبح expired.
function purgeExpired(db) {
  const at = q.nowIso();
  return db.prepare(`UPDATE sms_outbox SET phone_encrypted='',
      status=CASE WHEN status='pending' THEN 'expired' ELSE status END, updated_at=?
    WHERE purge_after IS NOT NULL AND purge_after<=? AND phone_encrypted<>''`).run(at, at).changes;
}

module.exports = { normalizePhone, enqueue, countForTicket, phoneLast4Matches, purgeExpired, MAX_PER_TICKET, retentionDays };
