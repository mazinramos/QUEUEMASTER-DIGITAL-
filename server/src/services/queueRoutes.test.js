'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const express = require('express');
const H = require('./queueTestHelpers');
const q = require('./queueDb');

// يحاكي ما يفعله app.js (حساب 1): تحميل { path, router } من routes/ + جلسة بسيطة للاختبار
async function boot() {
  const { db, ids } = H.setup(null);
  process.env.BASE_URL = 'http://clinic.local';
  const app = express();
  app.use((req, _res, next) => { const s = req.get('x-test-staff'); if (s) req.session = { staffId: Number(s) }; next(); });
  for (const f of ['public', 'queue', 'tickets']) {
    const m = require(`../routes/${f}`);
    app.use(m.path, m.router);
  }
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, { body, staff } = {}) => {
    const r = await fetch(base + url, { method, headers: Object.assign({ 'content-type': 'application/json' }, staff ? { 'x-test-staff': String(staff) } : {}), body: body ? JSON.stringify(body) : undefined });
    const ct = r.headers.get('content-type') || '';
    return { status: r.status, body: ct.includes('json') ? await r.json() : await r.text(), headers: r.headers };
  };
  return { db, ids, call, close: () => server.close() };
}

test('تدفق المريض والموظف عبر HTTP بصيغة { ok, data } وأكواد العقد', async () => {
  const { ids, call, close } = await boot();
  try {
    const clinic = await call('GET', '/api/public/clinic');
    assert.equal(clinic.status, 200); assert.equal(clinic.body.ok, true);
    const svc = clinic.body.data.services[0];
    assert.equal(svc.prefix, 'A'); assert.ok(!JSON.stringify(clinic.body).includes('"id":1'));
    assert.equal(clinic.headers.get('cache-control'), 'no-store');

    const bad = await call('POST', '/api/public/tickets', { body: {} });
    assert.equal(bad.status, 400); assert.equal(bad.body.error.code, 'VALIDATION');

    const issued = await call('POST', '/api/public/tickets', { body: { serviceKey: svc.key } });
    assert.equal(issued.status, 201);
    const { ticket, token } = issued.body.data;
    assert.equal(ticket.number, 'A-001'); assert.equal(token.length, 43);

    const st = await call('GET', `/api/public/tickets/${token}`);
    assert.equal(st.body.data.status, 'waiting'); assert.equal(st.body.data.number, 'A-001');
    assert.equal(st.body.data._publicId, undefined);
    assert.equal((await call('GET', '/api/public/tickets/' + 'z'.repeat(43))).status, 404);

    const qrSvg = await call('GET', `/api/public/tickets/${token}/qr.svg`);
    assert.match(qrSvg.headers.get('content-type'), /svg/); assert.match(qrSvg.body, /<svg/);
    const portal = await call('GET', '/api/public/qr/portal.svg'); assert.match(portal.body, /<svg/);
    assert.equal((await call('GET', '/api/public/qr/wifi.svg')).status, 404); // لم يُضبط
    ids; // eslint
    // الموظف
    const noAuth = await call('POST', '/api/queue/call-next', { body: { counterId: ids.counters[0] } });
    assert.equal(noAuth.status, 401); assert.equal(noAuth.body.error.code, 'UNAUTHENTICATED');
    const cn = await call('POST', '/api/queue/call-next', { staff: ids.staff[0], body: { counterId: ids.counters[0] } });
    assert.equal(cn.status, 200); assert.equal(cn.body.data.ticket.status, 'called');
    const pidv = cn.body.data.ticket.publicId;
    assert.equal((await call('GET', `/api/public/tickets/${token}`)).body.data.status, 'called');
    assert.equal((await call('POST', `/api/queue/tickets/${pidv}/complete`, { staff: ids.staff[0] })).body.error.code, 'INVALID_TRANSITION');
    assert.equal((await call('POST', `/api/queue/tickets/${pidv}/start`, { staff: ids.staff[0] })).status, 200);
    assert.equal((await call('POST', `/api/queue/tickets/${pidv}/complete`, { staff: ids.staff[0] })).body.data.ticket.status, 'completed');
    assert.equal((await call('POST', '/api/queue/call-next', { staff: ids.staff[0], body: { counterId: ids.counters[0] } })).body.error.code, 'QUEUE_EMPTY');
    assert.equal((await call('POST', `/api/queue/tickets/${pidv}/cancel`, { staff: ids.staff[0] })).body.error.code, 'FORBIDDEN');
    // verify بالتوكن
    const v = await call('POST', '/api/queue/verify', { staff: ids.staff[0], body: { token } });
    assert.equal(v.body.data.ticket.number, 'A-001');
    const lk = await call('GET', '/api/queue/lookup?number=a1', { staff: ids.staff[0] });
    assert.equal(lk.body.data.ticket.status, 'completed');
    // أدمن
    assert.equal((await call('GET', '/api/admin/tickets', { staff: ids.staff[0] })).status, 403);
    const list = await call('GET', '/api/admin/tickets', { staff: ids.manager });
    assert.equal(list.body.data.total, 1);
    const evs = await call('GET', `/api/admin/tickets/${pidv}/events`, { staff: ids.manager });
    assert.deepEqual(evs.body.data.events.map((e) => e.type), ['created', 'called', 'serving', 'completed']);
    assert.equal((await call('POST', '/api/admin/queue/reset-day', { staff: ids.manager, body: {} })).status, 400);
    assert.equal((await call('POST', '/api/admin/queue/reset-day', { staff: ids.manager, body: { confirm: true } })).body.data.cancelled, 0);
  } finally { close(); }
});

