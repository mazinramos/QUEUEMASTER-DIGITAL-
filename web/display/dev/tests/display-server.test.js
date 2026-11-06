'use strict';
const h = require('./_helpers');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const svc = require('../../../../server/src/services/displayService');
const { createDisplayRouter } = require('../../../../server/src/routes/display');

const SECRET = 'test-secret';
process.env.DISPLAY_COOKIE_SECRET = SECRET; // نفس السر لـ resolveDisplay (الإنتاج: كلاهما getSecret())
async function setup(opts = {}) {
  const db = h.createTestDb();
  const clinic = h.seedClinic(db);
  const other = h.seedClinic(db, { name: 'عيادة أخرى' });
  const ins = db.prepare(`INSERT INTO staff (id,clinic_id,username,password_hash,full_name,role,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`);
  const ts0 = h.iso();
  ins.run(1, clinic.clinicId, 'admin', 'x', 'Admin', 'admin', ts0, ts0);
  ins.run(2, clinic.clinicId, 'staff', 'x', 'Staff', 'staff', ts0, ts0);
  ins.run(9, other.clinicId, 'admin2', 'x', 'Admin2', 'admin', ts0, ts0);
  const uploads = fs.mkdtempSync(path.join(os.tmpdir(), 'qm-up-'));
  fs.mkdirSync(path.join(uploads, 'audio', 'ar'), { recursive: true });
  const emitted = [];
  let staff = { id: 1, role: 'admin', clinicId: clinic.clinicId };
  const app = express();
  app.use(createDisplayRouter({
    getDb: () => db, secret: SECRET, getUploadsDir: () => uploads,
    emit: (clinicId, ev, p) => emitted.push({ room: `clinic:${clinicId}:display`, ev, p }),
    getStaff: () => staff, pairLimit: opts.pairLimit || 10,
  }));
  app.use((err, req, res, next) => { res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err.message } }); });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    db, clinic, other, uploads, emitted, base, setStaff: (s) => { staff = s; },
    close: () => { server.close(); db.close(); fs.rmSync(uploads, { recursive: true, force: true }); },
  };
}
const J = (r) => r.json();
const post = (url, body, headers = {}) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const cookieFrom = (res) => (res.headers.get('set-cookie') || '').split(';')[0];

