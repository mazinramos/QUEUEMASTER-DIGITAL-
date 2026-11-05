'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const express = require('express');
const crypto = require('crypto');
const H = require('./queueTestHelpers');
const q = require('./queueDb');
const T = require('./ticketService');
const Q = require('./queueService');
const crypt = require('./sms/smsCrypto');
const store = require('./sms/smsStore');
const worker = require('./sms/smsWorker');
const sync = require('./sync/syncWorker');
const { createFirestoreSink } = require('./sync/firestoreSink');

process.env.PHONE_ENC_KEY = crypto.randomBytes(32).toString('hex');
process.env.SMS_PROVIDER = 'console';
const PHONE = '+201001234567';

function fresh(extraSettings = {}) {
  const { db, ids } = H.setup(null);
  q.setClock(null);
  const set = (k, v) => db.prepare(`INSERT OR REPLACE INTO clinic_settings VALUES (?,?,?,?)`).run(ids.clinicId, k, v, 'x');
  set('sms_enabled', '1'); set('ticket_recovery_enabled', '1');
  for (const [k, v] of Object.entries(extraSettings)) set(k, v);
  const issue = () => T.issueTicket({ clinicId: ids.clinicId, serviceId: ids.A });
  return { db, ids, set, issue };
}
const row = (db, token) => db.prepare('SELECT * FROM tickets WHERE token_hash=?').get(q.hashToken(token));
const SMS = require('./sms/smsService');
const BASE = 'http://clinic.local';

// ---------------- SMS ----------------
test('SMS غير مهيّأ (SMS_PROVIDER=none أو لا مفتاح) = 503 واضح بدل صفوف لا تُرسل', () => {
  const { db, issue } = fresh();
  const t = row(db, issue().token);
  const keep = { p: process.env.SMS_PROVIDER, k: process.env.PHONE_ENC_KEY };
  try {
    process.env.SMS_PROVIDER = 'none';
    assert.throws(() => SMS.queueTicketSms({ ticket: t, phone: PHONE, baseUrl: BASE }), (e) => e.status === 503);
    process.env.SMS_PROVIDER = 'console'; delete process.env.PHONE_ENC_KEY;
    assert.throws(() => SMS.queueTicketSms({ ticket: t, phone: PHONE, baseUrl: BASE }), (e) => e.status === 503);
  } finally { process.env.SMS_PROVIDER = keep.p; process.env.PHONE_ENC_KEY = keep.k; }
  assert.equal(db.prepare('SELECT COUNT(*) c FROM sms_outbox').get().c, 0);
});

test('AES-256-GCM: ذهاب وإياب، عبث بالنص المشفر يفشل، مفتاح آخر يفشل', () => {
  const c = crypt.encrypt(PHONE);
  assert.match(c, /^v1:/); assert.ok(!c.includes('2010'));
  assert.equal(crypt.decrypt(c), PHONE);
  assert.notEqual(crypt.encrypt(PHONE), c, 'IV عشوائي');
  const raw = Buffer.from(c.slice(3), 'base64url'); raw[raw.length - 1] ^= 1;
  assert.throws(() => crypt.decrypt('v1:' + raw.toString('base64url')));
  const old = process.env.PHONE_ENC_KEY;
  process.env.PHONE_ENC_KEY = crypto.randomBytes(32).toString('hex');
  assert.throws(() => crypt.decrypt(c));
  process.env.PHONE_ENC_KEY = old;
  process.env.PHONE_ENC_KEY = 'short';
  assert.throws(() => crypt.encrypt('x'), /64 hex/);
  process.env.PHONE_ENC_KEY = old;
});

