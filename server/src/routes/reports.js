'use strict';
/**
 * routes/reports.js — إحصاءات اللوحة والتقارير (حساب 5). للقراءة فقط، الحد الأدنى للدور: manager.
 *   GET /api/admin/stats/overview?date=
 *   GET /api/admin/reports/{summary|daily|weekly|monthly|services|waiting-times|staff}?from=&to=&serviceId=&format=csv&lang=ar|en
 * CSV: UTF-8 + BOM، CRLF، حماية من formula injection (reportsCsv.js).
 */
const express = require('express');
const { createReportsService, ReportsError } = require('../services/reportsService');
const { toCsv } = require('../services/reportsCsv');

const MIN_ROLE = 'manager';

const H = {
  ar: {
    date: 'التاريخ', period: 'الفترة', issued: 'المصدرة', completed: 'المكتملة', skipped: 'المتخطاة', cancelled: 'الملغاة', waiting: 'المنتظرة',
    avgWait: 'متوسط الانتظار (د)', avgSvc: 'متوسط الخدمة (د)', service: 'الخدمة', prefix: 'البادئة', staff: 'الموظف', username: 'اسم المستخدم',
    role: 'الدور', called: 'المنادى عليها', recalls: 'إعادة النداء', from: 'من', to: 'إلى', activeDays: 'أيام العمل', perDay: 'متوسط/يوم',
    metric: 'المؤشر', value: 'القيمة', bucket: 'الفئة (دقائق)', count: 'العدد', hour: 'الساعة', samples: 'العينات', median: 'الوسيط (د)', p90: 'الشريحة 90 (د)', max: 'الأقصى (د)',
  },
  en: {
    date: 'Date', period: 'Period', issued: 'Issued', completed: 'Completed', skipped: 'Skipped', cancelled: 'Cancelled', waiting: 'Waiting',
    avgWait: 'Avg wait (min)', avgSvc: 'Avg service (min)', service: 'Service', prefix: 'Prefix', staff: 'Staff', username: 'Username',
    role: 'Role', called: 'Called', recalls: 'Recalls', from: 'From', to: 'To', activeDays: 'Active days', perDay: 'Avg/day',
    metric: 'Metric', value: 'Value', bucket: 'Bucket (min)', count: 'Count', hour: 'Hour', samples: 'Samples', median: 'Median (min)', p90: 'P90 (min)', max: 'Max (min)',
  },
};

// كل تقرير: كيف نحسبه، وكيف نحوله إلى CSV
const REPORTS = {
  summary: {
    run: (s, c, q) => s.summary(c, q),
    csv: (r, h) => ({ headers: [h.metric, h.value], rows: [[h.from, r.from], [h.to, r.to], [h.issued, r.issued], [h.completed, r.completed], [h.skipped, r.skipped], [h.cancelled, r.cancelled], [h.avgWait, r.avgWaitMin], [h.avgSvc, r.avgServiceMin], [h.activeDays, r.activeDays], [h.perDay, r.avgPerActiveDay]] }),
  },
  daily: {
    run: (s, c, q) => s.daily(c, q),
    csv: (r, h) => ({ headers: [h.date, h.issued, h.completed, h.skipped, h.cancelled, h.waiting, h.avgWait, h.avgSvc], rows: r.rows.map((x) => [x.date, x.issued, x.completed, x.skipped, x.cancelled, x.waiting, x.avgWaitMin, x.avgServiceMin]) }),
  },
  weekly: {
    run: (s, c, q) => s.weekly(c, q),
    csv: (r, h) => periodCsv(r, h),
  },
  monthly: {
    run: (s, c, q) => s.monthly(c, q),
    csv: (r, h) => periodCsv(r, h),
  },
  services: {
    run: (s, c, q) => s.services(c, q),
    csv: (r, h, lang) => ({ headers: [h.service, h.prefix, h.issued, h.completed, h.skipped, h.cancelled, h.avgWait, h.avgSvc], rows: r.rows.map((x) => [lang === 'en' && x.name_en ? x.name_en : x.name_ar, x.prefix, x.issued, x.completed, x.skipped, x.cancelled, x.avgWaitMin, x.avgServiceMin]) }),
  },
  'waiting-times': {
    run: (s, c, q) => s.waitingTimes(c, q),
    csv: (r, h) => ({
      headers: [h.metric, h.value],
      rows: [[h.samples, r.samples], [h.avgWait, r.avgMin], [h.median, r.medianMin], [h.p90, r.p90Min], [h.max, r.maxMin],
        ...r.buckets.map((b) => [`${h.bucket} ${b.label}`, b.count]),
        ...r.byHour.filter((x) => x.count).map((x) => [`${h.hour} ${String(x.hour).padStart(2, '0')}:00 — ${h.avgWait}`, x.avgMin])],
    }),
  },
  staff: {
    run: (s, c, q) => s.staff(c, q),
    csv: (r, h) => ({ headers: [h.staff, h.username, h.role, h.called, h.completed, h.skipped, h.cancelled, h.recalls, h.avgSvc], rows: r.rows.map((x) => [x.fullName, x.username, x.role, x.called, x.completed, x.skipped, x.cancelled, x.recalls, x.avgServiceMin]) }),
  },
};
function periodCsv(r, h) {
  return { headers: [h.period, h.issued, h.completed, h.skipped, h.cancelled, h.avgWait, h.avgSvc], rows: r.rows.map((x) => [x.period, x.issued, x.completed, x.skipped, x.cancelled, x.avgWaitMin, x.avgServiceMin]) };
}

