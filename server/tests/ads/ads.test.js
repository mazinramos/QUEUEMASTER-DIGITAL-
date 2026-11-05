'use strict';
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startAdsHarness } = require('../helpers/adsHarness');
const { seedDisplay } = require('../helpers/testDb');
const fx = require('../helpers/fixtures');

const MB = 1024 * 1024;
const NOW = new Date('2026-11-04T10:00:00.000Z');
const iso = (mins) => new Date(NOW.getTime() + mins * 60000).toISOString();

describe('ads: الرفع الآمن', () => {
  let h;
  before(async () => { h = await startAdsHarness({ clock: NOW, limits: { imageBytes: 1 * MB, videoBytes: 2 * MB } }); });
  after(() => h.close());

  const base = { title: 'إعلان', duration_sec: 10 };

  for (const [name, buf, type, ext, mime] of [
    ['JPG', fx.jpg(), 'image', '.jpg', 'image/jpeg'],
    ['PNG', fx.png(), 'image', '.png', 'image/png'],
    ['WebP', fx.webp(), 'image', '.webp', 'image/webp'],
    ['MP4', fx.mp4(), 'video', '.mp4', 'video/mp4'],
  ]) {
    test(`يقبل ${name} صالحاً ويخزّنه باسم عشوائي بامتداد النوع المكتشف`, async () => {
      const r = await h.call('POST', '/api/admin/ads', { headers: h.admin1, form: h.makeForm({ ...base, media_type: type }, { buffer: buf, type: mime, name: 'اسم أصلي.php' }) });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.match(r.body.data.ad.url, new RegExp(`^/media/[a-f0-9]{32}\\${ext}$`));
      assert.ok(!r.body.data.ad.url.includes('php'));
      const file = path.join(h.uploadsDir, r.body.data.ad.url.replace('/media/', ''));
      assert.ok(fs.existsSync(file));
    });
  }

  test('الامتداد لا يخدع الفحص: ملف exe باسم .png يُرفض', async () => {
    const r = await h.call('POST', '/api/admin/ads', { form: h.makeForm({ ...base, media_type: 'image' }, { buffer: fx.exe(), type: 'image/png', name: 'a.png' }) });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, 'VALIDATION');
  });

  for (const [name, buf, mime] of [['SVG (XSS)', fx.svg(), 'image/svg+xml'], ['HTML', fx.html(), 'text/html'], ['PHP', fx.php(), 'image/jpeg']]) {
    test(`يرفض ${name}`, async () => {
      const r = await h.call('POST', '/api/admin/ads', { form: h.makeForm({ ...base, media_type: 'image' }, { buffer: buf, type: mime, name: 'x.jpg' }) });
      assert.equal(r.status, 400);
    });
  }

  test('يرفض MP4 بـ brand غير معروف', async () => {
    const r = await h.call('POST', '/api/admin/ads', { form: h.makeForm({ ...base, media_type: 'video' }, { buffer: fx.mp4('zzzz'), type: 'video/mp4', name: 'a.mp4' }) });
    assert.equal(r.status, 400);
  });

  test('حد حجم الصورة (1MB في هذا الإعداد)', async () => {
    const big = Buffer.concat([fx.png(), Buffer.alloc(1 * MB + 10, 7)]);
    const r = await h.call('POST', '/api/admin/ads', { form: h.makeForm({ ...base, media_type: 'image' }, { buffer: big, type: 'image/png', name: 'big.png' }) });
    assert.equal(r.status, 400);
    assert.match(r.body.error.message, /الحد|أكبر/);
  });

  test('الفيديو يسمح بحجم أكبر من الصورة لكن ضمن حده', async () => {
    const mid = Buffer.concat([fx.mp4(), Buffer.alloc(1.5 * MB, 7)]);
    const r = await h.call('POST', '/api/admin/ads', { form: h.makeForm({ ...base, media_type: 'video' }, { buffer: mid, type: 'video/mp4', name: 'v.mp4' }) });
    assert.equal(r.status, 201);
    const huge = Buffer.concat([fx.mp4(), Buffer.alloc(3 * MB, 7)]);
    const r2 = await h.call('POST', '/api/admin/ads', { form: h.makeForm({ ...base, media_type: 'video' }, { buffer: huge, type: 'video/mp4', name: 'v.mp4' }) });
    assert.equal(r2.status, 400);
  });

  test('media_type لا يطابق المحتوى (يدّعي فيديو ويرسل PNG)', async () => {
    const r = await h.call('POST', '/api/admin/ads', { form: h.makeForm({ ...base, media_type: 'video' }, { buffer: fx.png(), type: 'image/png', name: 'a.png' }) });
    assert.equal(r.status, 400);
    assert.match(r.body.error.message, /يطابق|media_type/);
  });

  test('لا تبقى ملفات مؤقتة أو يتيمة بعد الرفض', async () => {
    assert.deepEqual(h.tmpFiles(), []);
    const n = h.db.prepare('SELECT COUNT(*) c FROM advertisements').get().c;
    assert.equal(h.uploadedFiles().length, n, 'كل ملف على القرص يقابله إعلان');
  });

  test('اسمان لنفس الملف ينتجان اسمين مختلفين', async () => {
    const mk = () => h.call('POST', '/api/admin/ads', { form: h.makeForm({ ...base, media_type: 'image' }, { buffer: fx.png(), type: 'image/png', name: 'same.png' }) });
    const [a, b] = [await mk(), await mk()];
    assert.notEqual(a.body.data.ad.url, b.body.data.ad.url);
  });

  test('نوع MIME غير مسموح يُرفض مبكراً', async () => {
    const r = await h.call('POST', '/api/admin/ads', { form: h.makeForm({ ...base, media_type: 'image' }, { buffer: fx.png(), type: 'application/x-msdownload', name: 'a.png' }) });
    assert.equal(r.status, 400);
  });
});

