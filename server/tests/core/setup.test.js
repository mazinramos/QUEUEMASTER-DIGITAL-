'use strict';
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

let app;
before(() => { app = h.newApp(); });

const body = { clinicName: 'عيادة جديدة', username: 'owner', password: 'First-Run-Pass-1' };

test('setup requires csrf (session) and valid input', async () => {
  const agent = h.request.agent(app);
  assert.equal((await agent.post('/api/auth/setup').send(body)).status, 403);
  const csrf = (await agent.get('/api/auth/csrf')).body.data.csrfToken;
  const weak = await agent.post('/api/auth/setup').set('X-CSRF-Token', csrf).send({ ...body, password: '123' });
  assert.equal(weak.status, 400);
});

test('setup creates clinic + admin once, then is locked forever', async () => {
  const agent = h.request.agent(app);
  const csrf = (await agent.get('/api/auth/csrf')).body.data.csrfToken;
  const first = await agent.post('/api/auth/setup').set('X-CSRF-Token', csrf).send(body);
  assert.equal(first.status, 201);
  assert.equal(h.getDb().prepare("SELECT COUNT(*) c FROM staff WHERE role='admin'").get().c, 1);
  const second = await agent.post('/api/auth/setup').set('X-CSRF-Token', csrf).send({ ...body, username: 'hacker' });
  assert.equal(second.status, 403);
  assert.equal(h.getDb().prepare("SELECT COUNT(*) c FROM staff WHERE username='hacker'").get().c, 0);
  const l = await h.login(app, 'owner', body.password);
  assert.equal(l.res.status, 200); assert.equal(l.res.body.data.staff.role, 'admin');
});
