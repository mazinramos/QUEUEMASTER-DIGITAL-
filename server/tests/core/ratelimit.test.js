'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
process.env.LOGIN_RATE_MAX = '4';
process.env.LOCK_AFTER_FAILS = '100';
const h = require('./helpers');

test('login endpoint is rate limited (429 RATE_LIMITED)', async () => {
  const app = h.newApp();
  const agent = h.request.agent(app);
  const csrf = (await agent.get('/api/auth/csrf')).body.data.csrfToken;
  const codes = [];
  for (let i = 0; i < 7; i++) {
    const r = await agent.post('/api/auth/login').set('X-CSRF-Token', csrf).send({ username: 'nobody', password: 'whatever-123' });
    codes.push(r.status);
  }
  assert.ok(codes.includes(429), `statuses: ${codes}`);
  assert.equal(codes[0], 401);
});