describe('ads: CRUD والتحقق والصلاحيات', () => {
  let h;
  beforeEach(async () => { if (h) await h.close(); h = await startAdsHarness({ clock: NOW }); });
  after(() => h && h.close());

  const png = () => ({ buffer: fx.png(), type: 'image/png', name: 'a.png' });
  const mkImage = (extra = {}, headers) => h.call('POST', '/api/admin/ads', { headers, form: h.makeForm({ title: 'صورة', media_type: 'image', ...extra }, png()) });

  test('دورة كاملة: إنشاء ← قراءة ← تعديل ← حذف (والملف يُحذف)', async () => {
    const c = await mkImage({ priority: '5', duration_sec: '20' });
    assert.equal(c.status, 201);
    const ad = c.body.data.ad;
    assert.equal(ad.priority, 5); assert.equal(ad.durationSec, 20); assert.equal(ad.status, 'active');
    const fileName = ad.url.replace('/media/', '');
    assert.ok(h.uploadedFiles().includes(fileName));

    const g = await h.call('GET', `/api/admin/ads/${ad.id}`);
    assert.equal(g.body.data.ad.title, 'صورة');

    const u = await h.call('PUT', `/api/admin/ads/${ad.id}`, { form: h.makeForm({ title: 'معدّل', priority: '9' }) });
    assert.equal(u.status, 200);
    assert.equal(u.body.data.ad.title, 'معدّل');
    assert.equal(u.body.data.ad.url, ad.url, 'الملف محفوظ عند التعديل بدون ملف جديد');

    const d = await h.call('DELETE', `/api/admin/ads/${ad.id}`);
    assert.equal(d.status, 200);
    assert.ok(!h.uploadedFiles().includes(fileName), 'الملف حُذف من القرص');
    assert.equal((await h.call('GET', `/api/admin/ads/${ad.id}`)).status, 404);
  });

  test('استبدال الملف يحذف القديم', async () => {
    const ad = (await mkImage()).body.data.ad;
    const old = ad.url.replace('/media/', '');
    const u = await h.call('PUT', `/api/admin/ads/${ad.id}`, { form: h.makeForm({}, { buffer: fx.jpg(), type: 'image/jpeg', name: 'n.jpg' }) });
    assert.equal(u.status, 200);
    assert.notEqual(u.body.data.ad.url, ad.url);
    assert.ok(!h.uploadedFiles().includes(old));
    assert.equal(h.uploadedFiles().length, 1);
  });

  test('إعلان نصي بدون ملف، ويرفض بدون نص', async () => {
    const ok = await h.call('POST', '/api/admin/ads', { form: h.makeForm({ title: 'نص', media_type: 'text', body_text: 'مرحباً بكم' }) });
    assert.equal(ok.status, 201);
    assert.equal(ok.body.data.ad.url, null);
    const bad = await h.call('POST', '/api/admin/ads', { form: h.makeForm({ title: 'نص', media_type: 'text' }) });
    assert.equal(bad.status, 400);
    const withFile = await h.call('POST', '/api/admin/ads', { form: h.makeForm({ title: 'نص', media_type: 'text', body_text: 'x' }, png()) });
    assert.equal(withFile.status, 400);
    assert.equal(h.uploadedFiles().length, h.db.prepare('SELECT COUNT(*) c FROM advertisements WHERE file_path IS NOT NULL').get().c, 'لا ملفات يتيمة بعد رفض إعلان نصي مع ملف');
  });

  test('مسح الجدولة: إرسال starts_at/ends_at فارغين في PUT يعيدهما null', async () => {
    const ad = (await mkImage({ starts_at: iso(-10), ends_at: iso(60) })).body.data.ad;
    assert.ok(ad.startsAt && ad.endsAt);
    const u = await h.call('PUT', `/api/admin/ads/${ad.id}`, { form: h.makeForm({ starts_at: '', ends_at: '' }) });
    assert.equal(u.status, 200, JSON.stringify(u.body));
    assert.equal(u.body.data.ad.startsAt, null); assert.equal(u.body.data.ad.endsAt, null);
    const keep = await h.call('PUT', `/api/admin/ads/${ad.id}`, { form: h.makeForm({ title: 'جديد' }) });
    assert.equal(keep.body.data.ad.startsAt, null, 'عدم إرسال الحقل لا يغيّره');
  });

  test('صورة بدون ملف تُرفض', async () => {
    const r = await h.call('POST', '/api/admin/ads', { form: h.makeForm({ title: 'x', media_type: 'image' }) });
    assert.equal(r.status, 400);
  });

  for (const [label, fields] of [
    ['مدة أقل من 3', { duration_sec: '2' }],
    ['مدة أكبر من 300', { duration_sec: '301' }],
    ['عنوان فارغ', { title: '   ' }],
    ['نهاية قبل البداية', { starts_at: iso(60), ends_at: iso(10) }],
    ['تاريخ غير صالح', { starts_at: 'ليس تاريخاً' }],
    ['display_ids ليست مصفوفة', { display_ids: '"abc"' }],
    ['display_ids JSON تالف', { display_ids: '[1,' }],
    ['media_type غير معروف', { media_type: 'gif' }],
  ]) {
    test(`تحقق: ${label}`, async () => {
      const r = await mkImage(fields);
      assert.equal(r.status, 400, JSON.stringify(r.body));
      assert.equal(r.body.error.code, 'VALIDATION');
      assert.equal(h.uploadedFiles().length, 0, 'لا ملف يتيم بعد فشل التحقق');
    });
  }

  test('XSS في العنوان يُخزَّن كنص خام (الهروب مسؤولية العرض) ولا يتحول لتنفيذ', async () => {
    const r = await mkImage({ title: '<script>alert(1)</script>' });
    assert.equal(r.status, 201);
    assert.equal(r.body.data.ad.title, '<script>alert(1)</script>');
  });

  test('SQL injection في الحقول لا يكسر شيئاً', async () => {
    const r = await mkImage({ title: "x'); DROP TABLE advertisements;--" });
    assert.equal(r.status, 201);
    assert.equal(h.db.prepare('SELECT COUNT(*) c FROM advertisements').get().c, 1);
    const g = await h.call('GET', "/api/admin/ads/1 OR 1=1");
    assert.equal(g.status, 404);
  });

  test('حقول غير معروفة (clinic_id, file_path) تُتجاهل: لا حقن مسار ولا تغيير عيادة', async () => {
    const r = await mkImage({ clinic_id: '2', file_path: '../../../etc/passwd', id: '999' });
    assert.equal(r.status, 201);
    const row = h.db.prepare('SELECT * FROM advertisements').get();
    assert.equal(row.clinic_id, 1);
    assert.match(row.file_path, /^[a-f0-9]{32}\.png$/);
  });

  test('بدون جلسة 401، وموظف عادي 403', async () => {
    const r1 = await h.call('GET', '/api/admin/ads', { headers: {} });
    assert.equal(r1.status, 401);
    const staff = h.asStaff({ id: 9, clinicId: 1, role: 'staff' });
    assert.equal((await h.call('GET', '/api/admin/ads', { headers: staff })).status, 403);
    assert.equal((await mkImage({}, staff)).status, 403);
    assert.equal(h.uploadedFiles().length, 0, 'الرفض قبل multer: لا ملف كُتب');
  });

  test('عزل العيادات: عيادة 2 لا ترى/تعدّل/تحذف إعلان عيادة 1', async () => {
    const ad = (await mkImage()).body.data.ad;
    assert.deepEqual((await h.call('GET', '/api/admin/ads', { headers: h.admin2 })).body.data.ads, []);
    assert.equal((await h.call('GET', `/api/admin/ads/${ad.id}`, { headers: h.admin2 })).status, 404);
    assert.equal((await h.call('GET', `/api/admin/ads/${ad.id}/preview`, { headers: h.admin2 })).status, 404);
    assert.equal((await h.call('PUT', `/api/admin/ads/${ad.id}`, { headers: h.admin2, form: h.makeForm({ title: 'اختراق' }) })).status, 404);
    assert.equal((await h.call('DELETE', `/api/admin/ads/${ad.id}`, { headers: h.admin2 })).status, 404);
    assert.equal((await h.call('GET', `/api/admin/ads/${ad.id}`)).body.data.ad.title, 'صورة');
    assert.equal(h.uploadedFiles().length, 1);
  });

  test('استهداف شاشة من عيادة أخرى أو غير موجودة مرفوض', async () => {
    const d1 = seedDisplay(h.db, 1); const d2 = seedDisplay(h.db, 2);
    assert.equal((await mkImage({ display_ids: [d1] })).status, 201);
    assert.equal((await mkImage({ display_ids: [d2] })).status, 400);
    assert.equal((await mkImage({ display_ids: [9999] })).status, 400);
  });

  test('تسجيل تدقيق في audit_logs لكل إنشاء/تعديل/حذف', async () => {
    const ad = (await mkImage()).body.data.ad;
    await h.call('PUT', `/api/admin/ads/${ad.id}`, { form: h.makeForm({ title: 'ب' }) });
    await h.call('DELETE', `/api/admin/ads/${ad.id}`);
    const acts = h.db.prepare('SELECT action, clinic_id, staff_id FROM audit_logs ORDER BY id').all();
    assert.deepEqual(acts.map((a) => a.action), ['ad.create', 'ad.update', 'ad.delete']);
    assert.ok(acts.every((a) => a.clinic_id === 1 && a.staff_id === 1));
  });

  test('id غير صالح → 404 (لا 500)', async () => {
    for (const id of ['abc', '0', '-1', '1.5']) assert.equal((await h.call('GET', `/api/admin/ads/${id}`)).status, 404, id);
  });
});

