'use strict';
/**
 * تكامل الإعلانات مع الباك إند الحقيقي (createApp من ح1: جلسات، CSRF، RBAC، app.js يحمّل routes/ads.js،
 * وخدمة /media من ح4 إن وُجدت). يُتخطى تلقائياً إن لم تُدمج فروع الحسابات الأخرى بعد.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const SRC = path.resolve(__dirname, '../../src');
const have = (p) => fs.existsSync(path.join(SRC, p));
const ready = have('app.js') && have('utils/password.js') && have('middleware/auth.js') && have('routes/auth.js');
const hasMedia = have('routes/display.js');

const fx = require('../helpers/fixtures');
const PW = 'Str0ng-Test-Pass!';

describe('ads × الباك إند الحقيقي', { skip: ready ? false : 'ح1 غير مدمج بعد' }, () => {
  let server; let base; let db; let uploadsDir; let emitted; let origEmit; let sockets;

  before(async () => {
    process.env.NODE_ENV = 'test';
    process.env.DB_PATH = ':memory:';
    uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qm-int-up-'));
    process.env.UPLOADS_DIR = uploadsDir;
    require(path.join(SRC, 'config')).uploadsDir = uploadsDir; // مصدر وحيد: الرفع (ح5) و/media (ح4) يقرآن config.uploadsDir
    const { createApp } = require(path.join(SRC, 'app.js'));
    ({ getDb: global.__getDb } = require(path.join(SRC, 'database')));
    const app = createApp();
    db = global.__getDb();
    const { hashPassword } = require(path.join(SRC, 'utils/password.js'));
    const hash = await hashPassword(PW);
    const ts = new Date().toISOString();
    const clinic = (n) => Number(db.prepare('INSERT INTO clinics (name_ar,created_at,updated_at) VALUES (?,?,?)').run(n, ts, ts).lastInsertRowid);
    const staff = (c, u, role) => db.prepare('INSERT INTO staff (clinic_id,username,password_hash,full_name,role,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run(c, u, hash, u, role, ts, ts);
    const c1 = clinic('A'); const c2 = clinic('B');
    staff(c1, 'adm1', 'admin'); staff(c1, 'stf1', 'staff'); staff(c2, 'adm2', 'admin');

    sockets = require(path.join(SRC, 'sockets'));
    origEmit = sockets.emitToClinic;
    emitted = [];
    sockets.emitToClinic = (clinicId, event, payload) => emitted.push({ clinicId, event, payload });

    server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    if (sockets) sockets.emitToClinic = origEmit;
    if (server) await new Promise((r) => server.close(r));
    try { require(path.join(SRC, 'routes/ads.js')).getDefaultService().stopScheduler(); } catch (_) {}
    try { require(path.join(SRC, 'database')).close(); } catch (_) {}
    if (uploadsDir) fs.rmSync(uploadsDir, { recursive: true, force: true });
  });

  async function session(username) {
    let cookie = '';
    const grab = (res) => { for (const c of res.headers.getSetCookie()) cookie = `${c.split(';')[0]}`; };
    const r0 = await fetch(`${base}/api/auth/csrf`); grab(r0);
    let csrf = (await r0.json()).data.csrfToken;
    if (username) {
      const r = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf, cookie }, body: JSON.stringify({ username, password: PW }) });
      grab(r);
      const b = await r.json();
      assert.equal(r.status, 200, JSON.stringify(b));
      csrf = b.data.csrfToken || csrf;
    }
    return {
      async req(method, url, { form, noCsrf } = {}) {
        const headers = { cookie };
        if (!noCsrf) headers['x-csrf-token'] = csrf;
        const res = await fetch(base + url, { method, headers, body: form });
        let body = null; try { body = await res.json(); } catch (_) {}
        return { status: res.status, body, res };
      },
    };
  }
  const form = (fields, file) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.append(k, v);
    if (file) fd.append('file', new Blob([file.buffer], { type: file.type }), file.name);
    return fd;
  };
  const img = { buffer: fx.png(), type: 'image/png', name: 'a.png' };

  test('بدون جلسة → 401', async () => {
    const s = await session(null);
    assert.equal((await s.req('GET', '/api/admin/ads')).status, 401);
  });

  test('موظف عادي → 403 للقراءة والكتابة', async () => {
    const s = await session('stf1');
    assert.equal((await s.req('GET', '/api/admin/ads')).status, 403);
    assert.equal((await s.req('POST', '/api/admin/ads', { form: form({ title: 'x', media_type: 'text', body_text: 'y' }) })).status, 403);
  });

  test('أدمن بدون X-CSRF-Token → 403 ولا يُكتب شيء', async () => {
    const s = await session('adm1');
    const r = await s.req('POST', '/api/admin/ads', { noCsrf: true, form: form({ title: 'x', media_type: 'image' }, img) });
    assert.equal(r.status, 403);
    assert.equal(fs.readdirSync(uploadsDir).filter((f) => !f.startsWith('.')).length, 0);
  });

  let adId; let url;
  test('أدمن: إنشاء إعلان صورة يخزّن الملف ويبث advertisement:updated', async () => {
    const s = await session('adm1');
    emitted.length = 0;
    const r = await s.req('POST', '/api/admin/ads', { form: form({ title: 'تكامل', media_type: 'image', priority: '3' }, img) });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    adId = r.body.data.ad.id; url = r.body.data.ad.url;
    assert.match(url, /^\/media\/[a-f0-9]{32}\.png$/);
    assert.ok(fs.existsSync(path.join(uploadsDir, url.replace('/media/', ''))));
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].event, 'advertisement:updated');
    assert.equal(emitted[0].payload.ads[0].title, 'تكامل');
    const audit = db.prepare("SELECT action FROM audit_logs WHERE entity='advertisement'").all();
    assert.deepEqual(audit.map((a) => a.action), ['ad.create']);
  });

  test('الملف المرفوع يُخدَّم فعلاً عبر /media (ح4) بنوع صحيح و nosniff', { skip: hasMedia ? false : 'ح4 غير مدمج' }, async () => {
    const res = await fetch(base + url);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/png');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), fx.png());
  });

  test('عيادة أخرى لا ترى الإعلان ولا تعدّله ولا تحذفه', async () => {
    const s = await session('adm2');
    assert.deepEqual((await s.req('GET', '/api/admin/ads')).body.data.ads, []);
    assert.equal((await s.req('GET', `/api/admin/ads/${adId}`)).status, 404);
    assert.equal((await s.req('PUT', `/api/admin/ads/${adId}`, { form: form({ title: 'اختراق' }) })).status, 404);
    assert.equal((await s.req('DELETE', `/api/admin/ads/${adId}`)).status, 404);
  });

  test('رفض رفع يتنكر: ملف exe باسم png عبر الباك إند الحقيقي', async () => {
    const s = await session('adm1');
    const r = await s.req('POST', '/api/admin/ads', { form: form({ title: 'x', media_type: 'image' }, { buffer: fx.exe(), type: 'image/png', name: 'a.png' }) });
    assert.equal(r.status, 400);
    assert.equal(r.body.ok, false);
  });

  test('حذف الإعلان يزيل الملف ولا يعود /media يخدمه', { skip: hasMedia ? false : 'ح4 غير مدمج' }, async () => {
    const s = await session('adm1');
    assert.equal((await s.req('DELETE', `/api/admin/ads/${adId}`)).status, 200);
    assert.equal((await fetch(base + url)).status, 404);
  });
});
