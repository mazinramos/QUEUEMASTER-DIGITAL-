'use strict';
/**
 * مسارات الشاشة (حساب 4):
 *   POST /api/display/pair          إقران الشاشة بالكود -> كوكي qm.display
 *   GET  /api/display/bootstrap     حالة أول تحميل/إعادة الاتصال
 *   GET/POST /api/admin/displays    إدارة الشاشات (أدمن)
 *   PUT  /api/admin/displays/:id/settings
 *   GET  /media/:file, /media/audio/:lang/:file
 * يصدّر { path:'/', router } ليحمّله app.js تلقائياً (المسارات كاملة داخل الراوتر).
 */
const express = require('express');
const { z } = require('zod');
const svc = require('../services/displayService');
const { createMediaHandlers } = require('../services/displayMedia');

const ok = (res, data, status = 200) => res.status(status).json({ ok: true, data });
const fail = (res, status, code, message) => res.status(status).json({ ok: false, error: { code, message } });

/* ---------- الاعتماديات (قابلة للحقن للاختبار) ---------- */
function resolveDb() {
  const m = require('../database'); // حساب 1: better-sqlite3 instance
  const db = (typeof m.getDb === 'function' && m.getDb()) || m.db || m;
  if (!db || typeof db.prepare !== 'function') throw new Error('database module لا يعيد better-sqlite3 instance');
  return db;
}
/** بث لغرفة شاشات العيادة عبر واجهة حساب 2 (الغلاف eventId/ts/clinicId يضيفه هو). */
function resolveEmit() {
  try {
    const s = require('../sockets');
    if (typeof s.emitToDisplays === 'function') return (clinicId, ev, payload) => s.emitToDisplays(clinicId, ev, payload);
    if (typeof s.emitToRoom === 'function') return (clinicId, ev, payload) => s.emitToRoom(`clinic:${clinicId}:display`, ev, payload, clinicId);
  } catch { /* لم يجهز بعد */ }
  return null;
}
/** middleware حساب 1 الحقيقي (requireRole('admin') = requireAuth + رتبة)؛ null إن لم يتوفر. */
function loadAdminChain() {
  try { const m = require('../middleware'); const c = m.requireRole('admin'); return Array.isArray(c) ? c : [c]; } catch { return null; }
}
function runChain(chain, req, res, next) {
  let i = 0;
  const step = (err) => { if (err) return next(err); const fn = chain[i++]; return fn ? fn(req, res, step) : next(); };
  step();
}
/** الموظف الحالي كما يضعه middleware حساب 1 (req.staff أو req.user أو req.session.staff). */
function currentStaff(req) {
  const s = req.staff || req.user || (req.session && req.session.staff) || null;
  if (!s) return null;
  return { id: s.id, role: s.role, clinicId: s.clinicId != null ? s.clinicId : s.clinic_id };
}

const settingsSchema = z.object({
  announce_lang: z.enum(['ar', 'en', 'both']),
  audio_enabled: z.boolean(),
  volume: z.number().min(0).max(1),
  speech_rate: z.number().min(0.5).max(2),
  speech_pitch: z.number().min(0).max(2),
  repeat_count: z.number().int().min(1).max(5),
  repeat_delay_ms: z.number().int().min(0).max(30000),
}).partial().strict();
const createSchema = z.object({ name: z.string().trim().min(1).max(80), settings: settingsSchema.optional() }).strict();
const updateSchema = z.object({ name: z.string().trim().min(1).max(80).optional(), is_active: z.boolean().optional() }).strict();

function secureCookie(req) {
  try { const c = require('../config'); if (c.session && typeof c.session.secureCookie === 'boolean') return c.session.secureCookie; } catch { /* اختبارات معزولة */ }
  return !!req.secure;
}

