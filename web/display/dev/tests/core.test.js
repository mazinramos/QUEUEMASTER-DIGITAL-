'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../../js/core.js');

test('normalize: أشكال مختلفة للخدمة والشباك والتذكرة', () => {
  assert.deepEqual(C.normalizeService('كشف'), { prefix: '', name_ar: 'كشف', name_en: 'كشف' });
  assert.equal(C.normalizeCounter({ number: '2', name: 'شباك 2' }).number, 2);
  assert.equal(C.normalizeCounter(3).number, 3);
  const t = C.normalizeTicket({ number: 'A-025', service: 'x' }, { number: 2, name: 'ش' });
  assert.equal(t.number, 'A-025'); assert.equal(t.counter.number, 2);
  assert.equal(C.normalizeTicket({}), null);
  assert.equal(C.normalizeTicket(null), null);
});

test('normalizeSettings: افتراضيات وحدود', () => {
  const d = C.normalizeSettings(null);
  assert.deepEqual(d, { announce_lang: 'both', audio_enabled: true, volume: 1, speech_rate: 0.9, speech_pitch: 1, repeat_count: 2, repeat_delay_ms: 2500 });
  const s = C.normalizeSettings({ announceLang: 'ar', audioEnabled: 0, volume: 7, speech_rate: 0, repeat_count: 99, repeat_delay_ms: -5 });
  assert.equal(s.announce_lang, 'ar'); assert.equal(s.audio_enabled, false); assert.equal(s.volume, 1);
  assert.equal(s.speech_rate, 0.5); assert.equal(s.repeat_count, 5); assert.equal(s.repeat_delay_ms, 0);
  assert.equal(C.normalizeSettings({ announce_lang: 'zz' }).announce_lang, 'both');
});

test('الإعلانات: أهلية بالتاريخ/التفعيل/الاستهداف/النوع + الترتيب بالأولوية', () => {
  const now = Date.parse('2026-11-05T12:00:00Z');
  const mk = (o) => Object.assign({ id: 1, mediaType: 'image', url: '/media/a.png', isActive: true, durationSec: 10 }, o);
  const ads = [
    mk({ id: 1 }), mk({ id: 2, priority: 5 }), mk({ id: 3, isActive: false }),
    mk({ id: 4, startsAt: '2026-11-06T00:00:00Z' }), mk({ id: 5, endsAt: '2026-11-05T12:00:00Z' }), mk({ id: 6, endsAt: '2026-11-05T12:00:01Z' }),
    mk({ id: 7, displayIds: [9] }), mk({ id: 8, displayIds: [3] }),
    mk({ id: 9, mediaType: 'text', url: null, bodyText: 'نص' }), mk({ id: 10, mediaType: 'text', url: null }),
    mk({ id: 11, url: null }), mk({ id: 12, mediaType: 'pdf' }),
  ];
  assert.deepEqual(C.eligibleAds(ads, now, 3).map((a) => a.id), [2, 1, 6, 8, 9]);
  assert.deepEqual(C.eligibleAds(ads, now, null).map((a) => a.id), [2, 1, 6, 7, 8, 9], 'بدون معرف شاشة لا يُصفّى الاستهداف');
});

test('normalizeAd: snake_case + file_path + مدة محصورة', () => {
  const a = C.normalizeAd({ id: 1, media_type: 'video', file_path: 'server/uploads/v.mp4', duration_sec: 999, display_ids: '[1,2]', is_active: 1 });
  assert.equal(a.url, '/media/v.mp4'); assert.equal(a.durationSec, 300); assert.deepEqual(a.displayIds, [1, 2]); assert.equal(a.isActive, true);
  assert.equal(C.normalizeAd({ id: 2, mediaType: 'text', durationSec: 1 }).durationSec, 3);
});

test('deduper: يتجاهل المكرر ويحدّ الذاكرة بـ 200', () => {
  const d = C.createEventDeduper(200);
  assert.equal(d.seen('a'), false); assert.equal(d.seen('a'), true);
  assert.equal(d.seen(undefined), false); assert.equal(d.seen(undefined), false);
  for (let i = 0; i < 250; i++) d.seen('e' + i);
  assert.equal(d.size(), 200);
  assert.equal(d.seen('a'), false, 'خرج من الذاكرة بعد 200 حدث أحدث');
  assert.equal(d.seen('e249'), true);
});

test('isFresh: أقل من 30 ثانية مع تعويض فرق الساعة', () => {
  const now = Date.parse('2026-11-05T12:00:00Z');
  assert.equal(C.isFresh('2026-11-05T11:59:45Z', now), true);
  assert.equal(C.isFresh('2026-11-05T11:59:29Z', now), false);
  assert.equal(C.isFresh('bad', now), false);
  // ساعة الجهاز متأخرة دقيقة عن الخادم: الخادم يرسل ts حديثاً
  assert.equal(C.isFresh('2026-11-05T12:01:00Z', now, 60000), true);
  assert.equal(C.isFresh('2026-11-05T12:01:00Z', now, 0), false);
});

