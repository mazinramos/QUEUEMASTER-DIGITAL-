/* القشرة: تسجيل الدخول، تغيير كلمة المرور الإجباري، التنقل (hash)، الصلاحيات، اللغة. */
(function () {
  var A = QM.admin; var h = A.h; var t = A.t; var api = A.api;
  var app = document.getElementById('app');
  var RANK = { staff: 1, manager: 2, admin: 3 };
  var NAV = [
    { id: 'dashboard', icon: 'house', role: 'manager' }, { id: 'queue', icon: 'ticket', role: 'manager' }, { id: 'ads', icon: 'megaphone', role: 'manager' },
    { id: 'reports', icon: 'list', role: 'manager' }, { id: 'clinic', icon: 'hospital', role: 'manager' }, { id: 'services', icon: 'stethoscope', role: 'manager' },
    { id: 'counters', icon: 'hash', role: 'manager' }, { id: 'staff', icon: 'users', role: 'admin' }, { id: 'displays', icon: 'bell', role: 'admin' },
    { id: 'integrations', icon: 'refresh-cw', role: 'manager' }, { id: 'audit', icon: 'history', role: 'admin' }
  ];
  var cleanup = null; var view = 'login'; var mainEl = null;

  function can(role) { return A.state.me && RANK[A.state.me.role] >= RANK[role]; }
  function langSwitch() {
    return h('div', { class: 'qm-lang', role: 'group', 'aria-label': t('common.language') }, h('button', { type: 'button', 'data-lang': 'ar', 'aria-pressed': QM.i18n.lang === 'ar' ? 'true' : 'false' }, 'العربية'), h('button', { type: 'button', 'data-lang': 'en', 'aria-pressed': QM.i18n.lang === 'en' ? 'true' : 'false' }, 'EN'));
  }

  /* ---------- تسجيل الدخول ---------- */
  function showLogin(message) {
    A.clear(app); document.title = t('a.signin') + ' — QueueMaster';
    var u = A.f.text(t('a.username'), { required: true, dir: 'ltr', autocomplete: 'username' }); var p = A.f.text(t('a.password'), { type: 'password', required: true, autocomplete: 'current-password', dir: 'ltr' });
    var err = h('div', { class: 'qm-error-text', role: 'alert', hidden: !message }, message || '');
    var submit = A.btn(t('a.signin'), { type: 'submit', kind: 'navy', onClick: null });
    var form = h('form', { class: 'adm-form', novalidate: true }, u.el, p.el, err, submit);
    form.addEventListener('submit', async function (e) {
      e.preventDefault(); err.hidden = true;
      if (!u.get().trim() || !p.get()) { err.textContent = t('f.required'); err.hidden = false; return; }
      submit.disabled = true; submit.setAttribute('aria-busy', 'true');
      try {
        var d = await api.post('/api/auth/login', { username: u.get().trim().toLowerCase(), password: p.get() }, { csrf: true, silent401: true });
        api.resetCsrf(); A.state.me = d.staff; start();
      } catch (ex) { err.textContent = ex.code === 'UNAUTHENTICATED' ? t('a.login.err') : A.err(ex); err.hidden = false; submit.disabled = false; submit.removeAttribute('aria-busy'); p.input.value = ''; p.input.focus(); }
    });
    app.appendChild(h('main', { class: 'adm-login' }, h('div', { class: 'adm-login__top' }, langSwitch()),
      h('div', { class: 'qm-card adm-login__card' }, h('div', { class: 'adm-brand' }, A.icon('hospital', 28), h('span', null, 'QueueMaster')), h('h1', { class: 'adm-h1' }, t('a.title')), form)));
    u.input.focus();
  }

  function showChangePassword() {
    A.clear(app); view = 'changepw';
    var cur = A.f.text(t('a.curpw'), { type: 'password', required: true, autocomplete: 'current-password', dir: 'ltr' }); var nw = A.f.text(t('a.newpw'), { type: 'password', required: true, autocomplete: 'new-password', dir: 'ltr', max: 128 });
    var err = h('div', { class: 'qm-error-text', role: 'alert', hidden: true });
    var form = h('form', { class: 'adm-form', novalidate: true }, h('div', { class: 'qm-banner qm-banner--warn' }, h('div', { class: 'qm-banner__body' }, t('a.mustchange'))), cur.el, nw.el, err);
    var btn = A.btn(t('a.changepw'), { kind: 'navy', onClick: async function () {
      err.hidden = true;
      try { await api.post('/api/auth/change-password', { currentPassword: cur.get(), newPassword: nw.get() }, { csrf: true }); A.toast(t('f.saved'), 'ok'); var me = await api.get('/api/auth/me'); A.state.me = me.staff; start(); }
      catch (ex) { err.textContent = A.err(ex); err.hidden = false; }
    } });
    form.addEventListener('submit', function (e) { e.preventDefault(); btn.click(); });
    form.appendChild(btn);
    app.appendChild(h('main', { class: 'adm-login' }, h('div', { class: 'adm-login__top' }, langSwitch()), h('div', { class: 'qm-card adm-login__card' }, h('h1', { class: 'adm-h1' }, t('a.changepw')), form)));
  }

  async function logout() { try { await api.post('/api/auth/logout', {}, { csrf: true }); } catch (e) { /* الجلسة منتهية أصلاً */ } api.resetCsrf(); A.state.me = null; if (cleanup) { cleanup(); cleanup = null; } showLogin(); }

  /* ---------- الهيكل + التوجيه ---------- */
  function routeName() { var m = /^#\/([a-z-]+)/.exec(location.hash); return m ? m[1] : 'dashboard'; }
  function shell() {
    A.clear(app);
    var me = A.state.me;
    var nav = h('nav', { class: 'adm-nav', 'aria-label': t('a.title') }, NAV.filter(function (n) { return can(n.role); }).map(function (n) {
      return h('a', { href: '#/' + n.id, class: 'adm-nav__link', 'data-view': n.id, 'aria-current': n.id === view ? 'page' : null }, A.icon(n.icon), h('span', null, t('nav.' + n.id)));
    }));
    mainEl = h('main', { class: 'adm-main', id: 'main', tabindex: '-1' });
    app.appendChild(h('div', { class: 'adm-shell' },
      h('aside', { class: 'adm-side' }, h('div', { class: 'adm-brand' }, A.icon('hospital', 26), h('span', null, 'QueueMaster')), nav),
      h('div', { class: 'adm-content' },
        h('header', { class: 'adm-top' }, h('div', { class: 'adm-who' }, h('strong', null, me.fullName), h('span', { class: 'qm-hint' }, t('a.role.' + me.role))), h('div', { class: 'adm-top__actions' }, langSwitch(), A.btn(t('a.signout'), { sm: true, kind: 'secondary', icon: 'log-out', onClick: logout }))),
        mainEl)));
  }
  async function route() {
    if (!A.state.me) return;
    var name = routeName(); var def = A.views[name]; var nav = NAV.filter(function (n) { return n.id === name; })[0];
    if (cleanup) { try { cleanup(); } catch (e) { /* ignore */ } cleanup = null; }
    view = name;
    Array.prototype.forEach.call(document.querySelectorAll('.adm-nav__link'), function (a) { if (a.getAttribute('data-view') === name) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
    A.clear(mainEl);
    if (!def || !nav) { mainEl.appendChild(h('p', { class: 'adm-empty' }, t('a.notfound'))); return; }
    document.title = t('nav.' + name) + ' — QueueMaster';
    if (!can(def.role)) { mainEl.appendChild(h('div', { class: 'qm-banner qm-banner--error', role: 'alert' }, h('div', { class: 'qm-banner__body' }, t('a.forbidden')))); return; }
    var token = {}; route.token = token;
    try { var c = await def.render(mainEl); if (route.token === token) cleanup = typeof c === 'function' ? c : null; else if (typeof c === 'function') c(); }
    catch (e) { A.clear(mainEl); mainEl.appendChild(A.errorBox(e, route)); }
  }

  function start() {
    var me = A.state.me;
    if (me.mustChangePassword) return showChangePassword();
    if (RANK[me.role] < RANK.manager) { A.clear(app); app.appendChild(h('main', { class: 'adm-login' }, h('div', { class: 'qm-card adm-login__card' }, h('p', null, t('a.forbidden')), A.btn(t('a.signout'), { kind: 'secondary', onClick: logout })))); return; }
    shell(); route();
  }
  window.addEventListener('hashchange', route);
  QM.i18n.onChange(function () { if (!A.state.me) showLogin(); else if (A.state.me.mustChangePassword) showChangePassword(); else { shell(); route(); } });
  QM.bindLangSwitch(QM.i18n);
  api.onUnauthenticated(function () { if (A.state.me) { A.state.me = null; if (cleanup) { cleanup(); cleanup = null; } showLogin(t('err.UNAUTHENTICATED')); } });

  (async function boot() {
    try { var d = await api.get('/api/auth/me', { silent401: true }); A.state.me = d.staff; start(); }
    catch (e) { if (e && e.code === 'UNAUTHENTICATED') showLogin(); else { A.clear(app); app.appendChild(h('main', { class: 'adm-login' }, A.errorBox(e, function () { location.reload(); }))); } }
  })();
})();
