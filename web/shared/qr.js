/* QR rendering helpers on top of vendor/qrcode.js (qrcode-generator, MIT). Output: inline SVG string or canvas drawing. */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.QM = root.QM || {}; root.QM.qr = api.create(root.qrcode); }
})(typeof self !== 'undefined' ? self : this, function () {
  function create(lib) {
    function matrix(text, ecc) {
      var q = lib(0, ecc || 'M'); q.addData(String(text), 'Byte'); q.make();
      var n = q.getModuleCount();
      return { size: n, isDark: function (r, c) { return q.isDark(r, c); } };
    }
    /* scalable SVG (viewBox), crisp edges; margin = quiet zone in modules (spec says >= 4 for scanners; default 3 keeps the card compact, use 4 for print) */
    function svg(text, o) {
      o = o || {}; var m = matrix(text, o.ecc), margin = o.margin == null ? 3 : o.margin, n = m.size, d = '';
      for (var r = 0; r < n; r++) { var run = -1; for (var c = 0; c <= n; c++) {
        var dark = c < n && m.isDark(r, c);
        if (dark && run < 0) run = c;
        if (!dark && run >= 0) { d += 'M' + (run + margin) + ' ' + (r + margin) + 'h' + (c - run) + 'v1h-' + (c - run) + 'z'; run = -1; } } }
      var total = n + margin * 2;
      return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + total + ' ' + total + '" shape-rendering="crispEdges" role="img"' + (o.label ? ' aria-label="' + o.label.replace(/"/g, '&quot;') + '"' : '') + '>' +
        '<rect width="' + total + '" height="' + total + '" fill="' + (o.bg || '#fff') + '"/><path fill="' + (o.fg || '#000') + '" d="' + d + '"/></svg>';
    }
    /* draws into a 2D canvas context at (x,y) with outer size px (includes quiet zone) */
    function draw(ctx, text, x, y, size, o) {
      o = o || {}; var m = matrix(text, o.ecc), margin = o.margin == null ? 4 : o.margin, total = m.size + margin * 2, cell = size / total;
      ctx.fillStyle = o.bg || '#fff'; ctx.fillRect(x, y, size, size); ctx.fillStyle = o.fg || '#000';
      for (var r = 0; r < m.size; r++) for (var c = 0; c < m.size; c++) if (m.isDark(r, c)) {
        var px = Math.round(x + (c + margin) * cell), py = Math.round(y + (r + margin) * cell);
        ctx.fillRect(px, py, Math.ceil(cell), Math.ceil(cell)); }
    }
    return { matrix: matrix, svg: svg, draw: draw };
  }
  return { create: create };
});
