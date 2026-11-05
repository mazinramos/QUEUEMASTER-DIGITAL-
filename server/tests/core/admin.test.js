'use strict';
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
process.env.LOGIN_RATE_MAX = '1000';
const h = require('./helpers');

let app; let c1; let c2; let svcA; let svcOther;
before(async () => {
  app = h.newApp();
  c1 = await h.mkClinic('Clinic One');
  c2 = await h.mkClinic('Clinic Two');
  await h.mkStaff(c1, 'adm1', 'admin');
  await h.mkStaff(c1, 'mgr1', 'manager');
  await h.mkStaff(c1, 'stf1', 'staff');
  await h.mkStaff(c2, 'adm2', 'admin');
  svcA = h.mkService(c1, 'A');
  svcOther = h.mkService(c2, 'Z');
});

const ADMIN_PATHS = ['/api/admin/clinic', '/api/admin/services', '/api/admin/counters', '/api/admin/staff', '/api/admin/audit'];

test('RBAC: unauthenticated -> 401 on every admin route', async () => {
  for (const p of ADMIN_PATHS) assert.equal((await h.request(app).get(p)).status, 401, p);
});

test('RBAC: staff role cannot reach any admin route (403)', async () => {
  const s = await h.login(app, 'stf1');
  for (const p of ADMIN_PATHS) assert.equal((await s.get(p)).status, 403, p);
  assert.equal((await s.post('/api/admin/services', { nameAr: 'x', prefix: 'Q' })).status, 403);
});

test('RBAC: manager can read lists but not write, nor read staff/audit', async () => {
  const m = await h.login(app, 'mgr1');
  assert.equal((await m.get('/api/admin/clinic')).status, 200);
  assert.equal((await m.get('/api/admin/services')).status, 200);
  assert.equal((await m.get('/api/admin/counters')).status, 200);
  assert.equal((await m.post('/api/admin/services', { nameAr: 'x', prefix: 'M' })).status, 403);
  assert.equal((await m.put('/api/admin/clinic', { nameAr: 'hacked' })).status, 403);
  assert.equal((await m.get('/api/admin/staff')).status, 403);
  assert.equal((await m.get('/api/admin/audit')).status, 403);
});

test('services CRUD + validation + duplicate prefix + audit', async () => {
  const a = await h.login(app, 'adm1');
  const bad = await a.post('/api/admin/services', { nameAr: '', prefix: 'TOOLONG' });
  assert.equal(bad.status, 400); assert.equal(bad.body.error.code, 'VALIDATION');
  assert.equal((await a.post('/api/admin/services', { nameAr: 'x', prefix: 'B', evil: 1 })).status, 400); // strict
  const created = await a.post('/api/admin/services', { nameAr: 'كشف', nameEn: 'Exam', prefix: 'b', estDurationMin: 15 });
  assert.equal(created.status, 201); assert.equal(created.body.data.prefix, 'B');
  assert.equal((await a.post('/api/admin/services', { nameAr: 'تاني', prefix: 'B' })).status, 409);
  const id = created.body.data.id;
  const upd = await a.put(`/api/admin/services/${id}`, { estDurationMin: 20, isActive: false });
  assert.equal(upd.body.data.estDurationMin, 20); assert.equal(upd.body.data.isActive, false);
  assert.equal((await a.get('/api/admin/services/abc')).status, 400);
  assert.equal((await a.del(`/api/admin/services/${id}`)).body.data.deleted, true);
  assert.equal((await a.get(`/api/admin/services/${id}`)).status, 404);
  const audit = await a.get('/api/admin/audit?action=service.');
  const actions = audit.body.data.items.map((i) => i.action);
  for (const x of ['service.create', 'service.update', 'service.delete']) assert.ok(actions.includes(x), x);
});

