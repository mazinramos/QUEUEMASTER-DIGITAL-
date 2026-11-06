/* Clinic branding -> CSS variables. The clinic sets one colour; this derives the accessible action colour (>= 4.5:1 with white text),
   hover and soft tint, and injects them on <html>. Status colours are never touched. */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.QM = root.QM || {}; root.QM.brand = api; }
})(typeof self !== 'undefined' ? self : this, function () {
  var DEFAULT = '#0F8F6B';
  function parseHex(h) {
    var m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(h || '').trim()); if (!m) return null;
    var s = m[1]; if (s.length === 3) s = s.replace(/./g, function (c) { return c + c; });
    return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
  }
  function toHex(rgb) { return '#' + rgb.map(function (v) { v = Math.max(0, Math.min(255, Math.round(v))); return (v < 16 ? '0' : '') + v.toString(16); }).join('').toUpperCase(); }
  function lum(rgb) { var c = rgb.map(function (v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; }
  function toRgb(x) { return Array.isArray(x) ? x : parseHex(x); }
  function contrast(a, b) { var l1 = lum(toRgb(a)), l2 = lum(toRgb(b)), hi = Math.max(l1, l2), lo = Math.min(l1, l2); return (hi + 0.05) / (lo + 0.05); }
  function mix(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }

  /* returns { brand, action, actionHover, on, soft } as hex strings */
  function derive(hex) {
    var base = parseHex(hex) || parseHex(DEFAULT), action = base, n = 0;
    while (contrast(action, [255, 255, 255]) < 4.5 && n++ < 60) action = mix(action, [0, 0, 0], 0.05);
    var hover = action, k = 0; hover = mix(action, [0, 0, 0], 0.16);
    return { brand: toHex(base), action: toHex(action), actionHover: toHex(hover), on: '#FFFFFF', soft: toHex(mix(base, [255, 255, 255], 0.9)) };
  }
  /* apply(branding | hex, doc?) -> derived colours. branding = { color, name_ar, name_en, logoUrl } as returned by GET /api/public/clinic */
  function apply(branding, doc) {
    var hex = typeof branding === 'string' ? branding : branding && branding.color, d = derive(hex);
    doc = doc || (typeof document !== 'undefined' ? document : null);
    if (doc) {
      var s = doc.documentElement.style;
      s.setProperty('--brand', d.brand); s.setProperty('--brand-action', d.action); s.setProperty('--brand-action-hover', d.actionHover);
      s.setProperty('--brand-on', d.on); s.setProperty('--brand-soft', d.soft);
    }
    return d;
  }
  /* safe logo url: same-origin path only (no remote images in this offline product) */
  function logoSrc(branding) { var u = branding && branding.logoUrl; return typeof u === 'string' && /^\/[^/\\]/.test(u) ? u : null; }
  function nameOf(branding, lang, fallback) {
    if (!branding) return fallback || '';
    var ar = branding.name_ar || branding.nameAr, en = branding.name_en || branding.nameEn;
    return (lang === 'en' ? (en || ar) : (ar || en)) || fallback || '';
  }
  return { DEFAULT: DEFAULT, parseHex: parseHex, toHex: toHex, contrast: contrast, mix: mix, derive: derive, apply: apply, logoSrc: logoSrc, nameOf: nameOf };
});
