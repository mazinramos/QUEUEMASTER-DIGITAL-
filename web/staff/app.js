/* QueueMaster staff console: login -> counter -> live desk (call/recall/start/complete/skip/return/cancel/transfer, lookup + QR scan). */
(function () {
  'use strict';
  var esc = QM.esc, toast = QM.toast, modal = QM.modal, i18n = QM.i18n, t = i18n.t.bind(i18n), L = QM.staffLogic, api = QM.api, ic = QM.icon;
  var ls = null; try { ls = window.localStorage; } catch (e) {}
  var $app = document.getElementById('app'), $head = document.getElementById('st-header');
  var S = { view: 'boot', staff: null, counter: null, state: null, lookup: null, lookupErr: null, busy: null, loginErr: null, pwErr: null, stale: false, lastOk: null, svcFilter: '', showPass: false, lookupBusy: false };

  var ICONS = { 'call-next': 'megaphone', recall: 'bell-ring', start: 'play', complete: 'square-check', skip: 'skip-forward', 'return': 'undo-2', cancel: 'ban', transfer: 'arrow-right-left' };
  function counterKey() { return 'qm.staff.counter.' + (S.staff && S.staff.id); }
  function saveCounter(id) { try { ls && ls.setItem(counterKey(), String(id)); } catch (e) {} }
  function savedCounter() { try { var v = ls && ls.getItem(counterKey()); return v ? Number(v) : null; } catch (e) { return null; } }
  function cname(c) { if (!c) return ''; var n = c.number; var nm = i18n.pick(c, 'name'); return nm && n != null && nm.indexOf(String(n)) >= 0 ? nm : (n != null ? t('s.counter.n', { n: n }) : nm); }
  function svcName(s) { return s ? (i18n.pick(s, 'name') || '') : ''; }
  function minText(n) { return n == null ? t('common.none') : t('s.stats.min', { n: i18n.fmtNumber(n) }); }
  function errBanner(msg) { return msg ? '<div class="qm-banner qm-banner--error" role="alert">' + ic('circle-alert', { size: 20 }) + '<div class="qm-banner__body">' + esc(msg) + '</div></div>' : ''; }
  function infoBanner(msg, kind) { return msg ? '<div class="qm-banner qm-banner--' + (kind || 'info') + '" role="status">' + ic('info', { size: 20 }) + '<div class="qm-banner__body">' + esc(msg) + '</div></div>' : ''; }
  function defaultCounterId() { return S.staff && S.staff.counter ? S.staff.counter.id : null; }

  /* ------------------------------------------------------------------ views */
  function langSwitch() { return '<div class="qm-lang" role="group" aria-label="Language / اللغة"><button type="button" data-lang="ar" lang="ar">العربية</button><button type="button" data-lang="en" lang="en">EN</button></div>'; }

  function loginView() {
    return '<form class="st-login qm-card" id="login-form" novalidate><div class="st-login__top">' + langSwitch() + '</div><h1 class="st-h1" tabindex="-1">' + esc(t('s.login.title')) + '</h1>' + errBanner(S.loginErr) +
      '<div class="qm-field"><label class="qm-label" for="lg-user">' + esc(t('s.login.user')) + '</label><input class="qm-input qm-latin" id="lg-user" data-keep name="username" autocomplete="username" autocapitalize="none" spellcheck="false" dir="ltr" required></div>' +
      '<div class="qm-field"><label class="qm-label" for="lg-pass">' + esc(t('s.login.pass')) + '</label><div class="st-pass"><input class="qm-input qm-latin" id="lg-pass" data-keep name="password" type="' + (S.showPass ? 'text' : 'password') + '" autocomplete="current-password" dir="ltr" required>' +
      '<button type="button" data-act="toggle-pass" aria-pressed="' + S.showPass + '" aria-label="' + esc(t('s.login.show')) + '">' + ic(S.showPass ? 'eye-off' : 'eye', { size: 20 }) + '</button></div></div>' +
      '<button class="qm-btn qm-btn--lg qm-btn--block" type="submit" ' + (S.busy === 'login' ? 'disabled aria-busy="true"' : '') + '>' + (S.busy === 'login' ? '<span class="qm-spinner"></span>' : ic('log-in', { size: 22 })) + esc(t('s.login.submit')) + '</button></form>';
  }
  function passwordView() {
    return '<form class="st-login qm-card" id="pw-form" novalidate><div class="st-login__top">' + langSwitch() + '</div><h1 class="st-h1" tabindex="-1">' + esc(t('s.pw.title')) + '</h1>' + infoBanner(t('s.pw.hint'), 'warn') + errBanner(S.pwErr) +
      '<div class="qm-field"><label class="qm-label" for="pw-cur">' + esc(t('s.pw.current')) + '</label><input class="qm-input" id="pw-cur" data-keep type="password" autocomplete="current-password" dir="ltr"></div>' +
      '<div class="qm-field"><label class="qm-label" for="pw-new">' + esc(t('s.pw.new')) + '</label><input class="qm-input" id="pw-new" data-keep type="password" autocomplete="new-password" dir="ltr"></div>' +
      '<div class="qm-field"><label class="qm-label" for="pw-new2">' + esc(t('s.pw.confirm')) + '</label><input class="qm-input" id="pw-new2" data-keep type="password" autocomplete="new-password" dir="ltr"></div>' +
      '<button class="qm-btn qm-btn--lg qm-btn--block" type="submit" ' + (S.busy === 'pw' ? 'disabled aria-busy="true"' : '') + '>' + esc(t('s.pw.submit')) + '</button></form>';
  }
  function counterView() {
    var opts = L.counterOptions(S.staff);
    if (!opts.length) return '<div class="st-login qm-card"><h1 class="st-h1" tabindex="-1">' + esc(t('s.counter.title')) + '</h1>' + infoBanner(t('s.counter.none'), 'warn') + '<button class="qm-btn qm-btn--secondary" data-act="logout">' + esc(t('s.logout')) + '</button></div>';
    return '<div class="st-login"><div><h1 class="st-h1" tabindex="-1">' + esc(t('s.counter.title')) + '</h1><p class="qm-hint">' + esc(t('s.counter.sub')) + '</p></div>' +
      opts.map(function (c) { return '<button class="st-counter-btn" data-act="pick-counter" data-id="' + esc(c.id) + '">' + ic('hash', { size: 24 }) + esc(cname(c)) + '</button>'; }).join('') + '</div>';
  }

  function btn(act, ctx, o) {
    o = o || {}; var busy = S.busy === act + ':' + ctx, dis = !!S.busy;
    var cls = 'qm-btn' + (o.lg ? ' qm-btn--lg' : '') + (o.kind ? ' qm-btn--' + o.kind : '') + (o.sm ? ' qm-btn--sm' : '');
    return '<button type="button" class="' + cls + '" data-act="do" data-id="' + esc(act) + '" data-ctx="' + esc(ctx) + '" ' + (dis ? 'disabled' : '') + (busy ? ' aria-busy="true"' : '') + '>' +
      (busy ? '<span class="qm-spinner"></span>' : ic(ICONS[act] || 'check', { size: o.lg ? 24 : 20 })) + esc(t('s.act.' + act)) + '</button>';
  }
  function actionButtons(ticket, ctx) {
    var acts = L.availableActions(ticket, S.staff, S.counter), primary = { called: 'start', serving: 'complete', skipped: 'return' }[ticket.status];
    var out = '';
    if (primary && acts.indexOf(primary) >= 0) out += btn(primary, ctx, { lg: true });
    acts.forEach(function (a) { if (a !== primary) out += btn(a, ctx, { kind: a === 'cancel' ? 'danger' : 'secondary' }); });
    return out;
  }

  function currentCard() {
    var cur = S.state.current, st = S.state.stats || {}, svcs = (S.staff.services || []);
    if (!cur) {
      var filter = svcs.length > 1 ? '<div class="qm-field"><label class="qm-label" for="svc-filter">' + esc(t('s.svc.filter')) + '</label><select class="qm-input st-select" id="svc-filter" data-keep><option value="">' + esc(t('s.svc.all')) + '</option>' +
        svcs.map(function (s) { return '<option value="' + esc(s.id) + '"' + (String(S.svcFilter) === String(s.id) ? ' selected' : '') + '>' + esc(svcName(s)) + '</option>'; }).join('') + '</select></div>' : '';
      return '<section class="qm-card st-cur" aria-labelledby="cur-h"><div class="st-cur__head"><h2 id="cur-h" class="st-h2" style="margin:0">' + esc(t('s.cur.title')) + '</h2></div><div class="st-cur__num st-cur__num--empty" aria-label="' + esc(t('s.cur.none')) + '">—</div>' +
        (svcs.length ? filter + '<button type="button" class="qm-btn qm-btn--lg qm-btn--block" data-act="do" data-id="call-next" data-ctx="current" ' + (S.busy ? 'disabled' : '') + (S.busy === 'call-next:current' ? ' aria-busy="true"' : '') + '>' +
        (S.busy === 'call-next:current' ? '<span class="qm-spinner"></span>' : ic('megaphone', { size: 26 })) + esc(t('s.act.call-next')) + '</button>' : infoBanner(t('s.noService'), 'warn')) + '</section>';
    }
    var since = cur.status === 'serving' ? (cur.servingAt || cur.calledAt) : cur.calledAt;
    return '<section class="qm-card st-cur" aria-labelledby="cur-h"><div class="st-cur__head"><h2 id="cur-h" class="st-h2" style="margin:0">' + esc(t('s.cur.title')) + '</h2><span class="qm-badge qm-badge--' + esc(cur.status) + '">' + esc(t('status.' + cur.status)) + '</span></div>' +
      '<div class="st-cur__num" id="cur-num">' + esc(cur.number) + '</div><div class="st-cur__meta"><span>' + esc(svcName(cur.service)) + '</span>' + (since ? '<span aria-hidden="true">·</span><span>' + esc(t('s.cur.since')) + ' <span class="st-timer" data-since="' + esc(since) + '">' + esc(L.elapsed(since)) + '</span></span>' : '') + '</div>' +
      '<div class="st-actions">' + actionButtons(cur, 'current') + '</div></section>';
  }

  function resultCard() {
    var r = S.lookup; if (!r) return '';
    var mine = L.sameCounter(r.counter, S.counter), counterTxt = r.counter ? cname(r.counter) : '';
    var note = (r.status === 'called' || r.status === 'serving') && r.counter && !mine ? infoBanner(t('s.lookup.other', { counter: counterTxt }), 'warn') : '';
    var warn = (r.isToday === false ? infoBanner(t('s.verify.notToday'), 'warn') : '') + (r.authorizedForService === false ? infoBanner(t('s.verify.notAuthorized'), 'warn') : '');
    var acts = actionButtons(r, 'lookup');
    return '<div class="st-result" id="lookup-result"><div class="st-result__top"><span class="st-result__num">' + esc(r.number) + '</span><span class="qm-badge qm-badge--' + esc(r.status) + '">' + esc(t('status.' + r.status)) + '</span></div>' +
      warn + '<div class="qm-hint">' + esc(svcName(r.service)) + (counterTxt ? ' · ' + esc(t('s.lookup.at', { counter: counterTxt })) : '') + (r.issuedAt ? ' · ' + esc(i18n.fmtTime(r.issuedAt)) : '') + '</div>' + note +
      (acts ? '<div class="st-actions">' + acts + '</div>' : '') + '<button type="button" class="qm-btn qm-btn--ghost qm-btn--sm" data-act="clear-lookup">' + esc(t('s.lookup.clear')) + '</button></div>';
  }
  function lookupCard() {
    return '<section class="qm-card st-lookup" aria-labelledby="lk-h"><h2 id="lk-h" class="st-h2" style="margin:0">' + esc(t('s.lookup.title')) + '</h2>' +
      '<div class="st-lookup__row"><input class="qm-input qm-latin" id="lookup-input" data-keep dir="ltr" autocomplete="off" autocapitalize="characters" placeholder="' + esc(t('s.lookup.ph')) + '" aria-label="' + esc(t('s.lookup.title')) + '">' +
      '<button type="button" class="qm-btn" data-act="lookup" ' + (S.lookupBusy ? 'disabled aria-busy="true"' : '') + ' aria-label="' + esc(t('s.lookup.go')) + '">' + ic('search', { size: 20 }) + '<span>' + esc(t('s.lookup.go')) + '</span></button>' +
      '<button type="button" class="qm-btn qm-btn--secondary" data-act="scan" aria-label="' + esc(t('s.lookup.scan')) + '">' + ic('scan-line', { size: 20 }) + '</button></div>' + errBanner(S.lookupErr) + resultCard() + '</section>';
  }
  function waited(x) { if (x.waitedMin != null) return x.waitedMin; var ms = Date.parse(x.issuedAt); return isNaN(ms) ? null : Math.max(0, Math.floor((Date.now() - ms) / 60000)); }
  function waitingCard() {
    var w = S.state.waiting || [];
    var rows = w.map(function (x) { return '<li><span class="st-list__num">' + esc(x.number) + '</span><span class="st-list__svc">' + esc(svcName(x.service)) + '</span>' +
      (waited(x) != null ? '<span class="st-list__wait">' + esc(t('s.wait.min', { n: i18n.fmtNumber(waited(x)) })) + '</span>' : '') + '</li>'; }).join('');
    return '<section class="qm-card" aria-labelledby="wl-h"><h2 id="wl-h" class="st-h2"><span>' + esc(t('s.wait.title')) + '</span><span class="qm-badge qm-badge--waiting">' + esc(i18n.fmtNumber(w.length)) + '</span></h2>' +
      (w.length ? '<ul class="st-list">' + rows + '</ul>' : '<p class="qm-hint">' + esc(t('s.wait.empty')) + '</p>') + '</section>';
  }
  function skippedCard() {
    var sk = S.state.skipped || []; if (!sk.length) return '';
    var p = L.perms(S.staff);
    return '<section class="qm-card" aria-labelledby="sk-h"><h2 id="sk-h" class="st-h2"><span>' + esc(t('s.skipped.title')) + '</span><span class="qm-badge qm-badge--skipped">' + esc(i18n.fmtNumber(sk.length)) + '</span></h2><ul class="st-list">' +
      sk.map(function (x) { return '<li><span class="st-list__num">' + esc(x.number) + '</span><span class="st-list__svc">' + esc(svcName(x.service)) + '</span>' + (p.skipReturn ? btn('return', 'sk:' + x.publicId, { sm: true, kind: 'secondary' }) : '') + '</li>'; }).join('') + '</ul></section>';
  }
  function deskView() {
    if (!S.state) return '<div style="text-align:center;padding:3rem"><span class="qm-spinner"></span><p class="qm-hint">' + esc(t('common.loading')) + '</p></div>';
    var st = S.state.stats || {};
    return '<h1 class="qm-sr-only st-h1" tabindex="-1">' + esc(t('s.title')) + '</h1><div class="st-stats"><div class="st-stat"><span class="st-stat__v" id="stat-waiting">' + esc(i18n.fmtNumber(st.waitingCount != null ? st.waitingCount : (S.state.waiting || []).length)) +
      '</span><span class="st-stat__l">' + esc(t('s.stats.waiting')) + '</span></div><div class="st-stat"><span class="st-stat__v" id="stat-avg">' + esc(minText(st.avgWaitMin)) + '</span><span class="st-stat__l">' + esc(t('s.stats.avg')) + '</span></div></div>' +
      '<div class="st-grid"><div class="st-col">' + currentCard() + lookupCard() + '</div><div class="st-col">' + waitingCard() + skippedCard() + '</div></div>';
  }
  var views = { boot: function () { return '<div style="text-align:center;padding:3rem"><span class="qm-spinner"></span></div>'; }, login: loginView, password: passwordView, counter: counterView, desk: deskView };

  function renderHeader() {
    if (!S.staff || S.view === 'login' || S.view === 'boot' || S.view === 'password') { $head.hidden = true; $head.innerHTML = ''; return; }
    $head.hidden = false;
    var sockOn = sc && sc.status === 'online';
    $head.innerHTML = '<div class="st-header__who">' + ic('user', { size: 22 }) + '<span class="st-header__name">' + esc(S.staff.fullName || S.staff.full_name || '') + '</span>' +
      (S.counter ? '<button type="button" class="st-chip" data-act="change-counter">' + ic('hash', { size: 18 }) + esc(cname(S.counter)) + (L.counterOptions(S.staff).length > 1 ? ic('chevron-down', { size: 16 }) : '') + '</button>' : '') + '</div>' +
      '<div class="st-header__tools"><span class="qm-conn qm-conn--' + (sockOn ? 'online' : 'offline') + '" title="' + esc(sockOn ? t('s.live.on') : t('s.live.poll')) + '"><i class="qm-conn__dot"></i><span>' + esc(sockOn ? t('s.live.on') : t('s.live.poll')) + '</span></span>' + langSwitch() +
      '<button type="button" class="st-hbtn" data-act="logout">' + ic('log-out', { size: 18 }) + '<span>' + esc(t('s.logout')) + '</span></button></div>';
    i18n.apply($head);
  }
  function renderConn() {
    var el = document.getElementById('conn-banner');
    el.innerHTML = S.stale ? '<div class="qm-banner qm-banner--warn">' + ic('wifi-off', { size: 20 }) + '<div class="qm-banner__body">' + esc(t('s.offline') + (S.lastOk ? ' ' + t('s.updated', { time: i18n.fmtTime(new Date(S.lastOk).toISOString()) }) : '')) + '</div>' +
      '<button type="button" class="qm-btn qm-btn--sm qm-btn--secondary" data-act="refresh">' + esc(t('common.retry')) + '</button></div>' : '';
  }
  function render(focusHeading) {
    var keep = {}, ae = document.activeElement;
    Array.prototype.forEach.call($app.querySelectorAll('[data-keep]'), function (el) { keep[el.id] = { v: el.value, f: el === ae, s: el.selectionStart, e: el.selectionEnd }; });
    var y = window.scrollY, listScroll = {}; Array.prototype.forEach.call($app.querySelectorAll('.st-list'), function (el, i) { listScroll[i] = el.scrollTop; });
    $app.innerHTML = views[S.view]();
    i18n.apply($app);
    Object.keys(keep).forEach(function (id) { var el = document.getElementById(id); if (!el) return; el.value = keep[id].v; if (keep[id].f) { el.focus(); try { el.setSelectionRange(keep[id].s, keep[id].e); } catch (e) {} } });
    Array.prototype.forEach.call($app.querySelectorAll('.st-list'), function (el, i) { if (listScroll[i]) el.scrollTop = listScroll[i]; });
    if (focusHeading) { var h = $app.querySelector('.st-h1'); if (h) h.focus({ preventScroll: true }); window.scrollTo(0, 0); } else window.scrollTo(0, y);
    renderHeader(); renderConn();
    document.title = (S.view === 'desk' && S.counter ? cname(S.counter) + ' — ' : '') + t('s.title');
  }

  /* ------------------------------------------------------------------ data */
  var sc = null, poller = null, refreshTimer = null, refreshing = false, timerInt = null;
  function normState(d) {
    return { counter: d.counter || S.counter, current: L.normalizeTicket(d.currentTicket || d.current), waiting: (d.waiting || []).map(L.normalizeTicket), skipped: (d.skipped || []).map(L.normalizeTicket),
      stats: d.stats || { waitingCount: (d.waiting || []).length, avgWaitMin: null } };
  }
  async function refreshState() {
    if (!S.staff || S.view !== 'desk' || refreshing) return; refreshing = true;
    var was = S.stale;
    try {
      var q = S.counter && S.counter.id !== defaultCounterId() ? { counterId: S.counter.id } : undefined;
      var d = await api.get('/api/queue/state', { query: q });
      S.state = normState(d); S.stale = false; S.lastOk = Date.now();
      if (S.lookup) await refreshLookup(true);
    } catch (e) {
      var c = L.classifyError(e);
      if (c.level === 'session') { refreshing = false; return sessionExpired(); }
      S.stale = true;
    }
    refreshing = false; if (S.view === 'desk') render(); if (was && !S.stale) toast(t('s.refreshed'), 'ok', 1800);
  }
  function scheduleRefresh() { clearTimeout(refreshTimer); refreshTimer = setTimeout(refreshState, 250); }
  async function refreshLookup(quiet) {
    if (!S.lookup) return;
    try { var d = await api.get('/api/queue/lookup', { query: { number: S.lookup.number }, silent401: true }); S.lookup = L.normalizeTicket(d); }
    catch (e) { if (e.code === 'NOT_FOUND') S.lookup = null; }
  }
  function startLive() {
    stopLive();
    sc = QM.createSocketClient({});
    sc.onStatus(function () { renderHeader(); });
    sc.onConnect(function () { refreshState(); });
    sc.on('*', function (p, ev) { if (/^(ticket|queue):/.test(ev)) scheduleRefresh(); });
    poller = QM.createPoller({ fn: refreshState, isOnline: function () { return !S.stale && sc && sc.status === 'online'; }, fastMs: 5000, slowMs: 20000 });
    poller.start(true);
    timerInt = setInterval(function () { Array.prototype.forEach.call(document.querySelectorAll('[data-since]'), function (el) { el.textContent = L.elapsed(el.getAttribute('data-since')); }); }, 1000);
  }
  function stopLive() { if (poller) poller.stop(); poller = null; if (sc) sc.close(); sc = null; clearInterval(timerInt); clearTimeout(refreshTimer); }

  /* ------------------------------------------------------------------ auth flow */
  function go(view) { S.view = view; render(true); }
  function sessionExpired() {
    if (!S.staff && S.view === 'login') return;
    stopLive(); api.resetCsrf(); S.staff = null; S.counter = null; S.state = null; S.lookup = null; S.busy = null; S.loginErr = t('s.login.expired'); go('login');
  }
  function afterAuth(staff) {
    S.staff = staff; S.loginErr = null; S.state = null; S.lookup = null; S.stale = false;
    if (staff.mustChangePassword || staff.must_change_password) return go('password');
    var c = L.pickCounter(staff, savedCounter());
    if (!c) return go('counter');
    S.counter = c; saveCounter(c.id); enterDesk();
  }
  function enterDesk() { S.view = 'desk'; render(true); startLive(); }
  async function login(form) {
    var u = document.getElementById('lg-user').value.trim(), p = document.getElementById('lg-pass').value;
    if (!u || !p) { S.loginErr = t('s.login.required'); render(); return; }
    S.busy = 'login'; S.loginErr = null; render();
    try { var d = await api.post('/api/auth/login', { username: u, password: p }, { csrf: true, silent401: true }); S.busy = null; if (d && d.csrfToken) api.setCsrf(d.csrfToken); afterAuth(d.staff || d); return; }
    catch (e) { S.loginErr = e.code === 'UNAUTHENTICATED' || e.status === 401 ? t('s.login.bad') : i18n.errorMessage(e); }
    S.busy = null; render();
  }
  async function changePassword() {
    var cur = document.getElementById('pw-cur').value, n1 = document.getElementById('pw-new').value, n2 = document.getElementById('pw-new2').value;
    if (n1.length < 8) { S.pwErr = t('s.pw.short'); render(); return; } if (n1 !== n2) { S.pwErr = t('s.pw.mismatch'); render(); return; }
    S.busy = 'pw'; S.pwErr = null; render();
    try { await api.post('/api/auth/change-password', { currentPassword: cur, newPassword: n1 }, { csrf: true }); var me = await api.get('/api/auth/me'); S.busy = null; me = me.staff || me; me.mustChangePassword = false; me.must_change_password = false; afterAuth(me); return; }
    catch (e) { S.pwErr = i18n.errorMessage(e); }
    S.busy = null; render();
  }
  async function logout() {
    var ok = await modal({ title: t('s.logout'), bodyHtml: '<p>' + esc(t('s.logout.confirm')) + '</p>', actions: [{ label: t('common.cancel'), kind: 'secondary', value: false }, { label: t('s.logout'), value: true }] });
    if (!ok) return;
    try { await api.post('/api/auth/logout', {}, { csrf: true, silent401: true }); } catch (e) {}
    stopLive(); api.resetCsrf(); S.staff = null; S.counter = null; S.state = null; S.lookup = null; S.loginErr = null; go('login');
  }
  async function changeCounter() {
    var opts = L.counterOptions(S.staff); if (opts.length < 2) return;
    if (S.state && S.state.current) { toast(t('s.counter.busy'), 'error'); return; }
    var picked = await modal({ title: t('s.counter.title'), bodyHtml: '<div class="pt-stack" style="display:grid;gap:.5rem">' + opts.map(function (c) { return '<button type="button" class="st-counter-btn" data-pick="' + esc(c.id) + '">' + esc(cname(c)) + '</button>'; }).join('') + '</div>',
      actions: [{ label: t('common.cancel'), kind: 'secondary', value: null }], onOpen: function (box, close) { box.addEventListener('click', function (e) { var b = e.target.closest('[data-pick]'); if (b) close(Number(b.getAttribute('data-pick'))); }); } });
    if (picked == null) return; var c = opts.filter(function (x) { return x.id === picked; })[0]; if (!c || (S.counter && c.id === S.counter.id)) return;
    S.counter = c; saveCounter(c.id); S.state = null; S.lookup = null; render(); refreshState();
  }

  /* ------------------------------------------------------------------ queue actions */
  function ticketFor(ctx, id) {
    if (ctx === 'current') return S.state && S.state.current; if (ctx === 'lookup') return S.lookup;
    if (ctx.indexOf('sk:') === 0) return ((S.state && S.state.skipped) || []).filter(function (x) { return x.publicId === ctx.slice(3); })[0];
    return null;
  }
  function handleError(e, ticketNumber) {
    var c = L.classifyError(e);
    if (c.level === 'session') return sessionExpired();
    if (c.level === 'info') toast(i18n.errorMessage(e), undefined, 4000); else toast(i18n.errorMessage(e), 'error');
    if (c.refresh) { refreshing = false; refreshState(); }
  }
  async function act(id, ctx) {
    if (S.busy) return; var ticket = id === 'call-next' ? null : ticketFor(ctx); if (id !== 'call-next' && !ticket) return;
    var body = {};
    if (id === 'skip') { var okSkip = await modal({ title: t('s.act.skip'), bodyHtml: '<p>' + esc(t('s.skip.confirm', { number: ticket.number })) + '</p>', actions: [{ label: t('common.cancel'), kind: 'secondary', value: false }, { label: t('s.act.skip'), value: true }] }); if (!okSkip) return; }
    if (id === 'cancel') {
      var reason = await modal({ title: t('s.cancel.title', { number: ticket.number }), bodyHtml: '<p>' + esc(t('s.cancel.sure')) + '</p><div class="qm-field" style="margin-top:.75rem"><label class="qm-label" for="cx-reason">' + esc(t('s.cancel.reason')) + '</label><input class="qm-input" id="cx-reason" maxlength="200" autocomplete="off"></div>',
        actions: [{ label: t('common.cancel'), kind: 'secondary', value: null }, { label: t('s.act.cancel'), kind: 'danger', collect: function (box) { return box.querySelector('#cx-reason').value.trim(); } }] });
      if (reason === null) return; if (reason) body.reason = reason;
    }
    if (id === 'transfer') {
      var targets = (S.staff.allServices || S.staff.services || []).filter(function (s) { return ticket.servicePrefix ? s.prefix !== ticket.servicePrefix : s.id !== ticket.serviceId; });
      if (!targets.length) { toast(t('s.transfer.none'), 'error'); return; }
      var sid = await modal({ title: t('s.transfer.title', { number: ticket.number }), bodyHtml: '<div class="qm-field"><label class="qm-label" for="tr-svc">' + esc(t('s.transfer.to')) + '</label><select class="qm-input st-select" id="tr-svc">' +
        targets.map(function (s) { return '<option value="' + esc(s.id) + '">' + esc(svcName(s)) + '</option>'; }).join('') + '</select></div>',
        actions: [{ label: t('common.cancel'), kind: 'secondary', value: null }, { label: t('s.act.transfer'), collect: function (box) { return Number(box.querySelector('#tr-svc').value); } }] });
      if (sid == null) return; body.serviceId = sid;
    }
    S.busy = id + ':' + ctx; render();
    try {
      var res;
      if (id === 'call-next') { var cb = { counterId: S.counter.id }; if (S.svcFilter) cb.serviceId = Number(S.svcFilter); res = await api.post('/api/queue/call-next', cb, { csrf: true }); }
      else res = await api.post('/api/queue/tickets/' + encodeURIComponent(ticket.publicId) + '/' + id, body, { csrf: true });
      var rt = L.normalizeTicket(res && (res.ticket || res)); var num = (rt && rt.number) || (ticket && ticket.number) || '';
      toast(t('s.done.' + id, { number: num }), 'ok', 2500);
      if (ctx === 'lookup' && S.lookup) { S.lookup = rt && rt.publicId === S.lookup.publicId ? Object.assign({}, S.lookup, rt) : S.lookup; }
    } catch (e) { S.busy = null; render(); handleError(e); return; }
    S.busy = null; refreshing = false; await refreshState(); render();
  }

  /* ------------------------------------------------------------------ lookup + QR scan */
  async function doLookup(raw) {
    var p = L.parseScan(raw); S.lookupErr = null;
    if (!p) { S.lookupErr = t('s.lookup.bad'); render(); return; }
    S.lookupBusy = true; render();
    try {
      var d = p.token ? await api.post('/api/queue/verify', { token: p.token }, { csrf: true }) : await api.get('/api/queue/lookup', { query: { number: p.number } });
      S.lookup = L.normalizeTicket(d); var inp = document.getElementById('lookup-input'); if (inp) inp.value = '';
    } catch (e) { S.lookup = null; if (L.classifyError(e).level === 'session') { S.lookupBusy = false; return sessionExpired(); } S.lookupErr = i18n.errorMessage(e); }
    S.lookupBusy = false; render();
  }
  function loadJsQR() {
    if (window.jsQR) return Promise.resolve(window.jsQR);
    return new Promise(function (res, rej) { var s = document.createElement('script'); s.src = '../shared/vendor/jsQR.js'; s.onload = function () { res(window.jsQR); }; s.onerror = rej; document.head.appendChild(s); });
  }
  async function scan() {
    var hasCam = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia), secure = window.isSecureContext;
    var stream = null, stopped = false, loopTimer = null, hint = '';
    if (!hasCam || !secure) hint = t('s.scan.insecure');
    var body = '<div class="st-scan"><div id="scan-cam" ' + (hint ? 'hidden' : '') + '><video id="scan-video" playsinline muted></video><p class="qm-hint" id="scan-status" role="status">' + esc(t('s.scan.starting')) + '</p></div>' +
      (hint ? '<div class="qm-banner qm-banner--warn" id="scan-hint">' + esc(hint) + '</div>' : '<div class="qm-banner qm-banner--warn" id="scan-hint" hidden></div>') +
      '<div class="qm-field"><label class="qm-label" for="scan-manual">' + esc(t('s.scan.manual')) + '</label><input class="qm-input qm-latin" id="scan-manual" dir="ltr" autocomplete="off" placeholder="' + esc(t('s.scan.ph')) + '"></div></div>';
    function stop() { stopped = true; clearTimeout(loopTimer); if (stream) stream.getTracks().forEach(function (tr) { tr.stop(); }); stream = null; }
    var result = await modal({ title: t('s.scan.title'), bodyHtml: body, actions: [{ label: t('common.cancel'), kind: 'secondary', value: null }, { label: t('s.scan.use'), collect: function (box) { return box.querySelector('#scan-manual').value; } }],
      onOpen: function (box, close) {
        var man = box.querySelector('#scan-manual'); man.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); close(man.value); } });
        function say(msg, warn) { var st = box.querySelector('#scan-status'); if (st) st.textContent = msg; if (warn) { var h = box.querySelector('#scan-hint'); if (h) { h.textContent = msg; h.hidden = false; } } }
        if (hint) return;
        (async function () {
          try {
            var detector = null; if ('BarcodeDetector' in window) { try { detector = new window.BarcodeDetector({ formats: ['qr_code'] }); } catch (e) { detector = null; } }
            var jsqr = detector ? null : await loadJsQR();
            stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
            if (stopped) { stream.getTracks().forEach(function (tr) { tr.stop(); }); return; }
            var v = box.querySelector('#scan-video'); v.srcObject = stream; await v.play(); say(t('s.scan.aim'));
            var cv = document.createElement('canvas'), cx = cv.getContext('2d', { willReadFrequently: true });
            (function tick() {
              if (stopped) return;
              (async function () {
                try {
                  var raw = null;
                  if (detector) { var codes = await detector.detect(v); raw = codes && codes[0] && codes[0].rawValue; }
                  else if (v.videoWidth) { var sc2 = Math.min(1, 640 / v.videoWidth); cv.width = Math.round(v.videoWidth * sc2); cv.height = Math.round(v.videoHeight * sc2); cx.drawImage(v, 0, 0, cv.width, cv.height);
                    var img = cx.getImageData(0, 0, cv.width, cv.height), q = jsqr(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' }); raw = q && q.data; }
                  if (raw) { if (L.parseScan(raw)) { close(raw); return; } say(t('s.scan.invalid')); }
                } catch (e) { /* keep scanning */ }
                if (!stopped) loopTimer = setTimeout(tick, 250);
              })();
            })();
          } catch (e) { var c = box.querySelector('#scan-cam'); if (c) c.hidden = true; say(e && (e.name === 'NotAllowedError' || e.name === 'SecurityError') ? t('s.scan.denied') : t('s.scan.unsupported'), true); }
        })();
      } });
    stop();
    if (result) doLookup(result);
  }

  /* ------------------------------------------------------------------ events */
  var actions = {
    'toggle-pass': function () { S.showPass = !S.showPass; render(); }, logout: logout, 'change-counter': changeCounter,
    'pick-counter': function (b) { var c = L.counterOptions(S.staff).filter(function (x) { return String(x.id) === b.getAttribute('data-id'); })[0]; if (c) { S.counter = c; saveCounter(c.id); enterDesk(); } },
    'do': function (b) { act(b.getAttribute('data-id'), b.getAttribute('data-ctx')); },
    lookup: function () { doLookup(document.getElementById('lookup-input').value); }, scan: scan, 'clear-lookup': function () { S.lookup = null; S.lookupErr = null; render(); },
    refresh: function () { refreshing = false; refreshState(); }
  };
  document.addEventListener('click', function (e) { var b = e.target.closest('[data-act]'); if (!b || b.disabled) return; var f = actions[b.getAttribute('data-act')]; if (f) f(b); });
  $app.addEventListener('submit', function (e) { e.preventDefault(); if (e.target.id === 'login-form') login(); if (e.target.id === 'pw-form') changePassword(); });
  $app.addEventListener('keydown', function (e) { if (e.key === 'Enter' && e.target.id === 'lookup-input') { e.preventDefault(); doLookup(e.target.value); } });
  $app.addEventListener('change', function (e) { if (e.target.id === 'svc-filter') S.svcFilter = e.target.value; });
  api.onUnauthenticated(function () { if (S.staff) sessionExpired(); });
  QM.bindLangSwitch(i18n); i18n.onChange(function () { render(); });

  /* ------------------------------------------------------------------ boot */
  (async function init() {
    i18n.apply();
    try { var d = await api.get('/api/auth/me', { silent401: true }); afterAuth(d.staff || d); }
    catch (e) { S.loginErr = null; go('login'); }
  })();
})();
