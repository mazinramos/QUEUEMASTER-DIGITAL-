'use strict';
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
process.env.LOGIN_RATE_MAX = '1000';
process.env.LOCK_AFTER_FAILS = '3';
const h = require('./helpers');

let app;
before(async () => {
  app = h.newApp();
  const c = await h.mkClinic('C1');
  await h.mkStaff(c, 'adm', 'admin');
  await h.mkStaff(c, 'locky', 'staff');
});

test('CSRF: mutating request without / with wrong token is rejected', async () => {
  const s = await h.login(app, 'adm');
  const none = await s.agent.post('/api/admin/services').send({ nameAr: 'x', prefix: 'X' });
  assert.equal(none.status, 403);
  const bad = await s.agent.post('/api/admin/services').set('X-CSRF-Token', 'forged').send({ nameAr: 'x', prefix: 'X' });
  assert.equal(bad.status, 403);
  const good = await s.post('/api/admin/services', { nameAr: 'x', prefix: 'X' });
  assert.equal(good.status, 201);
});

test('CSRF: token from another session is rejected', async () => {
  const a = await h.login(app, 'adm'); const b = await h.login(app, 'adm');
  const r = await a.agent.post('/api/admin/services').set('X-CSRF-Token', b.csrf).send({ nameAr: 'y', prefix: 'Y' });
  assert.equal(r.status, 403);
});

test('lockout after repeated failures, even with the right password', async () => {
  for (let i = 0; i < 3; i++) assert.equal((await h.login(app, 'locky', 'bad-password-xx')).res.status, 401);
  const locked = await h.login(app, 'locky');
  assert.equal(locked.res.status, 429); assert.equal(locked.res.body.error.code, 'RATE_LIMITED');
  require('../../src/services/authService')._resetLockouts();
  assert.equal((await h.login(app, 'locky')).res.status, 200);
});

test('security headers: CSP, nosniff, no x-powered-by, no-store on API', async () => {
  const r = await h.request(app).get('/api/health');
  assert.match(r.headers['content-security-policy'], /default-src 'self'/);
  assert.doesNotMatch(r.headers['content-security-policy'], /https?:\/\/(?!localhost)/); // no external CDN
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
  assert.equal(r.headers['x-powered-by'], undefined);
  assert.equal(r.headers['cache-control'], 'no-store');
});

test('malformed JSON gives 400 envelope, unknown API route 404 envelope', async () => {
  const bad = await h.request(app).post('/api/auth/login').set('Content-Type', 'application/json').send('{oops');
  assert.equal(bad.status, 400); assert.equal(bad.body.ok, false);
  const nf = await h.request(app).get('/api/does-not-exist');
  assert.equal(nf.status, 404); assert.equal(nf.body.error.code, 'NOT_FOUND');
});

test('expired and idle sessions are rejected', async () => {
  const s = await h.login(app, 'adm');
  h.getDb().prepare('UPDATE sessions SET expires_at = ?').run(new Date(Date.now() - 1000).toISOString());
  assert.equal((await s.get('/api/auth/me')).status, 401);
});

test('disabling a user kills their live session', async () => {
  const s = await h.login(app, 'locky');
  assert.equal((await s.get('/api/auth/me')).status, 200);
  h.getDb().prepare("UPDATE staff SET is_active = 0 WHERE username = 'locky'").run();
  assert.equal((await s.get('/api/auth/me')).status, 401);
  assert.equal((await h.login(app, 'locky')).res.status, 401);
});