test('service with tickets is deactivated, not deleted', async () => {
  const a = await h.login(app, 'adm1');
  const sid = h.mkService(c1, 'T');
  const now = new Date().toISOString();
  h.getDb().prepare(`INSERT INTO tickets (public_id,clinic_id,service_id,business_date,seq_number,display_number,token_hash,issued_at,created_at,updated_at)
    VALUES ('pub1',?,?,?,1,'T-001','h1',?,?,?)`).run(c1, sid, '2026-11-05', now, now, now);
  const r = await a.del(`/api/admin/services/${sid}`);
  assert.equal(r.body.data.deactivated, true);
  assert.equal((await a.get(`/api/admin/services/${sid}`)).body.data.isActive, false);
});

test('counters CRUD with service assignment; foreign service ids rejected', async () => {
  const a = await h.login(app, 'adm1');
  const ok = await a.post('/api/admin/counters', { nameAr: 'شباك 1', nameEn: 'Counter 1', number: 1, serviceIds: [svcA] });
  assert.equal(ok.status, 201); assert.deepEqual(ok.body.data.serviceIds, [svcA]);
  assert.equal((await a.post('/api/admin/counters', { nameAr: 'dup', number: 1 })).status, 409);
  const foreign = await a.post('/api/admin/counters', { nameAr: 'x', number: 9, serviceIds: [svcOther] });
  assert.equal(foreign.status, 400);
  assert.equal(h.getDb().prepare('SELECT COUNT(*) c FROM counters WHERE number = 9').get().c, 0); // rolled back
  const upd = await a.put(`/api/admin/counters/${ok.body.data.id}`, { serviceIds: [] });
  assert.deepEqual(upd.body.data.serviceIds, []);
});

test('staff CRUD: temp password, must_change flag, services, reset-password, deactivate', async () => {
  const a = await h.login(app, 'adm1');
  const c = await a.post('/api/admin/staff', { username: 'Nurse.One', fullName: 'Nurse One', role: 'staff', serviceIds: [svcA], canCancel: true });
  assert.equal(c.status, 201);
  assert.equal(c.body.data.username, 'nurse.one');
  assert.equal(c.body.data.mustChangePassword, true);
  assert.ok(c.body.data.temporaryPassword.length >= 12);
  assert.equal(c.body.data.password_hash, undefined);
  assert.deepEqual(c.body.data.serviceIds, [svcA]);
  assert.equal((await a.post('/api/admin/staff', { username: 'nurse.one', fullName: 'Dup', role: 'staff' })).status, 409);
  assert.equal((await a.post('/api/admin/staff', { username: 'zz', fullName: 'Bad', role: 'root' })).status, 400);
  const first = await h.login(app, 'nurse.one', c.body.data.temporaryPassword);
  assert.equal(first.res.status, 200); assert.equal(first.res.body.data.staff.mustChangePassword, true);
  const rp = await a.post(`/api/admin/staff/${c.body.data.id}/reset-password`, {});
  assert.equal(rp.status, 200);
  assert.equal((await first.get('/api/auth/me')).status, 401); // old session killed
  assert.equal((await h.login(app, 'nurse.one', c.body.data.temporaryPassword)).res.status, 401);
  assert.equal((await h.login(app, 'nurse.one', rp.body.data.temporaryPassword)).res.status, 200);
  assert.equal((await a.del(`/api/admin/staff/${c.body.data.id}`)).status, 200);
  assert.equal((await h.login(app, 'nurse.one', rp.body.data.temporaryPassword)).res.status, 401);
  const audit = (await a.get('/api/admin/audit?entity=staff')).body.data.items;
  assert.ok(JSON.stringify(audit).indexOf(c.body.data.temporaryPassword) === -1);
  assert.ok(JSON.stringify(audit).indexOf(rp.body.data.temporaryPassword) === -1);
});

test('cannot demote/disable the last admin or yourself', async () => {
  const a = await h.login(app, 'adm1');
  const me = (await a.get('/api/auth/me')).body.data.staff.id;
  assert.equal((await a.put(`/api/admin/staff/${me}`, { role: 'staff' })).status, 409);
  assert.equal((await a.del(`/api/admin/staff/${me}`)).status, 409);
});

