'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { io: connect } = require('socket.io-client');
const H = require('./queueTestHelpers');
const q = require('./queueDb');
const T = require('./ticketService');
const Q = require('./queueService');
const sockets = require('../sockets');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function boot() {
  const { db, ids } = H.setup(null);
  q.setClock(null);
  // clinic 2 لاختبار العزل
  const c2 = db.prepare(`INSERT INTO clinics (name_ar,created_at,updated_at) VALUES ('2','x','x')`).run().lastInsertRowid;
  const staff2 = db.prepare(`INSERT INTO staff (clinic_id,username,password_hash,full_name,role,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`).run(c2, 'z', 'x', 'z', 'manager', 'x', 'x').lastInsertRowid;
  const server = http.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  sockets.init(server, {
    startWorkers: false,
    // يحاكي express-session: كوكي fake=staff:<id>
    sessionMiddleware: (req, _res, next) => {
      const m = /fake=staff:(\d+)/.exec(req.headers.cookie || '');
      if (m) req.session = { staffId: Number(m[1]) };
      next();
    },
    resolveDisplay: (v) => { const m = /^disp:(\d+)$/.exec(v); return m ? { displayId: 1, clinicId: Number(m[1]) } : null; },
  });
  const client = (cookie) => new Promise((resolve, reject) => {
    const s = connect(`http://127.0.0.1:${port}`, { extraHeaders: cookie ? { cookie } : {}, transports: ['websocket'], reconnection: false });
    s.events = [];
    s.onAny((ev, p) => s.events.push({ ev, p }));
    s.on('connect', () => resolve(s));
    s.on('connect_error', (e) => reject(e));
  });
  return { db, ids, c2, staff2, client, port, close: async () => { await sockets.close(); server.close(); } };
}

test('الغرف والبث بعد commit: staff/display يستقبلان، المريض يستقبل تذكرته فقط', async () => {
  const { ids, client, close } = await boot();
  const conns = [];
  try {
    const staff = await client(`fake=staff:${ids.staff[0]}`); conns.push(staff);
    const display = await client('qm.display=disp:' + ids.clinicId); conns.push(display);
    const r1 = T.issueTicket({ clinicId: ids.clinicId, serviceId: ids.A });
    const r2 = T.issueTicket({ clinicId: ids.clinicId, serviceId: ids.A });
    const p1 = await client(); conns.push(p1);
    const p2 = await client(); conns.push(p2);
    const ack1 = await new Promise((res) => p1.emit('ticket:watch', { token: r1.token }, res));
    const ack2 = await new Promise((res) => p2.emit('ticket:watch', { token: r2.token }, res));
    assert.equal(ack1.ok, true); assert.equal(ack1.data.number, 'A-001');
    assert.equal(ack2.data.number, 'A-002');
    const bad = await new Promise((res) => p1.emit('ticket:watch', { token: 'q'.repeat(43) }, res));
    assert.equal(bad.ok, false); assert.equal(bad.error.code, 'NOT_FOUND');

    [staff, display, p1, p2].forEach((c) => { c.events.length = 0; });
    Q.callNext({ staffId: ids.staff[0], counterId: ids.counters[0] }); // يُنادي A-001
    await wait(150);

    const names = (c) => c.events.map((e) => e.ev);
    assert.deepEqual(names(staff).sort(), ['queue:updated', 'ticket:called']);
    assert.deepEqual(names(display).sort(), ['display:announcement', 'queue:updated', 'ticket:called']);
    assert.deepEqual(names(p1), ['ticket:called']);          // صاحب التذكرة فقط
    assert.deepEqual(names(p2), []);                         // لا تسريب لتذكرة غيره
    const called = display.events.find((e) => e.ev === 'ticket:called').p;
    assert.equal(called.ticket.number, 'A-001'); assert.equal(called.counter.number, 1); assert.equal(called.announce, true);
    assert.equal(called.clinicId, ids.clinicId); assert.match(called.eventId, /^[0-9a-f-]{36}$/); assert.ok(Date.parse(called.ts));
    const ann = display.events.find((e) => e.ev === 'display:announcement').p;
    assert.equal(ann.ticketNumber, 'A-001'); assert.equal(ann.counterNumber, 1);
    assert.equal(staff.events.find((e) => e.ev === 'ticket:called').p.eventId, called.eventId, 'نفس eventId لكل الغرف');
    // اللقطة لا تحوي توكن
    assert.ok(!JSON.stringify([...staff.events, ...display.events, ...p1.events]).includes(r1.token));

    // recall يعيد النطق عمداً، ويصل للمريض
    const pid = Q.getState({ staffId: ids.staff[0], counterId: ids.counters[0] }).currentTicket.publicId;
    [staff, display, p1].forEach((c) => { c.events.length = 0; });
    Q.recall({ staffId: ids.staff[0], publicId: pid });
    await wait(150);
    assert.ok(names(display).includes('ticket:recalled') && names(display).includes('display:announcement'));
    assert.ok(names(p1).includes('ticket:recalled'));
    // queue:updated لا يحمل announce
    assert.equal(display.events.find((e) => e.ev === 'queue:updated').p.announce, undefined);
    // أنهي الدورة → completed للمريض
    p1.events.length = 0;
    Q.start({ staffId: ids.staff[0], publicId: pid }); Q.complete({ staffId: ids.staff[0], publicId: pid });
    await wait(150);
    assert.deepEqual(names(p1), ['ticket:serving', 'ticket:completed']);
  } finally { conns.forEach((c) => c.close()); await close(); }
});

