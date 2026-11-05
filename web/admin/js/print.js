/* صفحة طباعة التقارير: print.html?report=daily&from=&to=&serviceId= . تعرض ترويسة العيادة والفترة ثم تفتح نافذة الطباعة بزر. */
(function () {
  var A = QM.admin; var h = A.h; var t = A.t; var app = document.getElementById('app');
  var NAMES = ['summary', 'daily', 'weekly', 'monthly', 'services', 'waiting-times', 'staff'];
  var p = new URLSearchParams(location.search); var name = p.get('report');
  async function run() {
    A.clear(app);
    if (NAMES.indexOf(name) < 0) { app.appendChild(h('p', { class: 'adm-empty' }, t('a.notfound'))); return; }
    app.appendChild(A.loading());
    try {
      var q = A.reportQuery({ from: p.get('from'), to: p.get('to'), serviceId: p.get('serviceId') });
      var res = await Promise.all([A.api.get('/api/admin/reports/' + name, { query: q }), A.api.get('/api/admin/clinic')]);
      var r = res[0]; var c = res[1]; A.clear(app);
      document.title = t('rp.' + name) + ' — ' + A.name(c);
      app.appendChild(h('div', { class: 'adm-print__bar' }, A.btn(t('rp.print'), { icon: 'printer', onClick: function () { window.print(); } }), h('div', { class: 'qm-lang', role: 'group' }, h('button', { type: 'button', 'data-lang': 'ar' }, 'العربية'), h('button', { type: 'button', 'data-lang': 'en' }, 'EN'))));
      app.appendChild(h('header', { class: 'adm-print__head' }, h('h1', null, A.name(c)), h('h2', null, t('rp.' + name)),
        h('p', { class: 'qm-hint' }, (r.from ? t('rp.from') + ' ' + r.from + ' ' + t('rp.to') + ' ' + r.to : '') + ' · ' + A.dt(new Date().toISOString(), c.timezone))));
      app.appendChild(A.renderReport(name, r));
    } catch (e) {
      A.clear(app);
      if (e && e.code === 'UNAUTHENTICATED') app.appendChild(h('div', { class: 'qm-banner qm-banner--error' }, h('div', { class: 'qm-banner__body' }, t('err.UNAUTHENTICATED'), ' '), h('a', { href: 'index.html' }, t('a.signin'))));
      else app.appendChild(A.errorBox(e, run));
    }
  }
  QM.bindLangSwitch(QM.i18n); QM.i18n.onChange(run);
  run();
})();
