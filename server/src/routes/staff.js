'use strict';
const express = require('express');
const { z } = require('zod');
const { getDb, nowIso } = require('../database');
const { ok, wrap } = require('../utils/respond');
const { E } = require('../utils/errors');
const { requireRole, clinicScope } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { writeAudit } = require('../middleware/audit');
const { hashPassword, randomPassword } = require('../utils/password');
const { destroyStaffSessions } = require('../middleware/session');

const router = express.Router();
router.use(requireRole('admin'), clinicScope);

const base = {
  username: z.string().trim().toLowerCase().regex(/^[a-z0-9._-]{3,32}$/, 'invalid username'),
  fullName: z.string().trim().min(2).max(100),
  role: z.enum(['admin', 'manager', 'staff']),
  defaultCounterId: z.number().int().positive().nullable().optional(),
  canSkipReturn: z.boolean().optional(),
  canCancel: z.boolean().optional(),
  canTransfer: z.boolean().optional(),
  isActive: z.boolean().optional(),
  serviceIds: z.array(z.number().int().positive()).max(100).optional(),
};
const createSchema = z.object({ ...base, password: z.string().min(10).max(128).optional() }).strict();
const updateSchema = z.object(base).partial().strict();
const idSchema = z.object({ id: z.coerce.number().int().positive() });

function ser(r) {
  const serviceIds = getDb().prepare('SELECT service_id FROM staff_services WHERE staff_id = ? ORDER BY service_id')
    .all(r.id).map((x) => x.service_id);
  return { id: r.id, username: r.username, fullName: r.full_name, role: r.role, defaultCounterId: r.default_counter_id,
    canSkipReturn: !!r.can_skip_return, canCancel: !!r.can_cancel, canTransfer: !!r.can_transfer,
    mustChangePassword: !!r.must_change_password, isActive: !!r.is_active, lastLoginAt: r.last_login_at, serviceIds };
}
const get = (req) => {
  const r = getDb().prepare('SELECT * FROM staff WHERE id = ? AND clinic_id = ?').get(req.params.id, req.clinicId);
  if (!r) throw E.notFound('Staff not found');
  return r;
};
function checkRefs(clinicId, b) {
  const db = getDb();
  if (b.defaultCounterId) {
    if (!db.prepare('SELECT 1 FROM counters WHERE id = ? AND clinic_id = ?').get(b.defaultCounterId, clinicId)) throw E.validation('Unknown defaultCounterId');
  }
  if (b.serviceIds) {
    const u = [...new Set(b.serviceIds)];
    if (u.length && db.prepare(`SELECT COUNT(*) c FROM services WHERE clinic_id = ? AND id IN (${u.map(() => '?').join(',')})`).get(clinicId, ...u).c !== u.length) {
      throw E.validation('Unknown serviceIds');
    }
  }
}
function setServices(staffId, ids) {
  getDb().prepare('DELETE FROM staff_services WHERE staff_id = ?').run(staffId);
  const ins = getDb().prepare('INSERT INTO staff_services (staff_id, service_id) VALUES (?,?)');
  for (const s of new Set(ids)) ins.run(staffId, s);
}
// never leave a clinic without an active admin
function guardLastAdmin(req, target, nextRole, nextActive) {
  const losing = target.role === 'admin' && target.is_active && (nextRole !== 'admin' || nextActive === false);
  if (!losing) return;
  const n = getDb().prepare("SELECT COUNT(*) c FROM staff WHERE clinic_id = ? AND role = 'admin' AND is_active = 1").get(req.clinicId).c;
  if (n <= 1) throw E.conflict('Cannot remove the last active admin');
}

router.get('/', (req, res) => ok(res,
  getDb().prepare('SELECT * FROM staff WHERE clinic_id = ? ORDER BY id').all(req.clinicId).map(ser)));
router.get('/:id', validate(idSchema, 'params'), (req, res) => ok(res, ser(get(req))));

