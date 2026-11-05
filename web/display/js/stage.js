/* مسرح الإعلانات: طبقتان بتبديل متلاشٍ (crossfade). كل المحتوى يُبنى بـ DOM (لا innerHTML ببيانات خارجية). */
(function (root) {
  'use strict';
  function cleanup(el) {
    try {
      el.querySelectorAll('video').forEach((v) => { v.pause(); v.removeAttribute('src'); v.load(); });
    } catch (e) { /* تجاهل */ }
    el.remove();
  }
  function createStage(host, fadeMs) {
    const FADE = fadeMs == null ? 850 : fadeMs;
    let current = null;
    return {
      get current() { return current; },
      show(el) {
        el.classList.add('ad-layer');
        host.appendChild(el);
        const old = current; current = el;
        // إطار واحد ليبدأ الانتقال من opacity:0
        requestAnimationFrame(() => {
          el.classList.add('is-in');
          if (old) { old.classList.remove('is-in'); setTimeout(() => cleanup(old), FADE); }
        });
      },
      clear() { if (current) { cleanup(current); current = null; } },
    };
  }
  root.DisplayStage = { createStage };
}(typeof self !== 'undefined' ? self : this));
