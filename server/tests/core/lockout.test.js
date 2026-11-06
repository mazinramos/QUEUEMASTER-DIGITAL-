'use strict';
const { test, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
process.env.LOGIN_RATE_MAX = '100000';
const h = require('./helpers');
const config = require('../../src/config');
const svc = require('../../src/services/authService');

let app; let c1; let c2; let staffId;
before(async () => {
  app = h.newApp();
  c1 = await h.mkClinic('C1'); c2 = await h.mkClinic('C2');
  await h.mkStaff(c1, 'adm', 'admin');
  staffId = await h.mkStaff(c1, 'locky', 'staff');
  await h.mkStaff(c1, 'dup', 'staff'); await h.mkStaff(c2, 'dup', 'staff');
});
beforeEach(() => { svc._resetLockouts(); config.rateLimit.lockAfterFails = 3; config.rateLimit.lockMinutes = 15; });

const bad = (u, extra = {}) => h.login(app, u, 'wrong-password-xx').then((s) => s.res);
async function loginBody(username, password, extra = {}) {
  const agent = h.request.agent(app);
  const csrf = (await agent.get('/api/auth/csrf')).body.data.csrfToken;
  return agent.post('/api/auth/login').set('X-CSRF-Token', csrf).send({ username, password, ...extra });
}

test('locks after N failures, with Retry-After; correct password is refused while locked', async () => {
  for (let i = 0; i < 3; i++) assert.equal((await bad('locky')).status, 401);
  const locked = await h.login(app, 'locky');
  assert.equal(locked.res.status, 429);
  assert.equal(locked.res.body.error.code, 'RATE_LIMITED');
  const ra = Number(locked.res.headers['retry-after']);
  assert.ok(ra > 0 && ra <= 15 * 60, `retry-after=${ra}`);
});

test('lock lives in the DB row (survives anything in process memory)', async () => {
  for (let i = 0; i < 3; i++) await bad('locky');
  const row = h.getDb().prepare("SELECT * FROM login_attempts WHERE scope='user' AND staff_id = ?").get(staffId);
  assert.ok(row && Date.parse(row.locked_until) > Date.now());
  assert.equal(row.key, `s:${staffId}`);
  const app2 = h.newApp(); // "restart": brand-new app instance, no shared memory
  const agent = h.request.agent(app2);
  const csrf = (await agent.get('/api/auth/csrf')).body.data.csrfToken;
  const r = await agent.post('/api/auth/login').set('X-CSRF-Token', csrf).send({ username: 'locky', password: h.PW });
  assert.equal(r.status, 429);
});

test('lock survives a REAL process restart (file DB, two separate node processes)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qm-lock-'));
  const env = { PATH: process.env.PATH, HOME: dir, NODE_ENV: 'development', DATA_DIR: dir, LOCK_AFTER_FAILS: '3' };
  const run = (code) => spawnSync(process.execPath, ['-e', code], { cwd: path.join(__dirname, '..', '..'), env, encoding: 'utf8' });
  const a = run(`
    const { getDb, nowIso } = require('./src/database'); require('./src/database/migrate').runMigrations(getDb());
    const now = nowIso(); const db = getDb();
    db.prepare("INSERT INTO clinics (name_ar,created_at,updated_at) VALUES ('c',?,?)").run(now, now);
    db.prepare("INSERT INTO staff (clinic_id,username,password_hash,full_name,role,created_at,updated_at) VALUES (1,'u1','x','U','staff',?,?)").run(now, now);
    const svc = require('./src/services/authService');
    const keys = svc.attemptKeys({ id: 1 }, 'u1', '10.0.0.9');
    for (let i = 0; i < 3; i++) svc.recordFailure(keys);
    console.log(JSON.stringify(svc.checkLock(keys)));`);
  assert.equal(a.status, 0, a.stderr);
  assert.equal(JSON.parse(a.stdout).locked, true);
  const b = run(`
    const svc = require('./src/services/authService'); const { getDb } = require('./src/database');
    console.log(JSON.stringify(svc.checkLock(svc.attemptKeys({ id: 1 }, 'u1', '10.0.0.9'))));`);
  assert.equal(b.status, 0, b.stderr);
  const st = JSON.parse(b.stdout);
  assert.equal(st.locked, true); assert.ok(st.retryAfterSec > 0);
});

