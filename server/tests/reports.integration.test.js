'use strict';
/** تكامل التقارير مع الباك إند الحقيقي (ح1 جلسات/RBAC/CSRF + ح2 مسارات /api/admin/tickets). يُتخطى إن لم تُدمج الفروع. */
const path = require('path');
const fs = require('fs');
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const SRC = path.resolve(__dirname, '../src');
const have = (p) => fs.existsSync(path.join(SRC, p));
const ready = have('app.js') && have('utils/password.js') && have('routes/auth.js');
const PW = 'Str0ng-Test-Pass!';

describe('reports × الباك إند الحقيقي', { skip: ready ? false : 'ح1 غير مدمج بعد' }, () => {
  let server; let base;
  before(async () => {
    process.env.NODE_ENV = 'test'; process.env.DB_PATH = ':memory:';
    const { createApp } = require(path.join(SRC, 'app.js'));
    const app = createApp();
    const db = require(path.join(SRC, 'database')).getDb();
    const hash = await require(path.join(SRC, 'utils/password.js')).hashPassword(PW);
    const ts = new Date().toISOString();
    const c1 = Number(db.prepare('INSERT INTO clinics (name_ar,created_at,updated_at) VALUES (?,?,?)').run('A', ts, ts).lastInsertRowid);
    const ins = db.prepare('INSERT INTO staff (clinic_id,username,password_hash,full_name,role,created_at,updated_at) VALUES (?,?,?,?,?,?,?)');
    ins.run(c1, 'adm', hash, 'Admin', 'admin', ts, ts); ins.run(c1, 'stf', hash, 'Staff', 'staff', ts, ts);
    server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => {
    if (server) await new Promise((r) => server.close(r));
    try { require(path.join(SRC, 'database')).close(); } catch (_) {}
  });

  async function login(username) {
    let cookie = '';
    const grab = (res) => { for (const c of res.headers.getSetCookie()) cookie = c.split(';')[0]; };
    const r0 = await fetch(`${base}/api/auth/csrf`); grab(r0);
    const csrf = (await r0.json()).data.csrfToken;
    const r = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf, cookie }, body: JSON.stringify({ username, password: PW }) });
    grab(r); assert.equal(r.status, 200);
    return async (url) => { const res = await fetch(base + url, { headers: { cookie } }); return { status: res.status, body: await res.json().catch(() => null), res }; };
  }

  test('بدون جلسة 401 وموظف 403', async () => {
    assert.equal((await fetch(`${base}/api/admin/stats/overview`)).status, 401);
    const get = await login('stf');
    assert.equal((await get('/api/admin/stats/overview')).status, 403);
    assert.equal((await get('/api/admin/reports/daily')).status, 403);
  });

  test('أدمن: overview وتقارير JSON وCSV على بيانات فارغة بلا أخطاء', async () => {
    const get = await login('adm');
    const o = await get('/api/admin/stats/overview');
    assert.equal(o.status, 200, JSON.stringify(o.body));
    assert.equal(o.body.data.cards.today, 0);
    for (const n of ['summary', 'daily', 'weekly', 'monthly', 'services', 'waiting-times', 'staff']) {
      assert.equal((await get(`/api/admin/reports/${n}`)).status, 200, n);
      const c = await get(`/api/admin/reports/${n}?format=csv`);
      assert.equal(c.status, 200, `${n} csv`);
    }
  });

  test('الراوتر لا يبتلع مسارات /api/admin الأخرى (ح1/ح2)', async () => {
    const get = await login('adm');
    assert.equal((await get('/api/admin/services')).status, 200, 'ح1 services');
    const t = await get('/api/admin/tickets');
    assert.notEqual(t.status, 404, 'ح2 tickets ما زال يُخدم');
    assert.equal((await get('/api/admin/no-such-thing')).status, 404);
  });
});