function createDisplayRouter(deps = {}) {
  const getDb = deps.getDb || resolveDb;
  const getEmit = deps.emit !== undefined ? () => deps.emit : resolveEmit;
  const getStaff = deps.getStaff || currentStaff;
  const secret = deps.secret; // اختياري؛ الافتراضي من البيئة
  const media = createMediaHandlers(deps.getUploadsDir || (() => { try { return require('../config').uploadsDir; } catch { return undefined; } }));
  const router = express.Router();
  const json = express.json({ limit: '16kb' });

  const withDb = (fn) => (req, res, next) => {
    let db;
    try { db = getDb(); } catch (e) { return fail(res, 503, 'UNAVAILABLE', 'قاعدة البيانات غير جاهزة'); }
    svc.setAuditIp(req.ip);
    try { return fn(req, res, db); } catch (e) { return next(e); }
  };

  /* ---- محدد معدل محاولات الإقران (ذاكرة، لكل IP) ---- */
  const attempts = new Map();
  const LIMIT = deps.pairLimit || 10; const WINDOW = deps.pairWindowMs || 10 * 60 * 1000;
  const tooMany = (ip) => {
    const now = Date.now(); const a = (attempts.get(ip) || []).filter((t) => now - t < WINDOW);
    attempts.set(ip, a); return a.length >= LIMIT;
  };
  const noteFail = (ip) => { const a = attempts.get(ip) || []; a.push(Date.now()); attempts.set(ip, a); };

  /* ---- عام: الإقران والـ bootstrap ---- */
  router.post('/api/display/pair', json, withDb((req, res, db) => {
    const ip = req.ip || 'unknown';
    if (tooMany(ip)) return fail(res, 429, 'RATE_LIMITED', 'محاولات كثيرة، حاول لاحقاً');
    const code = req.body && req.body.code;
    if (typeof code !== 'string' || code.length > 32) return fail(res, 400, 'VALIDATION', 'الكود مطلوب');
    const display = svc.findDisplayByCode(db, code);
    if (!display) { noteFail(ip); return fail(res, 404, 'NOT_FOUND', 'كود الإقران غير صحيح'); }
    attempts.delete(ip);
    res.cookie(svc.COOKIE_NAME, svc.makeCookieValue(display, secret), {
      httpOnly: true, sameSite: 'lax', secure: secureCookie(req), path: '/', maxAge: 365 * 24 * 3600 * 1000,
    });
    const clinic = db.prepare('SELECT name_ar, name_en FROM clinics WHERE id = ?').get(display.clinic_id);
    res.setHeader('Cache-Control', 'no-store');
    return ok(res, { display: { id: display.id, name: display.name }, clinic });
  }));

  router.get('/api/display/bootstrap', withDb((req, res, db) => {
    const display = svc.authenticateDisplay(db, req.headers.cookie, secret);
    if (!display) return fail(res, 401, 'UNAUTHENTICATED', 'الشاشة غير مقترنة');
    res.setHeader('Cache-Control', 'no-store');
    return ok(res, svc.getBootstrap(db, display));
  }));

  /* ---- أدمن ---- */
  const requireAdmin = (req, res, next) => {
    if (!deps.getStaff) { // الإنتاج: middleware حساب 1 (جلسة، تغيير كلمة المرور، الرتبة)، ثم فحص العيادة أدناه
      const chain = loadAdminChain();
      if (chain) return runChain(chain, req, res, (err) => (err ? next(err) : finishAdmin(req, res, next)));
    }
    return finishAdmin(req, res, next);
  };
  const finishAdmin = (req, res, next) => {
    const s = getStaff(req);
    if (!s) return fail(res, 401, 'UNAUTHENTICATED', 'يلزم تسجيل الدخول');
    if (s.role !== 'admin' || s.clinicId == null) return fail(res, 403, 'FORBIDDEN', 'غير مصرح');
    req.adminStaff = s; return next();
  };
  const parse = (schema, body, res) => {
    const r = schema.safeParse(body || {});
    if (!r.success) { fail(res, 400, 'VALIDATION', r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ')); return null; }
    return r.data;
  };
  const idParam = (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) { fail(res, 400, 'VALIDATION', 'معرّف غير صالح'); return null; }
    return id;
  };
  const notify = (clinicId, event, payload) => {
    const emit = getEmit();
    if (!emit) return;
    try { emit(clinicId, event, payload); } catch (e) { console.error('[display] emit failed', e.message); }
  };

  router.get('/api/admin/displays', requireAdmin, withDb((req, res, db) => ok(res, { displays: svc.listDisplays(db, req.adminStaff.clinicId) })));

  router.post('/api/admin/displays', json, requireAdmin, withDb((req, res, db) => {
    const body = parse(createSchema, req.body, res); if (!body) return;
    const r = svc.createDisplay(db, { clinicId: req.adminStaff.clinicId, name: body.name, settings: body.settings, staffId: req.adminStaff.id });
    res.setHeader('Cache-Control', 'no-store');
    return ok(res, r, 201); // pairingCode يظهر مرة واحدة فقط
  }));

  router.put('/api/admin/displays/:id/settings', json, requireAdmin, withDb((req, res, db) => {
    const id = idParam(req, res); if (id === null) return;
    const body = parse(settingsSchema, req.body, res); if (!body) return;
    const d = svc.updateSettings(db, req.adminStaff.clinicId, id, body, req.adminStaff.id);
    if (!d) return fail(res, 404, 'NOT_FOUND', 'الشاشة غير موجودة');
    notify(d.clinic_id, 'display:settings_updated', { displayId: d.id, settings: d.settings });
    return ok(res, { display: d });
  }));

  // امتدادات مقترحة على العقد (انظر التقرير): تعديل الاسم/التفعيل، إعادة ضبط الكود، حذف
  router.put('/api/admin/displays/:id', json, requireAdmin, withDb((req, res, db) => {
    const id = idParam(req, res); if (id === null) return;
    const body = parse(updateSchema, req.body, res); if (!body) return;
    const d = svc.updateDisplay(db, req.adminStaff.clinicId, id, body, req.adminStaff.id);
    return d ? ok(res, { display: d }) : fail(res, 404, 'NOT_FOUND', 'الشاشة غير موجودة');
  }));
  router.post('/api/admin/displays/:id/reset-pairing', json, requireAdmin, withDb((req, res, db) => {
    const id = idParam(req, res); if (id === null) return;
    const r = svc.resetPairing(db, req.adminStaff.clinicId, id, req.adminStaff.id);
    if (!r) return fail(res, 404, 'NOT_FOUND', 'الشاشة غير موجودة');
    res.setHeader('Cache-Control', 'no-store');
    return ok(res, r);
  }));
  router.delete('/api/admin/displays/:id', requireAdmin, withDb((req, res, db) => {
    const id = idParam(req, res); if (id === null) return;
    return svc.deleteDisplay(db, req.adminStaff.clinicId, id, req.adminStaff.id) ? ok(res, { deleted: true }) : fail(res, 404, 'NOT_FOUND', 'الشاشة غير موجودة');
  }));

  /* ---- الوسائط ---- */
  router.get('/media/audio/:lang/:file', media.audio);
  router.get('/media/:file', media.file);

  return router;
}

module.exports = { path: '/', router: createDisplayRouter(), createDisplayRouter };