describe('ads: الجدولة والأولوية والاستهداف', () => {
  let h;
  before(async () => { h = await startAdsHarness({ clock: NOW }); });
  after(() => h.close());
  const mk = (fields) => h.call('POST', '/api/admin/ads', { form: h.makeForm({ media_type: 'text', body_text: 't', ...fields }) });

  test('الحالات: active / scheduled / expired / inactive', async () => {
    const act = (await mk({ title: 'a', starts_at: iso(-10), ends_at: iso(10) })).body.data.ad;
    const sch = (await mk({ title: 's', starts_at: iso(10) })).body.data.ad;
    const exp = (await mk({ title: 'e', ends_at: iso(-1) })).body.data.ad;
    const ina = (await mk({ title: 'i', is_active: 'false' })).body.data.ad;
    assert.deepEqual([act, sch, exp, ina].map((a) => a.status), ['active', 'scheduled', 'expired', 'inactive']);
    const only = await h.call('GET', '/api/admin/ads?status=active');
    assert.deepEqual(only.body.data.ads.map((a) => a.title), ['a']);
  });

  test('الحدود: تبدأ عند starts_at بالضبط وتنتهي عند ends_at بالضبط (النهاية حصرية)', async () => {
    const ad = (await mk({ title: 'edge', starts_at: iso(100), ends_at: iso(200) })).body.data.ad;
    const at = (m) => h.service.getActiveAds(1, { at: iso(m) }).some((a) => a.id === ad.id);
    assert.equal(at(99), false); assert.equal(at(100), true); assert.equal(at(199), true); assert.equal(at(200), false);
  });

  test('الترتيب: الأعلى أولوية أولاً ثم الأقدم', async () => {
    const h2 = await startAdsHarness({ clock: NOW });
    const m = (title, priority) => h2.call('POST', '/api/admin/ads', { form: h2.makeForm({ title, media_type: 'text', body_text: 't', priority: String(priority) }) });
    await m('low', 1); await m('high', 50); await m('mid-a', 10); await m('mid-b', 10);
    assert.deepEqual(h2.service.getActiveAds(1).map((a) => a.title), ['high', 'mid-a', 'mid-b', 'low']);
    await h2.close();
  });

  test('الاستهداف: displayIds=null للجميع، وإلا للشاشات المحددة فقط', async () => {
    const h2 = await startAdsHarness({ clock: NOW });
    const d1 = seedDisplay(h2.db, 1); const d2 = seedDisplay(h2.db, 1);
    const m = (title, ids) => h2.call('POST', '/api/admin/ads', { form: h2.makeForm({ title, media_type: 'text', body_text: 't', ...(ids ? { display_ids: ids } : {}) }) });
    await m('all'); await m('only1', [d1]); await m('only2', [d2]);
    const t = (d) => h2.service.getActiveAds(1, { displayId: d }).map((a) => a.title).sort();
    assert.deepEqual(t(d1), ['all', 'only1']); assert.deepEqual(t(d2), ['all', 'only2']);
    assert.deepEqual(h2.service.getActiveAds(1).map((a) => a.title).sort(), ['all', 'only1', 'only2']);
    await h2.close();
  });

  test('المعاينة: تعرض الحالة والسبب والاستهداف', async () => {
    const ad = (await mk({ title: 'p', starts_at: iso(30) })).body.data.ad;
    const r = await h.call('GET', `/api/admin/ads/${ad.id}/preview`);
    assert.equal(r.status, 200);
    assert.equal(r.body.data.activeNow, false);
    assert.equal(r.body.data.ad.status, 'scheduled');
    assert.equal(r.body.data.targets, 'all');
  });
});

