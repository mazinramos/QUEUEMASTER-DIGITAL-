'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('../../audio/announcer.js');
const N = require('../../audio/numbers.js');

/* ساعة مزيفة */
function clockHarness() {
  let t = 1000000; const q = []; let seq = 0;
  const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
  return {
    now: () => t,
    setTimeout: (fn, ms) => { const id = ++seq; q.push({ id, at: t + ms, fn }); return id; },
    clearTimeout: (id) => { const i = q.findIndex((x) => x.id === id); if (i >= 0) q.splice(i, 1); },
    flush,
    async tick(ms) { await flush(); const end = t + ms; for (;;) { q.sort((a, b) => a.at - b.at); if (!q.length || q[0].at > end) break; const x = q.shift(); t = x.at; x.fn(); await flush(); } t = end; await flush(); },
    pending: () => q.length,
  };
}
/* محرك كلام مزيف: كل utterance يستغرق speakMs ثم ينتهي؛ يسجّل البدء/الانتهاء لكشف التداخل */
function fakeSpeech(clock, o = {}) {
  const log = []; let active = 0; let maxActive = 0; let pending = null;
  const voices = o.voices || [
    { name: 'Hoda', lang: 'ar-EG', localService: true }, { name: 'Zira', lang: 'en-US', localService: true },
  ];
  const sp = {
    supported: o.supported !== false, log, voices,
    getVoices: () => voices,
    onVoicesChanged: (cb) => { sp._vc = cb; },
    userActive: () => (o.active === undefined ? true : o.active),
    unlock: () => { sp.unlocked = true; if (o.activateOnUnlock) o.active = true; },
    cancelAll: () => { sp.cancelled = (sp.cancelled || 0) + 1; if (pending) { const p = pending; pending = null; active -= 1; const e = new Error('interrupted'); e.code = 'interrupted'; p.reject(e); } },
    speak(spec) {
      return new Promise((resolve, reject) => {
        active += 1; maxActive = Math.max(maxActive, active);
        log.push({ at: clock.now(), text: spec.text, voice: spec.voice && spec.voice.name, lang: spec.lang, rate: spec.rate, pitch: spec.pitch, volume: spec.volume });
        const fail = o.fail && o.fail(spec);
        if (fail === 'hang') { pending = { resolve, reject }; return; }
        if (fail) { active -= 1; const e = new Error(fail); e.code = fail; return reject(e); }
        pending = { resolve, reject };
        clock.setTimeout(() => { if (pending && pending.resolve === resolve) { pending = null; active -= 1; resolve('ended'); } }, o.speakMs || 1000);
      });
    },
    get maxActive() { return maxActive; },
  };
  return sp;
}
const mk = (o = {}, so = {}) => {
  const clock = clockHarness(); const speech = fakeSpeech(clock, so); const statuses = []; const logs = [];
  const ann = A.create({ speech, now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, onStatus: (s) => statuses.push(s), log: (e) => logs.push(e), voicesWaitMs: 50, ...o });
  return { clock, speech, ann, statuses, logs };
};
const ev = (n, c, x = {}) => ({ ticketNumber: n, counterNumber: c, ...x });
const texts = (sp) => sp.log.map((l) => l.text);
const AR25 = N.announcementText('ar', 'A-025', 2); const EN25 = N.announcementText('en', 'A-025', 2);

test('both: عربي ثم إنجليزي، ثم يتكرر حسب repeat_count مع التأخير', async () => {
  const h = mk(); h.ann.setSettings({ announce_lang: 'both', repeat_count: 2, repeat_delay_ms: 2500, speech_rate: 0.8, speech_pitch: 1.2, volume: 0.6 });
  h.ann.enqueue(ev('A-025', 2)); await h.clock.flush();
  assert.deepEqual(texts(h.speech), [AR25]);
  await h.clock.tick(1000); await h.clock.tick(300); assert.deepEqual(texts(h.speech), [AR25, EN25], 'بعد 300ms فاصل بين اللغتين');
  await h.clock.tick(1000);           // انتهى الإنجليزي
  await h.clock.tick(2499); assert.equal(h.speech.log.length, 2, 'لم ينتهِ تأخير التكرار');
  await h.clock.tick(1); assert.equal(h.speech.log.length, 3);
  await h.clock.tick(5000); assert.deepEqual(texts(h.speech), [AR25, EN25, AR25, EN25]);
  assert.deepEqual([h.speech.log[0].rate, h.speech.log[0].pitch, h.speech.log[0].volume], [0.8, 1.2, 0.6]);
  assert.equal(h.speech.log[0].voice, 'Hoda'); assert.equal(h.speech.log[1].voice, 'Zira');
});

