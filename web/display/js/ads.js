/* مشغّل الإعلانات: تناوب صور/فيديو/نص بانتقال سلس، يحترم الأولوية والتواريخ والتفعيل والاستهداف،
   وعند عدم وجود إعلانات يعرض بطاقات معلومات العيادة والتوعية الصحية.
   المنطق قابل للاختبار في Node (حقن المؤقتات والبناء)؛ طبقة DOM في buildAdElement. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./core.js'));
  else root.DisplayAds = factory(root.DisplayCore);
}(typeof self !== 'undefined' ? self : this, function (C) {
  'use strict';
  const G = typeof self !== 'undefined' ? self : globalThis;
  const CARD_MS = 12000;
  const IMG_TIMEOUT = 8000;
  const VIDEO_TIMEOUT = 10000;

  /* ---------- بناء عنصر الإعلان (DOM) ---------- */
  function buildAdElement(ad, doc) {
    doc = doc || document;
    if (ad.mediaType === 'text') {
      const box = doc.createElement('div'); box.className = 'ad-text';
      if (ad.title) { const t = doc.createElement('div'); t.className = 'ad-title'; t.textContent = ad.title; box.appendChild(t); }
      const b = doc.createElement('div'); b.className = 'ad-body'; b.textContent = ad.bodyText || ''; box.appendChild(b);
      return Promise.resolve(box);
    }
    if (ad.mediaType === 'image') {
      return new Promise((resolve, reject) => {
        const img = doc.createElement('img'); img.className = 'ad-media'; img.alt = ad.title || ''; img.decoding = 'async';
        img.onload = () => resolve(img); img.onerror = () => reject(new Error('image load failed'));
        img.src = ad.url;
      });
    }
    return new Promise((resolve, reject) => { // video
      const v = doc.createElement('video'); v.className = 'ad-media';
      v.muted = true; v.defaultMuted = true; v.setAttribute('muted', ''); v.autoplay = true; v.loop = true; v.playsInline = true; v.preload = 'auto';
      v.setAttribute('playsinline', ''); v.disablePictureInPicture = true; v.controls = false;
      v.onloadeddata = () => resolve(v); v.onerror = () => reject(new Error('video load failed'));
      v.src = ad.url;
    });
  }
  function withTimeout(p, ms) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout')), ms);
      p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
    });
  }

  /* ---------- المتحكم ---------- */
  function create(opts) {
    const stage = opts.stage;
    const now = opts.now || Date.now;
    const setT = opts.setTimeout || setTimeout; const clearT = opts.clearTimeout || clearTimeout;
    const build = opts.buildAd || ((ad) => withTimeout(buildAdElement(ad), ad.mediaType === 'video' ? VIDEO_TIMEOUT : IMG_TIMEOUT));
    const buildCard = opts.buildCard || ((ctx, i) => {
      const cards = G.DisplayInfoCards.buildCards(ctx.clinic, ctx.lang, ctx.strings);
      return cards.length ? G.DisplayInfoCards.renderCard(cards[i % cards.length]) : null;
    });
    const getContext = opts.getContext || (() => ({}));
    const log = opts.onEvent || (() => {});

    const st = { ads: [], displayId: null, last: null, current: null, timer: null, cardIdx: 0, fails: 0, stopped: true, token: 0, pre: null };

    const after = (a, last) => !last || a.priority < last.priority || (a.priority === last.priority && (a.id || 0) > (last.id || 0));
    const eligible = () => C.eligibleAds(st.ads, now(), st.displayId);
    const schedule = (ms) => { clearT(st.timer); st.timer = setT(advance, ms); };

    function showCard(token) {
      if (token !== st.token) return;
      let el = null;
      try { el = buildCard(getContext(), st.cardIdx); } catch (e) { console.error('[ads] card', e); }
      st.cardIdx += 1;
      if (el) stage.show(el);
      st.current = null;
      log({ type: 'card' });
      schedule(CARD_MS);
    }

    function preloadNext() {
      // تحميل مسبق للصورة التالية فقط (الفيديو لا يُحمّل مسبقاً لتفادي تشغيله خارج المسرح)
      const list = eligible();
      if (list.length < 2 || !st.last) return;
      const nxt = list.find((a) => after(a, st.last)) || list[0];
      if (nxt.mediaType !== 'image' || (st.pre && st.pre.id === nxt.id)) return;
      st.pre = { id: nxt.id, promise: build(nxt) };
      st.pre.promise.catch(() => {});
    }

    async function advance() {
      if (st.stopped) return;
      const token = ++st.token;
      const list = eligible();
      if (!list.length) { st.fails = 0; st.last = null; return showCard(token); }
      const ad = list.find((a) => after(a, st.last)) || list[0];
      if (list.length === 1 && st.current && st.current.id === ad.id) { // إعلان وحيد معروض: لا إعادة بناء ولا وميض
        log({ type: 'keep', id: ad.id }); return schedule(ad.durationSec * 1000);
      }
      try {
        let p;
        if (st.pre && st.pre.id === ad.id) { p = st.pre.promise; st.pre = null; } else p = build(ad);
        const el = await p;
        if (token !== st.token || st.stopped) return;
        stage.show(el);
        if (typeof el.play === 'function') { try { const r = el.play(); if (r && r.catch) r.catch(() => {}); } catch (e) { /* تجاهل */ } }
        st.current = ad; st.last = ad; st.fails = 0;
        log({ type: 'ad', id: ad.id, mediaType: ad.mediaType, ms: ad.durationSec * 1000 });
        schedule(ad.durationSec * 1000);
        preloadNext();
      } catch (e) {
        if (token !== st.token || st.stopped) return;
        console.warn('[ads] skip ad', ad.id, e && e.message);
        log({ type: 'fail', id: ad.id });
        st.last = ad; st.fails += 1; st.current = null;
        if (st.fails >= list.length) { st.fails = 0; return showCard(token); } // كلها فاشلة: بطاقات معلومات ثم إعادة المحاولة
        schedule(250);
      }
    }

    return {
      start() { st.stopped = false; clearT(st.timer); advance(); },
      stop() { st.stopped = true; st.token += 1; clearT(st.timer); },
      /** يُستدعى عند bootstrap وعند advertisement:updated (القائمة الفعّالة الجديدة). */
      setAds(list, displayId) {
        st.ads = (list || []).map(C.normalizeAd).filter(Boolean);
        st.displayId = displayId == null ? null : displayId;
        st.pre = null;
        if (st.stopped) return;
        const elig = eligible();
        const curOk = st.current && elig.some((a) => a.id === st.current.id);
        if (st.current ? !curOk : elig.length > 0) { clearT(st.timer); advance(); } // انتهى/حُذف المعروض، أو وصلت إعلانات أثناء البطاقات
      },
      _state: st,
    };
  }

  return { create, buildAdElement, CARD_MS };
}));