test('announceGate: يدمج ticket+announcement لنفس النداء، ويقبل إعادة النداء المتعمدة', () => {
  const g = C.createAnnounceGate({ windowMs: 1500 });
  assert.equal(g.accept('A-1|2', 'ticket', 1000), true);
  assert.equal(g.accept('A-1|2', 'announcement', 1100), false, 'نفس النداء من المصدر الآخر');
  assert.equal(g.accept('A-1|2', 'ticket', 1200), true, 'ضغط إعادة نداء ثانٍ (نفس المصدر) مقبول');
  assert.equal(g.accept('A-1|2', 'announcement', 5000), true, 'خارج النافذة');
  assert.equal(g.accept('A-2|2', 'announcement', 5100), true, 'تذكرة مختلفة');
  // الترتيب المعاكس: announcement أولاً ثم ticket
  const g2 = C.createAnnounceGate({ windowMs: 1500 });
  assert.equal(g2.accept('B-1|1', 'announcement', 0), true);
  assert.equal(g2.accept('B-1|1', 'ticket', 50), false);
});

test('state: bootstrap ثم called يرفع التذكرة للبؤرة وينقلها من التالي', () => {
  let s = C.applyBootstrap(C.emptyState(), {
    current: [{ number: 'A-001', status: 'serving', counter: { number: 1 }, calledAt: '2026-11-05T10:00:00Z' }],
    next: [{ number: 'A-002' }, { number: 'A-003' }], recent: [{ number: 'A-001', calledAt: '2026-11-05T10:00:00Z' }], waitingCount: 5,
  });
  assert.equal(s.focus.number, 'A-001'); assert.equal(s.waitingCount, 5);
  s = C.applyTicketEvent(s, 'ticket:called', { ticket: { number: 'A-002', service: 'x' }, counter: { number: 2, name: 'شباك 2' }, ts: '2026-11-05T10:05:00Z' });
  assert.equal(s.focus.number, 'A-002'); assert.equal(s.focus.counter.number, 2);
  assert.deepEqual(s.current.map((t) => t.number), ['A-002', 'A-001']);
  assert.deepEqual(s.next.map((t) => t.number), ['A-003']);
  assert.deepEqual(s.recent.map((t) => t.number), ['A-002', 'A-001']);
  const n = s.focusSeq;
  s = C.applyTicketEvent(s, 'ticket:recalled', { ticket: { number: 'A-002' }, counter: { number: 2 } });
  assert.equal(s.focusSeq, n + 1, 'إعادة النداء تحرّك البؤرة من جديد'); assert.equal(s.recent.length, 2, 'بلا تكرار في الأخيرة');
});

test('state: serving/completed/cancelled وqueue:updated', () => {
  let s = C.applyBootstrap(C.emptyState(), { current: [], next: [], recent: [] });
  assert.equal(s.focus, null);
  s = C.applyTicketEvent(s, 'ticket:called', { ticket: { number: 'A-010' }, counter: { number: 1 } });
  s = C.applyTicketEvent(s, 'ticket:called', { ticket: { number: 'B-004' }, counter: { number: 2 } });
  s = C.applyTicketEvent(s, 'ticket:serving', { ticket: { number: 'A-010' }, counter: { number: 1 } });
  assert.equal(s.current.find((t) => t.number === 'A-010').status, 'serving');
  s = C.applyTicketEvent(s, 'ticket:completed', { ticket: { number: 'B-004' } });
  assert.deepEqual(s.current.map((t) => t.number), ['A-010']); assert.equal(s.focus.number, 'A-010', 'البؤرة تنتقل لما بقي');
  assert.equal(s.recent.length, 2, 'المكتمل يبقى في آخر المنادى');
  s = C.applyTicketEvent(s, 'ticket:cancelled', { ticket: { number: 'A-010' } });
  assert.equal(s.focus, null); assert.ok(!s.recent.find((t) => t.number === 'A-010'));
  s = C.applyQueueUpdated(s, { services: [{ key: 'a', waiting: 3 }, { key: 'b', waiting: 2 }], current: [{ number: 'C-1', counter: { number: 3 } }], next: [{ number: 'C-2' }, { number: 'C-3' }, { number: 'C-4' }, { number: 'C-5' }] });
  assert.equal(s.waitingCount, 5); assert.equal(s.focus.number, 'C-1'); assert.equal(s.next.length, 3);
  const same = C.applyTicketEvent(s, 'ticket:unknown', { ticket: { number: 'Z' } });
  assert.deepEqual(same.current, s.current);
});

test('state: إعادة الاتصال تستبدل الحالة وتحافظ على البؤرة إن بقيت', () => {
  let s = C.applyBootstrap(C.emptyState(), { current: [{ number: 'A-1', calledAt: '2026-11-05T10:00:00Z' }, { number: 'A-2', calledAt: '2026-11-05T10:01:00Z' }] });
  assert.equal(s.focus.number, 'A-2');
  s = C.applyTicketEvent(s, 'ticket:called', { ticket: { number: 'A-1' }, counter: { number: 1 }, ts: '2026-11-05T10:02:00Z' });
  const re = C.applyBootstrap(s, { current: [{ number: 'A-1', calledAt: '2026-11-05T10:02:00Z' }, { number: 'A-2', calledAt: '2026-11-05T10:01:00Z' }] });
  assert.equal(re.focus.number, 'A-1');
  const gone = C.applyBootstrap(re, { current: [] });
  assert.equal(gone.focus, null);
});