test('CLINIC ISOLATION: clinic 1 admin cannot see or touch clinic 2 data', async () => {
  const a1 = await h.login(app, 'adm1'); const a2 = await h.login(app, 'adm2');
  const s2 = await a2.post('/api/admin/services', { nameAr: 'عيادة 2', prefix: 'Q' });
  const k2 = await a2.post('/api/admin/counters', { nameAr: 'ش', number: 5 });
  const st2 = await a2.post('/api/admin/staff', { username: 'only.two', fullName: 'Two Only', role: 'staff' });
  const list = async (p, u) => (await u.get(p)).body.data;
  assert.ok(!(await list('/api/admin/services', a1)).some((x) => x.id === s2.body.data.id));
  assert.ok(!(await list('/api/admin/counters', a1)).some((x) => x.id === k2.body.data.id));
  assert.ok(!(await list('/api/admin/staff', a1)).some((x) => x.id === st2.body.data.id));
  assert.equal((await a1.get(`/api/admin/services/${s2.body.data.id}`)).status, 404);
  assert.equal((await a1.put(`/api/admin/services/${s2.body.data.id}`, { nameAr: 'pwn' })).status, 404);
  assert.equal((await a1.del(`/api/admin/services/${s2.body.data.id}`)).status, 404);
  assert.equal((await a1.put(`/api/admin/counters/${k2.body.data.id}`, { nameAr: 'pwn' })).status, 404);
  assert.equal((await a1.put(`/api/admin/staff/${st2.body.data.id}`, { fullName: 'pwn' })).status, 404);
  assert.equal((await a1.post(`/api/admin/staff/${st2.body.data.id}/reset-password`, {})).status, 404);
  assert.equal((await a1.del(`/api/admin/staff/${st2.body.data.id}`)).status, 404);
  assert.equal(h.getDb().prepare('SELECT name_ar FROM services WHERE id = ?').get(s2.body.data.id).name_ar, 'عيادة 2');
  // staff referencing a foreign counter/service is refused
  assert.equal((await a1.post('/api/admin/staff', { username: 'x.cross', fullName: 'Cross', role: 'staff', defaultCounterId: k2.body.data.id })).status, 400);
  assert.equal((await a1.post('/api/admin/staff', { username: 'x.cross2', fullName: 'Cross', role: 'staff', serviceIds: [s2.body.data.id] })).status, 400);
  // audit logs are scoped too
  const a1Audit = (await a1.get('/api/admin/audit?pageSize=200')).body.data.items;
  assert.ok(!a1Audit.some((i) => i.entityId === String(s2.body.data.id) && i.entity === 'service'));
});

test('clinic GET/PUT validation (timezone, email, language)', async () => {
  const a = await h.login(app, 'adm1');
  assert.equal((await a.put('/api/admin/clinic', { timezone: 'Mars/Phobos' })).status, 400);
  assert.equal((await a.put('/api/admin/clinic', { email: 'nope' })).status, 400);
  assert.equal((await a.put('/api/admin/clinic', { defaultLanguage: 'fr' })).status, 400);
  const r = await a.put('/api/admin/clinic', { nameEn: 'Clinic One EN', timezone: 'Africa/Cairo', defaultLanguage: 'en' });
  assert.equal(r.status, 200); assert.equal(r.body.data.defaultLanguage, 'en');
  assert.equal((await a.get('/api/admin/clinic')).body.data.id, c1);
});

test('audit endpoint: filters + pagination, admin only', async () => {
  const a = await h.login(app, 'adm1');
  const r = await a.get('/api/admin/audit?pageSize=2&page=1');
  assert.equal(r.status, 200); assert.equal(r.body.data.items.length, 2); assert.ok(r.body.data.total > 2);
  assert.equal((await a.get('/api/admin/audit?pageSize=9999')).status, 400);
});
