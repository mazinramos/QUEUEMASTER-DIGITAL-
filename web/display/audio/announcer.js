/* مُعلن الصوت: طابور نداءات متسلسل بلا تداخل فوق speechSynthesis، مع بديل مسجّل للعربية.
   كل الاعتماديات (speech/clips/المؤقتات) قابلة للحقن لاختبار المنطق في Node بدون متصفح. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./numbers.js'), require('./clips.js'));
  else root.DisplayAnnouncer = factory(root.DisplayNumbers, root.DisplayClips);
}(typeof self !== 'undefined' ? self : this, function (N, CL) {
  'use strict';

  const DEFAULTS = { announce_lang: 'both', audio_enabled: true, volume: 1, speech_rate: 0.9, speech_pitch: 1, repeat_count: 2, repeat_delay_ms: 2500 };
  const clamp = (v, lo, hi, d) => { v = Number(v); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d; };
  function normalize(s) {
    s = s || {};
    return {
      announce_lang: ['ar', 'en', 'both'].includes(s.announce_lang) ? s.announce_lang : DEFAULTS.announce_lang,
      audio_enabled: s.audio_enabled === undefined ? true : !!s.audio_enabled,
      volume: clamp(s.volume, 0, 1, DEFAULTS.volume),
      speech_rate: clamp(s.speech_rate, 0.5, 2, DEFAULTS.speech_rate),
      speech_pitch: clamp(s.speech_pitch, 0, 2, DEFAULTS.speech_pitch),
      repeat_count: Math.round(clamp(s.repeat_count, 1, 5, DEFAULTS.repeat_count)),
      repeat_delay_ms: Math.round(clamp(s.repeat_delay_ms, 0, 30000, DEFAULTS.repeat_delay_ms)),
    };
  }

  /* ---------- اختيار الصوت ---------- */
  function langMatch(v, lang) {
    const l = String(v && v.lang || '').toLowerCase().replace('_', '-');
    return l === lang || l.startsWith(lang + '-');
  }
  /** الأصوات المحلية (تعمل بلا إنترنت) أولاً، ثم الجودة المعروفة، ثم الافتراضي. يستثني الأصوات المعطوبة. */
  function pickVoice(voices, lang, o) {
    o = o || {};
    const bad = o.bad || new Set();
    const list = (voices || []).filter((v) => langMatch(v, lang) && !bad.has(v.name));
    if (!list.length) return null;
    const score = (v) => (o.preferred && v.name === o.preferred ? 100 : 0) + (v.localService ? 8 : 0)
      + (/natural|neural|enhanced|premium|siri|google|microsoft|apple/i.test(v.name || '') ? 2 : 0) + (v.default ? 1 : 0);
    return list.map((v, i) => ({ v, i, s: score(v) })).sort((a, b) => b.s - a.s || a.i - b.i)[0].v;
  }

  /* ---------- مشغّلات المتصفح ---------- */
  function createBrowserSpeech(win) {
    win = win || window;
    const ss = win.speechSynthesis; const U = win.SpeechSynthesisUtterance;
    const keep = new Set(); let gesture = false;
    ['pointerdown', 'click', 'keydown', 'touchstart'].forEach((ev) => win.addEventListener(ev, () => { gesture = true; }, { capture: true, passive: true }));
    return {
      supported: !!(ss && U),
      getVoices: () => (ss ? ss.getVoices() : []),
      onVoicesChanged(cb) { if (ss && ss.addEventListener) ss.addEventListener('voiceschanged', cb); },
      userActive() { const ua = win.navigator && win.navigator.userActivation; return ua ? !!ua.hasBeenActive : gesture; },
      speak(spec) {
        return new Promise((resolve, reject) => {
          const u = new U(spec.text);
          u.lang = spec.voice ? spec.voice.lang : (spec.lang === 'ar' ? 'ar-SA' : 'en-US');
          if (spec.voice) u.voice = spec.voice;
          u.rate = spec.rate; u.pitch = spec.pitch; u.volume = spec.volume;
          keep.add(u); // يمنع جمع القمامة لـ utterance قبل onend (علّة معروفة في Chrome)
          u.onend = () => { keep.delete(u); resolve('ended'); };
          u.onerror = (e) => { keep.delete(u); const err = new Error('speech ' + (e.error || 'error')); err.code = e.error || 'error'; reject(err); };
          try { ss.resume(); ss.speak(u); } catch (e) { keep.delete(u); e.code = e.code || 'error'; reject(e); }
        });
      },
      unlock() { try { const u = new U(' '); u.volume = 0; ss.speak(u); } catch (e) { /* تجاهل */ } },
      cancelAll() { try { ss.cancel(); } catch (e) { /* تجاهل */ } },
    };
  }

  function createBrowserClips(win, base) {
    win = win || window; base = base || '/media/audio';
    const exists = new Map(); let current = null;
    const head = (u) => { if (!exists.has(u)) exists.set(u, win.fetch(u, { method: 'HEAD', cache: 'no-cache' }).then((r) => r.ok).catch(() => false)); return exists.get(u); };
    return {
      base,
      async available(urls) { return (await Promise.all(urls.map(head))).every(Boolean); },
      /** هل يتوفر تسجيل لعيّنة؟ (فحص رخيص لتحديد الحالة) */
      async probe() { return head(`${base}/ar/${CL.PHRASES.ticket.file}.mp3`).then((a) => a && head(`${base}/ar/${CL.PHRASES.counter.file}.mp3`)); },
      play(urls, volume) {
        return new Promise((resolve, reject) => {
          let i = 0;
          const next = () => {
            if (i >= urls.length) { current = null; return resolve('ended'); }
            const a = new win.Audio(urls[i++]); a.volume = volume; current = { a, reject };
            a.onended = next; a.onerror = () => { current = null; const e = new Error('clip failed'); e.code = 'clip'; reject(e); };
            const p = a.play(); if (p && p.catch) p.catch((e) => { current = null; e.code = e.name === 'NotAllowedError' ? 'not-allowed' : 'clip'; reject(e); });
          };
          next();
        });
      },
      cancelAll() { if (current) { const { a, reject } = current; current = null; try { a.pause(); } catch (e) { /* تجاهل */ } const e = new Error('cancelled'); e.code = 'interrupted'; reject(e); } },
    };
  }

  /* ---------- المُعلن ---------- */
  function create(opts) {
    opts = opts || {};
    const speech = opts.speech || { supported: false, getVoices: () => [], userActive: () => true, speak: () => Promise.reject(new Error('no speech')), cancelAll() {}, onVoicesChanged() {} };
    const clips = opts.clips || null;
    const now = opts.now || Date.now;
    const setT = opts.setTimeout || setTimeout; const clearT = opts.clearTimeout || clearTimeout;
    const onStatus = opts.onStatus || (() => {});
    const log = opts.log || (() => {});
    const letters = opts.letters || 'latin';
    const maxWaitMs = opts.maxWaitMs || 120000;   // أقصى انتظار في الطابور قبل اعتبار النداء بائداً
    const freshMs = opts.freshMs || 30000;        // بعد فك الحظر: نتجاهل ما هو أقدم من هذا
    const maxQueue = opts.maxQueue || 10;
    const voicesWaitMs = opts.voicesWaitMs == null ? 2500 : opts.voicesWaitMs;
    const preferred = opts.preferredVoices || {};

    const st = { settings: normalize(opts.settings), queue: [], running: false, gen: 0, blocked: false, bad: new Set(),
      voicesLoaded: false, clipsOk: null, arSkipped: false, status: null, active: null, sleepers: new Set() };

    /* --- الحالة --- */
    function hasVoice(lang) { return !!pickVoice(speech.getVoices(), lang, { bad: st.bad }); }
    function computeStatus() {
      const s = st.settings;
      if (!s.audio_enabled) return { state: 'off', needsGate: false };
      const needsGate = st.blocked || !speech.userActive();
      if (needsGate) return { state: 'blocked', needsGate: true };
      const needAr = s.announce_lang !== 'en'; const needEn = s.announce_lang !== 'ar';
      const noArabic = needAr && ((st.voicesLoaded && !hasVoice('ar') && st.clipsOk !== true) || st.arSkipped);
      const noEnglish = needEn && st.voicesLoaded && !hasVoice('en') && !speech.supported;
      if (!speech.supported && st.clipsOk !== true) return { state: 'no-voice', needsGate: false };
      if (noArabic || noEnglish) return { state: 'no-voice', needsGate: false };
      return { state: 'on', needsGate: false };
    }
    function emit() {
      const c = computeStatus(); c.queueLength = st.queue.length;
      const key = `${c.state}|${c.needsGate}|${c.queueLength}`;
      if (key !== st.status) { st.status = key; try { onStatus(c); } catch (e) { /* تجاهل */ } }
      return c;
    }
    async function refreshAvailability() {
      if (clips && st.settings.announce_lang !== 'en' && !hasVoice('ar') && st.clipsOk === null) {
        try { st.clipsOk = !!(await clips.probe()); } catch (e) { st.clipsOk = false; }
      }
      emit();
    }
    st.voicesLoaded = !!(speech.getVoices() || []).length;
    if (!st.voicesLoaded) {
      setT(() => { st.voicesLoaded = true; refreshAvailability(); }, voicesWaitMs);
    }
    if (speech.onVoicesChanged) speech.onVoicesChanged(() => { st.voicesLoaded = true; st.clipsOk = null; refreshAvailability(); });
    refreshAvailability();

    /* --- أدوات --- */
    function sleep(ms, tok) {
      return new Promise((resolve) => {
        if (tok !== st.gen) return resolve();
        const w = { resolve }; st.sleepers.add(w);
        w.t = setT(() => { st.sleepers.delete(w); resolve(); }, ms);
      });
    }
    function watchdogMs(text, rate) { return Math.max(4000, Math.round((text.length * 130) / Math.max(rate, 0.5)) + 3000); }
    function withWatchdog(promise, ms) {
      return new Promise((resolve, reject) => {
        const t = setT(() => { const e = new Error('speech watchdog timeout'); e.code = 'timeout'; reject(e); }, ms);
        promise.then((v) => { clearT(t); resolve(v); }, (e) => { clearT(t); reject(e); });
      });
    }

    /* --- نطق جملة واحدة --- */
    async function say(spec, item, tok) {
      const s = st.settings;
      if (spec.lang === 'ar' && !hasVoice('ar')) {
        const urls = clips && CL.clipUrls(item.ticketNumber, item.counterNumber, { base: clips.base });
        if (urls && await clips.available(urls)) {
          st.clipsOk = true;
          if (tok !== st.gen) return 'cancelled';
          try { await clips.play(urls, s.volume); st.arSkipped = false; emit(); return 'ok'; } catch (e) { if (e.code === 'not-allowed' || tok !== st.gen) throw e; log({ type: 'clips-failed' }); }
        }
        st.arSkipped = true; // لا صوت عربي ولا ملفات كاملة لهذا النداء: ننبّه بدل الصمت المضلل
        log({ type: 'no-arabic', item: item.ticketNumber });
        emit();
        return 'skipped';
      }
      for (let attempt = 0; attempt < 3; attempt++) {
        const voice = pickVoice(speech.getVoices(), spec.lang, { bad: st.bad, preferred: preferred[spec.lang] });
        if (!voice && spec.lang === 'ar') return 'skipped';
        if (!speech.supported) return 'skipped';
        try {
          if (tok !== st.gen) return 'cancelled';
          await withWatchdog(speech.speak({ text: spec.text, lang: spec.lang, voice, rate: s.speech_rate, pitch: s.speech_pitch, volume: s.volume }), watchdogMs(spec.text, s.speech_rate));
          if (spec.lang === 'ar' && st.arSkipped) { st.arSkipped = false; emit(); }
          return 'ok';
        } catch (e) {
          if (tok !== st.gen) return 'cancelled';
          const code = e && e.code;
          if (code === 'not-allowed') throw e;
          if (code === 'interrupted' || code === 'canceled') return 'cancelled';
          if (code === 'timeout') { speech.cancelAll(); log({ type: 'watchdog' }); return 'ok'; } // onend لم يصل (علّة Chrome): نفترض انتهاء النطق ولا نحظر الصوت
          if (voice) st.bad.add(voice.name); // صوت بعيد/معطوب (مثلاً بلا إنترنت): جرّب التالي
          log({ type: 'voice-failed', voice: voice && voice.name, code });
        }
      }
      return 'skipped';
    }

    async function runItem(item, tok) {
      const s = st.settings;
      const utts = N.buildUtterances(item.ticketNumber, item.counterNumber, s.announce_lang, { letters });
      for (let r = 0; r < s.repeat_count; r++) {
        if (r > 0) { await sleep(s.repeat_delay_ms, tok); }
        for (let i = 0; i < utts.length; i++) {
          if (tok !== st.gen) return;
          if (i > 0) await sleep(300, tok);
          if (tok !== st.gen) return;
          await say(utts[i], item, tok);
        }
      }
    }

    async function pump() {
      if (st.running) return;
      st.running = true;
      try {
        while (st.queue.length) {
          if (!st.settings.audio_enabled) break;
          if (st.blocked || !speech.userActive()) { st.blocked = true; emit(); break; }
          const item = st.queue.shift();
          if (now() - item.enqueuedAt > maxWaitMs) { log({ type: 'drop-stale', item: item.ticketNumber }); continue; }
          const tok = st.gen; st.active = item; emit();
          try { await runItem(item, tok); } catch (e) {
            if (e && e.code === 'not-allowed') { st.blocked = true; if (now() - item.enqueuedAt <= freshMs) st.queue.unshift(item); emit(); break; }
            log({ type: 'error', message: e && e.message });
          }
          st.active = null;
        }
      } finally { st.running = false; st.active = null; emit(); }
    }

    function clear() {
      st.gen += 1; st.queue = [];
      const l = Array.from(st.sleepers); st.sleepers.clear(); l.forEach((w) => { clearT(w.t); w.resolve(); });
      try { speech.cancelAll(); } catch (e) { /* تجاهل */ }
      if (clips) try { clips.cancelAll(); } catch (e) { /* تجاهل */ }
      emit();
    }

    return {
      /** evt: { ticketNumber, counterNumber, eventId?, ts?, recall? } */
      enqueue(evt) {
        if (!st.settings.audio_enabled) { log({ type: 'disabled' }); return false; }
        if (!evt || !evt.ticketNumber || evt.counterNumber == null) return false;
        const key = `${evt.ticketNumber}|${evt.counterNumber}`;
        if (st.queue.some((q) => q.key === key)) { log({ type: 'dup-pending', key }); return false; } // نفس النداء ينتظر دوره أصلاً
        if (st.queue.length >= maxQueue) st.queue.shift();
        st.queue.push({ key, ticketNumber: String(evt.ticketNumber), counterNumber: evt.counterNumber, recall: !!evt.recall, enqueuedAt: now() });
        emit(); pump();
        return true;
      },
      /** يُستدعى من نقرة المستخدم (زر تفعيل الصوت). */
      unlock() {
        if (speech.unlock && (st.blocked || !st.unlockedOnce)) { speech.unlock(); st.unlockedOnce = true; } // نطق صامت واحد يكفي لتأسيس التفاعل
        st.blocked = false;
        const t = now(); st.queue = st.queue.filter((q) => t - q.enqueuedAt <= freshMs); // لا نطق لنداءات قديمة بعد فك الحظر
        emit(); pump();
      },
      setSettings(s) {
        const was = st.settings.audio_enabled; st.settings = normalize(s);
        if (!st.settings.audio_enabled && was) clear();
        st.clipsOk = st.clipsOk === true ? true : null;
        refreshAvailability();
      },
      clear,
      refresh: emit, // إعادة تقييم الحالة (قد يتغير userActivation بلا حدث)
      status: () => computeStatus(),
      voiceInfo() {
        const v = speech.getVoices();
        return { ar: pickVoice(v, 'ar', { bad: st.bad }), en: pickVoice(v, 'en', { bad: st.bad }), total: (v || []).length, clipsOk: st.clipsOk };
      },
      _state: st,
    };
  }

  return { create, normalize, pickVoice, createBrowserSpeech, createBrowserClips, DEFAULTS };
}));
