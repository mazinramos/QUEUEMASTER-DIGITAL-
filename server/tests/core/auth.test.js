'use strict';
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

let app; let c1;
before(async () => {
  process.env.LOGIN_RATE_MAX = '1000';
  app = h.newApp();
  c1 = await h.mkClinic('C1');
  await h.mkStaff(c1, 'adm', 'admin');
  await h.mkStaff(c1, 'mustchg', 'staff', { must_change_password: 1 });
});

test('health is public and uses the standard envelope', async () => {
  const r = await h.request(app).get('/api/health');
  assert.equal(r.status, 200); assert.equal(r.body.ok, true); assert.equal(r.body.data.status, 'ok');
});

test('login success sets HttpOnly SameSite cookie and returns staff', async () => {
  const s = await h.login(app, 'adm');
  assert.equal(s.res.status, 200);
  assert.equal(s.res.body.data.staff.role, 'admin');
  const cookie = s.res.headers['set-cookie'].find((x) => x.startsWith('qm.sid='));
  assert.match(cookie, /HttpOnly/i); assert.match(cookie, /SameSite=Lax/i);
  assert.equal(s.res.body.data.staff.password_hash, undefined);
  const me = await s.get('/api/auth/me');
  assert.equal(me.status, 200); assert.equal(me.body.data.staff.username, 'adm');
});

test('wrong password / unknown user give the same 401', async () => {
  const a = await h.login(app, 'adm', 'wrong-password-123');
  const b = await h.login(app, 'ghost', 'wrong-password-123');
  assert.equal(a.res.status, 401); assert.equal(b.res.status, 401);
  assert.equal(a.res.body.error.message, b.res.body.error.message);
  assert.equal(a.res.body.error.code, 'UNAUTHENTICATED');
});

test('/me without session is 401; logout invalidates the session', async () => {
  assert.equal((await h.request(app).get('/api/auth/me')).status, 401);
  const s = await h.login(app, 'adm');
  assert.equal((await s.post('/api/auth/logout', {})).status, 200);
  assert.equal((await s.get('/api/auth/me')).status, 401);
});

test('session id rotates on login (anti fixation)', async () => {
  const { hashSid } = require('../../src/middleware/session');
  const agent = h.request.agent(app);
  const c = await agent.get('/api/auth/csrf');
  const oldSid = /qm\.sid=([^;]+)/.exec(c.headers['set-cookie'][0])[1];
  assert.ok(h.getDb().prepare('SELECT 1 FROM sessions WHERE sid = ?').get(hashSid(decodeURIComponent(oldSid))));
  const l = await agent.post('/api/auth/login').set('X-CSRF-Token', c.body.data.csrfToken).send({ username: 'adm', password: h.PW });
  assert.equal(l.status, 200);
  const sids = l.headers['set-cookie'].map((x) => /^qm\.sid=([^;]*)/.exec(x)).filter(Boolean).map((m) => m[1]).filter(Boolean);
  const newSid = sids[sids.length - 1];
  assert.notEqual(newSid, oldSid);
  assert.equal(h.getDb().prepare('SELECT 1 FROM sessions WHERE sid = ?').get(hashSid(decodeURIComponent(oldSid))), undefined);
  assert.notEqual(l.body.data.csrfToken, c.body.data.csrfToken);
});

test('password is stored as argon2id', () => {
  const row = h.getDb().prepare("SELECT password_hash FROM staff WHERE username='adm'").get();
  assert.match(row.password_hash, /^\$argon2id\$/);
});

test('change-password: validates, rotates, clears must_change flag', async () => {
  const s = await h.login(app, 'mustchg');
  // blocked from other APIs until password changed
  const blocked = await s.get('/api/admin/clinic');
  assert.equal(blocked.status, 403);
  assert.equal((await s.post('/api/auth/change-password', { currentPassword: 'nope-nope-nope', newPassword: 'AnotherPass-123' })).status, 400);
  assert.equal((await s.post('/api/auth/change-password', { currentPassword: h.PW, newPassword: 'short' })).status, 400);
  const ok = await s.post('/api/auth/change-password', { currentPassword: h.PW, newPassword: 'AnotherPass-123' });
  assert.equal(ok.status, 200);
  const again = await h.login(app, 'mustchg', 'AnotherPass-123');
  assert.equal(again.res.status, 200);
  assert.equal(again.res.body.data.staff.mustChangePassword, false);
});

test('login validation rejects malformed input', async () => {
  const agent = h.request.agent(app);
  const csrf = (await agent.get('/api/auth/csrf')).body.data.csrfToken;
  const r = await agent.post('/api/auth/login').set('X-CSRF-Token', csrf).send({ username: { $ne: 1 }, password: 5 });
  assert.equal(r.status, 400); assert.equal(r.body.error.code, 'VALIDATION');
});

test('audit log records login and failed login without secrets', async () => {
  await h.login(app, 'adm', 'wrong-password-123');
  const rows = h.getDb().prepare("SELECT action, details FROM audit_logs WHERE action LIKE 'auth.%'").all();
  assert.ok(rows.some((r) => r.action === 'auth.login'));
  assert.ok(rows.some((r) => r.action === 'auth.login_failed'));
  assert.ok(!rows.some((r) => /wrong-password|Str0ng/.test(r.details || '')));
});
