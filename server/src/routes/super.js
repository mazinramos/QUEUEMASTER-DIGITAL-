'use strict';
// إدارة العيادات (نظام متعدد العيادات) بدون واجهة: مصادقة برمز SUPER_ADMIN_TOKEN في الترويسة X-Super-Token.
// معطّل تماماً (404) إن لم يُضبط الرمز أو كان أقصر من 32 حرفاً.
const crypto = require('crypto');
const express = require('express');
const { z } = require('zod');
const { getDb, nowIso } = require('../database');
const { ok, wrap } = require('../utils/respond');
const { E } = require('../utils/errors');
const { validate } = require('../middleware/validate');
const { writeAudit } = require('../middleware/audit');
const { superLimiter } = require('../middleware/rateLimit');
const { hashPassword, randomPassword } = require('../utils/password');
const { destroyClinicSessions } = require('../middleware/session');

const router = express.Router();

const sha = (v) => crypto.createHash('sha256').update(String(v)).digest();
function superAuth(req, res, next) {
  const expected = process.env.SUPER_ADMIN_TOKEN;
  if (!expected || expected.length < 32) return next(E.notFound('Route not found')); // معطّل: لا يُكشف وجوده
  return superLimiter(req, res, (err) => {
    if (err) return next(err);
    const given = req.get('X-Super-Token') || '';
    if (!crypto.timingSafeEqual(sha(given), sha(expected))) {
      try { writeAudit(req, 'super.auth_failed', 'clinic', null, null, { clinicId: null, staffId: null }); } catch { /* ignore */ }
      return next(E.unauthenticated('Invalid super-admin token'));
    }
    return next();
  });
}
router.use(superAuth);

const tzOk = (tz) => { try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; } };
const createSchema = z.object({
  nameAr: z.string().trim().min(2).max(120),
  nameEn: z.string().trim().max(120).nullable().optional(),
  address: z.string().trim().max(300).nullable().optional(),
  phone: z.string().trim().max(40).nullable().optional(),
  timezone: z.string().refine(tzOk, 'invalid timezone').optional(),
  defaultLanguage: z.enum(['ar', 'en']).optional(),
  admin: z.object({
    username: z.string().trim().toLowerCase().regex(/^[a-z0-9._-]{3,32}$/, 'invalid username'),
    fullName: z.string().trim().min(2).max(100).optional(),
    password: z.string().min(10).max(128).optional(),
  }).strict(),
}).strict();
const idSchema = z.object({ id: z.coerce.number().int().positive() });

router.get('/clinics', (req, res) => {
  const rows = getDb().prepare(`SELECT c.id, c.name_ar, c.name_en, c.is_active, c.created_at,
      (SELECT COUNT(*) FROM staff s WHERE s.clinic_id = c.id) AS staff_count,
      (SELECT COUNT(*) FROM services v WHERE v.clinic_id = c.id) AS service_count
    FROM clinics c ORDER BY c.id`).all();
  ok(res, rows.map((r) => ({ id: r.id, nameAr: r.name_ar, nameEn: r.name_en, isActive: !!r.is_active, createdAt: r.created_at,
    staffCount: r.staff_count, serviceCount: r.service_count })));
});

router.post('/clinics', validate(createSchema), wrap(async (req, res) => {
  const b = req.body;
  const generated = b.admin.password ? null : randomPassword();
  const hash = await hashPassword(b.admin.password || generated);
  const now = nowIso(); const db = getDb();
  const out = db.transaction(() => {
    const clinicId = db.prepare(`INSERT INTO clinics (name_ar,name_en,address,phone,timezone,default_language,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(b.nameAr, b.nameEn ?? null, b.address ?? null, b.phone ?? null,
      b.timezone || 'Africa/Cairo', b.defaultLanguage || 'ar', now, now).lastInsertRowid;
    const staffId = db.prepare(`INSERT INTO staff (clinic_id,username,password_hash,full_name,role,can_skip_return,can_cancel,can_transfer,
      must_change_password,created_at,updated_at) VALUES (?,?,?,?,?,1,1,1,1,?,?)`)
      .run(clinicId, b.admin.username, hash, b.admin.fullName || b.admin.username, 'admin', now, now).lastInsertRowid;
    return { clinicId, staffId };
  })();
  writeAudit(req, 'super.clinic.create', 'clinic', out.clinicId, { adminUsername: b.admin.username, nameAr: b.nameAr },
    { clinicId: out.clinicId, staffId: null });
  ok(res, { clinicId: out.clinicId, admin: { id: out.staffId, username: b.admin.username, mustChangePassword: true },
    temporaryPassword: generated }, 201);
}));

router.put('/clinics/:id/active', validate(idSchema, 'params'), validate(z.object({ isActive: z.boolean() }).strict()), (req, res) => {
  const c = getDb().prepare('SELECT id FROM clinics WHERE id = ?').get(req.params.id);
  if (!c) throw E.notFound('Clinic not found');
  getDb().prepare('UPDATE clinics SET is_active = ?, updated_at = ? WHERE id = ?').run(+req.body.isActive, nowIso(), c.id);
  if (!req.body.isActive) destroyClinicSessions(c.id);
  writeAudit(req, req.body.isActive ? 'super.clinic.activate' : 'super.clinic.deactivate', 'clinic', c.id, null, { clinicId: c.id, staffId: null });
  ok(res, { id: c.id, isActive: req.body.isActive });
});

module.exports = { path: '/api/super', router };