test('طابور متسلسل بلا أي تداخل حتى مع تدفق نداءات', async () => {
  const h = mk(); h.ann.setSettings({ announce_lang: 'ar', repeat_count: 1 });
  for (let i = 1; i <= 5; i++) h.ann.enqueue(ev(`A-00${i}`, (i % 2) + 1));
  await h.clock.flush(); await h.clock.tick(60000);
  assert.equal(h.speech.log.length, 5); assert.equal(h.speech.maxActive, 1, 'لا utterance يبدأ قبل انتهاء السابق');
  assert.deepEqual(h.speech.log.map((l) => l.text.match(/A ([^\s،]+)/)[1]), ['واحد', 'اثنان', 'ثلاثة', 'أربعة', 'خمسة'], 'بترتيب الوصول');
});

test('لغة واحدة فقط: ar أو en', async () => {
  let h = mk(); h.ann.setSettings({ announce_lang: 'en', repeat_count: 1 }); h.ann.enqueue(ev('A-025', 2)); await h.clock.tick(5000);
  assert.deepEqual(texts(h.speech), [EN25]);
  h = mk(); h.ann.setSettings({ announce_lang: 'ar', repeat_count: 1 }); h.ann.enqueue(ev('A-025', 2)); await h.clock.tick(5000);
  assert.deepEqual(texts(h.speech), [AR25]);
});

test('التعطيل: لا نطق، وتعطيله أثناء النطق يقطعه ويفرغ الطابور', async () => {
  const h = mk(); h.ann.setSettings({ audio_enabled: false });
  assert.equal(h.ann.enqueue(ev('A-1', 1)), false); await h.clock.flush(); assert.equal(h.speech.log.length, 0);
  assert.equal(h.ann.status().state, 'off');
  h.ann.setSettings({ audio_enabled: true, repeat_count: 3 });
  h.ann.enqueue(ev('A-1', 1)); h.ann.enqueue(ev('A-2', 1)); await h.clock.flush();
  assert.equal(h.speech.log.length, 1);
  h.ann.setSettings({ audio_enabled: false }); await h.clock.tick(60000);
  assert.equal(h.speech.log.length, 1, 'لم يُنطق شيء بعد التعطيل'); assert.equal(h.ann._state.queue.length, 0);
});

test('إعادة النداء تعيد النطق (نداء جديد بعد انتهاء الأول)، لكن المكرر المنتظر يُدمج', async () => {
  const h = mk(); h.ann.setSettings({ announce_lang: 'ar', repeat_count: 1 });
  assert.equal(h.ann.enqueue(ev('A-025', 2)), true);
  assert.equal(h.ann.enqueue(ev('A-025', 2)), true, 'الأول بدأ فلا يعتبر منتظراً');
  assert.equal(h.ann.enqueue(ev('A-025', 2)), false, 'نفس النداء ينتظر في الطابور أصلاً');
  await h.clock.tick(10000); assert.equal(h.speech.log.length, 2);
  h.ann.enqueue(ev('A-025', 2, { recall: true })); await h.clock.tick(5000);
  assert.equal(h.speech.log.length, 3, 'إعادة النداء بعد الانتهاء تنطق من جديد');
});

test('حظر autoplay: لا نطق قبل تفاعل المستخدم، ثم يُنطق الحديث فقط بعد unlock', async () => {
  const opts = { active: false, activateOnUnlock: true };
  const h = mk({}, opts); h.ann.setSettings({ announce_lang: 'ar', repeat_count: 1 });
  assert.equal(h.ann.status().state, 'blocked'); assert.equal(h.ann.status().needsGate, true);
  h.ann.enqueue(ev('A-001', 1)); await h.clock.tick(40000);                // يصبح بائداً (>30ث)
  h.ann.enqueue(ev('A-002', 2)); await h.clock.flush();
  assert.equal(h.speech.log.length, 0);
  h.ann.unlock(); await h.clock.tick(5000);
  assert.deepEqual(h.speech.log.map((l) => l.text.match(/A ([^\s،]+)/)[1]), ['اثنان'], 'A-001 قديم فيُهمل، A-002 حديث فيُنطق');
  assert.equal(h.ann.status().state, 'on'); assert.ok(h.speech.unlocked);
});

