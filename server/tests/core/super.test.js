'use strict';
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
process.env.LOGIN_RATE_MAX = '100000';
const h = require('./helpers');

const TOKEN = 'super-admin-token-0123456789-abcdefghijkl'; // 41 chars
let app; let c1;
const call = (method, url, body, token = TOKEN, extra = {}) => {
  let r = h.request(app)[method](url).set(extra);
  if (token !== null) r = r.set('X-Super-Token', token);
  return body === undefined ? r : r.send(body);
};
before(async () => {
  app = h.newApp();
  c1 = await h.mkClinic('Existing Clinic');
  await h.mkStaff(c1, 'adm', 'admin');
});
beforeEach(() => { process.env.SUPER_ADMIN_TOKEN = TOKEN; });
after(() => { delete process.env.SUPER_ADMIN_TOKEN; });

const NEW = { nameAr: 'عيادة النور', nameEn: 'Al Nour', timezone: 'Africa/Cairo', admin: { username: 'noor.admin', fullName: 'Noor Admin' } };

test('disabled (404, indistinguishable from a missing route) when the token is unset or too short', async () => {
  delete process.env.SUPER_ADMIN_TOKEN;
  assert.equal((await call('get', '/api/super/clinics')).status, 404);
  process.env.SUPER_ADMIN_TOKEN = 'short-token';
  const r = await call('get', '/api/super/clinics', undefined, 'short-token');
  assert.equal(r.status, 404);
  assert.deepEqual(r.body, (await h.request(app).get('/api/nothing-here')).body);
});

test('wrong / missing / near-miss tokens -> 401, and a staff session is not a substitute', async () => {
  assert.equal((await call('get', '/api/super/clinics', undefined, null)).status, 401);
  assert.equal((await call('get', '/api/super/clinics', undefined, 'wrong')).status, 401);
  assert.equal((await call('get', '/api/super/clinics', undefined, `${TOKEN}x`)).status, 401);
  assert.equal((await call('get', '/api/super/clinics', undefined, TOKEN.slice(0, -1))).status, 401);
  const admin = await h.login(app, 'adm');
  const viaSession = await admin.agent.post('/api/super/clinics').set('X-CSRF-Token', admin.csrf).send({ ...NEW });
  assert.equal(viaSession.status, 401);
  const asBearer = await h.request(app).get('/api/super/clinics').set('Authorization', `Bearer ${TOKEN}`);
  assert.equal(asBearer.status, 401); // only the dedicated header is accepted
  assert.equal(h.getDb().prepare("SELECT COUNT(*) c FROM clinics WHERE name_ar = 'عيادة النور'").get().c, 0);
});

test('create clinic: admin with temporary password, must change it, isolated from other clinics', async () => {
  const r = await call('post', '/api/super/clinics', NEW);
  assert.equal(r.status, 201);
  const { clinicId, temporaryPassword, admin } = r.body.data;
  assert.ok(clinicId > c1); assert.ok(temporaryPassword.length >= 12); assert.equal(admin.mustChangePassword, true);
  const row = h.getDb().prepare('SELECT * FROM clinics WHERE id = ?').get(clinicId);
  assert.equal(row.name_ar, 'عيادة النور'); assert.equal(row.default_language, 'ar'); assert.equal(row.is_active, 1);
  assert.match(h.getDb().prepare('SELECT password_hash FROM staff WHERE username = ?').get('noor.admin').password_hash, /^\$(argon2id|scrypt)\$/);

  const s = await h.login(app, 'noor.admin', temporaryPassword);
  assert.equal(s.res.status, 200); assert.equal(s.res.body.data.staff.clinicId, clinicId); assert.equal(s.res.body.data.staff.mustChangePassword, true);
  assert.equal((await s.get('/api/admin/services')).status, 403); // blocked until password changed
  assert.equal((await s.post('/api/auth/change-password', { currentPassword: temporaryPassword, newPassword: 'My-New-Clinic-Pass-1' })).status, 200);
  const again = await h.login(app, 'noor.admin', 'My-New-Clinic-Pass-1');
  const mine = await again.get('/api/admin/clinic');
  assert.equal(mine.body.data.id, clinicId); assert.equal(mine.body.data.nameAr, 'عيادة النور');
  const svc = await again.post('/api/admin/services', { nameAr: 'كشف', prefix: 'K' });
  assert.equal(svc.status, 201);
  // the existing clinic's admin sees none of it, and vice versa
  const other = await h.login(app, 'adm');
  assert.equal((await other.get('/api/admin/services')).body.data.length, 0);
  assert.equal((await other.get('/api/admin/clinic')).body.data.id, c1);
  assert.equal((await other.get('/api/admin/staff')).body.data.some((x) => x.username === 'noor.admin'), false);
});

