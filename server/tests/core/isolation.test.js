'use strict';
// عزل العيادات على المسارات التي يملكها حساب 2/3/5 (طابور، مريض، تذاكر، تقارير، إعلانات، شاشات).
// تتخطى نفسها تلقائياً إن لم تكن هذه المسارات محمّلة (فرع acct-1 وحده)، وتعمل كاملة على الشجرة المدمجة.
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
process.env.LOGIN_RATE_MAX = '100000';
process.env.TICKET_ISSUE_MAX_PER_10MIN = '1000';
const h = require('./helpers');

let app; let A; let B; const ids = {};
const has = (prefix) => app.get('loadedRoutes').some((r) => r.startsWith(prefix));
const hasFile = (f) => app.get('loadedRoutes').some((r) => r.includes(`(${f})`));
const needFile = (t, f) => { if (!hasFile(f)) { t.skip(`${f} not loaded in this tree`); return false; } return true; };
const need = (t, prefix) => { if (!has(prefix)) { t.skip(`${prefix} not loaded in this tree`); return false; } return true; };
const db = () => h.getDb();
const row = (sql, ...a) => db().prepare(sql).get(...a);
const bad = (r, label) => assert.ok([400, 403, 404].includes(r.status), `${label}: expected 4xx, got ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);

async function publicIssue(clinic) {
  const info = await h.request(app).get(`/api/public/clinic?clinic=${clinic}`);
  assert.equal(info.status, 200, JSON.stringify(info.body));
  const key = info.body.data.services[0].key;
  const r = await h.request(app).post(`/api/public/tickets?clinic=${clinic}`).send({ serviceKey: key });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { token: r.body.data.token, key, number: r.body.data.ticket.number };
}

before(async () => {
  app = h.newApp();
  A = await h.mkClinic('Clinic A'); B = await h.mkClinic('Clinic B');
  const now = new Date().toISOString();
  const mk = (clinic, name, prefix) => {
    const sid = db().prepare('INSERT INTO services (clinic_id,name_ar,prefix,created_at,updated_at) VALUES (?,?,?,?,?)').run(clinic, name, prefix, now, now).lastInsertRowid;
    const cid = db().prepare('INSERT INTO counters (clinic_id,name_ar,number,created_at,updated_at) VALUES (?,?,1,?,?)').run(clinic, `شباك ${name}`, now, now).lastInsertRowid;
    db().prepare('INSERT INTO counter_services (counter_id, service_id) VALUES (?,?)').run(cid, sid);
    return { sid, cid };
  };
  Object.assign(ids, { a: mk(A, 'خدمة-A-فقط', 'A'), b: mk(B, 'خدمة-B-فقط', 'A') }); // نفس البادئة A في العيادتين عمداً
  for (const [clinic, tag, svc] of [[A, 'a', ids.a], [B, 'b', ids.b]]) {
    for (const role of ['staff', 'manager', 'admin']) {
      const sidStaff = await h.mkStaff(clinic, `${tag}_${role}`, role, { can_cancel: 1, can_skip_return: 1, can_transfer: 1 });
      db().prepare('INSERT INTO staff_services (staff_id, service_id) VALUES (?,?)').run(sidStaff, svc.sid);
      if (role === 'staff') db().prepare('UPDATE staff SET default_counter_id = ? WHERE id = ?').run(svc.cid, sidStaff);
    }
  }
  if (has('/api/public')) {
    ids.ta = await publicIssue(A); ids.tb = await publicIssue(B);
    ids.tb2 = await publicIssue(B);
    for (const [k, clinic] of [['a', A], ['b', B]]) ids[`pub_${k}`] = row('SELECT public_id, display_number FROM tickets WHERE clinic_id = ? ORDER BY id LIMIT 1', clinic);
    ids.pub_b2 = row('SELECT public_id FROM tickets WHERE clinic_id = ? ORDER BY id DESC LIMIT 1', B);
  }
});

const snapshotB = () => JSON.stringify(db().prepare('SELECT id, status, counter_id, service_id FROM tickets WHERE clinic_id = ? ORDER BY id').all(B));

test('PUBLIC: clinic must be named when several exist; unknown/inactive clinics are 404', async (t) => {
  if (!need(t, '/api/public')) return;
  assert.equal((await h.request(app).get('/api/public/clinic')).status, 400);
  assert.equal((await h.request(app).get('/api/public/clinic?clinic=99999')).status, 404);
  assert.equal((await h.request(app).get('/api/public/clinic?clinic=abc')).status, 404);
  assert.equal((await h.request(app).get('/api/public/clinic?clinic=1%20OR%201=1')).status, 404);
  const C = await h.mkClinic('Clinic Off'); db().prepare('UPDATE clinics SET is_active = 0 WHERE id = ?').run(C);
  assert.equal((await h.request(app).get(`/api/public/clinic?clinic=${C}`)).status, 404);
});

test('PUBLIC: each clinic exposes only its own services, and tickets land in the right clinic', async (t) => {
  if (!need(t, '/api/public')) return;
  const a = await h.request(app).get(`/api/public/clinic?clinic=${A}`); const b = await h.request(app).get(`/api/public/clinic?clinic=${B}`);
  assert.ok(JSON.stringify(a.body).includes('خدمة-A-فقط') && !JSON.stringify(a.body).includes('خدمة-B-فقط'));
  assert.ok(JSON.stringify(b.body).includes('خدمة-B-فقط') && !JSON.stringify(b.body).includes('خدمة-A-فقط'));
  assert.equal(row('SELECT clinic_id FROM tickets WHERE public_id = ?', ids.pub_a.public_id).clinic_id, A);
  assert.equal(row('SELECT clinic_id FROM tickets WHERE public_id = ?', ids.pub_b.public_id).clinic_id, B);
  assert.equal(ids.pub_a.display_number, ids.pub_b.display_number); // both are A-001 yet separate tickets
});

test('PUBLIC: a service key from clinic B cannot be used to issue a ticket under clinic A', async (t) => {
  if (!need(t, '/api/public')) return;
  const before = db().prepare('SELECT COUNT(*) c FROM tickets').get().c;
  const r = await h.request(app).post(`/api/public/tickets?clinic=${A}`).send({ serviceKey: ids.tb.key });
  bad(r, 'cross-clinic serviceKey');
  assert.equal(db().prepare('SELECT COUNT(*) c FROM tickets').get().c, before);
});

test('PUBLIC: status by token returns only that ticket (no other clinic data)', async (t) => {
  if (!need(t, '/api/public')) return;
  const r = await h.request(app).get(`/api/public/tickets/${ids.ta.token}`);
  assert.equal(r.status, 200);
  const dump = JSON.stringify(r.body);
  assert.ok(dump.includes('خدمة-A-فقط') && !dump.includes('خدمة-B-فقط') && !dump.includes('public_id') && !dump.includes('clinic_id'));
  assert.equal((await h.request(app).get('/api/public/tickets/not-a-real-token-0123456789abcdefghijk')).status, 404);
});

test('QUEUE: staff of clinic A cannot call-next with clinic B counter/service ids', async (t) => {
  if (!need(t, '/api/queue')) return;
  const s = await h.login(app, 'a_staff'); const snap = snapshotB();
  bad(await s.post('/api/queue/call-next', { counterId: ids.b.cid }), 'foreign counter');
  bad(await s.post('/api/queue/call-next', { counterId: ids.a.cid, serviceId: ids.b.sid }), 'foreign service');
  bad(await s.post('/api/queue/call-next', { counterId: ids.b.cid, serviceId: ids.b.sid }), 'both foreign');
  assert.equal(snapshotB(), snap, 'clinic B tickets untouched');
});

test('QUEUE: every action on a clinic B ticket is 404 for clinic A staff and changes nothing', async (t) => {
  if (!need(t, '/api/queue')) return;
  const s = await h.login(app, 'a_manager'); const snap = snapshotB();
  for (const act of ['recall', 'start', 'complete', 'skip', 'return', 'cancel']) {
    bad(await s.post(`/api/queue/tickets/${ids.pub_b.public_id}/${act}`, {}), act);
  }
  bad(await s.post(`/api/queue/tickets/${ids.pub_b.public_id}/transfer`, { serviceId: ids.a.sid }), 'transfer');
  assert.equal(snapshotB(), snap);
});

test('QUEUE: lookup by number and verify by token never cross clinics (same number A-001 in both)', async (t) => {
  if (!need(t, '/api/queue')) return;
  const sa = await h.login(app, 'a_staff'); const sb = await h.login(app, 'b_staff');
  const la = await sa.get('/api/queue/lookup?number=A-001'); const lb = await sb.get('/api/queue/lookup?number=A-001');
  assert.equal(la.status, 200); assert.equal(lb.status, 200);
  assert.ok(JSON.stringify(la.body).includes(ids.pub_a.public_id) && !JSON.stringify(la.body).includes(ids.pub_b.public_id));
  assert.ok(JSON.stringify(lb.body).includes(ids.pub_b.public_id) && !JSON.stringify(lb.body).includes(ids.pub_a.public_id));
  bad(await sa.post('/api/queue/verify', { token: ids.tb.token }), 'verify foreign token');
  assert.equal((await sa.post('/api/queue/verify', { token: ids.ta.token })).status, 200);
});

test('QUEUE: state and call-next serve only the caller\'s own clinic', async (t) => {
  if (!need(t, '/api/queue')) return;
  const sa = await h.login(app, 'a_staff');
  const st = await sa.get('/api/queue/state');
  assert.equal(st.status, 200);
  assert.ok(!JSON.stringify(st.body).includes(ids.pub_b.public_id) && !JSON.stringify(st.body).includes('خدمة-B-فقط'));
  const snap = snapshotB();
  const call = await sa.post('/api/queue/call-next', { counterId: ids.a.cid });
  assert.equal(call.status, 200, JSON.stringify(call.body));
  assert.equal(row('SELECT status FROM tickets WHERE public_id = ?', ids.pub_a.public_id).status, 'called');
  assert.equal(snapshotB(), snap);
});

test('ADMIN TICKETS: list / events / cancel / reset-day are scoped to the caller\'s clinic', async (t) => {
  if (!needFile(t, 'tickets.js')) return;
  const m = await h.login(app, 'a_manager'); const snap = snapshotB();
  const list = await m.get('/api/admin/tickets');
  assert.equal(list.status, 200);
  assert.ok(!JSON.stringify(list.body).includes(ids.pub_b.public_id) && !JSON.stringify(list.body).includes(ids.pub_b2.public_id));
  assert.ok(JSON.stringify(list.body).includes(ids.pub_a.public_id));
  bad(await m.get(`/api/admin/tickets/${ids.pub_b.public_id}/events`), 'foreign events');
  bad(await m.post(`/api/admin/tickets/${ids.pub_b.public_id}/cancel`, { reason: 'x' }), 'foreign admin cancel');
  assert.equal(snapshotB(), snap);
  const reset = await m.post('/api/admin/queue/reset-day', { confirm: true });
  assert.ok([200, 400].includes(reset.status), String(reset.status));
  assert.equal(snapshotB(), snap, 'reset-day in clinic A must not touch clinic B');
  const bm = await h.login(app, 'b_manager');
  assert.ok(JSON.stringify((await bm.get('/api/admin/tickets')).body).includes(ids.pub_b.public_id));
});

test('REPORTS: overview and reports only reflect the caller\'s clinic', async (t) => {
  if (!needFile(t, 'reports.js')) return;
  const m = await h.login(app, 'a_manager');
  const r = await m.get('/api/admin/stats/overview');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(!JSON.stringify(r.body).includes('خدمة-B-فقط'));
  const other = await m.get(`/api/admin/reports/waiting?serviceId=${ids.b.sid}`);
  assert.ok([400, 403, 404].includes(other.status), `foreign serviceId in reports -> ${other.status}`);
});

test('ADS: list/get/update/delete cannot reach another clinic\'s advertisements', async (t) => {
  if (!needFile(t, 'ads.js')) return;
  const now = new Date().toISOString();
  const adB = db().prepare(`INSERT INTO advertisements (clinic_id,title,media_type,body_text,duration_sec,created_at,updated_at) VALUES (?,?,?,?,10,?,?)`).run(B, 'إعلان-B-سري', 'text', 'نص', now, now).lastInsertRowid;
  const a = await h.login(app, 'a_admin');
  const list = await a.get('/api/admin/ads');
  assert.equal(list.status, 200);
  assert.ok(!JSON.stringify(list.body).includes('إعلان-B-سري'));
  bad(await a.get(`/api/admin/ads/${adB}`), 'get foreign ad');
  bad(await a.put(`/api/admin/ads/${adB}`, { title: 'hacked' }), 'put foreign ad');
  bad(await a.del(`/api/admin/ads/${adB}`), 'delete foreign ad');
  assert.equal(row('SELECT title FROM advertisements WHERE id = ?', adB).title, 'إعلان-B-سري');
});

test('DISPLAYS: clinic A admin cannot list, edit, reset or delete clinic B displays', async (t) => {
  if (!needFile(t, 'display.js')) return;
  const now = new Date().toISOString();
  const dB = db().prepare('INSERT INTO displays (clinic_id,name,pairing_code_hash,created_at,updated_at) VALUES (?,?,?,?,?)').run(B, 'شاشة-B-سرية', 'x'.repeat(64), now, now).lastInsertRowid;
  const a = await h.login(app, 'a_admin');
  const list = await a.get('/api/admin/displays');
  assert.equal(list.status, 200);
  assert.ok(!JSON.stringify(list.body).includes('شاشة-B-سرية'));
  bad(await a.put(`/api/admin/displays/${dB}`, { name: 'hacked' }), 'put display');
  bad(await a.put(`/api/admin/displays/${dB}/settings`, { volume: 0 }), 'display settings');
  bad(await a.post(`/api/admin/displays/${dB}/reset-pairing`, {}), 'reset pairing');
  bad(await a.del(`/api/admin/displays/${dB}`), 'delete display');
  assert.equal(row('SELECT name FROM displays WHERE id = ?', dB).name, 'شاشة-B-سرية');
});

test('MY ADMIN ROUTES vs queue ids: staff of clinic A cannot assign clinic B services/counters via staff CRUD', async () => {
  const a = await h.login(app, 'a_admin');
  const r = await a.post('/api/admin/staff', { username: 'x.cross', fullName: 'Cross Clinic', role: 'staff', serviceIds: [ids.b.sid], defaultCounterId: ids.b.cid });
  bad(r, 'cross-clinic staff');
  assert.equal(row("SELECT COUNT(*) c FROM staff WHERE username = 'x.cross'").c, 0);
});