test('unknown usernames lock too, with an identical response shape (no user enumeration)', async () => {
  for (let i = 0; i < 3; i++) await bad('ghost');
  const ghost = await loginBody('ghost', 'whatever-123');
  for (let i = 0; i < 3; i++) await bad('locky');
  const real = await loginBody('locky', 'whatever-123');
  assert.equal(ghost.status, 429); assert.equal(real.status, 429);
  assert.deepEqual(ghost.body, real.body);
});

test('success resets the user counter; stale counters are forgotten', async () => {
  await bad('locky'); await bad('locky');
  assert.equal((await h.login(app, 'locky')).res.status, 200);
  assert.equal(h.getDb().prepare("SELECT COUNT(*) c FROM login_attempts WHERE scope='user' AND staff_id=?").get(staffId).c, 0);
  await bad('locky'); await bad('locky');
  assert.equal((await h.login(app, 'locky')).res.status, 200); // 2 fails (not 4) => no lock
  await bad('locky'); await bad('locky');
  h.getDb().prepare("UPDATE login_attempts SET updated_at = ? WHERE scope='user'").run(new Date(Date.now() - 3600e3).toISOString());
  await bad('locky'); // counter restarted from 1, not 3
  assert.equal((await h.login(app, 'locky')).res.status, 200);
});

test('lock expires by itself', async () => {
  for (let i = 0; i < 3; i++) await bad('locky');
  h.getDb().prepare("UPDATE login_attempts SET locked_until = ?").run(new Date(Date.now() - 1000).toISOString());
  assert.equal((await h.login(app, 'locky')).res.status, 200);
});

test('same username in two clinics is locked independently', async () => {
  for (let i = 0; i < 3; i++) await loginBody('dup', 'nope-nope-123', { clinicId: c1 });
  assert.equal((await loginBody('dup', h.PW, { clinicId: c1 })).status, 429);
  assert.equal((await loginBody('dup', h.PW, { clinicId: c2 })).status, 200);
});

test('IP lock stops spraying many usernames from one address', async () => {
  config.rateLimit.lockAfterFails = 2; // ip threshold = 10
  for (let i = 0; i < 10; i++) await bad(`spray${i}`);
  const r = await loginBody('adm', h.PW); // valid credentials, but the address is locked
  assert.equal(r.status, 429);
});

test('admin unlock + reset-password clear the lock; staff cannot unlock; cross-clinic unlock is 404', async () => {
  for (let i = 0; i < 3; i++) await bad('locky');
  assert.equal((await h.login(app, 'locky')).res.status, 429);
  svc._resetLockouts(); // admin itself is not locked
  const adm = await h.login(app, 'adm');
  for (let i = 0; i < 3; i++) await bad('locky');
  const r = await adm.post(`/api/admin/staff/${staffId}/unlock`, {});
  assert.equal(r.status, 200);
  assert.equal((await h.login(app, 'locky')).res.status, 200);
  const other = h.getDb().prepare("SELECT id FROM staff WHERE clinic_id = ? AND username = 'dup'").get(c2).id;
  assert.equal((await adm.post(`/api/admin/staff/${other}/unlock`, {})).status, 404);
  const s = await h.login(app, 'locky');
  assert.equal((await s.post(`/api/admin/staff/${staffId}/unlock`, {})).status, 403);
  const audit = (await adm.get('/api/admin/audit?action=staff.unlock')).body.data.items;
  assert.ok(audit.length >= 1);
});

test('login_attempts never stores passwords; purge removes stale rows', async () => {
  await bad('locky');
  const rows = JSON.stringify(h.getDb().prepare('SELECT * FROM login_attempts').all());
  assert.ok(!/wrong-password|Str0ng/.test(rows));
  h.getDb().prepare('UPDATE login_attempts SET updated_at = ?').run(new Date(Date.now() - 86400e3).toISOString());
  assert.ok(svc.purgeAttempts() >= 1);
  assert.equal(h.getDb().prepare('SELECT COUNT(*) c FROM login_attempts').get().c, 0);
});
