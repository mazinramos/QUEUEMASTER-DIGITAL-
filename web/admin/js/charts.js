/* رسوم SVG بسيطة بلا مكتبات: أعمدة مجمّعة. ألوان من الـ tokens عبر CSS. */
(function () {
  var A = QM.admin; var NS = 'http://www.w3.org/2000/svg';
  function s(tag, attrs, text) { var el = document.createElementNS(NS, tag); Object.keys(attrs || {}).forEach(function (k) { el.setAttribute(k, attrs[k]); }); if (text != null) el.textContent = String(text); return el; }
  /* سقف يقبل القسمة على 4 بخطوة صحيحة (1/2/5×10^k) ليكون محور Y بأعداد صحيحة مفهومة */
  function niceMax(v) { var raw = Math.max(4, v) / 4; var p = Math.pow(10, Math.floor(Math.log10(raw))); var n = raw / p; var step = (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p; return step * 4; }

  /* data: [{label, values:[...]}]، series: [{name}] ، opts: {height, labelEvery, ariaLabel} */
  A.barChart = function (data, series, opts) {
    opts = opts || {};
    var W = 640, H = opts.height || 220, padL = 36, padR = 8, padT = 12, padB = 28;
    var max = niceMax(Math.max.apply(null, [1].concat.apply([], data.map(function (d) { return d.values; }))));
    var svg = s('svg', { viewBox: '0 0 ' + W + ' ' + H, class: 'adm-chart', role: 'img', 'aria-label': opts.ariaLabel || '', preserveAspectRatio: 'xMidYMid meet' });
    var iw = W - padL - padR, ih = H - padT - padB;
    for (var g = 0; g <= 4; g++) {
      var y = padT + ih - (ih * g) / 4;
      svg.appendChild(s('line', { x1: padL, x2: W - padR, y1: y, y2: y, class: 'adm-chart__grid' }));
      svg.appendChild(s('text', { x: padL - 6, y: y + 4, class: 'adm-chart__tick', 'text-anchor': 'end' }, Math.round((max * g) / 4)));
    }
    var n = data.length || 1, band = iw / n, k = series.length, bw = Math.max(2, Math.min(28, (band * 0.7) / k));
    data.forEach(function (d, i) {
      var x0 = padL + band * i + (band - bw * k) / 2;
      d.values.forEach(function (v, j) {
        var bh = (ih * v) / max;
        var r = s('rect', { x: x0 + bw * j, y: padT + ih - bh, width: bw - 1, height: Math.max(0, bh), rx: 2, class: 'adm-chart__bar adm-chart__bar--' + j });
        r.appendChild(s('title', {}, d.label + ' — ' + series[j].name + ': ' + v));
        svg.appendChild(r);
      });
      if (!opts.labelEvery || i % opts.labelEvery === 0) svg.appendChild(s('text', { x: padL + band * i + band / 2, y: H - 8, class: 'adm-chart__tick', 'text-anchor': 'middle' }, d.label));
    });
    var legend = A.h('div', { class: 'adm-legend' }, series.map(function (se, j) { return A.h('span', { class: 'adm-legend__item' }, A.h('i', { class: 'adm-legend__sw adm-chart__bar--' + j }), se.name); }));
    return A.h('figure', { class: 'adm-figure' }, svg, series.length > 1 || opts.legend ? legend : null);
  };
})();