test('عزل العيادات: staff/display عيادة أخرى لا يستقبلان', async () => {
  const { ids, c2, staff2, client, close } = await boot();
  const conns = [];
  try {
    const other = await client(`fake=staff:${staff2}`); conns.push(other);
    const otherDisp = await client('qm.display=disp:' + c2); conns.push(otherDisp);
    T.issueTicket({ clinicId: ids.clinicId, serviceId: ids.A });
    await wait(150);
    assert.equal(other.events.length, 0); assert.equal(otherDisp.events.length, 0);
  } finally { conns.forEach((c) => c.close()); await close(); }
});

test('لا بث عند فشل المعاملة، والمصادقة: شاشة/موظف غير صالح = رفض', async () => {
  const { ids, db, client, close } = await boot();
  const conns = [];
  try {
    const staff = await client(`fake=staff:${ids.staff[0]}`); conns.push(staff);
    assert.throws(() => Q.callNext({ staffId: ids.staff[0], counterId: ids.counters[0] }), { code: 'QUEUE_EMPTY' });
    await wait(100);
    assert.equal(staff.events.length, 0);
    await assert.rejects(client('qm.display=garbage'), /UNAUTHENTICATED/);
    db.prepare('UPDATE staff SET is_active=0 WHERE id=?').run(ids.staff[1]);
    await assert.rejects(client(`fake=staff:${ids.staff[1]}`), /UNAUTHENTICATED/);
    await assert.rejects(client(`fake=staff:99999`), /UNAUTHENTICATED/);
  } finally { conns.forEach((c) => c.close()); await close(); }
});

test('المريض لا يستطيع أي حدث غير ticket:watch؛ الموظف لا يستطيع ticket:watch؛ حد الإغراق', async () => {
  const { ids, client, close } = await boot();
  const conns = [];
  try {
    const r = T.issueTicket({ clinicId: ids.clinicId, serviceId: ids.A });
    const staff = await client(`fake=staff:${ids.staff[0]}`); conns.push(staff);
    const deny = await new Promise((res) => staff.emit('ticket:watch', { token: r.token }, res));
    assert.equal(deny.ok, false); assert.equal(deny.error.code, 'FORBIDDEN');

    const p = await client(); conns.push(p);
    p.emit('ticket:called', { fake: true }); p.emit('queue:updated', {}); // لا معالجات لها
    await wait(100);
    assert.equal(staff.events.length, 0);

    // حد التتبع لكل socket
    const tokens = [r.token];
    for (let i = 0; i < 6; i++) tokens.push(T.issueTicket({ clinicId: ids.clinicId, serviceId: ids.A }).token);
    let lastAck;
    for (let i = 0; i < 6; i++) lastAck = await new Promise((res) => p.emit('ticket:watch', { token: tokens[i] }, res));
    assert.equal(lastAck.ok, false); assert.equal(lastAck.error.code, 'RATE_LIMITED');

    const flooder = await client(); conns.push(flooder);
    const closed = new Promise((res) => flooder.on('disconnect', res));
    for (let i = 0; i < sockets.FLOOD_MAX_EVENTS + 5; i++) flooder.emit('junk', i);
    const why = await Promise.race([closed, wait(2000).then(() => 'timeout')]);
    assert.notEqual(why, 'timeout', 'flooding client must be disconnected');
  } finally { conns.forEach((c) => c.close()); await close(); }
});

test('emitToClinic/emitToRoom للآخرين: غلاف eventId/ts/clinicId، وإعادة اتصال تستبدل الحالة ولا تعيد نداءات قديمة', async () => {
  const { ids, client, close } = await boot();
  const conns = [];
  try {
    const display = await client('qm.display=disp:' + ids.clinicId); conns.push(display);
    sockets.emitToDisplays(ids.clinicId, 'display:settings_updated', { displayId: 1, settings: { volume: 0.5 } });
    sockets.emitToClinic(ids.clinicId, 'advertisement:updated', { ads: [] });
    await wait(100);
    const e = display.events.find((x) => x.ev === 'display:settings_updated').p;
    assert.equal(e.clinicId, ids.clinicId); assert.ok(e.eventId); assert.equal(e.settings.volume, 0.5);
    assert.ok(display.events.find((x) => x.ev === 'advertisement:updated'));
    // نداء يحدث أثناء انقطاع الشاشة لا يُعاد بثّه عند عودتها (الخادم لا يخزّن أحداثاً)
    const r = T.issueTicket({ clinicId: ids.clinicId, serviceId: ids.A }); void r;
    display.close();
    Q.callNext({ staffId: ids.staff[0], counterId: ids.counters[0] });
    const back = await client('qm.display=disp:' + ids.clinicId); conns.push(back);
    await wait(150);
    assert.equal(back.events.length, 0, 'no replay of missed announcements');
    // الحالة تُستعاد من REST/لقطة (queue:updated التالي يحمل لقطة كاملة)
    T.issueTicket({ clinicId: ids.clinicId, serviceId: ids.A });
    await wait(150);
    const snap = back.events.find((x) => x.ev === 'queue:updated').p;
    assert.equal(snap.current.length, 1); assert.equal(snap.current[0].number, 'A-001');
    assert.equal(snap.services.find((s) => s.waiting === 1) != null, true);
  } finally { conns.forEach((c) => c.close()); await close(); }
});
