'use strict';
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createTestDb } = require('./helpers/testDb');
const { seedService, seedCounter, seedTicket, seedEvent } = require('./helpers/seed');
const { createReportsService } = require('../src/services/reportsService');
const { createReportsRouter } = require('../src/routes/reports');
const { toCsv, cell, BOM } = require('../src/services/reportsCsv');

const NOW = new Date('2026-11-04T10:00:00.000Z'); // 12:00 بتوقيت القاهرة، التاريخ التشغيلي 2026-11-04
const RANK = { staff: 1, manager: 2, admin: 3 };
const at = (date, hm) => `${date}T${hm}:00.000Z`;

describe('reports', () => {
  let t; let db; let server; let base; let ids;
  const adm1 = { 'x-test-staff': JSON.stringify({ id: 1, clinicId: 1, role: 'admin' }) };
  const adm2 = { 'x-test-staff': JSON.stringify({ id: 2, clinicId: 2, role: 'admin' }) };
  const stf = { 'x-test-staff': JSON.stringify({ id: 9, clinicId: 1, role: 'staff' }) };
  const get = async (url, headers = adm1) => {
    const res = await fetch(base + url, { headers });
    const text = await res.text();
    let body = null; try { body = JSON.parse(text); } catch (_) {}
    return { status: res.status, body, text, res };
  };

  before(async () => {
    t = createTestDb(); db = t.db;
    const A = seedService(db, 1, 'A', 'الباطنة', 0); const B = seedService(db, 1, 'B', 'العيون', 1);
    const c1 = seedCounter(db, 1, 1); const c2 = seedCounter(db, 1, 2);
    const D = '2026-11-04';
    const mk = (o) => seedTicket(db, { clinicId: 1, serviceId: A, date: D, prefix: 'A', ...o });
    mk({ status: 'completed', issued: at(D, '08:00'), called: at(D, '08:10'), serving: at(D, '08:11'), completed: at(D, '08:21'), counterId: c1, calledBy: 1 });
    mk({ status: 'completed', issued: at(D, '08:05'), called: at(D, '08:25'), serving: at(D, '08:26'), completed: at(D, '08:56'), counterId: c1, calledBy: 1 });
    const skipped = mk({ status: 'skipped', issued: at(D, '08:10'), called: at(D, '08:40'), counterId: c2, calledBy: 9 });
    const cancelled = mk({ status: 'cancelled', issued: at(D, '09:00') });
    mk({ status: 'waiting', issued: at(D, '09:30') });
    mk({ status: 'called', issued: at(D, '09:00'), called: at(D, '09:30'), counterId: c2, calledBy: 9 });
    seedTicket(db, { clinicId: 1, serviceId: B, date: D, prefix: 'B', status: 'completed', issued: at(D, '07:00'), called: at(D, '07:05'), serving: at(D, '07:05'), completed: at(D, '07:15'), counterId: c2, calledBy: 9 });
    seedEvent(db, { clinicId: 1, ticketId: skipped, type: 'skipped', staffId: 9 });
    seedEvent(db, { clinicId: 1, ticketId: cancelled, type: 'cancelled', staffId: 1 });
    const D3 = '2026-11-03';
    for (const hm of ['08:00', '08:30']) {
      const [h, m] = hm.split(':').map(Number); const p = (x) => String(x).padStart(2, '0');
      seedTicket(db, { clinicId: 1, serviceId: A, date: D3, prefix: 'A', status: 'completed', issued: at(D3, hm), called: at(D3, `${p(h)}:${p(m + 10)}`), serving: at(D3, `${p(h)}:${p(m + 10)}`), completed: at(D3, `${p(h)}:${p(m + 20)}`), counterId: c1, calledBy: 1 });
    }
    const D0 = '2026-10-20';
    seedTicket(db, { clinicId: 1, serviceId: A, date: D0, prefix: 'A', status: 'completed', issued: at(D0, '08:00'), called: at(D0, '08:40'), serving: at(D0, '08:40'), completed: at(D0, '08:45'), counterId: c1, calledBy: 1 });
    // عيادة 2 (يجب ألا تتسرب)
    const S2 = seedService(db, 2, 'Z', '=HYPERLINK("http://evil")');
    seedTicket(db, { clinicId: 2, serviceId: S2, date: D, prefix: 'Z', status: 'completed', issued: at(D, '08:00'), called: at(D, '08:01'), serving: at(D, '08:01'), completed: at(D, '08:02') });
    ids = { A, B, S2 };

    const service = createReportsService({ getDb: () => db, now: () => NOW });
    const app = express();
    const guards = (req, res, next) => {
      const raw = req.headers['x-test-staff'];
      if (!raw) return res.status(401).json({ ok: false, error: { code: 'UNAUTHENTICATED', message: 'x' } });
      const s = JSON.parse(raw);
      if ((RANK[s.role] || 0) < RANK.manager) return res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: 'x' } });
      req.staff = s; return next();
    };
    app.use('/api/admin', createReportsRouter({ service, guards }));
    server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    base = `http://127.0.0.1:${server.address().port}/api/admin`;
  });
  after(async () => { await new Promise((r) => server.close(r)); t.cleanup(); });

  test('بطاقات اليوم بأرقام مُحسوبة يدوياً', async () => {
    const r = await get('/stats/overview');
    assert.equal(r.status, 200);
    const c = r.body.data.cards;
    assert.deepEqual(c, { today: 7, waiting: 1, inService: 1, completed: 3, skipped: 1, cancelled: 1, avgWaitMin: 19, avgServiceMin: 16.7 });
    assert.equal(r.body.data.date, '2026-11-04');
  });

  test('أداء الخدمات والشبابيك في اللوحة', async () => {
    const d = (await get('/stats/overview')).body.data;
    const a = d.services.find((s) => s.prefix === 'A'); const b = d.services.find((s) => s.prefix === 'B');
    assert.deepEqual([a.issued, a.waiting, a.inService, a.completed, a.skipped, a.cancelled, a.avgWaitMin, a.avgServiceMin], [6, 1, 1, 2, 1, 1, 22.5, 20]);
    assert.deepEqual([b.issued, b.completed, b.avgWaitMin, b.avgServiceMin], [1, 1, 5, 10]);
    const c1 = d.counters.find((c) => c.number === 1); const c2 = d.counters.find((c) => c.number === 2);
    assert.deepEqual([c1.served, c1.avgServiceMin, c1.currentTicket], [2, 20, null]);
    assert.equal(c2.served, 1); assert.match(c2.currentTicket, /^A-/);
  });

  test('التوزيع الساعي بتوقيت العيادة (UTC+2) وآخر 7 أيام مع ملء الفراغات', async () => {
    const d = (await get('/stats/overview')).body.data;
    assert.equal(d.hourly.length, 24);
    assert.deepEqual([d.hourly[9].issued, d.hourly[10].issued, d.hourly[11].issued], [1, 3, 3]);
    assert.equal(d.hourly.reduce((a, h) => a + h.issued, 0), 7);
    assert.equal(d.last7Days.length, 7);
    assert.deepEqual(d.last7Days.slice(-2).map((x) => [x.date, x.issued]), [['2026-11-03', 2], ['2026-11-04', 7]]);
    assert.equal(d.last7Days[0].issued, 0);
  });

  test('تاريخ آخر للوحة', async () => {
    const d = (await get('/stats/overview?date=2026-11-03')).body.data;
    assert.deepEqual([d.cards.today, d.cards.completed, d.cards.avgWaitMin, d.cards.avgServiceMin], [2, 2, 10, 10]);
  });

  test('daily: أيام فارغة مملوءة بأصفار والمتوسطات null', async () => {
    const r = (await get('/reports/daily?from=2026-11-02&to=2026-11-04')).body.data;
    assert.deepEqual(r.rows.map((x) => [x.date, x.issued]), [['2026-11-02', 0], ['2026-11-03', 2], ['2026-11-04', 7]]);
    assert.equal(r.rows[0].avgWaitMin, null);
    assert.equal(r.rows[2].avgWaitMin, 19);
  });

  test('weekly (ISO الاثنين) و monthly', async () => {
    const w = (await get('/reports/weekly?from=2026-10-01&to=2026-11-04')).body.data;
    assert.deepEqual(w.rows.map((x) => [x.period, x.issued]), [['2026-10-19', 1], ['2026-11-02', 9]]);
    const m = (await get('/reports/monthly?from=2026-10-01&to=2026-11-30')).body.data;
    assert.deepEqual(m.rows.map((x) => [x.period, x.issued, x.avgWaitMin]), [['2026-10', 1, 40], ['2026-11', 9, 16.4]]);
  });

  test('summary ومرشّح الخدمة', async () => {
    const s = (await get('/reports/summary?from=2026-11-03&to=2026-11-04')).body.data;
    assert.deepEqual([s.issued, s.completed, s.skipped, s.cancelled, s.activeDays, s.avgPerActiveDay], [9, 5, 1, 1, 2, 4.5]);
    const sb = (await get(`/reports/summary?from=2026-11-03&to=2026-11-04&serviceId=${ids.B}`)).body.data;
    assert.deepEqual([sb.issued, sb.avgWaitMin], [1, 5]);
  });

  test('services', async () => {
    const r = (await get('/reports/services?from=2026-11-03&to=2026-11-04')).body.data.rows;
    assert.deepEqual(r.map((x) => [x.prefix, x.issued, x.completed]), [['A', 8, 4], ['B', 1, 1]]);
  });

  test('waiting-times: المتوسط والوسيط وp90 والتوزيع', async () => {
    const w = (await get('/reports/waiting-times')).body.data;
    assert.equal(w.samples, 7);
    assert.deepEqual([w.avgMin, w.medianMin, w.p90Min, w.maxMin], [16.4, 10, 30, 30]);
    assert.deepEqual(w.buckets.map((b) => b.count), [0, 1, 3, 1, 2, 0]);
    assert.equal(w.byHour.reduce((a, h) => a + h.count, 0), 7);
  });

  test('staff: المنادى/المكتمل/متوسط الخدمة والتخطي/الإلغاء من الأحداث', async () => {
    const r = (await get('/reports/staff?from=2026-11-04&to=2026-11-04')).body.data.rows;
    const s1 = r.find((x) => x.id === 1); const s9 = r.find((x) => x.id === 9);
    assert.deepEqual([s1.called, s1.completed, s1.avgServiceMin, s1.cancelled], [2, 2, 20, 1]);
    assert.deepEqual([s9.called, s9.completed, s9.avgServiceMin, s9.skipped], [3, 1, 10, 1]);
  });

  test('عزل العيادات: عيادة 2 ترى بياناتها فقط', async () => {
    const d = (await get('/stats/overview', adm2)).body.data;
    assert.equal(d.cards.today, 1);
    assert.deepEqual(d.services.map((s) => s.prefix), ['Z']);
    assert.equal((await get(`/reports/summary?serviceId=${ids.A}`, adm2)).status, 404, 'serviceId من عيادة أخرى');
    const staff = (await get('/reports/staff?from=2026-11-04&to=2026-11-04', adm2)).body.data.rows;
    assert.deepEqual(staff.map((x) => x.id), [2]);
  });

  test('الصلاحيات: 401 بلا جلسة، 403 للموظف', async () => {
    assert.equal((await get('/stats/overview', {})).status, 401);
    assert.equal((await get('/reports/daily', stf)).status, 403);
  });

  for (const [label, url, status] of [
    ['تاريخ غير صالح', '/reports/daily?from=2026-13-40&to=2026-11-04', 400],
    ['صيغة تاريخ خاطئة', '/reports/daily?from=04-11-2026', 400],
    ['from بعد to', '/reports/daily?from=2026-11-05&to=2026-11-01', 400],
    ['مدى أكبر من 366 يوماً', '/reports/daily?from=2025-01-01&to=2026-11-04', 400],
    ['serviceId غير صالح', '/reports/daily?serviceId=abc', 400],
    ['تقرير غير معروف', '/reports/nope', 404],
    ['مفتاح prototype', '/reports/__proto__', 404],
    ['constructor', '/reports/constructor', 404],
    ['format غير مدعوم', '/reports/daily?format=xml', 400],
    ['date اللوحة غير صالح', '/stats/overview?date=ليس-تاريخ', 400],
  ]) {
    test(`تحقق: ${label}`, async () => {
      const r = await get(url);
      assert.equal(r.status, status, r.text);
      assert.equal(r.body.ok, false);
    });
  }

  test('SQLi في المعاملات لا تنفذ', async () => {
    const r = await get(`/reports/daily?from=2026-11-04'%20OR%201=1--&to=2026-11-04`);
    assert.equal(r.status, 400);
    const r2 = await get(`/reports/daily?serviceId=1%20OR%201=1`);
    assert.equal(r2.status, 400);
  });

  test('CSV: BOM، ترويسات عربية، CRLF، نوع المحتوى واسم الملف', async () => {
    const r = await get('/reports/daily?from=2026-11-03&to=2026-11-04&format=csv');
    assert.equal(r.status, 200);
    assert.match(r.res.headers.get('content-type'), /^text\/csv; charset=utf-8/);
    assert.match(r.res.headers.get('content-disposition'), /attachment; filename="queuemaster-daily-2026-11-03_2026-11-04\.csv"/);
    const raw = Buffer.from(await (await fetch(base + '/reports/daily?from=2026-11-03&to=2026-11-04&format=csv', { headers: adm1 })).arrayBuffer());
    assert.deepEqual([...raw.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'BOM UTF-8');
    const text = raw.toString('utf8').slice(1);
    const lines = text.split('\r\n');
    assert.equal(lines[0], 'التاريخ,المصدرة,المكتملة,المتخطاة,الملغاة,المنتظرة,متوسط الانتظار (د),متوسط الخدمة (د)');
    assert.equal(lines[1], '2026-11-03,2,2,0,0,0,10,10');
    assert.equal(lines[2], '2026-11-04,7,3,1,1,1,19,16.7');
    assert.equal(lines[3], ''); assert.equal(lines.length, 4);
  });

  test('CSV بالإنجليزية وكل التقارير تدعم csv', async () => {
    const en = await get('/reports/services?from=2026-11-04&to=2026-11-04&format=csv&lang=en');
    assert.match(en.text, /Service,Prefix,Issued/);
    for (const n of ['summary', 'daily', 'weekly', 'monthly', 'services', 'waiting-times', 'staff']) {
      const res = await fetch(`${base}/reports/${n}?format=csv`, { headers: adm1 });
      assert.equal(res.status, 200, n);
      const bytes = Buffer.from(await res.arrayBuffer());
      assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], n);
    }
  });

  test('CSV injection: اسم خدمة يبدأ بـ = يُحيَّد', async () => {
    const r = await get('/reports/services?from=2026-11-04&to=2026-11-04&format=csv', adm2);
    assert.ok(r.text.includes(`'=HYPERLINK(""http://evil"")`) || r.text.includes(`"'=HYPERLINK(""http://evil"")"`), r.text);
    assert.ok(!/^=/m.test(r.text.replace(BOM, '')));
  });
});

describe('reportsCsv (وحدة)', () => {
  test('تغليف الفواصل والاقتباس والأسطر', () => {
    assert.equal(cell('a,b'), '"a,b"'); assert.equal(cell('say "hi"'), '"say ""hi"""'); assert.equal(cell('x\ny'), '"x\ny"');
  });
  test('حقن الصيغ: = + - @ tab CR', () => {
    for (const s of ['=1+1', '+SUM(A1)', '-2+3', '@cmd', '\tx', '\rx']) assert.ok(cell(s).replace(/^"/, '').startsWith("'"), JSON.stringify(s));
  });
  test('الأرقام السالبة (number) لا تتأثر، والنصوص العادية كما هي، null فارغ', () => {
    assert.equal(cell(-5), '-5'); assert.equal(cell('عادي'), 'عادي'); assert.equal(cell(null), ''); assert.equal(cell(NaN), '');
  });
  test('toCsv: BOM وCRLF ونهاية سطر', () => {
    const s = toCsv(['ا', 'ب'], [[1, 'x']]);
    assert.equal(s, '\uFEFFا,ب\r\n1,x\r\n');
  });
});