test('إقران: كود صحيح يضبط كوكي HttpOnly وbootstrap يعمل', async () => {
  const t = await setup();
  try {
    const { display, pairingCode } = svc.createDisplay(t.db, { clinicId: t.clinic.clinicId, name: 'شاشة الصالة' });
    assert.match(pairingCode, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    const raw = t.db.prepare('SELECT pairing_code_hash FROM displays WHERE id=?').get(display.id).pairing_code_hash;
    assert.notEqual(raw, pairingCode); assert.match(raw, /^[0-9a-f]{64}$/);

    const r = await post(`${t.base}/api/display/pair`, { code: pairingCode.toLowerCase() });
    assert.equal(r.status, 200);
    const sc = r.headers.get('set-cookie');
    assert.match(sc, /^qm\.display=/); assert.match(sc, /HttpOnly/i); assert.match(sc, /SameSite=Lax/i);
    const body = await r.json();
    assert.equal(body.ok, true); assert.equal(body.data.display.name, 'شاشة الصالة');

    const b = await fetch(`${t.base}/api/display/bootstrap`, { headers: { cookie: cookieFrom(r) } });
    assert.equal(b.status, 200);
    const d = (await b.json()).data;
    assert.equal(d.clinic.name_ar, 'عيادة الأمل');
    assert.equal(d.display.id, display.id);
    for (const k of ['settings', 'current', 'next', 'recent', 'ads', 'serverTime', 'waitingCount']) assert.ok(k in d, k);
    assert.equal(d.settings.announce_lang, 'both'); assert.equal(d.settings.audio_enabled, true);
  } finally { t.close(); }
});

test('إقران: كود خاطئ/شكل غير صالح/نوع غير نص', async () => {
  const t = await setup();
  try {
    assert.equal((await post(`${t.base}/api/display/pair`, { code: 'AAAA-BBBB' })).status, 404);
    assert.equal((await post(`${t.base}/api/display/pair`, { code: '123' })).status, 404);
    assert.equal((await post(`${t.base}/api/display/pair`, { code: { $ne: 1 } })).status, 400);
    assert.equal((await post(`${t.base}/api/display/pair`, {})).status, 400);
  } finally { t.close(); }
});

test('إقران: تحديد المعدل بعد محاولات فاشلة', async () => {
  const t = await setup({ pairLimit: 3 });
  try {
    for (let i = 0; i < 3; i++) assert.equal((await post(`${t.base}/api/display/pair`, { code: 'AAAA-BBBB' })).status, 404);
    const r = await post(`${t.base}/api/display/pair`, { code: 'AAAA-BBBB' });
    assert.equal(r.status, 429); assert.equal((await r.json()).error.code, 'RATE_LIMITED');
  } finally { t.close(); }
});

test('bootstrap: بدون كوكي/كوكي مزوّر/شاشة معطلة/كود معاد ضبطه = 401', async () => {
  const t = await setup();
  try {
    const { display, pairingCode } = svc.createDisplay(t.db, { clinicId: t.clinic.clinicId, name: 'x' });
    assert.equal((await fetch(`${t.base}/api/display/bootstrap`)).status, 401);
    assert.equal((await fetch(`${t.base}/api/display/bootstrap`, { headers: { cookie: `qm.display=${display.id}.${'a'.repeat(64)}` } })).status, 401);
    const ck = cookieFrom(await post(`${t.base}/api/display/pair`, { code: pairingCode }));
    assert.equal((await fetch(`${t.base}/api/display/bootstrap`, { headers: { cookie: ck } })).status, 200);
    svc.resetPairing(t.db, t.clinic.clinicId, display.id, 1);
    assert.equal((await fetch(`${t.base}/api/display/bootstrap`, { headers: { cookie: ck } })).status, 401, 'إعادة ضبط الكود تبطل الكوكي القديم');
    const r2 = svc.resetPairing(t.db, t.clinic.clinicId, display.id, 1);
    const ck2 = cookieFrom(await post(`${t.base}/api/display/pair`, { code: r2.pairingCode }));
    svc.updateDisplay(t.db, t.clinic.clinicId, display.id, { is_active: false }, 1);
    assert.equal((await fetch(`${t.base}/api/display/bootstrap`, { headers: { cookie: ck2 } })).status, 401);
  } finally { t.close(); }
});

test('bootstrap: محتوى الطابور، عزل العيادات، ترتيب التالي، التاريخ التجاري', async () => {
  const t = await setup();
  try {
    const now = Date.now();
    const iso = (ms) => new Date(now - ms).toISOString();
    h.addTicket(t.db, t.clinic, { n: 20, status: 'completed', counter: t.clinic.c1, calledAt: iso(600000) });
    h.addTicket(t.db, t.clinic, { n: 21, status: 'serving', counter: t.clinic.c1, calledAt: iso(300000) });
    h.addTicket(t.db, t.clinic, { n: 22, status: 'called', counter: t.clinic.c2, calledAt: iso(5000) });
    h.addTicket(t.db, t.clinic, { n: 23, issuedAt: iso(4000) });
    h.addTicket(t.db, t.clinic, { n: 24, issuedAt: iso(3000), priority: 1 });
    h.addTicket(t.db, t.clinic, { n: 25, issuedAt: iso(2000) });
    h.addTicket(t.db, t.clinic, { n: 26, issuedAt: iso(1000) });
    h.addTicket(t.db, t.clinic, { n: 30, status: 'called', counter: t.clinic.c1, calledAt: iso(1000), date: '2001-01-01' }); // أمس: يُتجاهل
    h.addTicket(t.db, t.other, { n: 99, status: 'called', counter: t.other.c1, calledAt: iso(1) });  // عيادة أخرى
    const { pairingCode } = svc.createDisplay(t.db, { clinicId: t.clinic.clinicId, name: 'x' });
    const ck = cookieFrom(await post(`${t.base}/api/display/pair`, { code: pairingCode }));
    const d = (await (await fetch(`${t.base}/api/display/bootstrap`, { headers: { cookie: ck } })).json()).data;
    assert.deepEqual(d.current.map((x) => x.number), ['A-022', 'A-021']);
    assert.equal(d.current[0].counter.number, 2);
    assert.deepEqual(d.next.map((x) => x.number), ['A-024', 'A-023', 'A-025'], 'الأولوية أولاً ثم الأقدم، 3 فقط');
    assert.equal(d.waitingCount, 4);
    assert.deepEqual(d.recent.map((x) => x.number), ['A-022', 'A-021', 'A-020']);
    assert.ok(!JSON.stringify(d).includes('A-099') && !JSON.stringify(d).includes('A-030'));
  } finally { t.close(); }
});

test('الإعلانات في bootstrap: الفعّال/التواريخ/الاستهداف/الأولوية/الإخفاء بلا ملف', async () => {
  const t = await setup();
  try {
    const ts = new Date().toISOString(); const day = 86400000;
    const add = (o) => t.db.prepare(`INSERT INTO advertisements (clinic_id,title,media_type,file_path,body_text,duration_sec,priority,starts_at,ends_at,is_active,display_ids,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(o.clinic || t.clinic.clinicId, o.title, o.type || 'image', ('file' in o ? o.file : 'server/uploads/a.png'), o.body ?? null, o.dur || 10, o.pr || 0, o.s ?? null, o.e ?? null, o.act ?? 1, o.ids ?? null, ts, ts);
    const { display, pairingCode } = svc.createDisplay(t.db, { clinicId: t.clinic.clinicId, name: 'x' });
    add({ title: 'low' });
    add({ title: 'high', pr: 5, file: 'b.jpg' });
    add({ title: 'inactive', act: 0 });
    add({ title: 'future', s: new Date(Date.now() + day).toISOString() });
    add({ title: 'expired', e: new Date(Date.now() - day).toISOString() });
    add({ title: 'other-display', ids: JSON.stringify([display.id + 100]) });
    add({ title: 'this-display', ids: JSON.stringify([display.id]), file: 'c.webp' });
    add({ title: 'text', type: 'text', file: null, body: 'مرحباً' });
    add({ title: 'text-empty', type: 'text', file: null, body: null });
    add({ title: 'no-file', file: null });
    add({ title: 'other-clinic', clinic: t.other.clinicId });
    const ck = cookieFrom(await post(`${t.base}/api/display/pair`, { code: pairingCode }));
    const d = (await (await fetch(`${t.base}/api/display/bootstrap`, { headers: { cookie: ck } })).json()).data;
    assert.deepEqual(d.ads.map((a) => a.title), ['high', 'low', 'this-display', 'text']);
    assert.equal(d.ads[0].url, '/media/b.jpg');
    assert.equal(d.ads[1].url, '/media/a.png', 'يُحوَّل المسار لاسم ملف فقط');
  } finally { t.close(); }
});

test('إدارة الشاشات: صلاحيات، إنشاء، إعدادات، تحقق، عزل، بث الإعدادات', async () => {
  const t = await setup();
  try {
    t.setStaff(null);
    assert.equal((await fetch(`${t.base}/api/admin/displays`)).status, 401);
    t.setStaff({ id: 2, role: 'staff', clinicId: t.clinic.clinicId });
    assert.equal((await fetch(`${t.base}/api/admin/displays`)).status, 403);
    t.setStaff({ id: 1, role: 'admin', clinicId: t.clinic.clinicId });

    const c = await post(`${t.base}/api/admin/displays`, { name: 'شاشة 1', settings: { announce_lang: 'ar', repeat_count: 3 } });
    assert.equal(c.status, 201);
    const created = (await c.json()).data;
    assert.match(created.pairingCode, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    assert.equal(created.display.settings.announce_lang, 'ar'); assert.equal(created.display.settings.repeat_count, 3);

    const list = (await (await fetch(`${t.base}/api/admin/displays`)).json()).data.displays;
    assert.equal(list.length, 1); assert.ok(!JSON.stringify(list).includes(created.pairingCode));
    assert.ok(!JSON.stringify(list).includes('pairing_code_hash'));

    const id = created.display.id;
    const put = (body, p = `/api/admin/displays/${id}/settings`) => fetch(`${t.base}${p}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const ok = await put({ volume: 0.4, audio_enabled: false, announce_lang: 'en' });
    assert.equal(ok.status, 200);
    const s = (await ok.json()).data.display.settings;
    assert.equal(s.volume, 0.4); assert.equal(s.audio_enabled, false); assert.equal(s.announce_lang, 'en'); assert.equal(s.repeat_count, 3);
    assert.equal(t.emitted.length, 1);
    assert.equal(t.emitted[0].room, `clinic:${t.clinic.clinicId}:display`); assert.equal(t.emitted[0].ev, 'display:settings_updated');
    assert.equal(t.emitted[0].p.displayId, id); assert.equal(t.emitted[0].p.settings.volume, 0.4);

    for (const bad of [{ volume: 2 }, { speech_rate: 0.1 }, { repeat_count: 9 }, { announce_lang: 'fr' }, { foo: 1 }, { volume: '1' }]) {
      assert.equal((await put(bad)).status, 400, JSON.stringify(bad));
    }
    assert.equal((await put({ volume: 1 }, '/api/admin/displays/abc/settings')).status, 400);

    // عزل: أدمن عيادة أخرى لا يرى ولا يعدّل
    t.setStaff({ id: 9, role: 'admin', clinicId: t.other.clinicId });
    assert.equal((await put({ volume: 1 })).status, 404);
    assert.equal((await (await fetch(`${t.base}/api/admin/displays`)).json()).data.displays.length, 0);
    assert.equal((await fetch(`${t.base}/api/admin/displays/${id}`, { method: 'DELETE' })).status, 404);
    assert.equal((await post(`${t.base}/api/admin/displays/${id}/reset-pairing`, {})).status, 404);

    t.setStaff({ id: 1, role: 'admin', clinicId: t.clinic.clinicId });
    assert.equal((await post(`${t.base}/api/admin/displays`, { name: '' })).status, 400);
    assert.equal((await fetch(`${t.base}/api/admin/displays/${id}`, { method: 'DELETE' })).status, 200);
    assert.ok(t.db.prepare(`SELECT COUNT(*) n FROM audit_logs WHERE action LIKE 'display.%'`).get().n >= 3, 'تسجيل في audit_logs');
  } finally { t.close(); }
});

/* ---------------- media ---------------- */
test('media: ملفات صالحة، MIME، nosniff، ETag/304', async () => {
  const t = await setup();
  try {
    fs.writeFileSync(path.join(t.uploads, 'a.png'), Buffer.from('PNGDATA'));
    fs.writeFileSync(path.join(t.uploads, 'v.mp4'), Buffer.from('0123456789'));
    const r = await fetch(`${t.base}/media/a.png`);
    assert.equal(r.status, 200); assert.equal(r.headers.get('content-type'), 'image/png');
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(await r.text(), 'PNGDATA');
    const etag = r.headers.get('etag');
    assert.equal((await fetch(`${t.base}/media/a.png`, { headers: { 'if-none-match': etag } })).status, 304);
    assert.equal((await fetch(`${t.base}/media/a.png`, { method: 'HEAD' })).headers.get('content-length'), '7');
    assert.equal((await fetch(`${t.base}/media/v.mp4`)).headers.get('content-type'), 'video/mp4');
  } finally { t.close(); }
});

test('media: Range للفيديو (206 / suffix / 416)', async () => {
  const t = await setup();
  try {
    fs.writeFileSync(path.join(t.uploads, 'v.mp4'), Buffer.from('0123456789'));
    const g = (range) => fetch(`${t.base}/media/v.mp4`, { headers: { range } });
    let r = await g('bytes=2-4'); assert.equal(r.status, 206); assert.equal(r.headers.get('content-range'), 'bytes 2-4/10'); assert.equal(await r.text(), '234');
    r = await g('bytes=7-'); assert.equal(r.status, 206); assert.equal(await r.text(), '789');
    r = await g('bytes=-3'); assert.equal(r.status, 206); assert.equal(await r.text(), '789');
    r = await g('bytes=5-999'); assert.equal(r.status, 206); assert.equal(r.headers.get('content-range'), 'bytes 5-9/10');
    r = await g('bytes=10-20'); assert.equal(r.status, 416); assert.equal(r.headers.get('content-range'), 'bytes */10');
    r = await g('bytes=5-2'); assert.equal(r.status, 416);
    r = await g('bytes=abc'); assert.equal(r.status, 416);
  } finally { t.close(); }
});

test('media: أمان المسار والأنواع (traversal، امتدادات ممنوعة، مخفية، symlink)', async () => {
  const t = await setup();
  try {
    fs.writeFileSync(path.join(t.uploads, 'ok.png'), 'x');
    fs.writeFileSync(path.join(t.uploads, 'evil.html'), '<script>alert(1)</script>');
    fs.writeFileSync(path.join(t.uploads, 'evil.svg'), '<svg onload=alert(1)/>');
    fs.writeFileSync(path.join(t.uploads, '.env'), 'SECRET=1');
    fs.writeFileSync(path.join(t.uploads, '.hidden.png'), 'x');
    fs.writeFileSync(path.join(t.uploads, 'noext'), 'x');
    fs.writeFileSync(path.join(t.uploads, 'double..png'), 'x');
    const outside = path.join(os.tmpdir(), `qm-secret-${Date.now()}.png`);
    fs.writeFileSync(outside, 'TOPSECRET');
    let symlinkOk = true;
    try { fs.symlinkSync(outside, path.join(t.uploads, 'link.png')); } catch { symlinkOk = false; }
    const paths = ['evil.html', 'evil.svg', '.env', '.hidden.png', 'noext', 'double..png', '..%2F..%2Fetc%2Fpasswd', '%2e%2e%2fok.png', 'a%00.png', 'ok.png%00.html', 'nope.png', 'sub%5Cok.png', 'ok.PNG.exe'];
    if (symlinkOk) paths.push('link.png');
    for (const p of paths) {
      const r = await fetch(`${t.base}/media/${p}`);
      assert.equal(r.status, 404, `${p} => ${r.status}`);
      assert.ok(!(await r.text()).includes('TOPSECRET'));
    }
    // حالة الأحرف الكبيرة في الامتداد مقبولة لكن بنفس القواعد
    fs.writeFileSync(path.join(t.uploads, 'UP.PNG'), 'x');
    assert.equal((await fetch(`${t.base}/media/UP.PNG`)).status, 200);
    // مجلد باسم صالح
    fs.mkdirSync(path.join(t.uploads, 'dir.png'));
    assert.equal((await fetch(`${t.base}/media/dir.png`)).status, 404);
    fs.rmSync(outside, { force: true });
  } finally { t.close(); }
});

test('media/audio: ar/en فقط وامتدادات صوت فقط', async () => {
  const t = await setup();
  try {
    fs.writeFileSync(path.join(t.uploads, 'audio', 'ar', 'number-5.mp3'), 'MP3');
    fs.writeFileSync(path.join(t.uploads, 'audio', 'ar', 'x.png'), 'x');
    const r = await fetch(`${t.base}/media/audio/ar/number-5.mp3`);
    assert.equal(r.status, 200); assert.equal(r.headers.get('content-type'), 'audio/mpeg');
    assert.equal((await fetch(`${t.base}/media/audio/ar/x.png`)).status, 404);
    assert.equal((await fetch(`${t.base}/media/audio/fr/number-5.mp3`)).status, 404);
    assert.equal((await fetch(`${t.base}/media/audio/..%2F/number-5.mp3`)).status, 404);
    assert.equal((await fetch(`${t.base}/media/audio/ar/missing.mp3`)).status, 404);
    assert.equal((await fetch(`${t.base}/media/number-5.mp3`)).status, 404, 'الصوت غير مسموح في المسار العام');
  } finally { t.close(); }
});

test('businessDate يحترم منطقة العيادة', () => {
  const d = new Date('2026-11-05T22:30:00Z');
  assert.equal(svc.businessDate('Africa/Cairo', d), '2026-11-06');
  assert.equal(svc.businessDate('UTC', d), '2026-11-05');
  assert.equal(svc.businessDate('Not/AZone', d), '2026-11-05');
});

test('displayAuth.resolveDisplay: عقد حساب 2 (قيمة الكوكي -> {displayId, clinicId})', async () => {
  const t = await setup();
  try {
    const { resolveDisplay } = require('../../../../server/src/services/displayAuth');
    const { display, pairingCode } = svc.createDisplay(t.db, { clinicId: t.clinic.clinicId, name: 'x' });
    const ck = cookieFrom(await post(`${t.base}/api/display/pair`, { code: pairingCode }));
    const value = decodeURIComponent(ck.split('=').slice(1).join('='));
    assert.deepEqual(resolveDisplay(value, t.db), { displayId: display.id, clinicId: t.clinic.clinicId });
    for (const bad of [null, undefined, '', 'x', '1.abc', `${display.id}.${'0'.repeat(64)}`, 'a'.repeat(500), 123]) assert.equal(resolveDisplay(bad, t.db), null, String(bad).slice(0, 20));
    svc.updateDisplay(t.db, t.clinic.clinicId, display.id, { is_active: false }, 1);
    assert.equal(resolveDisplay(value, t.db), null, 'شاشة معطلة');
    svc.updateDisplay(t.db, t.clinic.clinicId, display.id, { is_active: true }, 1);
    assert.deepEqual(resolveDisplay(value, t.db).displayId, display.id);
    t.db.prepare('UPDATE clinics SET is_active = 0 WHERE id = ?').run(t.clinic.clinicId);
    assert.equal(resolveDisplay(value, t.db), null, 'عيادة معطلة');
  } finally { t.close(); }
});