function getActor(req) {
  const a = req.staff || (req.session && req.session.staff) || req.user;
  if (!a) return null;
  const clinicId = a.clinicId ?? a.clinic_id;
  return clinicId == null ? null : { id: a.id, clinicId: Number(clinicId), role: a.role };
}

function defaultGuards() {
  let chain = null;
  return (req, res, next) => {
    if (!chain) {
      let mw; try { mw = require('../middleware'); } catch (_) { mw = null; }
      if (!mw || typeof mw.requireRole !== 'function') return res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: 'auth middleware unavailable' } });
      chain = [mw.requireRole(MIN_ROLE)].flat();
    }
    let i = 0;
    const step = (err) => { if (err) return next(err); const fn = chain[i++]; return fn ? fn(req, res, step) : next(); };
    return step();
  };
}

function createReportsRouter({ service, guards } = {}) {
  const svc = service || createReportsService({ getDb: () => require('../database').getDb() });
  const router = express.Router();
  router.use(guards || defaultGuards());
  router.use((req, res, next) => {
    const actor = getActor(req);
    if (!actor) return res.status(401).json({ ok: false, error: { code: 'UNAUTHENTICATED', message: 'غير مسجل الدخول' } });
    req.actor = actor; return next();
  });

  router.get('/stats/overview', (req, res, next) => {
    try { res.json({ ok: true, data: svc.overview(req.actor.clinicId, req.query) }); } catch (e) { next(e); }
  });

  router.get('/reports/:name', (req, res, next) => {
    try {
      const def = Object.prototype.hasOwnProperty.call(REPORTS, req.params.name) ? REPORTS[req.params.name] : null;
      if (!def) throw new ReportsError(404, 'NOT_FOUND', 'تقرير غير معروف');
      const result = def.run(svc, req.actor.clinicId, req.query);
      if (req.query.format === undefined || req.query.format === 'json') return res.json({ ok: true, data: result });
      if (req.query.format !== 'csv') throw new ReportsError(400, 'VALIDATION', 'format يجب أن يكون json أو csv');
      const lang = req.query.lang === 'en' ? 'en' : 'ar';
      const { headers, rows } = def.csv(result, H[lang], lang);
      const stamp = (result.from && result.to) ? `${result.from}_${result.to}` : new Date().toISOString().slice(0, 10);
      res.set({
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="queuemaster-${req.params.name}-${stamp}.csv"`,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
      });
      return res.send(toCsv(headers, rows));
    } catch (e) { return next(e); }
  });

  // eslint-disable-next-line no-unused-vars
  router.use((err, req, res, next) => {
    if (err && Number.isInteger(err.status) && err.status >= 400 && err.status < 500 && typeof err.code === 'string') {
      return res.status(err.status).json({ ok: false, error: { code: err.code, message: err.message } });
    }
    console.error('[reports] unexpected error:', err);
    return res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: 'خطأ داخلي' } });
  });
  return router;
}

// تحميل تلقائي (app.js): نبني الراوتر عند أول طلب
const lazy = express.Router();
let built = null;
lazy.use((req, res, next) => {
  if (!built) built = createReportsRouter();
  return built(req, res, next);
});
// نحصر هذا الراوتر في مساراته فقط حتى لا يلتقط مسارات /api/admin الأخرى (ح1/ح2/ح4)
const scoped = express.Router();
scoped.use((req, res, next) => (/^\/(stats|reports)(\/|$)/.test(req.path) ? lazy(req, res, next) : next()));

module.exports = { path: '/api/admin', router: scoped, createReportsRouter, REPORTS };