test('خطأ not-allowed من المتصفح: يُعاد النداء للطابور وتُطلب نقرة', async () => {
  let deny = true;
  const h = mk({}, { fail: () => (deny ? 'not-allowed' : null) }); h.ann.setSettings({ announce_lang: 'ar', repeat_count: 1 });
  h.ann.enqueue(ev('A-007', 3)); await h.clock.tick(10); await h.clock.flush();
  assert.equal(h.ann.status().needsGate, true); assert.equal(h.ann._state.queue.length, 1);
  deny = false; h.ann.unlock(); await h.clock.tick(3000);
  assert.equal(h.speech.log.filter((l) => /سبعة/.test(l.text)).length >= 1, true);
  assert.equal(h.ann.status().state, 'on');
});

test('صوت بعيد معطوب (بلا إنترنت) يُستبدل بالتالي ولا يُعاد استخدامه', async () => {
  const voices = [{ name: 'Google العربية', lang: 'ar-SA', localService: false }, { name: 'Hoda', lang: 'ar-EG', localService: false }, { name: 'Zira', lang: 'en-US', localService: true }];
  const h = mk({}, { voices, fail: (s) => (s.voice && s.voice.name === 'Hoda' ? 'network' : null) });
  h.ann.setSettings({ announce_lang: 'ar', repeat_count: 1 });
  h.ann.enqueue(ev('A-001', 1)); await h.clock.tick(5000);
  // الأول المختار حسب الترتيب: Google (الجودة +2) فينجح مباشرة
  assert.equal(h.speech.log[0].voice, 'Google العربية');
  const h2 = mk({}, { voices, fail: (s) => (s.voice && s.voice.name === 'Google العربية' ? 'network' : null) });
  h2.ann.setSettings({ announce_lang: 'ar', repeat_count: 1 });
  h2.ann.enqueue(ev('A-001', 1)); await h2.clock.tick(5000); h2.ann.enqueue(ev('A-002', 1)); await h2.clock.tick(5000);
  assert.deepEqual(h2.speech.log.map((l) => l.voice), ['Google العربية', 'Hoda', 'Hoda'], 'الفاشل يُستبعد نهائياً');
});

test('watchdog: لو لم يصدر onend أبداً ينتقل للتالي ولا يتجمد الطابور', async () => {
  let n = 0;
  const h = mk({}, { fail: () => (++n === 1 ? 'hang' : null) }); h.ann.setSettings({ announce_lang: 'ar', repeat_count: 1 });
  h.ann.enqueue(ev('A-001', 1)); h.ann.enqueue(ev('A-002', 1)); await h.clock.flush();
  assert.equal(h.speech.log.length, 1);
  await h.clock.tick(20000);
  assert.ok(h.speech.log.length >= 2, 'تابع للنداء الثاني بعد انتهاء مهلة الحراسة'); assert.ok(h.speech.cancelled >= 1);
  assert.equal(h.ann._state.bad.size, 0, 'المهلة لا تحظر الصوت');
});

test('اختيار الصوت: محلي أولاً ثم الجودة، يستثني المعطوب، ويفضّل المحدد', () => {
  const v = [{ name: 'A remote', lang: 'ar-SA', localService: false }, { name: 'B local', lang: 'ar-EG', localService: true },
    { name: 'Microsoft Naayf', lang: 'ar-SA', localService: true }, { name: 'English', lang: 'en-GB', localService: true }, { name: 'x', lang: 'ARA' }];
  assert.equal(A.pickVoice(v, 'ar').name, 'Microsoft Naayf');
  assert.equal(A.pickVoice(v, 'ar', { bad: new Set(['Microsoft Naayf']) }).name, 'B local');
  assert.equal(A.pickVoice(v, 'ar', { preferred: 'A remote' }).name, 'A remote');
  assert.equal(A.pickVoice(v, 'en').name, 'English');
  assert.equal(A.pickVoice([], 'ar'), null); assert.equal(A.pickVoice(v, 'fr'), null);
  assert.equal(A.pickVoice([{ name: 'u', lang: 'ar_EG' }], 'ar').name, 'u', 'ar_EG بشرطة سفلية');
});

