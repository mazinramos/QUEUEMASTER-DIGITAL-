/* الطابور (ح2): قائمة التذاكر مع تصفية، سجل أحداث التذكرة، إلغاء بسبب، وتصفير اليوم بتأكيد كتابي. */
(function () {
  var A = QM.admin; var h = A.h; var t = A.t; var api = A.api;
  A.views = A.views || {};
  var STATUSES = ['waiting', 'called', 'serving', 'completed', 'skipped', 'cancelled'];
  var EVENT_KEY = { created: 'ev.created', issued: 'ev.created', called: 'ev.called', recalled: 'ev.recalled', serving: 'ev.serving', started: 'ev.serving', completed: 'ev.completed', skipped: 'ev.skipped', returned: 'ev.returned', cancelled: 'ev.cancelled', transferred: 'ev.transferred' };

  A.views.queue = { role: 'manager', render: async function (root) {
    var services = await api.get('/api/admin/services').catch(function () { return []; });
    var st = { date: A.today(), serviceId: '', status: '', q: '', page: 1 };
    var out = h('div');
    var dateIn = h('input', { type: 'date', class: 'qm-input adm-date', value: st.date, 'aria-label': t('d.date') });
    var svcSel = h('select', { class: 'qm-input adm-select', 'aria-label': t('q.service') }, [h('option', { value: '' }, t('f.all'))].concat(services.map(function (s) { return h('option', { value: s.id }, s.prefix + ' · ' + A.name(s)); })));
    var stSel = h('select', { class: 'qm-input adm-select', 'aria-label': t('q.status') }, [h('option', { value: '' }, t('f.all'))].concat(STATUSES.map(function (s) { return h('option', { value: s }, t('status.' + s)); })));
    var qIn = h('input', { type: 'search', class: 'qm-input adm-search', placeholder: t('q.search'), 'aria-label': t('q.search'), dir: 'ltr' });
    var reset = A.btn(t('q.reset'), { kind: 'danger', sm: true, onClick: resetDay });
    root.appendChild(A.pageHead(t('q.title'), [reset]));
    root.appendChild(h('div', { class: 'adm-filters' }, dateIn, svcSel, stSel, qIn));
    root.appendChild(h('div', { class: 'qm-card adm-section' }, out));
    var tm;
    dateIn.addEventListener('change', function () { st.date = dateIn.value || A.today(); st.page = 1; load(); });
    svcSel.addEventListener('change', function () { st.serviceId = svcSel.value; st.page = 1; load(); });
    stSel.addEventListener('change', function () { st.status = stSel.value; st.page = 1; load(); });
    qIn.addEventListener('input', function () { clearTimeout(tm); tm = setTimeout(function () { st.q = qIn.value.trim(); st.page = 1; load(); }, 300); });

    async function load() {
      A.clear(out); out.appendChild(A.loading());
      try {
        var d = await api.get('/api/admin/tickets', { query: { date: st.date, serviceId: st.serviceId, status: st.status, q: st.q, page: st.page } });
        A.clear(out);
        out.appendChild(h('p', { class: 'qm-hint' }, t('q.total', { n: A.num(d.total) })));
        out.appendChild(A.table([
          { label: t('q.number'), render: function (r) { return h('strong', { class: 'qm-num' }, r.number); } },
          { label: t('q.service'), render: function (r) { return r.service ? r.service.prefix + ' · ' + A.name({ nameAr: r.service.name_ar, nameEn: r.service.name_en }) : '—'; } },
          { label: t('q.status'), render: function (r) { return A.badge(t('status.' + r.status), r.status); } },
          { label: t('q.counter'), render: function (r) { return r.counter ? h('span', { class: 'qm-num' }, r.counter.number) : '—'; } },
          { label: t('q.issued'), render: function (r) { return i18nTime(r.issuedAt); } }, { label: t('q.called'), render: function (r) { return i18nTime(r.calledAt); } },
          { label: t('f.actions'), render: function (r) { return h('div', { class: 'adm-rowactions' },
            A.btn(t('q.events'), { sm: true, kind: 'secondary', icon: 'history', onClick: function () { return showEvents(r); } }),
            ['waiting', 'called', 'serving'].indexOf(r.status) >= 0 ? A.btn(t('q.cancel'), { sm: true, kind: 'danger', onClick: function () { return cancel(r); } }) : null); } }
        ], d.items));
        var pages = Math.max(1, Math.ceil(d.total / d.pageSize));
        if (pages > 1) out.appendChild(A.pager(d.page, pages, function (p) { st.page = p; load(); }));
      } catch (e) { A.clear(out); out.appendChild(A.errorBox(e, load)); }
    }
    function i18nTime(iso) { return iso ? QM.i18n.fmtTime(iso) : '—'; }

    async function showEvents(tk) {
      var d = await api.get('/api/admin/tickets/' + encodeURIComponent(tk.publicId) + '/events');
      var list = d.events.length ? h('ol', { class: 'adm-timeline' }, d.events.map(function (e) {
        return h('li', null, h('strong', null, t(EVENT_KEY[e.type] || '', null) === (EVENT_KEY[e.type] || '') ? e.type : t(EVENT_KEY[e.type])), ' ', h('span', { class: 'qm-hint' }, QM.i18n.fmtTime(e.at)),
          e.staff ? h('div', { class: 'qm-hint' }, t('q.by') + ' ' + e.staff.name) : null, e.counter ? h('div', { class: 'qm-hint' }, t('q.counter') + ' ' + e.counter) : null,
          e.meta && e.meta.reason ? h('div', { class: 'qm-hint' }, String(e.meta.reason)) : null);
      })) : h('p', { class: 'qm-hint' }, t('q.noEvents'));
      A.dialog(t('q.events') + ' — ' + tk.number, list, [{ label: t('f.close'), onClick: function () { return true; } }]);
    }
    function cancel(tk) {
      var reason = A.f.text(t('q.reason'), { max: 200 });
      A.dialog(t('q.cancel') + ' — ' + tk.number, reason.el, [{ label: t('f.cancel'), kind: 'secondary', onClick: function () { return true; } }, { label: t('q.cancel'), kind: 'danger', onClick: async function () {
        await api.post('/api/admin/tickets/' + encodeURIComponent(tk.publicId) + '/cancel', { reason: reason.get().trim() || undefined }, { csrf: true });
        A.toast(t('q.cancelled'), 'ok'); load(); return true; } }]);
    }
    function resetDay() {
      var word = t('q.resetWord'); var inp = A.f.text(t('q.resetType', { w: word }), { autocomplete: 'off' });
      A.dialog(t('q.reset'), h('div', { class: 'adm-form' }, h('div', { class: 'qm-banner qm-banner--warn' }, h('div', { class: 'qm-banner__body' }, t('q.resetWarn'))), inp.el), [{ label: t('f.cancel'), kind: 'secondary', onClick: function () { return true; } }, { label: t('q.reset'), kind: 'danger', onClick: async function (ctx) {
        if (inp.get().trim() !== word) { ctx.error(t('q.resetType', { w: word })); return false; }
        var r = await api.post('/api/admin/queue/reset-day', { confirm: true }, { csrf: true });
        A.toast(t('q.resetDone', { n: A.num(r && (r.cancelled != null ? r.cancelled : r.count) || 0) }), 'ok'); load(); return true; } }]);
    }
    load();
  } };
})();
