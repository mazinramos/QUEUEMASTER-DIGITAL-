'use strict';
const { getDb, nowIso } = require('../database');
const config = require('../config');
const { hashPassword, verifyPassword } = require('../utils/password');

// ---- قفل الحساب المؤقت (محفوظ في جدول login_attempts) ----
const L = () => config.rateLimit;
const windowMs = () => Math.max(L().lockMinutes, 15) * 60 * 1000; // بعدها يُنسى العدّاد
const ipThreshold = () => L().lockAfterFails * 5;

function attemptKeys(staff, username, ip) {
  return {
    user: staff ? { scope: 'user', key: `s:${staff.id}`, staffId: staff.id }
      : { scope: 'user', key: `u:${String(username).toLowerCase().slice(0, 64)}`, staffId: null },
    ip: ip ? { scope: 'ip', key: String(ip).slice(0, 64), staffId: null } : null,
  };
}

// هل أحد المفتاحين مقفول الآن؟ => { locked, retryAfterSec }
function checkLock(keys) {
  const db = getDb(); const now = Date.now(); let retry = 0;
  for (const k of [keys.user, keys.ip]) {
    if (!k) continue;
    const row = db.prepare('SELECT locked_until FROM login_attempts WHERE scope = ? AND key = ?').get(k.scope, k.key);
    const until = row && row.locked_until ? Date.parse(row.locked_until) : 0;
    if (until > now) retry = Math.max(retry, Math.ceil((until - now) / 1000));
  }
  return { locked: retry > 0, retryAfterSec: retry };
}

function bump(k, threshold) {
  const db = getDb(); const now = Date.now(); const iso = nowIso();
  db.transaction(() => {
    const row = db.prepare('SELECT count, updated_at FROM login_attempts WHERE scope = ? AND key = ?').get(k.scope, k.key);
    let count = row && now - Date.parse(row.updated_at) <= windowMs() ? row.count : 0;
    count += 1;
    let lockedUntil = null;
    if (count >= threshold) { lockedUntil = new Date(now + L().lockMinutes * 60 * 1000).toISOString(); count = 0; }
    db.prepare(`INSERT INTO login_attempts (scope, key, staff_id, count, locked_until, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?)
        ON CONFLICT(scope, key) DO UPDATE SET count = excluded.count, locked_until = excluded.locked_until,
          staff_id = COALESCE(excluded.staff_id, login_attempts.staff_id), updated_at = excluded.updated_at`)
      .run(k.scope, k.key, k.staffId, count, lockedUntil, iso, iso);
  }).immediate();
}
function recordFailure(keys) {
  bump(keys.user, L().lockAfterFails);
  if (keys.ip) bump(keys.ip, ipThreshold());
}
// نجاح الدخول يصفّر عدّاد المستخدم فقط (عدّاد الـ IP لا يُصفَّر حتى لا يُستغل حساب صحيح)
function clearFailures(keys) {
  getDb().prepare('DELETE FROM login_attempts WHERE scope = ? AND key = ?').run(keys.user.scope, keys.user.key);
}
function unlockStaff(staffId) {
  return getDb().prepare("DELETE FROM login_attempts WHERE scope = 'user' AND staff_id = ?").run(staffId).changes;
}
function purgeAttempts() {
  const cutoff = new Date(Date.now() - windowMs()).toISOString();
  return getDb().prepare('DELETE FROM login_attempts WHERE (locked_until IS NULL OR locked_until < ?) AND updated_at < ?')
    .run(new Date().toISOString(), cutoff).changes;
}
const _resetLockouts = () => getDb().prepare('DELETE FROM login_attempts').run(); // اختبارات فقط

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
  attemptKeys, checkLock, recordFailure, clearFailures, unlockStaff, purgeAttempts, _resetLockouts,
  burnTime, serializeStaff, touchLogin,
};
