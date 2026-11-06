'use strict';
const { test, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
process.env.LOGIN_RATE_MAX = '1000';
const h = require('./helpers');
const config = require('../../src/config');

let app;
before(async () => {
  app = h.newApp();
  const c = await h.mkClinic('C1');
  await h.mkStaff(c, 'adm', 'admin');
});
beforeEach(() => { config.session.secureCookie = 'false'; });

async function loginFrom(host, headers = {}) {
  const csrfRes = await h.request(app).get('/api/auth/csrf').set('Host', host).set(headers);
  const jar = csrfRes.headers['set-cookie'].map((c) => c.split(';')[0]).join('; ');
  const r = await h.request(app).post('/api/auth/login').set('Host', host).set(headers).set('Cookie', jar)
    .set('X-CSRF-Token', csrfRes.body.data.csrfToken).send({ username: 'adm', password: h.PW });
  const setCookies = r.headers['set-cookie'] || [];
  const session = setCookies.filter((c) => /^qm\.sid=[^;]+/.test(c)).pop();
  return { r, session };
}

test('default (false): login from a phone on http://192.168.x.x works, cookie has NO Secure flag', async () => {
  const { r, session } = await loginFrom('192.168.1.50:3000');
  assert.equal(r.status, 200);
  assert.ok(session);
  assert.doesNotMatch(session, /;\s*Secure/i);
  assert.match(session, /HttpOnly/i); assert.match(session, /SameSite=Lax/i);
  // a browser would send exactly this cookie back over http -> still authenticated
  const me = await h.request(app).get('/api/auth/me').set('Host', '192.168.1.50:3000').set('Cookie', session.split(';')[0]);
  assert.equal(me.status, 200);
});

test('auto: http -> no Secure; https via trusted proxy header -> Secure', async () => {
  config.session.secureCookie = 'auto';
  const plain = await loginFrom('192.168.1.50:3000');
  assert.doesNotMatch(plain.session, /;\s*Secure/i);
  const tls = await loginFrom('clinic.example', { 'X-Forwarded-Proto': 'https' });
  assert.match(tls.session, /;\s*Secure/i);
});

test('true: always Secure', async () => {
  config.session.secureCookie = 'true';
  const { session } = await loginFrom('192.168.1.50:3000');
  assert.match(session, /;\s*Secure/i);
});

test('logout clears the cookie with matching attributes', async () => {
  const s = await h.login(app, 'adm');
  const r = await s.post('/api/auth/logout', {});
  assert.ok(r.headers['set-cookie'].some((c) => /^qm\.sid=;/.test(c)));
});