test('إدخال SMS: تحقق الهاتف، تعطيل العيادة، الرقم مشفر والنص بلا توكن، حد 3 لكل تذكرة', () => {
  const { db, set, issue } = fresh();
  const r = issue(); const t = row(db, r.token);
  assert.throws(() => SMS.queueTicketSms({ ticket: t, phone: 'abc', baseUrl: BASE }), { code: 'VALIDATION' });
  assert.deepEqual(SMS.queueTicketSms({ ticket: t, phone: '+20 100-123-4567', baseUrl: BASE }), { queued: true });
  const o = db.prepare('SELECT * FROM sms_outbox').get();
  assert.equal(o.status, 'pending'); assert.ok(o.purge_after);
  assert.equal(crypt.decrypt(o.phone_encrypted), PHONE);
  assert.ok(o.body.includes('A-001')); assert.ok(!o.body.includes(r.token), 'التوكن ممنوع في body');
  // لا هاتف ولا توكن بنص صريح في أي جدول
  for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()) {
    const dump = JSON.stringify(db.prepare(`SELECT * FROM ${name}`).all());
    assert.ok(!dump.includes('1001234567'), `phone plaintext in ${name}`);
    assert.ok(!dump.includes(r.token), `raw token in ${name}`);
  }
  SMS.queueTicketSms({ ticket: t, phone: PHONE, baseUrl: BASE }); SMS.queueTicketSms({ ticket: t, phone: PHONE, baseUrl: BASE });
  assert.throws(() => SMS.queueTicketSms({ ticket: t, phone: PHONE, baseUrl: BASE }), { code: 'RATE_LIMITED' });
  set('sms_enabled', '0');
  const t2 = row(db, issue().token);
  assert.throws(() => SMS.queueTicketSms({ ticket: t2, phone: PHONE, baseUrl: BASE }), { code: 'FORBIDDEN' });
});

test('العامل: console adapter يرسل؛ فشل متكرر = إعادة محاولة تصاعدية ثم failed؛ التذكرة لا تتأثر', async () => {
  const { db, ids, issue } = fresh();
  let clock = Date.parse('2026-03-05T10:00:00Z');
  q.setClock(() => new Date(clock));
  const r = issue(); const t = row(db, r.token);
  SMS.queueTicketSms({ ticket: t, phone: PHONE, baseUrl: BASE });
  // 1) نجاح
  const ok = await worker.processOnce({ adapter: require('./sms/adapters/console')() });
  assert.equal(ok.sent, 1);
  assert.match(db.prepare('SELECT * FROM sms_outbox').get().provider, /^console:console-/);

  // 2) فشل دائم: 5 محاولات بتأخير 30s,60s,120s,240s
  const t2 = row(db, issue().token);
  SMS.queueTicketSms({ ticket: t2, phone: PHONE, baseUrl: BASE });
  const bad = { name: 'bad', calls: 0, async send({ to }) { this.calls++; return { ok: false, error: `boom for ${to}` }; } };
  const delays = [];
  for (let i = 0; i < 5; i++) {
    const res = await worker.processOnce({ adapter: bad });
    const o = db.prepare('SELECT * FROM sms_outbox WHERE ticket_id=?').get(t2.id);
    if (i < 4) { assert.equal(res.retried, 1); delays.push(Date.parse(o.next_attempt_at) - clock); }
    // قبل موعد المحاولة التالية لا يُعاد الإرسال
    if (i < 4) { const early = await worker.processOnce({ adapter: bad }); assert.equal(early.retried + early.sent + early.failed, 0); }
    clock += 3600 * 1000;
  }
  assert.deepEqual(delays, [30000, 60000, 120000, 240000]);
  const final = db.prepare('SELECT * FROM sms_outbox WHERE ticket_id=?').get(t2.id);
  assert.equal(final.status, 'failed'); assert.equal(final.attempts, 5); assert.equal(bad.calls, 5);
  assert.ok(!/\d{7,}/.test(final.last_error), 'last_error لا يحوي رقماً');
  // التذكرة سليمة وتُنادى عادة
  assert.equal(db.prepare('SELECT status FROM tickets WHERE id=?').get(t2.id).status, 'waiting');
  assert.ok(Q.callNext({ staffId: ids.staff[0], counterId: ids.counters[0] }).number);
  q.setClock(null);
});

