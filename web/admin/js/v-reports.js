/* التقارير: عرض + CSV + طباعة. الباك إند: /api/admin/reports/:name */
(function () {
  var A = QM.admin; var h = A.h; var t = A.t; var api = A.api;
  A.views = A.views || {};
  var NAMES = ['summary', 'daily', 'weekly', 'monthly', 'services', 'waiting-times', 'staff'];
  A.isoDate = function (d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };

  /* يرسم نتيجة تقرير (يُستخدم في الصفحة وفي صفحة الطباعة) */
  A.renderReport = function (name, r) {
    var m = function (x) { return A.min(x); };
    if (name === 'summary') return A.table([{ label: t('rp.metric'), key: 'k' }, { label: t('rp.value'), render: function (x) { return x.v; } }], [
      { k: t('rp.from'), v: r.from }, { k: t('rp.to'), v: r.to }, { k: t('c.issued'), v: A.num(r.issued) }, { k: t('c.completed'), v: A.num(r.completed) }, { k: t('c.skipped'), v: A.num(r.skipped) }, { k: t('c.cancelled'), v: A.num(r.cancelled) },
      { k: t('c.avgWait'), v: m(r.avgWaitMin) }, { k: t('c.avgService'), v: m(r.avgServiceMin) }, { k: t('rp.activeDays'), v: A.num(r.activeDays) }, { k: t('rp.perDay'), v: r.avgPerActiveDay == null ? '—' : A.num(r.avgPerActiveDay) }]);
    if (name === 'daily' || name === 'weekly' || name === 'monthly') {
      var key = name === 'daily' ? 'date' : 'period'; var lab = name === 'daily' ? t('d.date') : (name === 'weekly' ? t('rp.week') : t('rp.month'));
      var chart = A.barChart(r.rows.map(function (x, i) { return { label: String(x[key]).slice(name === 'monthly' ? 2 : 5), values: [x.issued, x.completed] }; }), [{ name: t('c.issued') }, { name: t('c.completed') }], { ariaLabel: lab, labelEvery: Math.ceil(r.rows.length / 12) });
      return h('div', null, r.rows.length > 1 ? chart : null, A.table([{ label: lab, render: function (x) { return h('span', { class: 'qm-num' }, x[key]); } }, { label: t('c.issued'), key: 'issued', class: 'qm-num' }, { label: t('c.completed'), key: 'completed', class: 'qm-num' },
        { label: t('c.skipped'), key: 'skipped', class: 'qm-num' }, { label: t('c.cancelled'), key: 'cancelled', class: 'qm-num' }, { label: t('c.avgWait'), render: function (x) { return m(x.avgWaitMin); } }, { label: t('c.avgService'), render: function (x) { return m(x.avgServiceMin); } }], r.rows));
    }
    if (name === 'services') return A.table([{ label: t('q.service'), render: function (x) { return x.prefix + ' · ' + A.name({ nameAr: x.name_ar, nameEn: x.name_en }); } }, { label: t('c.issued'), key: 'issued', class: 'qm-num' }, { label: t('c.completed'), key: 'completed', class: 'qm-num' },
      { label: t('c.skipped'), key: 'skipped', class: 'qm-num' }, { label: t('c.cancelled'), key: 'cancelled', class: 'qm-num' }, { label: t('c.avgWait'), render: function (x) { return m(x.avgWaitMin); } }, { label: t('c.avgService'), render: function (x) { return m(x.avgServiceMin); } }], r.rows);
    if (name === 'staff') return A.table([{ label: t('st.fullName'), key: 'fullName' }, { label: t('rp.called'), key: 'called', class: 'qm-num' }, { label: t('c.completed'), key: 'completed', class: 'qm-num' }, { label: t('c.skipped'), key: 'skipped', class: 'qm-num' },
      { label: t('c.cancelled'), key: 'cancelled', class: 'qm-num' }, { label: t('rp.recalls'), key: 'recalls', class: 'qm-num' }, { label: t('c.avgService'), render: function (x) { return m(x.avgServiceMin); } }], r.rows);
    if (name === 'waiting-times') {
      return h('div', null,
        A.table([{ label: t('rp.metric'), key: 'k' }, { label: t('rp.value'), render: function (x) { return x.v; } }], [{ k: t('rp.samples'), v: A.num(r.samples) }, { k: t('c.avgWait'), v: m(r.avgMin) }, { k: t('rp.median'), v: m(r.medianMin) }, { k: t('rp.p90'), v: m(r.p90Min) }, { k: t('rp.max'), v: m(r.maxMin) }]),
        h('h3', { class: 'adm-h3' }, t('rp.dist')), A.barChart(r.buckets.map(function (b) { return { label: b.label, values: [b.count] }; }), [{ name: t('rp.count') }], { ariaLabel: t('rp.dist'), legend: false }),
        A.table([{ label: t('rp.hour'), render: function (x) { return h('span', { class: 'qm-num' }, String(x.hour).padStart(2, '0') + ':00'); } }, { label: t('rp.count'), key: 'count', class: 'qm-num' }, { label: t('c.avgWait'), render: function (x) { return m(x.avgMin); } }], r.byHour.filter(function (x) { return x.count; })));
    }
    return h('p', null, '—');
  };
  A.reportQuery = function (o) { var q = {}; if (o.from) q.from = o.from; if (o.to) q.to = o.to; if (o.serviceId) q.serviceId = o.serviceId; return q; };
  A.qs = function (q) { var p = Object.keys(q).map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(q[k]); }); return p.length ? '?' + p.join('&') : ''; };

  A.views.reports = { role: 'manager', render: async function (root) {
    var services = await api.get('/api/admin/services').catch(function () { return []; });
    var now = new Date(); var weekAgo = new Date(now.getTime() - 6 * 86400000);
    var type = A.f.select(t('rp.type'), NAMES.map(function (n) { return { value: n, label: t('rp.' + n) }; }), { value: 'daily' });
    var from = A.f.text(t('rp.from'), { type: 'date', value: A.isoDate(weekAgo), dir: 'ltr' }); var to = A.f.text(t('rp.to'), { type: 'date', value: A.isoDate(now), dir: 'ltr' });
    var svc = A.f.select(t('rp.service'), [{ value: '', label: t('f.all') }].concat(services.map(function (s) { return { value: s.id, label: s.prefix + ' · ' + A.name(s) }; })));
    var out = h('div'); var lastName = 'daily';
    var csvLink = h('a', { class: 'qm-btn qm-btn--secondary qm-btn--sm', href: '#', download: '' }, A.icon('download'), t('rp.csv'));
    var printLink = h('a', { class: 'qm-btn qm-btn--secondary qm-btn--sm', href: '#', target: '_blank', rel: 'noopener' }, A.icon('printer'), t('rp.print'));
    var run = A.btn(t('rp.run'), { onClick: load });
    root.appendChild(A.pageHead(t('rp.title')));
    root.appendChild(h('div', { class: 'qm-card adm-section' }, h('div', { class: 'adm-filters adm-filters--form' }, type.el, from.el, to.el, svc.el), h('div', { class: 'adm-actions' }, run, csvLink, printLink)));
    root.appendChild(h('div', { class: 'qm-card adm-section' }, out));
    function links() {
      var q = A.reportQuery({ from: from.get(), to: to.get(), serviceId: svc.get() });
      csvLink.href = '/api/admin/reports/' + type.get() + A.qs(Object.assign({}, q, { format: 'csv', lang: QM.i18n.lang }));
      printLink.href = 'print.html' + A.qs(Object.assign({ report: type.get() }, q));
    }
    [type, from, to, svc].forEach(function (f) { f.input.addEventListener('change', links); }); links();
    async function load() {
      links(); A.clear(out); out.appendChild(A.loading());
      try { var name = type.get(); var r = await api.get('/api/admin/reports/' + name, { query: A.reportQuery({ from: from.get(), to: to.get(), serviceId: svc.get() }) }); A.clear(out); out.appendChild(A.renderReport(name, r)); }
      catch (e) { A.clear(out); out.appendChild(A.errorBox(e, load)); }
    }
    load();
  } };
})();
