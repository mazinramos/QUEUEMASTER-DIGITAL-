/* مشغّل الإعلانات — المرحلة 1: التناوب على بطاقات المعلومات/التوعية. (المرحلة 2 تضيف الصور/الفيديو/النص) */
(function (root) {
  'use strict';
  const CARD_MS = 12000;
  function create(opts) {
    const { stage, getContext } = opts;
    let timer = null; let idx = 0; let stopped = false;
    function tick() {
      if (stopped) return;
      let delay = CARD_MS;
      try {
        const ctx = getContext();
        const cards = root.DisplayInfoCards.buildCards(ctx.clinic, ctx.lang, ctx.strings);
        if (cards.length) {
          idx = idx % cards.length;
          stage.show(root.DisplayInfoCards.renderCard(cards[idx]));
          idx += 1;
        }
      } catch (e) { console.error('[ads]', e); delay = 5000; }
      timer = setTimeout(tick, delay);
    }
    return {
      start() { stopped = false; clearTimeout(timer); tick(); },
      stop() { stopped = true; clearTimeout(timer); },
      setAds() { /* المرحلة 2 */ },
      refresh() { if (!stopped) { clearTimeout(timer); idx = 0; tick(); } },
    };
  }
  root.DisplayAds = { create };
}(typeof self !== 'undefined' ? self : this));
