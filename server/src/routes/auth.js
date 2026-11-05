'use strict';
const express = require('express');
const { z } = require('zod');
const { getDb, nowIso } = require('../database');
const { ok, wrap } = require('../utils/respond');
const { E } = require('../utils/errors');
const { hashPassword, verifyPassword } = require('../utils/password');
const { validate } = require('../middleware/validate');
const { requireAuth } = require('../middleware/auth');
const { writeAudit } = require('../middleware/audit');
const { loginLimiter, strictLimiter } = require('../middleware/rateLimit');
const { createSession, destroySession, destroyStaffSessions } = require('../middleware/session');
const svc = require('../services/authService');

const router = express.Router();

const passwordSchema = z.string().min(10, 'min 10 characters').max(128);
const usernameSchema = z.string().trim().toLowerCase().regex(/^[a-z0-9._-]{3,32}$/, 'invalid username');

const loginSchema = z.object({
  username: z.string().trim().toLowerCase().min(1).max(64),
  password: z.string().min(1).max(128),
  clinicId: z.number().int().positive().optional(),
}).strict();

const changePwSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: passwordSchema,
}).strict();

const setupSchema = z.object({
  clinicName: z.string().trim().min(2).max(120),
  username: usernameSchema,
  password: passwordSchema,
  fullName: z.string().trim().min(2).max(100).optional(),
}).strict();

const INVALID = () => E.unauthenticated('Invalid username or password');

router.get('/csrf', strictLimiter, (req, res) => {
  const session = req.session || createSession(res, null);
  ok(res, { csrfToken: session.csrf });
});

router.post('/login', loginLimiter, validate(loginSchema), wrap(async (req, res) => {
  const { username, password, clinicId } = req.body;
  const db = getDb();
  if (svc.isLocked(username)) throw E.rateLimited('Too many failed attempts. Try again later.');

  const rows = clinicId
    ? db.prepare('SELECT * FROM staff WHERE username = ? AND clinic_id = ?').all(username, clinicId)
    : db.prepare('SELECT * FROM staff WHERE username = ?').all(username);
  if (rows.length > 1) throw E.validation('clinicId is required for this username');

  const staff = rows[0];
  let valid = false;
  if (staff) {
    valid = await verifyPassword(staff.password_hash, password);
    if (valid) {
      const clinic = db.prepare('SELECT is_active FROM clinics WHERE id = ?').get(staff.clinic_id);
      valid = !!staff.is_active && !!(clinic && clinic.is_active);
    }
  } else {
    await svc.burnTime(password);
  }
  if (!valid) {
    svc.recordFailure(username);
    writeAudit(req, 'auth.login_failed', 'staff', staff ? staff.id : null, { username },
      { clinicId: staff ? staff.clinic_id : null, staffId: null });
    throw INVALID();
  }

  svc.clearFailures(username);
  if (req.session) destroySession(req, res); // new sid after login (anti session-fixation)
  const session = createSession(res, staff.id);
  svc.touchLogin(staff.id);
  const fresh = db.prepare('SELECT * FROM staff WHERE id = ?').get(staff.id);
  req.staff = fresh; req.session = session;
  writeAudit(req, 'auth.login', 'staff', staff.id);
  ok(res, { staff: svc.serializeStaff(fresh), csrfToken: session.csrf });
}));

router.post('/logout', (req, res) => {
  if (req.staff) writeAudit(req, 'auth.logout', 'staff', req.staff.id);
  destroySession(req, res);
  ok(res, { loggedOut: true });
});

router.get('/me', (req, res, next) => {
  if (!req.staff) return next(E.unauthenticated());
  return ok(res, { staff: svc.serializeStaff(req.staff), csrfToken: req.session.csrf });
});

router.post('/change-password', requireAuth, validate(changePwSchema), wrap(async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!(await verifyPassword(req.staff.password_hash, currentPassword))) {
    throw E.validation('Current password is incorrect');
  }
  if (newPassword === currentPassword) throw E.validation('New password must differ from the current one');
  if (newPassword.toLowerCase().includes(req.staff.username)) throw E.validation('Password must not contain the username');
  const hash = await hashPassword(newPassword);
  getDb().prepare('UPDATE staff SET password_hash = ?, must_change_password = 0, updated_at = ? WHERE id = ?')
    .run(hash, nowIso(), req.staff.id);
  destroyStaffSessions(req.staff.id, req.session.id); // other devices signed out
  writeAudit(req, 'auth.change_password', 'staff', req.staff.id);
  ok(res, { changed: true });
}));

// First-run wizard: creates clinic + admin ONLY while no admin exists
router.post('/setup', strictLimiter, validate(setupSchema), wrap(async (req, res) => {
  const db = getDb();
  const { clinicName, username, password, fullName } = req.body;
  const hash = await hashPassword(password);
  const now = nowIso();
  const result = db.transaction(() => { // re-check inside the transaction (race-safe)
    if (db.prepare("SELECT COUNT(*) c FROM staff WHERE role = 'admin'").get().c > 0) return null;
    const clinicId = db.prepare(
      'INSERT INTO clinics (name_ar, created_at, updated_at) VALUES (?,?,?)'
    ).run(clinicName, now, now).lastInsertRowid;
    const staffId = db.prepare(
      `INSERT INTO staff (clinic_id, username, password_hash, full_name, role, can_skip_return, can_cancel, can_transfer,
         created_at, updated_at) VALUES (?,?,?,?,?,1,1,1,?,?)`
    ).run(clinicId, username, hash, fullName || username, 'admin', now, now).lastInsertRowid;
    return { clinicId, staffId };
  }).immediate();
  if (!result) throw E.forbidden('Setup is already completed');
  writeAudit(req, 'auth.setup', 'clinic', result.clinicId, { username },
    { clinicId: result.clinicId, staffId: result.staffId });
  ok(res, { clinicId: result.clinicId }, 201);
}));

module.exports = { path: '/api/auth', router };
