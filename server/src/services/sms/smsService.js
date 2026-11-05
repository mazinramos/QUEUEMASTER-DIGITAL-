'use strict';
// إدخال رسالة في sms_outbox. الإرسال الفعلي في smsWorker (فشله لا يؤثر على التذكرة أبداً).
const q = require('../queueDb');
const { QueueError } = require('../queueErrors');
const store = require('./smsStore');
const qr = require('../qr');

function smsEnabled(db, clinicId) {
  const r = db.prepare(`SELECT value FROM clinic_settings WHERE clinic_id=? AND key='sms_enabled'`).get(clinicId);
  return !!r && ['1', 'true'].includes(String(r.value).toLowerCase());
}

// نص الرسالة لا يحوي التوكن (الـ body مخزّن في DB والتوكن الخام ممنوع فيها).
// الاسترجاع لاحقاً: رقم التذكرة + آخر 4 أرقام من هذا الهاتف.
function buildBody(clinic, ticket, portal) {
  if (clinic.default_language === 'en') {
    return `${clinic.name_en || clinic.name_ar}: your ticket is ${ticket.display_number}. Track your turn: ${portal}`;
  }
  return `${clinic.name_ar}: رقم تذكرتك ${ticket.display_number}. تابع دورك: ${portal}`;
}

function queueTicketSms({ ticket, phone, baseUrl }) {
  const db = q.getDb();
  const unavailable = () => Object.assign(new QueueError('INTERNAL', 'SMS is not configured'), { status: 503 });
  if (!require('./smsCrypto').isConfigured()) throw unavailable();
  if (require('./index').providerName() === 'none') throw unavailable();
  const norm = store.normalizePhone(phone);
  if (!norm) throw new QueueError('VALIDATION', 'Invalid phone number');
  const clinic = db.prepare('SELECT * FROM clinics WHERE id=? AND is_active=1').get(ticket.clinic_id);
  if (!clinic || !smsEnabled(db, clinic.id)) throw new QueueError('FORBIDDEN', 'SMS is not enabled for this clinic');
  if (!['waiting', 'called', 'serving'].includes(ticket.status)) throw new QueueError('INVALID_TRANSITION', 'Ticket is no longer active');
  if (store.countForTicket(db, ticket.id) >= store.MAX_PER_TICKET) throw new QueueError('RATE_LIMITED', 'SMS limit reached for this ticket');
  const slug = db.prepare(`SELECT value FROM clinic_settings WHERE clinic_id=? AND key='slug'`).get(clinic.id);
  const multi = db.prepare('SELECT COUNT(*) n FROM clinics WHERE is_active=1').get().n > 1;
  const body = buildBody(clinic, ticket, qr.portalUrl(baseUrl, multi && slug ? slug.value : null));
  store.enqueue(db, { clinicId: clinic.id, ticketId: ticket.id, phone: norm, body });
  return { queued: true };
}

module.exports = { queueTicketSms, smsEnabled, buildBody };
