/* Motion helpers (Web Animations / CSS classes only, no libraries). */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.QM = root.QM || {}; root.QM.motion = api; }
})(typeof self !== 'undefined' ? self : this, function (root) {
  function reduced() { try { return !!(root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (e) { return false; } }
  /* restart a CSS animation class on an element (e.g. 'qm-roll' when a number changes) */
  function replay(el, cls) { if (!el) return; el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls); }
  /* change text with a roll-in; under reduced motion the text just changes */
  function setRolling(el, text) { if (!el || el.textContent === String(text)) return false; el.textContent = String(text); if (!reduced()) replay(el, 'qm-roll'); return true; }
  return { reduced: reduced, replay: replay, setRolling: setRolling };
});
