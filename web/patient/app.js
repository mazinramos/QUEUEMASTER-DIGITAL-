/* QueueMaster patient portal: welcome -> choose service -> issue -> digital ticket (live). No accounts, no personal data. */
(function () {
  'use strict';
  var esc = QM.esc, toast = QM.toast, modal = QM.modal, i18n = QM.i18n, t = i18n.t.bind(i18n), L = QM.patientLogic, api = QM.api, ic = QM.icon;
  var ls = null; try { ls = window.localStorage; } catch (e) {}
  var store = L.createStore(ls);
  var $app = document.getElementById('app');

  var clinicParam = (/[?&]clinic=([\w-]+)/.exec(location.search) || [])[1] || null;
  var S = { view: 'loading', clinic: store.loadClinic(), clinicErr: null, ticket: null, selectedKey: null, busy: false, err: null, notice: null,
    stale: false, lastOk: null, smsOpen: false, sms: 'idle', smsErr: null, recErr: null, recMsg: null, sig: '' };

  /* ---------- helpers ---------- */
  function clinicName() { return i18n.pick(S.clinic, 'name') || t('p.clinicFallback'); }
  function svcKey(s) { return s.key != null ? s.key : s.id; }
  function ticketService(tk) { return i18n.pick(tk.serviceObj || tk.service) || ''; }
  function tz() { return S.clinic && S.clinic.timezone || undefined; }
  function origin() { return location.origin; }
  function url() { return L.ticketUrl(origin(), S.ticket.token); }
  function statusText(s) { return t('status.' + s); }
  function counterText(c) { var n = L.counterNumber(c); if (n == null) return ''; var nm = typeof c === 'object' ? i18n.pick(c, 'name') : ''; return nm && !/^\d+$/.test(nm) && nm.indexOf(String(n)) < 0 ? nm : t('p.counter.n', { n: n }); }
  function waitText(m) { return m == null ? t('common.none') : t('p.wait.val', { n: i18n.fmtNumber(m) }); }
  function aheadText(n) { return n == null ? t('common.none') : i18n.plural('p.ahead', n); }
  function apiClinicQuery() { return clinicParam ? { clinic: clinicParam } : undefined; }

  /* ---------- brand / title / connection ---------- */
  function renderBrand() {
    document.getElementById('brand-name').textContent = clinicName();
    var logo = document.getElementById('brand-logo'); var u = S.clinic && S.clinic.logoUrl;
    logo.innerHTML = u && /^\/[^/]/.test(u) ? '<img alt="" src="' + esc(u) + '">' : ic('hospital', { size: 22 });
  }
  function updateTitle() {
    var base = clinicName() + ' — ' + t('p.title');
    if (S.ticket && S.ticket.number && (S.view === 'ticket' || S.view === 'success')) {
      var st = S.ticket.status === 'called' ? t('p.doc.title.called') : statusText(S.ticket.status || 'waiting');
      document.title = S.ticket.number + ' · ' + st + ' — ' + clinicName();
    } else document.title = base;
  }
  function renderConn() {
    var el = document.getElementById('conn-banner');
    if (!S.stale) { el.innerHTML = ''; return; }
    var msg = S.lastOk ? t('p.offline', { time: i18n.fmtTime(new Date(S.lastOk).toISOString(), tz()) }) : t('p.offline.never');
    el.innerHTML = '<div class="qm-banner qm-banner--warn">' + ic('wifi-off', { size: 20 }) + '<div class="qm-banner__body">' + esc(msg) + '</div>' +
      '<button type="button" class="qm-btn qm-btn--sm qm-btn--secondary" data-act="retry">' + esc(t('common.retry')) + '</button></div>';
  }

  /* ---------- views ---------- */
  function errBanner(msg) { return msg ? '<div class="qm-banner qm-banner--error" role="alert">' + ic('circle-alert', { size: 20 }) + '<div class="qm-banner__body">' + esc(msg) + '</div></div>' : ''; }
  function noticeBanner() { return S.notice ? '<div class="qm-banner qm-banner--info" role="status">' + ic('info', { size: 20 }) + '<div class="qm-banner__body">' + esc(S.notice) + '</div></div>' : ''; }

  function welcomeView() {
    var tk = S.ticket;
    var active = L.isActive(tk) && tk.number ? '<section class="qm-card pt-stack" aria-labelledby="act-h"><h2 id="act-h" style="font-weight:700">' + esc(t('p.active.title')) + '</h2>' +
      '<div class="pt-bignum" style="font-size:var(--qm-fs-2xl)">' + esc(tk.number) + '</div><div><span class="qm-badge qm-badge--' + esc(tk.status || 'waiting') + '">' + esc(statusText(tk.status || 'waiting')) + '</span></div>' +
      '<button class="qm-btn qm-btn--lg qm-btn--block" data-act="open-ticket">' + ic('ticket', { size: 22 }) + esc(t('p.active.view')) + '</button>' +
      '<button class="qm-btn qm-btn--secondary qm-btn--block" data-act="start">' + esc(t('p.active.new')) + '</button></section>' : '';
    var cta = active ? '' : '<button class="qm-btn qm-btn--lg qm-btn--block" data-act="start" ' + (S.clinic ? '' : 'disabled') + '>' + ic('ticket', { size: 24 }) + esc(t('p.welcome.cta')) + '</button>';
    return noticeBanner() + '<section class="pt-hero"><span class="pt-hero__icon">' + ic('stethoscope', { size: 36 }) + '</span><h1 class="pt-h1" tabindex="-1">' + esc(t('p.welcome.title')) + '</h1>' +
      '<p class="pt-sub">' + esc(t('p.welcome.sub')) + '</p></section>' + (S.clinicErr ? errBanner(S.clinicErr) + '<button class="qm-btn qm-btn--secondary" data-act="reload-clinic">' + esc(t('common.retry')) + '</button>' : '') +
      active + cta + '<button class="qm-btn qm-btn--ghost qm-btn--block" data-act="recover">' + ic('history', { size: 20 }) + esc(t('p.welcome.recover')) + '</button>';
  }

  function servicesView() {
    var list = (S.clinic && S.clinic.services) || [];
    var items = list.map(function (s) {
      var k = String(svcKey(s)), sel = String(S.selectedKey) === k;
      return '<button type="button" role="radio" aria-checked="' + sel + '" class="pt-svc" data-act="pick" data-key="' + esc(k) + '">' +
        '<span class="pt-svc__prefix qm-latin">' + esc(s.prefix || '') + '</span><span class="pt-svc__body"><span class="pt-svc__name">' + esc(i18n.pick(s, 'name')) + '</span>' +
        '<span class="pt-svc__wait">' + esc(s.waiting == null ? '' : i18n.plural('p.waiting', s.waiting)) + '</span></span><span class="pt-svc__check">' + ic('circle-check', { size: 26 }) + '</span></button>';
    }).join('');
    return '<div><h1 class="pt-h1" tabindex="-1">' + esc(t('p.services.title')) + '</h1><p class="pt-sub">' + esc(t('p.services.sub')) + '</p></div>' + errBanner(S.err) +
      (list.length ? '<div class="pt-stack" role="radiogroup" aria-label="' + esc(t('p.services.title')) + '">' + items + '</div>' : '<div class="qm-banner qm-banner--warn">' + esc(t('p.services.none')) + '</div>') +
      '<button class="qm-btn qm-btn--lg qm-btn--block" data-act="issue" ' + (S.selectedKey && !S.busy ? '' : 'disabled') + (S.busy ? ' aria-busy="true"' : '') + '>' +
      (S.busy ? '<span class="qm-spinner"></span>' : ic('ticket', { size: 22 })) + esc(S.selectedKey ? t('p.services.issue') : t('p.services.pick')) + '</button>' +
      '<button class="qm-btn qm-btn--ghost qm-btn--block" data-act="home">' + esc(t('common.back')) + '</button>';
  }

  function successView() {
    var tk = S.ticket;
    return '<section class="pt-hero pt-success"><span class="pt-success__tick">' + ic('check', { size: 48, stroke: 3 }) + '</span><h1 class="pt-h1" tabindex="-1">' + esc(t('p.success.title')) + '</h1>' +
      '<div class="pt-bignum">' + esc(tk.number) + '</div><div class="pt-sub">' + esc(ticketService(tk)) + '</div>' +
      '<div class="pt-stats" style="width:100%;border:1px solid var(--qm-border);border-radius:var(--qm-radius);background:var(--qm-surface)"><div class="pt-stat"><span class="pt-stat__v">' + esc(aheadText(tk.ahead)) + '</span><span class="pt-stat__l">' + esc(t('p.t.ahead')) +
      '</span></div><div class="pt-stat"><span class="pt-stat__v">' + esc(waitText(tk.estimatedWaitMin)) + '</span><span class="pt-stat__l">' + esc(t('p.t.wait')) + '</span></div></div>' +
      '<p class="pt-sub">' + esc(t('p.success.hint')) + '</p></section><button class="qm-btn qm-btn--lg qm-btn--block" data-act="open-ticket">' + esc(t('p.success.view')) + '</button>';
  }

  function ticketView() {
    var tk = S.ticket;
    if (!tk.number) return '<div style="text-align:center;padding:3rem"><span class="qm-spinner"></span><p class="pt-sub">' + esc(t('common.loading')) + '</p>' + errBanner(S.err) + '</div>';
    var st = tk.status || 'waiting', cn = counterText(tk.counter);
    var msg = { waiting: t('p.msg.waiting'), called: cn ? t('p.msg.called', { counter: cn }) : t('p.msg.called.nocounter'), serving: t('p.msg.serving'), completed: t('p.msg.completed'), cancelled: t('p.msg.cancelled'), skipped: t('p.msg.skipped') }[st] || '';
    var alertIcon = { waiting: 'hourglass', called: 'bell-ring', serving: 'stethoscope', completed: 'circle-check', cancelled: 'circle-x', skipped: 'circle-alert' }[st] || 'info';
    var stats = '';
    if (st === 'waiting') stats = stat(aheadText(tk.ahead), t('p.t.ahead')) + stat(waitText(tk.estimatedWaitMin), t('p.t.wait'));
    else if ((st === 'called' || st === 'serving') && L.counterNumber(tk.counter) != null) stats = stat(cn, t('p.t.counter')) + stat(i18n.fmtTime(tk.issuedAt, tz()), t('p.t.issued'));
    var live = QMsocketOnline() ? t('p.live.on') : t('p.live.poll');
    var finalState = L.isFinal(st);
    return '<h1 class="qm-sr-only pt-h1" tabindex="-1">' + esc(t('p.title') + ' ' + tk.number) + '</h1>' +
      noticeBanner() +
      '<div class="pt-alert pt-alert--' + esc(st) + '" role="status" aria-label="' + esc(t('p.sr.status')) + '">' + ic(alertIcon, { size: 28 }) + '<span>' + esc(msg) + '</span></div>' +
      '<article class="pt-ticket"><div class="pt-ticket__top"><div class="pt-ticket__clinic">' + esc(clinicName()) + '</div><div class="pt-ticket__service">' + esc(ticketService(tk)) + '</div></div>' +
      '<div class="pt-ticket__num"><span class="pt-ticket__label">' + esc(t('p.t.number')) + '</span><span class="pt-bignum" id="tk-number">' + esc(tk.number) + '</span>' +
      '<span class="qm-badge qm-badge--' + esc(st) + '">' + esc(statusText(st)) + '</span></div>' +
      (stats ? '<div class="pt-stats">' + stats + '</div>' : '') +
      '<div class="pt-qr">' + QM.qr.svg(url(), { margin: 2, label: t('p.t.number') + ' ' + tk.number }) + '</div>' +
      '<div class="pt-meta"><span>' + esc(t('p.t.issued') + ': ' + i18n.fmtTime(tk.issuedAt, tz())) + '</span><span>' + esc(live) + '</span></div></article>' +
      '<div class="pt-actions"><button class="qm-btn qm-btn--secondary" data-act="save">' + ic('download', { size: 20 }) + esc(t('p.act.save')) + '</button>' +
      '<button class="qm-btn qm-btn--secondary" data-act="print">' + ic('printer', { size: 20 }) + esc(t('p.act.print')) + '</button>' +
      '<button class="qm-btn qm-btn--secondary" data-act="share">' + ic('share-2', { size: 20 }) + esc(t('p.act.share')) + '</button>' +
      '<button class="qm-btn qm-btn--secondary" data-act="copy">' + ic('copy', { size: 20 }) + esc(t('p.act.copy')) + '</button></div>' +
      (finalState ? '' : smsCard(tk)) +
      '<button class="qm-btn ' + (finalState ? 'qm-btn--lg' : 'qm-btn--secondary') + ' qm-btn--block" data-act="start">' + ic('ticket', { size: 20 }) + esc(t('p.act.new')) + '</button>' +
      '<button class="qm-btn qm-btn--ghost qm-btn--block" data-act="recover">' + esc(t('p.act.recover')) + '</button>';
  }
  function stat(v, l) { return '<div class="pt-stat"><span class="pt-stat__v">' + esc(v) + '</span><span class="pt-stat__l">' + esc(l) + '</span></div>'; }
  function smsCard(tk) {
    var done = tk.smsRequested || S.sms === 'ok';
    return '<details class="pt-details" id="sms-details" ' + (S.smsOpen ? 'open' : '') + '><summary>' + ic('message-square', { size: 20 }) + esc(t('p.sms.title')) + '</summary><div class="pt-details__body">' +
      (done ? '<div class="qm-banner qm-banner--ok" role="status">' + ic('circle-check', { size: 20 }) + '<div class="qm-banner__body">' + esc(t('p.sms.ok')) + '</div></div>' :
        '<p class="pt-sub">' + esc(t('p.sms.hint')) + '</p><div class="qm-field"><label class="qm-label" for="sms-phone">' + esc(t('p.sms.phone')) + '</label>' +
        '<input class="qm-input qm-latin" id="sms-phone" data-keep type="tel" inputmode="tel" autocomplete="off" dir="ltr" placeholder="+20 100 000 0000"' + (S.smsErr ? ' aria-invalid="true" aria-describedby="sms-err"' : '') + '>' +
        (S.smsErr ? '<span class="qm-error-text" id="sms-err" role="alert">' + esc(S.smsErr) + '</span>' : '') + '</div>' +
        '<button class="qm-btn qm-btn--block" data-act="sms" ' + (S.sms === 'sending' ? 'disabled aria-busy="true"' : '') + '>' + esc(t('p.sms.send')) + '</button>') + '</div></details>';
  }

  function recoverView() {
    return '<div><h1 class="pt-h1" tabindex="-1">' + esc(t('p.rec.title')) + '</h1><p class="pt-sub">' + esc(t('p.rec.hint')) + '</p></div>' + errBanner(S.recErr) +
      (S.recMsg ? '<div class="qm-banner qm-banner--info" role="status">' + ic('info', { size: 20 }) + '<div class="qm-banner__body">' + esc(S.recMsg) + '</div></div>' : '') +
      '<div class="qm-card pt-stack"><div class="qm-field"><label class="qm-label" for="rec-number">' + esc(t('p.rec.number')) + '</label>' +
      '<input class="qm-input qm-latin" id="rec-number" data-keep autocomplete="off" autocapitalize="characters" dir="ltr" maxlength="10" placeholder="A-025"></div>' +
      '<div class="qm-field"><label class="qm-label" for="rec-last4">' + esc(t('p.rec.last4')) + '</label><input class="qm-input qm-latin" id="rec-last4" data-keep inputmode="numeric" autocomplete="off" dir="ltr" maxlength="4" placeholder="1234"></div>' +
      '<button class="qm-btn qm-btn--lg qm-btn--block" data-act="do-recover" ' + (S.busy ? 'disabled aria-busy="true"' : '') + '>' + esc(t('p.rec.submit')) + '</button></div>' +
      '<button class="qm-btn qm-btn--ghost qm-btn--block" data-act="home">' + esc(t('common.back')) + '</button>';
  }
  function loadingView() { return '<div style="text-align:center;padding:3rem"><span class="qm-spinner"></span><p class="pt-sub">' + esc(t('common.loading')) + '</p></div>'; }
  var views = { loading: loadingView, welcome: welcomeView, services: servicesView, success: successView, ticket: ticketView, recover: recoverView };

  /* ---------- render (keeps typed values / focus across live re-renders) ---------- */
  function render(focusHeading) {
    var keep = {}, ae = document.activeElement;
    Array.prototype.forEach.call($app.querySelectorAll('[data-keep]'), function (el) { keep[el.id] = { v: el.value, f: el === ae, s: el.selectionStart, e: el.selectionEnd }; });
    var scroll = window.scrollY;
    $app.innerHTML = views[S.view]();
    i18n.apply($app);
    Object.keys(keep).forEach(function (id) { var el = document.getElementById(id); if (!el) return; el.value = keep[id].v; if (keep[id].f) { el.focus(); try { el.setSelectionRange(keep[id].s, keep[id].e); } catch (e) {} } });
    if (focusHeading) { var h = $app.querySelector('.pt-h1'); if (h) h.focus({ preventScroll: true }); window.scrollTo(0, 0); } else window.scrollTo(0, scroll);
    renderBrand(); renderConn(); updateTitle();
  }

  /* ---------- data ---------- */
  async function loadClinic(silent) {
    try {
      var d = await api.get('/api/public/clinic', { query: apiClinicQuery() });
      S.clinic = d; store.saveClinic(d); S.clinicErr = null; if (d.language) i18n.setDefault(d.language);
      if (S.view === 'services' && S.selectedKey && !d.services.some(function (s) { return String(svcKey(s)) === String(S.selectedKey); })) S.selectedKey = null;
    } catch (e) { if (!silent || !S.clinic) S.clinicErr = i18n.t('p.clinicFail') + ' ' + i18n.errorMessage(e); }
    if (S.view === 'welcome' || S.view === 'services') render();
    else { renderBrand(); }
  }
  function persist() { if (S.ticket && S.ticket.token) store.saveTicket(S.ticket); }
  function expire() { store.clearTicket(); S.ticket = null; S.notice = t('p.expired'); S.stale = false; go('welcome'); }
  function adopt(next, ev) {
    var prev = S.ticket || {}; S.ticket = next; persist();
    if (L.shouldAlert(prev.status, next.status, ev)) alertPatient();
  }
  function alertPatient() { try { if (navigator.vibrate) navigator.vibrate([300, 150, 300, 150, 300]); } catch (e) {} }

  var refreshing = false;
  async function refreshTicket() {
    if (!S.ticket || refreshing) return; refreshing = true;
    var wasStale = S.stale;
    try {
      var d = await api.get('/api/public/tickets/' + encodeURIComponent(S.ticket.token), { silent401: true });
      var next = L.mergeServer(S.ticket, d);
      if (d && d.service && typeof d.service === 'object') next.serviceObj = d.service;
      S.stale = false; S.lastOk = Date.now(); S.err = null; adopt(next);
      if (wasStale) toast(t('p.online.back'), 'ok');
    } catch (e) {
      if (e.code === 'NOT_FOUND') { refreshing = false; return expire(); }
      S.stale = true; if (!S.ticket.number) S.err = i18n.errorMessage(e);
    }
    refreshing = false;
    var sig = L.signature(S.ticket, S.stale);
    if (sig !== S.sig || wasStale !== S.stale) { S.sig = sig; if (S.view === 'ticket' || S.view === 'success') render(); else renderConn(); }
  }

  /* ---------- live: socket + polling fallback ---------- */
  var sc = QM.createSocketClient({});
  function QMsocketOnline() { return sc.status === 'online'; }
  var poller = QM.createPoller({ fn: refreshTicket, isOnline: QMsocketOnline, fastMs: 5000, slowMs: 15000 });
  var svcPoller = QM.createPoller({ fn: function () { return loadClinic(true); }, isOnline: function () { return false; }, fastMs: 10000 });
  sc.onStatus(function () { if (S.view === 'ticket') render(); });
  sc.onConnect(function () { if (S.ticket && (S.view === 'ticket' || S.view === 'success')) refreshTicket(); });
  sc.on('*', function (payload, ev) {
    if (!S.ticket || ev.indexOf('ticket:') !== 0) return;
    adopt(L.mergeEvent(S.ticket, ev, payload), ev);
    if (S.view === 'ticket') render();
    refreshTicket();
  });
  function startLive() { if (S.ticket) { sc.watchTicket(S.ticket.token); poller.start(false); } }
  function stopLive() { poller.stop(); }

  /* ---------- navigation ---------- */
  function go(view) {
    S.view = view; S.err = null; S.notice = view === 'welcome' ? S.notice : null; S.recErr = null; if (view !== 'recover') S.recMsg = null;
    if (view === 'ticket' || view === 'success') { startLive(); if (view === 'ticket') refreshTicket(); } else stopLive();
    if (view === 'services') { svcPoller.start(false); loadClinic(true); } else svcPoller.stop();
    render(true);
  }

  /* ---------- actions ---------- */
  async function newTicketFlow() {
    if (L.isActive(S.ticket) && S.ticket.number) {
      var ok = await modal({ title: t('p.active.new'), bodyHtml: '<p>' + esc(t('p.confirmNew', { number: S.ticket.number })) + '</p>',
        actions: [{ label: t('common.cancel'), kind: 'secondary', value: false }, { label: t('common.confirm'), value: true }] });
      if (!ok) return;
    }
    S.selectedKey = null; go('services');
  }
  async function issue() {
    if (S.busy || !S.selectedKey) return; S.busy = true; S.err = null; render();
    try {
      var d = await api.post('/api/public/tickets', { serviceKey: S.selectedKey }, { query: apiClinicQuery() });
      var tk = d.ticket, svc = ((S.clinic && S.clinic.services) || []).filter(function (s) { return String(svcKey(s)) === String(S.selectedKey); })[0];
      S.ticket = { token: d.token, number: tk.number, service: tk.serviceName || tk.service, serviceObj: svc ? { name_ar: svc.name_ar, name_en: svc.name_en } : null,
        status: tk.status || 'waiting', ahead: tk.ahead, estimatedWaitMin: tk.estimatedWaitMin, issuedAt: tk.issuedAt, counter: null, smsRequested: false };
      persist(); S.stale = false; S.lastOk = Date.now(); S.busy = false; S.sig = ''; go('success'); return;
    } catch (e) { S.err = i18n.errorMessage(e); }
    S.busy = false; render();
  }
  async function sendSms() {
    var phone = L.normalizePhone(document.getElementById('sms-phone') && document.getElementById('sms-phone').value);
    if (!phone) { S.smsErr = t('p.sms.bad'); render(); return; }
    S.smsErr = null; S.sms = 'sending'; render();
    try { await api.post('/api/public/tickets/' + encodeURIComponent(S.ticket.token) + '/sms', { phone: phone }); S.sms = 'ok'; S.ticket.smsRequested = true; persist(); }
    catch (e) { S.sms = 'idle'; S.smsErr = i18n.errorMessage(e); }
    render();
  }
  async function saveImage() {
    var tk = S.ticket;
    try {
      var blob = await QM.ticketImage.render({ clinicName: clinicName(), serviceName: ticketService(tk), number: tk.number, issuedText: i18n.fmtDate(tk.issuedAt, tz()) + ' ' + i18n.fmtTime(tk.issuedAt, tz()),
        statusText: statusText(tk.status || 'waiting'), url: url(), dir: i18n.dir(), labels: { number: t('p.t.number'), service: t('p.t.service'), issued: t('p.t.issued'), status: t('p.img.status'), scan: t('p.img.scan') } });
      var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'ticket-' + tk.number + '.png'; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 15000); toast(t('p.toast.saved'), 'ok');
    } catch (e) { toast(t('p.toast.imgFail'), 'error'); }
  }
  function print() {
    var tk = S.ticket, sheet = document.getElementById('print-sheet');
    sheet.innerHTML = '<div class="ps-box"><div class="ps-small">' + esc(t('p.print.title')) + '</div><div class="ps-clinic">' + esc(clinicName()) + '</div><div class="ps-service">' + esc(ticketService(tk)) + '</div>' +
      '<div class="ps-num">' + esc(tk.number) + '</div><div class="ps-qr">' + QM.qr.svg(url(), { margin: 4 }) + '</div><div class="ps-small">' + esc(t('p.t.issued') + ': ' + i18n.fmtDate(tk.issuedAt, tz()) + ' ' + i18n.fmtTime(tk.issuedAt, tz())) + '</div>' +
      '<div class="ps-small">' + esc(t('p.print.keep')) + '</div><div class="ps-url">' + esc(url()) + '</div></div>';
    var clear = function () { sheet.innerHTML = ''; window.removeEventListener('afterprint', clear); }; window.addEventListener('afterprint', clear);
    setTimeout(function () { window.print(); }, 50);
  }
  async function copyLink() { var ok = await QM.copyText(url()); toast(ok ? t('p.toast.copied') : t('p.toast.copyFail'), ok ? 'ok' : 'error'); }
  async function share() {
    var data = { title: t('p.share.title'), text: t('p.share.text', { number: S.ticket.number }), url: url() };
    if (navigator.share) { try { await navigator.share(data); } catch (e) { if (e && e.name !== 'AbortError') copyLink(); } } else copyLink();
  }
  async function doRecover() {
    var num = L.normalizeTicketNumber(document.getElementById('rec-number').value), last4 = document.getElementById('rec-last4').value.trim();
    S.recErr = null; S.recMsg = null;
    if (!num) { S.recErr = t('p.rec.bad'); render(); return; }
    if (last4 && !/^\d{4}$/.test(last4)) { S.recErr = t('p.sms.bad'); render(); return; }
    S.busy = true; render();
    try {
      var body = { number: num }; if (last4) body.phoneLast4 = last4;
      var d = await api.post('/api/public/tickets/recover', body, { query: apiClinicQuery() });
      if (d && typeof d.token === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(d.token)) { S.ticket = { token: d.token, status: 'waiting' }; S.busy = false; S.sig = ''; persist(); go('ticket'); return; }
      S.recMsg = t('p.rec.noToken');
    } catch (e) { S.recErr = e.code === 'NOT_FOUND' ? t('p.rec.notfound') : i18n.errorMessage(e); }
    S.busy = false; render();
  }

  var actions = {
    start: newTicketFlow, 'open-ticket': function () { go('ticket'); }, home: function () { go('welcome'); }, recover: function () { go('recover'); }, 'do-recover': doRecover,
    pick: function (b) { S.selectedKey = b.getAttribute('data-key'); render(); }, issue: issue, sms: sendSms, save: saveImage, print: print, share: share, copy: copyLink,
    retry: function () { refreshTicket(); }, 'reload-clinic': function () { S.clinicErr = null; loadClinic(); }
  };
  $app.addEventListener('click', function (e) { var b = e.target.closest('[data-act]'); if (b && actions[b.getAttribute('data-act')] && !b.disabled) actions[b.getAttribute('data-act')](b); });
  document.getElementById('conn-banner').addEventListener('click', function (e) { var b = e.target.closest('[data-act="retry"]'); if (b) refreshTicket(); });
  $app.addEventListener('toggle', function (e) { if (e.target.id === 'sms-details') S.smsOpen = e.target.open; }, true);
  $app.addEventListener('keydown', function (e) { if (e.key === 'Enter' && e.target.id === 'rec-number') doRecover(); if (e.key === 'Enter' && e.target.id === 'sms-phone') sendSms(); });
  i18n.onChange(function () { render(); });

  /* ---------- boot ---------- */
  (function init() {
    QM.bindLangSwitch(i18n); i18n.apply(); renderBrand();
    var saved = store.loadTicket(), tokenParam = L.parseTokenFromSearch(location.search);
    if (tokenParam) {
      try { history.replaceState(null, '', location.pathname + (clinicParam ? '?clinic=' + clinicParam : '')); } catch (e) {}   // keep the token out of history/referrers
      S.ticket = saved && saved.token === tokenParam ? saved : { token: tokenParam, status: 'waiting' };
    } else if (saved) S.ticket = saved;
    loadClinic(false).then(function () { if (!S.ticket && S.view === 'loading') go('welcome'); });
    if (S.ticket) go('ticket'); else render();
  })();
})();
