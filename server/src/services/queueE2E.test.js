'use strict';
// اختبار تكامل من طرف لطرف على تطبيق حساب 1 الحقيقي (createApp + جلسات + CSRF + argon2 + مخطط 001_init).
// يتخطى نفسه تلقائياً إن لم تكن ملفات حساب 1 موجودة (قبل الدمج في main).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');

const helpersPath = path.resolve(__dirname, '../../tests/core/helpers.js');
let skip = !fs.existsSync(path.resolve(__dirname, '../app.js')) || !fs.existsSync(helpersPath);
let h; let supertestOk = true;
if (!skip) { try { require.resolve('supertest'); } catch (_) { supertestOk = false; } }
if (!skip && !supertestOk) skip = 'supertest not installed';
if (!skip) {
  process.env.TICKET_TOKEN_PEPPER = 'e2e-pepper-0123456789abcdef-xyz';
  process.env.PHONE_ENC_KEY = '11'.repeat(32);
  process.env.SMS_PROVIDER = 'console';
  process.env.LOGIN_RATE_MAX = '1000';
  process.env.QM_SILENT = '1';
  h = require(helpersPath);
}
const opts = { skip: skip ? (typeof skip === 'string' ? skip : 'account-1 app not present in this branch') : false };

test('E2E على التطبيق الحقيقي: مريض ← موظف ← أدمن ← socket بكوكي الجلسة الحقيقي', opts, async () => {
  const { io: connect } = require('socket.io-client');
  const sockets = require('../sockets');
  const app = h.newApp();
  const db = h.getDb();
  const now = new Date().toISOString();
  const c1 = await h.mkClinic('عيادة E2E');
  const svc = h.mkService(c1, 'A');
  const counter = db.prepare('INSERT INTO counters (clinic_id,name_ar,number,created_at,updated_at) VALUES (?,?,?,?,?)').run(c1, 'شباك 1', 1, now, now).lastInsertRowid;
  const stId = await h.mkStaff(c1, 'st1', 'staff');
  db.prepare('INSERT INTO staff_services VALUES (?,?)').run(stId, svc);
  await h.mkStaff(c1, 'mg', 'manager');
  await h.mkStaff(c1, 'must', 'staff', { must_change_password: 1 });
  const set = (k, v) => db.prepare('INSERT OR REPLACE INTO clinic_settings VALUES (?,?,?,?)').run(c1, k, v, now);
  set('sms_enabled', '1'); set('ticket_recovery_enabled', '1');

  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  sockets.init(server, { startWorkers: false }); // بدون أي خيارات تقريباً، كما في server.js الحقيقي عند ح1
  const port = server.address().port;
  const clients = [];
  const conn = (cookie) => new Promise((res, rej) => {
    const s = connect(`http://127.0.0.1:${port}`, { transports: ['websocket'], reconnection: false, extraHeaders: cookie ? { cookie } : {} });
    s.events = []; s.onAny((ev, p) => s.events.push({ ev, p }));
    s.on('connect', () => { clients.push(s); res(s); }); s.on('connect_error', rej);
  });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  try {
    // ---- مريض (بدون جلسة ولا CSRF)
    const clinic = await h.request(app).get('/api/public/clinic');
    assert.equal(clinic.status, 200);
    const key = clinic.body.data.services[0].key;
    const issued = await h.request(app).post('/api/public/tickets').send({ serviceKey: key });
    assert.equal(issued.status, 201);
    const { token } = issued.body.data;
    assert.equal(issued.body.data.ticket.number, 'A-001');
    const st0 = await h.request(app).get(`/api/public/tickets/${token}`);
    assert.equal(st0.body.data.status, 'waiting');

    // ---- موظف: CSRF مطلوب من ح1
    const st = await h.login(app, 'st1');
    assert.equal(st.res.status, 200);
    const noCsrf = await st.agent.post('/api/queue/call-next').send({ counterId: counter });
    assert.equal(noCsrf.status, 403);
    // socket الموظف بالكوكي الحقيقي + مريض + كوكي مزوّر
    const cookie = st.res.headers['set-cookie'].filter((x) => x.startsWith('qm.sid=')).pop().split(';')[0]; // الأول كوكي مسح للقديم
    const sStaff = await conn(cookie);
    const sPatient = await conn();
    const ack = await new Promise((r) => sPatient.emit('ticket:watch', { token }, r));
    assert.equal(ack.ok, true);
    const sFake = await conn('qm.sid=forged-session-id'); // يُعامل مريضاً بلا صلاحيات
    const denied = await new Promise((r) => sFake.emit('ticket:watch', { token: 'z'.repeat(43) }, r));
    assert.equal(denied.error.code, 'NOT_FOUND'); // سلوك المريض لا الموظف

    const cn = await st.post('/api/queue/call-next', { counterId: counter });
    assert.equal(cn.status, 200, JSON.stringify(cn.body));
    assert.equal(cn.body.data.ticket.number, 'A-001');
    await wait(200);
    assert.ok(sStaff.events.some((e) => e.ev === 'ticket:called'), 'staff socket (real session) got ticket:called');
    assert.ok(sPatient.events.some((e) => e.ev === 'ticket:called'), 'patient got his ticket event');
    assert.equal(sFake.events.length, 0, 'forged cookie socket gets nothing');
    assert.equal((await h.request(app).get(`/api/public/tickets/${token}`)).body.data.status, 'called');

    const pid = cn.body.data.ticket.publicId;
    assert.equal((await st.post(`/api/queue/tickets/${pid}/start`, {})).status, 200);
    assert.equal((await st.post(`/api/queue/tickets/${pid}/complete`, {})).status, 200);
    assert.equal((await st.post(`/api/queue/tickets/${pid}/cancel`, {})).body.error.code, 'FORBIDDEN');
    const v = await st.post('/api/queue/verify', { token });
    assert.equal(v.body.data.ticket.status, 'completed');

    // ---- must_change_password محجوب
    const must = await h.login(app, 'must');
    const mustCall = await must.post('/api/queue/call-next', { counterId: counter });
    assert.equal(mustCall.status, 403); assert.equal(mustCall.body.error.code, 'PASSWORD_CHANGE_REQUIRED');

    // ---- أدمن
    const mg = await h.login(app, 'mg');
    assert.equal((await st.get('/api/admin/tickets')).status, 403);
    const list = await mg.get('/api/admin/tickets');
    assert.equal(list.status, 200); assert.equal(list.body.data.total, 1);
    const evs = await mg.get(`/api/admin/tickets/${pid}/events`);
    assert.deepEqual(evs.body.data.events.map((e) => e.type), ['created', 'called', 'serving', 'completed']);
    const sync = await mg.get('/api/admin/sync/status');
    assert.equal(sync.status, 200); assert.equal(sync.body.data.mode, 'pending_integration');
    assert.ok(sync.body.data.pending >= 4);

    // ---- SMS + استرجاع عبر التطبيق الحقيقي
    const t2 = await h.request(app).post('/api/public/tickets').send({ serviceKey: key });
    const sms = await h.request(app).post(`/api/public/tickets/${t2.body.data.token}/sms`).send({ phone: '+201001234567' });
    assert.equal(sms.status, 202);
    const rec = await h.request(app).post('/api/public/tickets/recover').send({ number: 'A-002', phoneLast4: '4567' });
    assert.equal(rec.status, 200);
    assert.equal((await h.request(app).get(`/api/public/tickets/${t2.body.data.token}`)).status, 404, 'old token invalid');
    assert.equal((await h.request(app).get(`/api/public/tickets/${rec.body.data.token}`)).status, 200);

    // ---- لا توكن خام ولا هاتف صريح في أي جدول بعد كل هذا
    const dump = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()
      .map(({ name }) => JSON.stringify(db.prepare(`SELECT * FROM ${name}`).all())).join('');
    for (const t of [token, t2.body.data.token, rec.body.data.token]) assert.ok(!dump.includes(t), 'raw token in DB');
    assert.ok(!dump.includes('1001234567'), 'plain phone in DB');
  } finally {
    clients.forEach((c) => c.close());
    await sockets.close();
    server.close();
  }
});
