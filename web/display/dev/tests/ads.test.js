'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Ads = require('../../js/ads.js');

/* ساعة مزيفة + مسرح مزيف */
function harness(opts = {}) {
  let t = Date.parse('2026-11-05T12:00:00Z'); const q = []; let seq = 0;
  const shown = []; const events = [];
  const clock = {
    now: () => t,
    setTimeout: (fn, ms) => { const id = ++seq; q.push({ id, at: t + ms, fn }); return id; },
    clearTimeout: (id) => { const i = q.findIndex((x) => x.id === id); if (i >= 0) q.splice(i, 1); },
  };
  const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
  const tick = async (ms) => {
    const end = t + ms;
    for (;;) {
      q.sort((a, b) => a.at - b.at);
      if (!q.length || q[0].at > end) break;
      const x = q.shift(); t = x.at; x.fn(); await flush();
    }
    t = end; await flush();
  };
  const failing = new Set();
  const builds = [];
  const ctl = Ads.create({
    stage: { show: (el) => shown.push(el) },
    now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    buildAd: (ad) => { builds.push(ad.id); return failing.has(ad.id) ? Promise.reject(new Error('x')) : Promise.resolve({ kind: 'ad', id: ad.id }); },
    buildCard: (ctx, i) => ({ kind: 'card', i }),
    onEvent: (e) => events.push(e),
    ...opts,
  });
  return { ctl, tick, flush, shown, events, builds, failing, clock, setNow: (iso) => { t = Date.parse(iso); } };
}
const ad = (id, o = {}) => Object.assign({ id, mediaType: 'image', url: `/media/a${id}.png`, durationSec: 10, priority: 0, isActive: true }, o);
const seqOf = (shown) => shown.map((e) => (e.kind === 'ad' ? `ad${e.id}` : 'card'));

test('بدون إعلانات: بطاقات معلومات تتناوب كل 12 ثانية', async () => {
  const h = harness(); h.ctl.setAds([], 1); h.ctl.start(); await h.flush();
  await h.tick(12000 * 2);
  assert.deepEqual(seqOf(h.shown), ['card', 'card', 'card']);
  assert.deepEqual(h.shown.map((e) => e.i), [0, 1, 2]);
});

test('تناوب بالأولوية ثم الترتيب، والمدة لكل إعلان محترمة', async () => {
  const h = harness();
  h.ctl.setAds([ad(1, { durationSec: 5 }), ad(2, { priority: 3, durationSec: 20 }), ad(3, { durationSec: 7 })], 1);
  h.ctl.start(); await h.flush();
  assert.deepEqual(seqOf(h.shown), ['ad2']);
  await h.tick(19999); assert.equal(h.shown.length, 1, 'لم تنتهِ مدة 20ث بعد');
  await h.tick(1); assert.deepEqual(seqOf(h.shown), ['ad2', 'ad1']);
  await h.tick(5000); assert.deepEqual(seqOf(h.shown), ['ad2', 'ad1', 'ad3']);
  await h.tick(7000); assert.deepEqual(seqOf(h.shown), ['ad2', 'ad1', 'ad3', 'ad2'], 'دورة جديدة');
});

test('إعلان وحيد لا يُعاد بناؤه (بلا وميض)', async () => {
  const h = harness(); h.ctl.setAds([ad(1)], 1); h.ctl.start(); await h.flush();
  await h.tick(35000);
  assert.equal(h.shown.length, 1); assert.deepEqual(h.builds, [1]);
  assert.ok(h.events.filter((e) => e.type === 'keep').length >= 3);
});

test('تواريخ البدء/الانتهاء والتفعيل: لا يُعرض إلا الفعّال وينتهي أثناء التشغيل', async () => {
  const h = harness();
  h.ctl.setAds([ad(1, { endsAt: '2026-11-05T12:00:15Z' }), ad(2, { startsAt: '2026-11-05T12:00:25Z' }), ad(3, { isActive: false })], 1);
  h.ctl.start(); await h.flush();
  assert.deepEqual(seqOf(h.shown), ['ad1']);
  await h.tick(10000); // 12:00:10 -> ad1 ما زال فعالاً (وحيد) فيبقى
  await h.tick(10000); // 12:00:20 -> انتهى ad1، لا فعّال => بطاقة
  assert.equal(seqOf(h.shown).at(-1), 'card');
  await h.tick(12000); // 12:00:32 -> بدأ ad2
  assert.equal(seqOf(h.shown).at(-1), 'ad2');
});

test('الاستهداف: إعلان لشاشة أخرى لا يُعرض', async () => {
  const h = harness(); h.ctl.setAds([ad(1, { displayIds: [9] }), ad(2, { displayIds: [3] })], 3); h.ctl.start(); await h.flush();
  assert.deepEqual(seqOf(h.shown), ['ad2']);
});

test('advertisement:updated: وصول إعلانات أثناء البطاقات يعرضها فوراً، وحذف المعروض ينتقل فوراً', async () => {
  const h = harness(); h.ctl.setAds([], 1); h.ctl.start(); await h.flush();
  await h.tick(3000);
  h.ctl.setAds([ad(5)], 1); await h.flush();
  assert.deepEqual(seqOf(h.shown), ['card', 'ad5']);
  h.ctl.setAds([ad(6), ad(5)], 1); await h.flush();
  assert.equal(h.shown.length, 2, 'المعروض ما زال فعالاً: لا قفز');
  h.ctl.setAds([ad(6)], 1); await h.flush();
  assert.equal(seqOf(h.shown).at(-1), 'ad6', 'حُذف المعروض: ينتقل فوراً');
  h.ctl.setAds([], 1); await h.flush();
  assert.equal(seqOf(h.shown).at(-1), 'card', 'لا إعلانات: بطاقات');
});

test('فشل تحميل إعلان: يُتخطى بسرعة؛ فشل الكل: بطاقات ثم إعادة محاولة', async () => {
  const h = harness();
  h.failing.add(1);
  h.ctl.setAds([ad(1), ad(2)], 1); h.ctl.start(); await h.flush();
  await h.tick(300);
  assert.deepEqual(seqOf(h.shown), ['ad2'], 'ad1 فشل فتُخطي لـ ad2');
  h.failing.add(2);
  await h.tick(10000); await h.tick(1000);
  assert.ok(seqOf(h.shown).includes('card'), 'كلها فاشلة: بطاقات بدل شاشة فارغة');
  h.failing.clear();
  await h.tick(12000);
  assert.ok(seqOf(h.shown).at(-1).startsWith('ad'), 'بعد التعافي تعود الإعلانات');
});

test('stop يوقف كل شيء', async () => {
  const h = harness(); h.ctl.setAds([ad(1), ad(2)], 1); h.ctl.start(); await h.flush(); h.ctl.stop();
  const n = h.shown.length; await h.tick(60000); assert.equal(h.shown.length, n);
});

test('الأمان: روابط وسائط خارجية/غير /media/ مرفوضة', async () => {
  const h = harness();
  h.ctl.setAds([ad(1, { url: 'https://evil.example/x.png' }), ad(2, { url: 'javascript:alert(1)' }), ad(3, { url: '/media/../../etc/passwd' }), ad(4, { url: '//evil.example/a.png' }), ad(5)], 1);
  h.ctl.start(); await h.flush();
  assert.deepEqual(seqOf(h.shown), ['ad5']); assert.deepEqual(h.builds, [5]);
});
