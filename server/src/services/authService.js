'use strict';
const { getDb, nowIso } = require('../database');
const config = require('../config');
const { hashPassword, verifyPassword } = require('../utils/password');

// ---- temporary lockout (in-memory; resets on restart. Schema has no column for it) ----
const fails = new Map(); // key -> { count, lockedUntil }
const lockKey = (username) => String(username).toLowerCase();
function isLocked(username) {
  const e = fails.get(lockKey(username));
  if (!e) return false;
  if (e.lockedUntil && e.lockedUntil > Date.now()) return true;
  if (e.lockedUntil) fails.delete(lockKey(username));
  return false;
}
function recordFailure(username) {
  const k = lockKey(username);
  const e = fails.get(k) || { count: 0, lockedUntil: 0 };
  e.count += 1;
  if (e.count >= config.rateLimit.lockAfterFails) {
    e.lockedUntil = Date.now() + config.rateLimit.lockMinutes * 60 * 1000;
    e.count = 0;
  }
  fails.set(k, e);
}
const clearFailures = (username) => fails.delete(lockKey(username));
const _resetLockouts = () => fails.clear();

let dummyHash = null;
async function burnTime(password) { // equalize timing when username doesn't exist
  if (!dummyHash) dummyHash = await hashPassword('dummy-password-for-timing');
  await verifyPassword(dummyHash, password);
}

function serializeStaff(staffRow) {
  const db = getDb();
  const services = db.prepare(
    `SELECT sv.id, sv.name_ar AS nameAr, sv.name_en AS nameEn, sv.prefix
       FROM staff_services ss JOIN services sv ON sv.id = ss.service_id
      WHERE ss.staff_id = ? AND sv.clinic_id = ? AND sv.is_active = 1 ORDER BY sv.display_order, sv.id`
  ).all(staffRow.id, staffRow.clinic_id);
  let counter = null;
  if (staffRow.default_counter_id) {
    counter = db.prepare(
      'SELECT id, number, name_ar AS nameAr, name_en AS nameEn FROM counters WHERE id = ? AND clinic_id = ?'
    ).get(staffRow.default_counter_id, staffRow.clinic_id) || null;
  }
  return {
    id: staffRow.id,
    clinicId: staffRow.clinic_id,
    username: staffRow.username,
    fullName: staffRow.full_name,
    role: staffRow.role,
    permissions: {
      canSkipReturn: !!staffRow.can_skip_return,
      canCancel: !!staffRow.can_cancel,
      canTransfer: !!staffRow.can_transfer,
    },
    mustChangePassword: !!staffRow.must_change_password,
    services,
    counter,
  };
}

function touchLogin(staffId) {
  getDb().prepare('UPDATE staff SET last_login_at = ?, updated_at = ? WHERE id = ?').run(nowIso(), nowIso(), staffId);
}

module.exports = {
  isLocked, recordFailure, clearFailures, _resetLockouts, burnTime, serializeStaff, touchLogin,
};
