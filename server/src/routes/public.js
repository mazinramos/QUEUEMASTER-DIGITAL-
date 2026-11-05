'use strict';
// مسارات المريض (عامة، بدون جلسة) — api-contract.md  [ح2]
const express = require('express');
const T = require('../services/ticketService');
const qr = require('../services/qr');
const q = require('../services/queueDb');
const stats = require('../services/queueStats');
const { QueueError, sendError } = require('../services/queueErrors');
const { createLimiter } = require('../services/queueRateLimit');

const router = express.Router();
router.use(express.json({ limit: '10kb' }));
router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

const ip = (req) => req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
const issueLimit = createLimiter({ windowMs: 10 * 60 * 1000, max: Number(process.env.TICKET_ISSUE_MAX_PER_10MIN) || 20, keyFn: (r) => `issue:${ip(r)}` });
const recoverLimit = createLimiter({ windowMs: 15 * 60 * 1000, max: 5, keyFn: (r) => `rec:${ip(r)}:${String((r.body && r.body.number) || '').toUpperCase()}` });
const recoverIpLimit = createLimiter({ windowMs: 15 * 60 * 1000, max: 30, keyFn: (r) => `recip:${ip(r)}` });
const smsLimit = createLimiter({ windowMs: 10 * 60 * 1000, max: 5, keyFn: (r) => `sms:${ip(r)}` });
router._limiters = { issueLimit, recoverLimit, recoverIpLimit, smsLimit };

const wrap = (fn) => async (req, res) => {
  try { await fn(req, res); } catch (e) { sendError(res, e); }
};
const ok = (res, data, status = 200) => res.status(status).json({ ok: true, data });

function clinicFrom(req) {
  return T.resolveClinic(q.getDb(), (req.query && req.query.clinic) || (req.body && req.body.clinic));
}

// GET /api/public/clinic
router.get('/clinic', wrap((req, res) => {
  const db = q.getDb();
  const c = clinicFrom(req);
  const today = T.todayFor(c);
  const services = db.prepare('SELECT * FROM services WHERE clinic_id=? AND is_active=1 ORDER BY display_order, id').all(c.id).map((s) => ({
    key: q.serviceKey(s.id), id: q.serviceKey(s.id), // id = المفتاح العام (ليس رقم DB)
    name_ar: s.name_ar, name_en: s.name_en || null, prefix: s.prefix,
    waiting: db.prepare(`SELECT COUNT(*) AS c FROM tickets WHERE clinic_id=? AND service_id=? AND business_date=? AND status='waiting'`).get(c.id, s.id, today).c,
  }));
  const path = require('path');
  ok(res, {
    name_ar: c.name_ar, name_en: c.name_en || null,
    logoUrl: c.logo_path ? `/media/${path.basename(c.logo_path)}` : null,
    language: c.default_language, services,
  });
}));

// POST /api/public/tickets { serviceKey }
router.post('/tickets', issueLimit, wrap((req, res) => {
  const b = req.body || {};
  if (typeof b.serviceKey !== 'string' || !b.serviceKey || b.serviceKey.length > 64) throw new QueueError('VALIDATION', 'serviceKey is required');
  const c = clinicFrom(req);
  const r = T.issueTicket({ clinicId: c.id, serviceKey: b.serviceKey });
  ok(res, r, 201);
}));

// POST /api/public/tickets/recover { number, phoneLast4 }  (قبل :token حتى لا يُلتقط كتوكن)
router.post('/tickets/recover', recoverIpLimit, recoverLimit, wrap((req, res) => {
  const b = req.body || {};
  const c = clinicFrom(req);
  ok(res, T.recoverTicket({ clinicId: c.id, number: b.number, phoneLast4: b.phoneLast4 }));
}));

// GET /api/public/tickets/:token
router.get('/tickets/:token', wrap((req, res) => {
  const { _publicId, ...data } = T.publicStatus(req.params.token);
  ok(res, data);
}));

// GET /api/public/tickets/:token/qr.svg  (إضافة مقترحة للعقد)
router.get('/tickets/:token/qr.svg', wrap(async (req, res) => {
  T.getTicketByToken(req.params.token); // يتحقق من وجودها
  const svg = await qr.toSvg(qr.ticketUrl(qr.baseUrl(req), req.params.token));
  res.type('image/svg+xml').send(svg);
}));

// POST /api/public/tickets/:token/sms { phone }
router.post('/tickets/:token/sms', smsLimit, wrap((req, res) => {
  let sms;
  try { sms = require('../services/sms/smsService'); } catch (e) {
    if (e.code !== 'MODULE_NOT_FOUND') throw e;
    throw Object.assign(new QueueError('INTERNAL', 'SMS is not available'), { status: 501 });
  }
  const t = T.getTicketByToken(req.params.token);
  const b = req.body || {};
  ok(res, sms.queueTicketSms({ ticket: t, phone: b.phone, baseUrl: qr.baseUrl(req), token: req.params.token }), 202);
}));

// QR العيادة
router.get('/qr/portal.svg', wrap(async (req, res) => {
  const db = q.getDb();
  const c = clinicFrom(req);
  const slug = db.prepare(`SELECT value FROM clinic_settings WHERE clinic_id=? AND key='slug'`).get(c.id);
  const multi = db.prepare('SELECT COUNT(*) AS n FROM clinics WHERE is_active=1').get().n > 1;
  const svg = await qr.toSvg(qr.portalUrl(qr.baseUrl(req), multi && slug ? slug.value : null));
  res.type('image/svg+xml').send(svg);
}));

router.get('/qr/wifi.svg', wrap(async (req, res) => {
  const db = q.getDb();
  const c = clinicFrom(req);
  const get = (k) => { const r = db.prepare('SELECT value FROM clinic_settings WHERE clinic_id=? AND key=?').get(c.id, k); return r ? r.value : null; };
  const ssid = get('wifi_ssid');
  if (!ssid) throw new QueueError('NOT_FOUND', 'Wi-Fi is not configured');
  const svg = await qr.toSvg(qr.wifiString({ ssid, password: get('wifi_password'), type: get('wifi_type') || 'WPA', hidden: get('wifi_hidden') === '1' }));
  res.type('image/svg+xml').send(svg);
}));

module.exports = { path: '/api/public', router };