router.post('/', validate(createSchema), wrap(async (req, res) => {
  const b = req.body; checkRefs(req.clinicId, b);
  const generated = b.password ? null : randomPassword();
  const hash = await hashPassword(b.password || generated);
  const now = nowIso();
  let id;
  getDb().transaction(() => {
    try {
      id = getDb().prepare(`INSERT INTO staff (clinic_id,username,password_hash,full_name,role,default_counter_id,can_skip_return,
        can_cancel,can_transfer,must_change_password,is_active,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,1,?,?,?)`)
        .run(req.clinicId, b.username, hash, b.fullName, b.role, b.defaultCounterId ?? null, +!!b.canSkipReturn, +!!b.canCancel,
          +!!b.canTransfer, b.isActive === false ? 0 : 1, now, now).lastInsertRowid;
    } catch (e) { if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') throw E.conflict('Username already exists'); throw e; }
    if (b.serviceIds) setServices(id, b.serviceIds);
  })();
  writeAudit(req, 'staff.create', 'staff', id, { ...b, password: undefined });
  ok(res, { ...ser(getDb().prepare('SELECT * FROM staff WHERE id = ?').get(id)), temporaryPassword: generated }, 201);
}));

router.put('/:id', validate(idSchema, 'params'), validate(updateSchema), (req, res) => {
  const target = get(req); const b = req.body; checkRefs(req.clinicId, b);
  guardLastAdmin(req, target, b.role ?? target.role, b.isActive);
  const map = { username: 'username', fullName: 'full_name', role: 'role', defaultCounterId: 'default_counter_id',
    canSkipReturn: 'can_skip_return', canCancel: 'can_cancel', canTransfer: 'can_transfer', isActive: 'is_active' };
  getDb().transaction(() => {
    const sets = []; const vals = [];
    for (const [k, col] of Object.entries(map)) if (b[k] !== undefined) { sets.push(`${col} = ?`); vals.push(typeof b[k] === 'boolean' ? +b[k] : b[k]); }
    try { getDb().prepare(`UPDATE staff SET ${sets.concat('updated_at = ?').join(', ')} WHERE id = ? AND clinic_id = ?`)
      .run(...vals, nowIso(), req.params.id, req.clinicId); }
    catch (e) { if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') throw E.conflict('Username already exists'); throw e; }
    if (b.serviceIds) setServices(target.id, b.serviceIds);
  })();
  if (b.isActive === false || b.role) destroyStaffSessions(target.id);
  writeAudit(req, 'staff.update', 'staff', target.id, b);
  ok(res, ser(get(req)));
});

router.post('/:id/reset-password', validate(idSchema, 'params'), wrap(async (req, res) => {
  const target = get(req);
  const pw = randomPassword();
  getDb().prepare('UPDATE staff SET password_hash = ?, must_change_password = 1, updated_at = ? WHERE id = ?')
    .run(await hashPassword(pw), nowIso(), target.id);
  destroyStaffSessions(target.id);
  require('../services/authService').unlockStaff(target.id);
  writeAudit(req, 'staff.reset_password', 'staff', target.id);
  ok(res, { temporaryPassword: pw, mustChangePassword: true });
}));

// فك قفل الدخول المؤقت يدوياً (موظف تجاوز عدد المحاولات)
router.post('/:id/unlock', validate(idSchema, 'params'), (req, res) => {
  const target = get(req);
  const cleared = require('../services/authService').unlockStaff(target.id);
  writeAudit(req, 'staff.unlock', 'staff', target.id);
  ok(res, { unlocked: true, cleared });
});

// disable instead of delete (audit/ticket history references staff)
router.delete('/:id', validate(idSchema, 'params'), (req, res) => {
  const target = get(req);
  if (target.id === req.staff.id) throw E.conflict('You cannot deactivate yourself');
  guardLastAdmin(req, target, target.role, false);
  getDb().prepare('UPDATE staff SET is_active = 0, updated_at = ? WHERE id = ?').run(nowIso(), target.id);
  destroyStaffSessions(target.id);
  writeAudit(req, 'staff.deactivate', 'staff', target.id);
  ok(res, { deactivated: true });
});

module.exports = { path: '/api/admin/staff', router };