describe('ads: البث advertisement:updated', () => {
  let h;
  beforeEach(async () => { if (h) await h.close(); h = await startAdsHarness({ clock: NOW }); });
  after(() => h && h.close());
  const mk = (fields = {}) => h.call('POST', '/api/admin/ads', { form: h.makeForm({ title: 't', media_type: 'text', body_text: 'x', ...fields }) });

  test('يبث بعد الإنشاء/التعديل/الحذف بحمولة العقد (eventId, ts, clinicId, ads)', async () => {
    const ad = (await mk()).body.data.ad;
    await h.call('PUT', `/api/admin/ads/${ad.id}`, { form: h.makeForm({ is_active: 'false' }) });
    await h.call('DELETE', `/api/admin/ads/${ad.id}`);
    assert.equal(h.events.length, 3);
    for (const e of h.events) {
      assert.equal(e.event, 'advertisement:updated'); assert.equal(e.clinicId, 1);
      assert.match(e.payload.eventId, /^[0-9a-f-]{36}$/); assert.equal(e.payload.clinicId, 1);
      assert.ok(!Number.isNaN(Date.parse(e.payload.ts))); assert.ok(Array.isArray(e.payload.ads));
    }
    assert.equal(h.events[0].payload.ads.length, 1);
    assert.equal(h.events[1].payload.ads.length, 0, 'المعطّل لا يظهر في القائمة النشطة');
    assert.equal(new Set(h.events.map((e) => e.payload.eventId)).size, 3, 'eventId فريد');
  });

  test('لا يبث عند فشل التحقق أو 404 أو 403', async () => {
    await mk({ duration_sec: '1' });
    await h.call('DELETE', '/api/admin/ads/999');
    await h.call('POST', '/api/admin/ads', { headers: h.asStaff({ id: 1, clinicId: 1, role: 'staff' }), form: h.makeForm({ title: 't', media_type: 'text', body_text: 'x' }) });
    assert.equal(h.events.length, 0);
  });

  test('البث يذهب لعيادة صاحب الإعلان فقط ولا يسرّب إعلانات عيادة أخرى', async () => {
    await mk({ title: 'c1' });
    await h.call('POST', '/api/admin/ads', { headers: h.admin2, form: h.makeForm({ title: 'c2', media_type: 'text', body_text: 'y' }) });
    assert.deepEqual(h.events.map((e) => [e.clinicId, e.payload.ads.map((a) => a.title)]), [[1, ['c1']], [2, ['c2']]]);
  });

  test('فشل البث لا يُفشل الطلب', async () => {
    const h2 = await startAdsHarness({ clock: NOW });
    // نبني خدمة ببث يرمي
    const { createAdsService } = require('../../src/services/adsService');
    const svc = createAdsService({ getDb: () => h2.db, emit: () => { throw new Error('socket down'); }, uploadsDir: h2.uploadsDir, now: () => NOW, logger: { error() {} } });
    const ad = svc.create(1, { id: 1 }, { title: 'x', media_type: 'text', body_text: 'b' }, null);
    assert.equal(ad.title, 'x');
    await h2.close();
  });

  test('المجدول الزمني: يبث عند بدء/انتهاء إعلان بمرور الوقت فقط', async () => {
    await mk({ title: 'later', starts_at: iso(10), ends_at: iso(20) });
    h.events.length = 0;
    h.service.tick();           // خط الأساس
    h.service.tick();           // لا تغيير
    assert.equal(h.events.length, 0);
    h.setNow(new Date(iso(11))); h.service.tick();
    assert.equal(h.events.length, 1); assert.deepEqual(h.events[0].payload.ads.map((a) => a.title), ['later']);
    h.service.tick(); assert.equal(h.events.length, 1, 'لا تكرار بلا تغيير');
    h.setNow(new Date(iso(21))); h.service.tick();
    assert.equal(h.events.length, 2); assert.deepEqual(h.events[1].payload.ads, []);
  });
});