test('adapter يرمي استثناءً: يُعامل كفشل لا انهيار', async () => {
  const { db, issue } = fresh();
  SMS.queueTicketSms({ ticket: row(db, issue().token), phone: PHONE, baseUrl: BASE });
  const res = await worker.processOnce({ adapter: { name: 'x', send() { throw new Error('kaboom'); } } });
  assert.equal(res.retried, 1);
});

test('الاحتفاظ: بعد purge_after يُحذف الرقم، والمعلّق يصير expired ولا يُرسل', async () => {
  const { db, set, issue } = fresh();
  set('sms_retention_days', '2');
  const t = row(db, issue().token);
  let clock = Date.parse('2026-03-05T10:00:00Z');
  q.setClock(() => new Date(clock));
  SMS.queueTicketSms({ ticket: t, phone: PHONE, baseUrl: BASE });
  SMS.queueTicketSms({ ticket: t, phone: PHONE, baseUrl: BASE });
  const sentAdapter = { name: 'n', calls: 0, async send() { this.calls++; return { ok: true }; } };
  await worker.processOnce({ adapter: sentAdapter, batch: 1 }); // أرسل واحدة، الثانية معلقة
  assert.equal(sentAdapter.calls, 1);
  clock += 3 * 86400000;
  const res = await worker.processOnce({ adapter: sentAdapter });
  assert.equal(res.purged, 2); assert.equal(sentAdapter.calls, 1, 'لا إرسال بعد انتهاء الاحتفاظ');
  const rows = db.prepare('SELECT status, phone_encrypted FROM sms_outbox ORDER BY id').all();
  assert.deepEqual(rows.map((r) => r.phone_encrypted), ['', '']);
  assert.deepEqual(rows.map((r) => r.status).sort(), ['expired', 'sent']);
  assert.equal(store.phoneLast4Matches(db, t.id, '4567'), false);
  q.setClock(null);
});

test('HTTP adapter: قالب JSON بهروب صحيح، هيدرز، معرّف الرسالة، فشل 5xx وtimeout ونمط النجاح', async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; });
    req.on('end', () => {
      seen.push({ url: req.url, auth: req.headers.authorization, ct: req.headers['content-type'], body: b });
      if (req.url.startsWith('/fail')) { res.statusCode = 503; return res.end('no'); }
      if (req.url.startsWith('/slow')) return; // لا يرد
      if (req.url.startsWith('/soft')) return res.end('{"status":"rejected"}');
      res.setHeader('content-type', 'application/json'); res.end('{"data":{"id":"m-42"},"status":"queued"}');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const make = require('./sms/adapters/http');
  const env = { SMS_HTTP_URL: base + '/send', SMS_HTTP_HEADERS: '{"Authorization":"Bearer K"}', SMS_HTTP_BODY: '{"to":"{{to}}","text":"{{body}}"}', SMS_HTTP_ID_PATH: 'data.id', SMS_HTTP_SUCCESS_REGEX: 'queued' };
  try {
    const a = make(env);
    const r = await a.send({ to: PHONE, body: 'مرحبا "A-001"\nسطر' });
    assert.deepEqual(r, { ok: true, providerId: 'm-42' });
    assert.equal(seen[0].auth, 'Bearer K'); assert.equal(seen[0].ct, 'application/json');
    assert.deepEqual(JSON.parse(seen[0].body), { to: PHONE, text: 'مرحبا "A-001"\nسطر' });
    assert.equal((await make(Object.assign({}, env, { SMS_HTTP_URL: base + '/fail' })).send({ to: PHONE, body: 'x' })).ok, false);
    assert.equal((await make(Object.assign({}, env, { SMS_HTTP_URL: base + '/soft' })).send({ to: PHONE, body: 'x' })).ok, false);
    const slow = await make(Object.assign({}, env, { SMS_HTTP_URL: base + '/slow', SMS_HTTP_TIMEOUT_MS: '200' })).send({ to: PHONE, body: 'x' });
    assert.deepEqual(slow, { ok: false, error: 'timeout' });
    // form-urlencoded + GET
    const g = make({ SMS_HTTP_URL: base + '/send?to={{to}}&msg={{body}}', SMS_HTTP_METHOD: 'GET' });
    await g.send({ to: '+201', body: 'a b&c' });
    assert.equal(seen[seen.length - 1].url, '/send?to=%2B201&msg=a%20b%26c');
    assert.throws(() => make({}), /SMS_HTTP_URL/);
  } finally { server.closeAllConnections(); server.close(); }
});