test('wifi QR يُنتج عند ضبط الإعدادات؛ وصيغة WIFI: صحيحة مع التهريب', async () => {
  const qr = require('./qr');
  assert.equal(qr.wifiString({ ssid: 'Clinic;Guest', password: 'p:a"ss' }), 'WIFI:T:WPA;S:Clinic\\;Guest;P:p\\:a\\"ss;;');
  assert.equal(qr.wifiString({ ssid: 'Open', type: 'nopass' }), 'WIFI:T:nopass;S:Open;;');
  const { db, ids, call, close } = await boot();
  try {
    db.prepare(`INSERT INTO clinic_settings VALUES (?,?,?,?)`).run(ids.clinicId, 'wifi_ssid', 'Guest', 'x');
    db.prepare(`INSERT INTO clinic_settings VALUES (?,?,?,?)`).run(ids.clinicId, 'wifi_password', 'secret1234', 'x');
    const r = await call('GET', '/api/public/qr/wifi.svg');
    assert.equal(r.status, 200); assert.match(r.body, /<svg/);
  } finally { close(); }
});

test('محدّد إصدار التذاكر يرد 429 RATE_LIMITED', async () => {
  const { call, close } = await boot();
  const pub = require('../routes/public').router;
  try {
    const svc = (await call('GET', '/api/public/clinic')).body.data.services[0];
    pub._limiters.issueLimit.reset();
    let last;
    for (let i = 0; i < 21; i++) last = await call('POST', '/api/public/tickets', { body: { serviceKey: svc.key } });
    assert.equal(last.status, 429); assert.equal(last.body.error.code, 'RATE_LIMITED');
    pub._limiters.issueLimit.reset();
  } finally { close(); }
});

test('بنية الأخطاء: لا تسريب لتفاصيل داخلية عند خطأ غير متوقع', async () => {
  const { db, call, close } = await boot();
  try {
    db.exec('DROP TABLE tickets');
    const r = await call('GET', '/api/public/tickets/' + 'a'.repeat(43));
    assert.equal(r.status, 500); assert.equal(r.body.error.code, 'INTERNAL');
    assert.ok(!/tickets|SQL|no such/i.test(JSON.stringify(r.body)));
  } finally { close(); }
});
