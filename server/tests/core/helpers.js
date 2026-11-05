'use strict';
// Must be required BEFORE app modules: configures an isolated in-memory DB.
process.env.NODE_ENV = 'test';
process.env.DB_PATH = ':memory:';
const request = require('supertest');

const { createApp } = require('../../src/app');
const { getDb, nowIso } = require('../../src/database');
const { hashPassword } = require('../../src/utils/password');

const PW = 'Str0ng-Test-Pass!';
let hashCache;

async function mkClinic(name) {
  const now = nowIso();
  return getDb().prepare('INSERT INTO clinics (name_ar,created_at,updated_at) VALUES (?,?,?)').run(name, now, now).lastInsertRowid;
}
async function mkStaff(clinicId, username, role = 'staff', extra = {}) {
  hashCache = hashCache || (await hashPassword(PW));
  const now = nowIso();
  return getDb().prepare(`INSERT INTO staff (clinic_id,username,password_hash,full_name,role,can_cancel,can_skip_return,can_transfer,
    must_change_password,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(clinicId, username, hashCache, `Name ${username}`, role, extra.can_cancel || 0, extra.can_skip_return || 0,
      extra.can_transfer || 0, extra.must_change_password || 0, now, now).lastInsertRowid;
}
const mkService = (clinicId, prefix) => {
  const now = nowIso();
  return getDb().prepare('INSERT INTO services (clinic_id,name_ar,prefix,created_at,updated_at) VALUES (?,?,?,?,?)')
    .run(clinicId, `خدمة ${prefix}`, prefix, now, now).lastInsertRowid;
};

function newApp() { return createApp(); }

// logged-in agent with csrf token helper
async function login(app, username, password = PW) {
  const agent = request.agent(app);
  const c = await agent.get('/api/auth/csrf');
  let csrf = c.body.data.csrfToken;
  const r = await agent.post('/api/auth/login').set('X-CSRF-Token', csrf).send({ username, password });
  if (r.status === 200) csrf = r.body.data.csrfToken;
  return { agent, csrf, res: r,
    post: (u, b) => agent.post(u).set('X-CSRF-Token', csrf).send(b),
    put: (u, b) => agent.put(u).set('X-CSRF-Token', csrf).send(b),
    del: (u) => agent.delete(u).set('X-CSRF-Token', csrf),
    get: (u) => agent.get(u) };
}
module.exports = { request, newApp, getDb, mkClinic, mkStaff, mkService, login, PW };