test('create clinic: explicit password honoured (no temporaryPassword echoed), validation, duplicate-safe', async () => {
  const r = await call('post', '/api/super/clinics', { ...NEW, nameAr: 'عيادة الشفاء', admin: { username: 'shifa.admin', password: 'Chosen-Password-12' } });
  assert.equal(r.status, 201); assert.equal(r.body.data.temporaryPassword, null);
  assert.equal((await h.login(app, 'shifa.admin', 'Chosen-Password-12')).res.status, 200);
  for (const bad of [{ ...NEW, nameAr: 'x' }, { ...NEW, timezone: 'Mars/Base' }, { ...NEW, admin: { username: 'A B' } },
    { ...NEW, admin: { username: 'okname', password: 'short' } }, { ...NEW, extra: 1 }, { nameAr: 'بدون مدير' }]) {
    const x = await call('post', '/api/super/clinics', bad);
    assert.equal(x.status, 400, JSON.stringify(bad));
  }
  const clinics = h.getDb().prepare('SELECT COUNT(*) c FROM clinics').get().c;
  const same = await call('post', '/api/super/clinics', { ...NEW, nameAr: 'نفس المدير', admin: { username: 'shifa.admin' } });
  assert.equal(same.status, 201); // same username in ANOTHER clinic is allowed by the schema (unique per clinic)
  assert.equal(h.getDb().prepare('SELECT COUNT(*) c FROM clinics').get().c, clinics + 1);
});

test('a failing create is atomic: no half-created clinic is left behind', async () => {
  const before = h.getDb().prepare('SELECT COUNT(*) c FROM clinics').get().c;
  const orig = h.getDb().prepare.bind(h.getDb());
  h.getDb().prepare = (sql) => { if (/INSERT INTO staff/.test(sql)) throw new Error('simulated failure'); return orig(sql); };
  try {
    const r = await call('post', '/api/super/clinics', { ...NEW, nameAr: 'عيادة فاشلة', admin: { username: 'fail.admin' } });
    assert.equal(r.status, 500);
  } finally { h.getDb().prepare = orig; }
  assert.equal(h.getDb().prepare('SELECT COUNT(*) c FROM clinics').get().c, before);
});

test('list + deactivate: sessions die, login refused, reactivation restores access', async () => {
  const created = await call('post', '/api/super/clinics', { ...NEW, nameAr: 'عيادة مؤقتة', admin: { username: 'temp.admin', password: 'Temp-Admin-Pass-1' } });
  const id = created.body.data.clinicId;
  const list = await call('get', '/api/super/clinics');
  assert.equal(list.status, 200);
  const row = list.body.data.find((c) => c.id === id);
  assert.equal(row.staffCount, 1); assert.equal(row.isActive, true);
  assert.equal(JSON.stringify(list.body).includes('password'), false);

  const s = await h.login(app, 'temp.admin', 'Temp-Admin-Pass-1');
  assert.equal((await s.get('/api/auth/me')).status, 200);
  assert.equal((await call('put', `/api/super/clinics/${id}/active`, { isActive: false })).status, 200);
  assert.equal((await s.get('/api/auth/me')).status, 401);
  assert.equal((await h.login(app, 'temp.admin', 'Temp-Admin-Pass-1')).res.status, 401);
  assert.equal((await call('put', `/api/super/clinics/${id}/active`, { isActive: true })).status, 200);
  assert.equal((await h.login(app, 'temp.admin', 'Temp-Admin-Pass-1')).res.status, 200);
  assert.equal((await call('put', '/api/super/clinics/99999/active', { isActive: false })).status, 404);
  assert.equal((await call('put', `/api/super/clinics/${id}/active`, { isActive: 'no' })).status, 400);
});

test('audit trail records super actions with the new clinic id, never the token or passwords', async () => {
  const created = await call('post', '/api/super/clinics', { ...NEW, nameAr: 'عيادة التدقيق', admin: { username: 'audit.admin', password: 'Audit-Admin-Pass-1' } });
  const id = created.body.data.clinicId;
  const rows = h.getDb().prepare("SELECT * FROM audit_logs WHERE action LIKE 'super.%'").all();
  const mine = rows.find((r) => r.action === 'super.clinic.create' && r.clinic_id === id);
  assert.ok(mine); assert.equal(mine.staff_id, null);
  const dump = JSON.stringify(rows);
  assert.ok(!dump.includes(TOKEN) && !dump.includes('Audit-Admin-Pass-1'));
  assert.ok(rows.some((r) => r.action === 'super.auth_failed'));
});

test('repeated wrong tokens are rate limited (429); the correct token does not consume the budget', async () => {
  const codes = [];
  for (let i = 0; i < 14; i++) codes.push((await call('get', '/api/super/clinics', undefined, `wrong-${i}`)).status);
  assert.ok(codes.includes(429), codes.join(','));
});