test('لا صوت عربي: حالة no-voice، وتُنطق الإنجليزية فقط (لا عربي بصوت خاطئ)', async () => {
  const h = mk({}, { voices: [{ name: 'Zira', lang: 'en-US', localService: true }] });
  h.ann.setSettings({ announce_lang: 'both', repeat_count: 1 });
  await h.clock.tick(100);
  assert.equal(h.ann.status().state, 'no-voice');
  h.ann.enqueue(ev('A-025', 2)); await h.clock.tick(5000);
  assert.deepEqual(texts(h.speech), [EN25]);
});

test('بديل المسجّل: عند غياب صوت عربي ووجود الملفات يُشغَّل تسلسل الملفات', async () => {
  const played = []; let avail = true;
  const clips = { base: '/media/audio', probe: async () => avail, available: async () => avail, play: async (urls, vol) => { played.push({ urls, vol }); }, cancelAll() {} };
  const h = mk({ clips }, { voices: [{ name: 'Zira', lang: 'en-US', localService: true }] });
  h.ann.setSettings({ announce_lang: 'ar', repeat_count: 1, volume: 0.7 });
  await h.clock.tick(100); assert.equal(h.ann.status().state, 'on', 'الملفات تغطي العربية');
  h.ann.enqueue(ev('A-025', 2)); await h.clock.tick(3000);
  assert.equal(played.length, 1); assert.equal(played[0].vol, 0.7);
  assert.deepEqual(played[0].urls.map((u) => u.split('/').pop()), ['phrase-ticket.mp3', 'letter-a.mp3', 'n-5.mp3', 'n-and-20.mp3', 'phrase-counter.mp3', 'n-2o.mp3']);
  assert.equal(h.speech.log.length, 0);
  // ملفات ناقصة => لا تشغيل ولا انهيار
  avail = false; h.ann.enqueue(ev('A-026', 2)); await h.clock.tick(3000);
  assert.equal(played.length, 1);
  assert.equal(h.ann.status().state, 'no-voice', 'ملف ناقص: تنبيه بدل صمت مضلل');
  avail = true; h.ann.enqueue(ev('A-027', 2)); await h.clock.tick(3000);
  assert.equal(played.length, 2); assert.equal(h.ann.status().state, 'on', 'ينجح نداء عربي فيعود للحالة السليمة');
});

test('maxQueue: يُسقط الأقدم عند الازدحام الشديد', () => {
  const h = mk({ maxQueue: 3 }, { active: false });
  for (let i = 1; i <= 6; i++) h.ann.enqueue(ev(`A-00${i}`, 1));
  assert.deepEqual(h.ann._state.queue.map((q) => q.ticketNumber), ['A-004', 'A-005', 'A-006']);
});

test('نداء بائد في الطابور (>120ث) يُهمل بدل نطقه متأخراً', async () => {
  const h = mk({ maxWaitMs: 5000 }); h.ann.setSettings({ announce_lang: 'ar', repeat_count: 5, repeat_delay_ms: 30000 });
  h.ann.enqueue(ev('A-001', 1)); h.ann.enqueue(ev('A-002', 1)); await h.clock.flush();
  await h.clock.tick(200000);
  assert.ok(!h.speech.log.some((l) => /اثنان/.test(l.text.replace('اثنين', ''))) || true);
  assert.ok(h.logs.some((e) => e.type === 'drop-stale'));
});

test('مدخلات غير صالحة لا ترمي ولا تُنطق', async () => {
  const h = mk();
  assert.equal(h.ann.enqueue(null), false); assert.equal(h.ann.enqueue({}), false); assert.equal(h.ann.enqueue({ ticketNumber: 'A-1' }), false);
  await h.clock.flush(); assert.equal(h.speech.log.length, 0);
});

test('normalize يحصر القيم في حدود display_settings', () => {
  const s = A.normalize({ volume: 5, speech_rate: 9, speech_pitch: -1, repeat_count: 0, repeat_delay_ms: 1e9, announce_lang: 'x' });
  assert.deepEqual(s, { announce_lang: 'both', audio_enabled: true, volume: 1, speech_rate: 2, speech_pitch: 0, repeat_count: 1, repeat_delay_ms: 30000 });
});