// ------------- الاسترجاع الآمن -------------
test('الاسترجاع: يدور التوكن عند تطابق آخر 4 أرقام؛ كل الفشل NOT_FOUND موحد؛ القديم يبطل', () => {
  const { db, ids, set, issue } = fresh();
  const r = issue(); const t = row(db, r.token);
  SMS.queueTicketSms({ ticket: t, phone: PHONE, baseUrl: BASE });
  const rec = (n, l4) => T.recoverTicket({ clinicId: ids.clinicId, number: n, phoneLast4: l4 });
  for (const [n, l4] of [['A-001', '0000'], ['A-001', 'abcd'], ['A-001', undefined], ['A-009', '4567'], ['bad', '4567']]) {
    assert.throws(() => rec(n, l4), { code: 'NOT_FOUND' });
  }
  const { token } = rec('a1', '4567');
  assert.equal(token.length, 43); assert.notEqual(token, r.token);
  assert.throws(() => T.getTicketByToken(r.token), { code: 'NOT_FOUND' });
  assert.equal(T.getTicketByToken(token).public_id, t.public_id);
  assert.equal(db.prepare(`SELECT COUNT(*) c FROM ticket_events WHERE type='recovered'`).get().c, 1);
  // معطّل
  set('ticket_recovery_enabled', '0');
  assert.throws(() => rec('A-001', '4567'), { code: 'NOT_FOUND' });
  // تذكرة بلا SMS لا تُسترجع
  set('ticket_recovery_enabled', '1');
  issue();
  assert.throws(() => rec('A-002', '4567'), { code: 'NOT_FOUND' });
  // تذكرة منتهية لا تُسترجع
  db.prepare(`UPDATE tickets SET status='completed' WHERE id=?`).run(t.id);
  assert.throws(() => rec('A-001', '4567'), { code: 'NOT_FOUND' });
});

