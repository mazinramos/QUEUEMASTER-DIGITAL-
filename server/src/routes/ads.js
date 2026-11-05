'use strict';
/**
 * routes/ads.js — إعلانات الأدمن (حساب 5).
 * المسارات حسب docs/api-contract.md:
 *   GET/POST /api/admin/ads | PUT/DELETE /api/admin/ads/:id | GET /api/admin/ads/:id/preview
 *
 * اعتماديات على حساب 1 (تُحل بتأخير وتفشل بإغلاق آمن إن لم توجد):
 *   require('../middleware') يصدّر requireRole(minRole) ، واختيارياً csrfProtection
 *   المستخدم الحالي على req.staff | req.session.staff | req.user بالحقول {id, clinicId|clinic_id, role}
 */
const express = require('express');
const { AdsError, createAdsUpload } = require('../services/adsUpload');
const { createAdsService, DEFAULT_UPLOADS_DIR } = require('../services/adsService');

const MIN_ROLE = 'manager';

function getActor(req) {
  const a = req.staff || (req.session && req.session.staff) || req.user;
  if (!a) return null;
  const clinicId = a.clinicId ?? a.clinic_id;
  if (clinicId == null) return null;
  return { id: a.id, clinicId: Number(clinicId), role: a.role, ip: req.ip };
}

function defaultGuards() {
  return (req, res, next) => {
    let mw;
    try { mw = require('../middleware'); } catch (_) { mw = null; }
    if (!mw || typeof mw.requireRole !== 'function') {
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: 'auth middleware unavailable' } });
    }
    const chain = [mw.requireRole(MIN_ROLE)];
    if (typeof mw.csrfProtection === 'function') chain.push(mw.csrfProtection);
    let i = 0;
    const step = (err) => {
      if (err) return next(err);
      const fn = chain[i++];
      return fn ? fn(req, res, step) : next();
    };
    return step();
  };
}

function createAdsRouter({ service, upload, guards } = {}) {
  const svc = service || createAdsService();
  const up = upload || createAdsUpload({ uploadsDir: svc.uploadsDir });
  const guard = guards || defaultGuards();
  const router = express.Router();
  const ok = (res, data, status = 200) => res.status(status).json({ ok: true, data });

  const withActor = (req, res, next) => {
    const actor = getActor(req);
    if (!actor) return res.status(401).json({ ok: false, error: { code: 'UNAUTHENTICATED', message: 'غير مسجل الدخول' } });
    req.actor = actor;
    return next();
  };
  const parseId = (req, _res, next) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return next(new AdsError(404, 'NOT_FOUND', 'الإعلان غير موجود'));
    req.adId = id;
    return next();
  };

  router.use(guard, withActor);

  router.get('/', (req, res, next) => {
    try {
      const allowed = ['active', 'scheduled', 'expired', 'inactive'];
      const status = allowed.includes(req.query.status) ? req.query.status : undefined;
      ok(res, { ads: svc.list(req.actor.clinicId, { status }) });
    } catch (e) { next(e); }
  });

  router.post('/', up.middleware, (req, res, next) => {
    let stored = null;
    try {
      stored = up.commit(req.file);
      ok(res, { ad: svc.create(req.actor.clinicId, req.actor, req.body, stored) }, 201);
    } catch (e) { up.discard(req.file); next(e); }
  });

  router.get('/:id/preview', parseId, (req, res, next) => {
    try { ok(res, svc.preview(req.actor.clinicId, req.adId)); } catch (e) { next(e); }
  });

  router.get('/:id', parseId, (req, res, next) => {
    try { ok(res, { ad: svc.get(req.actor.clinicId, req.adId) }); } catch (e) { next(e); }
  });

  router.put('/:id', parseId, up.middleware, (req, res, next) => {
    let stored = null;
    try {
      stored = up.commit(req.file);
      ok(res, { ad: svc.update(req.actor.clinicId, req.adId, req.actor, req.body, stored) });
    } catch (e) { up.discard(req.file); next(e); }
  });

  router.delete('/:id', parseId, (req, res, next) => {
    try { ok(res, svc.remove(req.actor.clinicId, req.adId, req.actor)); } catch (e) { next(e); }
  });

  // أخطاء هذا الراوتر فقط (بصيغة العقد)
  // eslint-disable-next-line no-unused-vars
  router.use((err, req, res, next) => {
    if (err instanceof AdsError) {
      return res.status(err.status).json({ ok: false, error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } });
    }
    console.error('[ads] unexpected error:', err);
    return res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: 'خطأ داخلي' } });
  });

  return router;
}

let defaultService = null;
function getDefaultService() {
  if (!defaultService) {
    defaultService = createAdsService();
    if (process.env.NODE_ENV !== 'test') {
      try { defaultService.startScheduler(); } catch (e) { console.error('[ads] scheduler not started:', e.message); }
    }
  }
  return defaultService;
}

// تحميل تلقائي من app.js: الراوتر الافتراضي يُبنى عند أول طلب حتى لا يعتمد على جاهزية DB وقت الـ require
const lazy = express.Router();
let built = null;
lazy.use((req, res, next) => {
  if (!built) built = createAdsRouter({ service: getDefaultService() });
  return built(req, res, next);
});

module.exports = { path: '/api/admin/ads', router: lazy, createAdsRouter, getActor, getDefaultService, DEFAULT_UPLOADS_DIR };
