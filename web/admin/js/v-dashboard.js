/* الرئيسية: بطاقات الإحصاءات، أداء الخدمات والشبابيك، رسوم الساعة وآخر 7 أيام. تحديث تلقائي كل 15 ثانية. */
(function () {
  var A = QM.admin; var h = A.h; var t = A.t;
  A.views = A.views || {};

  function statCard(label, value, icon, kind) {
    return h('div', { class: 'adm-stat' + (kind ? ' adm-stat--' + kind : '') }, h('div', { class: 'adm-stat__icon' }, A.icon(icon, 22)), h('div', null, h('div', { class: 'adm-stat__value qm-num' }, value), h('div', { class: 'adm-stat__label' }, label)));
  }

  A.views.dashboard = { role: 'manager', render: function (root) {
    var date = A.today(); var timer = null; var alive = true;
    var out = h('div', { class: 'adm-stack' });
    var dateInput = h('input', { type: 'date', class: 'qm-input adm-date', value: date, 'aria-label': t('d.date') });
    var refresh = A.btn(t('d.refresh'), { kind: 'secondary', sm: true, icon: 'refresh-cw', onClick: load });
    root.appendChild(A.pageHead(t('nav.dashboard'), [dateInput, refresh]));
    root.appendChild(out);
    root.appendChild(h('p', { class: 'qm-hint' }, t('d.autoRefresh')));
    dateInput.addEventListener('change', function () { date = dateInput.value || A.today(); load(); });

    async function load() {
      try {
        var d = await A.api.get('/api/admin/stats/overview', { query: { date: date } });
        if (!alive) return;
        paint(d);
      } catch (e) { if (alive) { A.clear(out); out.appendChild(A.errorBox(e, load)); } }
    }
    function paint(d) {
      A.clear(out);
      var c = d.cards;
      out.appendChild(h('div', { class: 'adm-stats' }, [
        statCard(t('c.today'), A.num(c.today), 'ticket'), statCard(t('c.waiting'), A.num(c.waiting), 'hourglass', 'info'),
        statCard(t('c.inService'), A.num(c.inService), 'user', 'ok'), statCard(t('c.completed'), A.num(c.completed), 'circle-check', 'ok'),
        statCard(t('c.skipped'), A.num(c.skipped), 'skip-forward', 'warn'), statCard(t('c.cancelled'), A.num(c.cancelled), 'circle-x', 'bad'),
        statCard(t('c.avgWait'), A.min(c.avgWaitMin), 'clock'), statCard(t('c.avgService'), A.min(c.avgServiceMin), 'clock')
      ]));
      out.appendChild(h('div', { class: 'adm-grid2' },
        A.card(t('d.hourly'), A.barChart(d.hourly.map(function (x) { return { label: String(x.hour), values: [x.issued] }; }), [{ name: t('c.issued') }], { ariaLabel: t('d.hourly'), labelEvery: 2, legend: false })),
        A.card(t('d.last7'), A.barChart(d.last7Days.map(function (x) { return { label: x.date.slice(5), values: [x.issued, x.completed] }; }), [{ name: t('c.issued') }, { name: t('c.completed') }], { ariaLabel: t('d.last7') }))));
      out.appendChild(A.card(t('d.services'), A.table([
        { label: t('q.service'), render: function (s) { return h('strong', null, s.prefix + ' · ' + A.name({ nameAr: s.name_ar, nameEn: s.name_en })); } },
        { label: t('c.issued'), key: 'issued', class: 'qm-num' }, { label: t('c.waiting'), key: 'waiting', class: 'qm-num' }, { label: t('c.inService'), key: 'inService', class: 'qm-num' },
        { label: t('c.completed'), key: 'completed', class: 'qm-num' }, { label: t('c.skipped'), key: 'skipped', class: 'qm-num' }, { label: t('c.cancelled'), key: 'cancelled', class: 'qm-num' },
        { label: t('c.avgWait'), render: function (s) { return A.min(s.avgWaitMin); } }, { label: t('c.avgService'), render: function (s) { return A.min(s.avgServiceMin); } }
      ], d.services)));
      out.appendChild(A.card(t('d.counters'), A.table([
        { label: t('q.counter'), render: function (c) { return h('strong', null, c.number + ' · ' + A.name({ nameAr: c.name_ar, nameEn: c.name_en })); } },
        { label: t('f.active'), render: function (c) { return A.activeBadge(c.isActive); } },
        { label: t('c.served'), key: 'served', class: 'qm-num' }, { label: t('c.avgService'), render: function (c) { return A.min(c.avgServiceMin); } },
        { label: t('c.current'), render: function (c) { return c.currentTicket ? h('span', { class: 'qm-num' }, c.currentTicket) : '—'; } }
      ], d.counters)));
    }
    out.appendChild(A.loading());
    load();
    timer = setInterval(function () { if (document.visibilityState === 'visible') load(); }, 15000);
    return function () { alive = false; clearInterval(timer); };
  } };
})();