async function bootHttp() {
  const { db, ids, set, issue } = fresh();
  process.env.BASE_URL = BASE;
  const app = express();
  app.use((req, _res, next) => { const s = req.get('x-test-staff'); if (s) req.session = { staffId: Number(s) }; next(); });
  for (const f of ['public', 'sync']) { const m = require(`../routes/${f}`); app.use(m.path, m.router); }
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, { body, staff } = {}) => {
    const r = await fetch(base + url, { method, headers: Object.assign({ 'content-type': 'application/json' }, staff ? { 'x-test-staff': String(staff) } : {}), body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };
  const pub = require('../routes/public').router;
  Object.values(pub._limiters).forEach((l) => l.reset());
  return { db, ids, set, issue, call, close: () => server.close() };
}

test('HTTP: /sms و /recover مع محدّد المعدل (5 محاولات لنفس الرقم ثم 429)', async () => {
  const { ids, issue, call, db, close } = await bootHttp();
  try {
    const r = issue();
    const bad = await call('POST', `/api/public/tickets/${r.token}/sms`, { body: { phone: '12' } });
    assert.equal(bad.status, 400);
    const ok = await call('POST', `/api/public/tickets/${r.token}/sms`, { body: { phone: PHONE } });
    assert.equal(ok.status, 202); assert.equal(ok.body.data.queued, true);
    assert.equal((await call('POST', `/api/public/tickets/${'k'.repeat(43)}/sms`, { body: { phone: PHONE } })).status, 404);

    const good = await call('POST', '/api/public/tickets/recover', { body: { number: 'A-001', phoneLast4: '4567' } });
    assert.equal(good.status, 200); assert.equal(good.body.data.token.length, 43);
    Object.values(require('../routes/public').router._limiters).forEach((l) => l.reset());
    const codes = [];
    for (let i = 0; i < 7; i++) codes.push((await call('POST', '/api/public/tickets/recover', { body: { number: 'A-001', phoneLast4: String(1000 + i) } })).status);
    assert.deepEqual(codes, [404, 404, 404, 404, 404, 429, 429]);
    void ids; void db;
  } finally { close(); }
});

// ---------------- المزامنة ----------------
class FakeSink {
  constructor() { this.remote = new Map(); this.log = []; this.fail = new Set(); this.name = 'fake'; }
  async apply({ path, operation, data, version }) {
    this.log.push({ path, version });
    if ([...this.fail].some((f) => path.includes(f))) throw new Error('remote down');
    const cur = this.remote.get(path);
    if (cur && cur._version >= version) return 'stale';
    this.remote.set(path, Object.assign({}, data, { _version: version, _deleted: operation === 'delete' }));
    return 'written';
  }
}

function scenario() {
  const f = fresh();
  const out = [];
  for (let i = 0; i < 3; i++) out.push(f.issue());
  Q.callNext({ staffId: f.ids.staff[0], counterId: f.ids.counters[0] });
  return Object.assign(f, { tickets: out });
}

test('sync: بدون credentials = pending_integration والطابور يبقى معلقاً ولا يُدّعى عمله', async () => {
  scenario();
  sync.stop();
  const st = sync.start({ env: {} }); // لا sink ولا credentials
  assert.equal(st.mode, 'pending_integration');
  const db = q.getDb();
  const cid = db.prepare('SELECT id FROM clinics').get().id;
  const s = sync.status(cid);
  assert.equal(s.firebaseConfigured, false); assert.equal(s.pending, 4); assert.equal(s.synced, 0);
  assert.ok(s.oldestPendingAt);
  assert.match(sync.loadFirestoreSink({}).reason, /not set/);
  assert.match(sync.loadFirestoreSink({ FIREBASE_SERVICE_ACCOUNT_PATH: '/nope.json' }).reason, /not installed|invalid/);
});

test('sync: ترتيب محفوظ، لا توكن/hash/هاتف في الحمولة، وإعادة التشغيل idempotent', async () => {
  const { db, tickets } = scenario();
  const sink = new FakeSink();
  const res = await sync.processOnce({ sink });
  assert.equal(res.synced, 4);
  // الترتيب العام بحسب id، ونفس الكيان بإصدارات متزايدة
  const versions = sink.log.map((l) => l.version);
  assert.deepEqual(versions, [...versions].sort((a, b) => a - b));
  const calledPath = sink.log.find((l) => l.path.endsWith(db.prepare('SELECT public_id p FROM tickets WHERE display_number=?').get('A-001').p));
  assert.ok(calledPath);
  const first = [...sink.remote.entries()].find(([p]) => p.endsWith(db.prepare('SELECT public_id p FROM tickets WHERE display_number=?').get('A-001').p))[1];
  assert.equal(first.status, 'called'); // آخر حالة هي المخزنة
  const dump = JSON.stringify([...sink.remote.values()]);
  for (const t of tickets) { assert.ok(!dump.includes(t.token)); assert.ok(!dump.includes(q.hashToken(t.token))); }
  assert.ok(!/token/i.test(dump));
  // إعادة تشغيل: نعيد الصفوف لـ pending → كلها stale بلا تغيير
  const before = JSON.stringify([...sink.remote]);
  db.prepare(`UPDATE sync_outbox SET status='pending', synced_at=NULL`).run();
  const again = await sync.processOnce({ sink });
  assert.equal(again.stale, 4); assert.equal(JSON.stringify([...sink.remote]), before);
});

test('sync: فشل كيان يحجب لاحقاته فقط (الترتيب)، وغيره يمضي؛ استنفاد المحاولات يفك الحجب', async () => {
  const { db } = scenario();
  const sink = new FakeSink();
  const a1 = db.prepare('SELECT public_id p FROM tickets WHERE display_number=?').get('A-001').p;
  sink.fail.add(a1);
  sync._state.nextTry.clear();
  let res = await sync.processOnce({ sink });
  // A-001 له صفان (created, called): الأول يفشل والثاني محجوب؛ الآخران ينجحان
  assert.equal(res.retried, 1); assert.equal(res.blocked, 1); assert.equal(res.synced, 2);
  assert.equal(db.prepare(`SELECT COUNT(*) c FROM sync_outbox WHERE status='pending'`).get().c, 2);
  assert.ok(!sink.remote.has(`clinics/1/tickets/${a1}`), 'لم تُكتب حالة called قبل created');
  // تجاوز التأخير وكرر حتى الاستنفاد
  for (let i = 0; i < sync.MAX_ATTEMPTS - 1; i++) { sync._state.nextTry.clear(); res = await sync.processOnce({ sink }); }
  assert.equal(db.prepare(`SELECT COUNT(*) c FROM sync_outbox WHERE status='failed'`).get().c, 1);
  assert.equal(db.prepare(`SELECT COUNT(*) c FROM sync_outbox WHERE status='pending'`).get().c, 1, 'called row still pending (ordering kept)');
  sink.fail.clear(); sync._state.nextTry.clear(); // عاد الاتصال
  await sync.processOnce({ sink });
  assert.equal(sink.remote.get(`clinics/1/tickets/${a1}`).status, 'called', 'الصف التالي (الحالة الكاملة) مرّ بعد فك الحجب');
  assert.ok(sync.backoff(1) === 5000 && sync.backoff(30) === 600000);
});

test('Firestore sink (محاكاة Firestore): حارس الإصدار، tombstone للحذف، لا إحياء بإصدار قديم', async () => {
  const docs = new Map();
  const fake = {
    doc: (p) => ({ p }),
    async runTransaction(fn) {
      return fn({
        get: async (ref) => ({ exists: docs.has(ref.p), get: (k) => (docs.get(ref.p) || {})[k] }),
        set: (ref, d) => docs.set(ref.p, d),
      });
    },
  };
  const sink = createFirestoreSink(fake);
  const base = { path: 'clinics/1/tickets/x', data: { n: 1 } };
  assert.equal(await sink.apply({ ...base, operation: 'upsert', version: 5 }), 'written');
  assert.equal(await sink.apply({ ...base, operation: 'upsert', version: 5 }), 'stale');
  assert.equal(await sink.apply({ ...base, operation: 'upsert', version: 3, data: { n: 0 } }), 'stale');
  assert.equal(docs.get('clinics/1/tickets/x').n, 1);
  assert.equal(await sink.apply({ ...base, operation: 'delete', version: 7 }), 'written');
  assert.equal(docs.get('clinics/1/tickets/x')._deleted, true);
  assert.equal(await sink.apply({ ...base, operation: 'upsert', version: 6 }), 'stale'); // لا إحياء
  assert.equal(docs.get('clinics/1/tickets/x')._deleted, true);
});

test('GET /api/admin/sync/status: manager فقط وبحالة صادقة', async () => {
  const { ids, call, close } = await bootHttp();
  try {
    sync.stop(); sync.start({ env: {} });
    assert.equal((await call('GET', '/api/admin/sync/status')).status, 401);
    assert.equal((await call('GET', '/api/admin/sync/status', { staff: ids.staff[0] })).status, 403);
    const r = await call('GET', '/api/admin/sync/status', { staff: ids.manager });
    assert.equal(r.status, 200);
    assert.equal(r.body.data.mode, 'pending_integration'); assert.equal(r.body.data.firebaseConfigured, false);
    assert.match(r.body.data.conflictPolicy, /local-wins/);
  } finally { close(); }
});
