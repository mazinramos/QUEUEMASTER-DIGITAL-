/* شاشة الانتظار — التطبيق الرئيسي. لا يعرض بيانات خارجية عبر innerHTML أبداً (textContent فقط). */
(function () {
  'use strict';
  const C = window.DisplayCore;
  const STR = window.DisplayStrings;
  const qs = new URLSearchParams(location.search);
  const $ = (id) => document.getElementById(id);

  const S = {
    lang: qs.get('lang') === 'en' ? 'en' : qs.get('lang') === 'ar' ? 'ar' : 'ar',
    langLocked: qs.get('lang') === 'en' || qs.get('lang') === 'ar',
    str: STR.ar,
    clinic: null, display: null, settings: C.normalizeSettings(null),
    state: C.emptyState(), ads: [],
    offsetMs: 0, conn: 'connecting', everConnected: false,
    socket: null, resyncing: false, lastFocusSeq: 0, started: false,
    deduper: C.createEventDeduper(200), gate: C.createAnnounceGate({ windowMs: 1500 }),
    adsCtl: null, announcer: null,
  };
  const now = () => Date.now();
  const serverNow = () => now() + S.offsetMs;

  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

  /* ================= العروض واللغة ================= */
  function showView(name) {
    document.body.dataset.view = name;
    $('view-loading').hidden = name !== 'loading';
    $('view-pair').hidden = name !== 'pair';
    $('view-screen').hidden = name !== 'screen';
    if (name === 'pair') { $('pair-code').focus(); }
    $('fs-btn').hidden = name === 'loading';
  }
  function setLang(lang) {
    S.lang = lang === 'en' ? 'en' : 'ar';
    S.str = STR[S.lang];
    const h = document.documentElement;
    h.lang = S.lang; h.dir = S.lang === 'ar' ? 'rtl' : 'ltr';
    document.title = 'QueueMaster — ' + S.str.title;
    const t = S.str;
    $('loading-text').textContent = t.loading;
    $('pair-title').textContent = t.pairTitle; $('pair-hint').textContent = t.pairHint;
    $('pair-label').textContent = t.pairCode; $('pair-submit').textContent = t.pairButton;
    $('hero-label').textContent = t.nowCalling; $('at-counters-title').textContent = t.atCounters;
    $('next-title').textContent = t.next; $('recent-title').textContent = t.recent;
    $('audio-gate-btn').textContent = t.enableSound; $('audio-gate-hint').textContent = t.enableSoundHint;
    $('fs-btn').textContent = t.fullscreen;
    $('offline-banner').textContent = t.offlineBanner;
    setConn(S.conn);
  }

  /* ================= الرسم ================= */
  const svcName = (s) => (S.lang === 'en' ? (s.name_en || s.name_ar) : (s.name_ar || s.name_en)) || '';
  const ctrLabel = (c) => (c && c.number != null ? `${S.str.counter} ${c.number}` : '');

  function renderHeader() {
    const c = S.clinic || {};
    const name = S.lang === 'en' ? (c.name_en || c.name_ar) : (c.name_ar || c.name_en);
    $('clinic-name').textContent = name || '';
    const sub = S.lang === 'en' ? c.name_ar : c.name_en;
    $('clinic-sub').textContent = sub && sub !== name ? sub : '';
    const logo = $('clinic-logo');
    if (c.logoUrl) { if (logo.getAttribute('src') !== c.logoUrl) logo.src = c.logoUrl; logo.hidden = false; } else { logo.hidden = true; logo.removeAttribute('src'); }
    logo.onerror = () => { logo.hidden = true; };
  }

  function fitHero() {
    const box = $('hero-box'); const num = $('hero-number');
    const w = box.clientWidth; const h = box.clientHeight;
    if (!w || !h) return;
    num.style.fontSize = '100px';
    const nw = num.scrollWidth || 1; const nh = num.scrollHeight || 1;
    const k = Math.min((w * 0.96) / nw, (h * 0.98) / nh) * (S.state.focus ? 1 : 0.35); // الحالة الفارغة أصغر
    num.style.fontSize = Math.max(24, Math.min(2400, 100 * k)) + 'px';
  }

  function renderHero() {
    const f = S.state.focus; const hero = $('hero');
    hero.classList.toggle('is-empty', !f);
    $('hero-number').textContent = f ? f.number : S.str.none;
    $('hero-counter').textContent = f ? ctrLabel(f.counter) : S.str.noCall;
    $('hero-service').textContent = f ? svcName(f.service) : '';
    fitHero();
    if (f && S.state.focusSeq !== S.lastFocusSeq) {
      S.lastFocusSeq = S.state.focusSeq;
      hero.classList.remove('is-new'); void hero.offsetWidth; hero.classList.add('is-new');
      clearTimeout(renderHero.t); renderHero.t = setTimeout(() => hero.classList.remove('is-new'), 9000);
    }
  }

  function fillList(ul, items, build) {
    ul.textContent = '';
    if (!items.length) { const li = el('li', 'empty', S.str.none); ul.appendChild(li); return; }
    items.forEach((t) => ul.appendChild(build(t)));
  }

  function renderLists() {
    const st = S.state; const f = st.focus;
    // التذاكر الأخرى الجارية عند الشبابيك
    const others = st.current.filter((t) => !(f && t.number === f.number));
    const box = $('at-counters'); const chips = $('at-counters-list');
    chips.textContent = '';
    others.slice(0, 6).forEach((t) => {
      const li = el('li', 'chip'); li.appendChild(el('span', 'chip-no', t.number)); li.appendChild(el('span', 'chip-ctr', ctrLabel(t.counter)));
      chips.appendChild(li);
    });
    box.hidden = others.length === 0;

    fillList($('next-list'), st.next.slice(0, 3), (t) => {
      const li = el('li'); li.appendChild(el('span', 't-no', t.number)); li.appendChild(el('span', 't-sub', svcName(t.service))); return li;
    });
    const recent = st.recent.filter((t) => !(f && t.number === f.number)).slice(0, 4);
    fillList($('recent-list'), recent, (t) => {
      const li = el('li'); li.appendChild(el('span', 't-no', t.number)); li.appendChild(el('span', 't-sub t-ctr', ctrLabel(t.counter))); return li;
    });

    const active = st.waitingCount > 0 || st.current.length > 0;
    const qs_ = $('queue-state'); qs_.dataset.state = active ? 'active' : 'empty';
    qs_.textContent = active ? S.str.queueActive : S.str.queueEmpty;
    $('waiting-count').textContent = `${S.str.waiting}: ${st.waitingCount}`;
  }

  function renderAll() { renderHeader(); renderHero(); renderLists(); tickClock(); }

  /* ---- الساعة ---- */
  function tickClock() {
    const tz = S.clinic && S.clinic.timezone; const d = new Date(serverNow());
    const opt = (o) => { try { return Object.assign({ timeZone: tz || undefined }, o); } catch (e) { return o; } };
    try {
      $('clock').textContent = new Intl.DateTimeFormat('en-GB', opt({ hour: '2-digit', minute: '2-digit', hour12: false })).format(d);
      $('date').textContent = new Intl.DateTimeFormat(S.lang === 'ar' ? 'ar-EG-u-nu-latn' : 'en-GB', opt({ weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })).format(d);
    } catch (e) {
      $('clock').textContent = d.toTimeString().slice(0, 5); $('date').textContent = d.toDateString();
    }
  }

  /* ---- حالة الاتصال ---- */
  let offlineTimer = null;
  function setConn(state) {
    S.conn = state;
    const pill = $('conn-status'); pill.dataset.state = state;
    $('conn-text').textContent = state === 'online' ? S.str.connOnline : state === 'offline' ? S.str.connOffline : S.str.connConnecting;
    clearTimeout(offlineTimer);
    if (state === 'online') $('offline-banner').hidden = true;
    else if (S.started) offlineTimer = setTimeout(() => { if (S.conn !== 'online') $('offline-banner').hidden = false; }, 10000);
  }

  /* ================= البيانات ================= */
  async function fetchBootstrap() {
    const t0 = now();
    const res = await fetch('/api/display/bootstrap', { credentials: 'same-origin', cache: 'no-store' });
    if (res.status === 401) return { status: 'unpaired' };
    if (!res.ok) throw new Error('bootstrap ' + res.status);
    const body = await res.json();
    if (!body || !body.ok) throw new Error('bootstrap payload');
    const sv = Date.parse(body.data.serverTime);
    if (Number.isFinite(sv)) S.offsetMs = sv - (t0 + now()) / 2;
    return { status: 'ok', data: body.data };
  }

  function applyBootstrap(d) {
    S.display = d.display || S.display;
    S.clinic = d.clinic || S.clinic;
    if (!S.langLocked) setLang(S.clinic && S.clinic.language);
    S.settings = C.normalizeSettings(d.settings);
    S.state = C.applyBootstrap(S.state, d);
    S.ads = d.ads || [];
    S.lastFocusSeq = S.state.focusSeq; // لا وميض لحالة قديمة عند التحميل/إعادة الاتصال
    renderAll();
    if (S.adsCtl) { S.adsCtl.setAds(S.ads, S.display && S.display.id); }
    initAudio();
    if (S.announcer) S.announcer.setSettings(S.settings);
  }

  /** إعادة مزامنة كاملة: تستبدل الحالة ولا تنطق شيئاً (قاعدة 2 في socket-events). */
  async function resync() {
    if (S.resyncing) return 'busy';
    S.resyncing = true;
    try {
      const r = await fetchBootstrap();
      if (r.status === 'unpaired') { teardown(); showView('pair'); return 'unpaired'; }
      applyBootstrap(r.data);
      return 'ok';
    } catch (e) { console.warn('[display] resync failed:', e.message); return 'error'; } finally { S.resyncing = false; }
  }

  /* ================= Socket.IO ================= */
  const EVENTS = ['ticket:created', 'ticket:called', 'ticket:recalled', 'ticket:serving', 'ticket:completed', 'ticket:skipped', 'ticket:cancelled',
    'queue:updated', 'display:announcement', 'display:settings_updated', 'advertisement:updated'];

  function connectSocket() {
    if (S.socket) return;
    if (!window.io) { setConn('offline'); return; }
    const s = window.io({ reconnection: true, reconnectionDelay: 1000, reconnectionDelayMax: 8000, timeout: 8000 });
    S.socket = s;
    s.on('connect', () => {
      setConn('online');
      if (S.everConnected) resync(); // بعد انقطاع: استبدال الحالة بدون نطق
      S.everConnected = true;
    });
    s.on('disconnect', (reason) => {
      setConn('offline');
      // قطع من السيرفر عمداً: العميل لا يعيد الاتصال تلقائياً في هذه الحالة
      if (reason === 'io server disconnect') setTimeout(() => { if (S.socket) S.socket.connect(); }, 1500);
    });
    s.on('connect_error', () => { setConn('offline'); });
    EVENTS.forEach((name) => s.on(name, (p) => { try { onEvent(name, p); } catch (e) { console.error('[display] event', name, e); } }));
  }

  function onEvent(name, p) {
    if (!p || typeof p !== 'object') return;
    if (p.clinicId != null && S.display && Number(p.clinicId) !== Number(S.display.clinicId)) return;
    if (S.deduper.seen(p.eventId)) return;
    switch (name) {
      case 'ticket:called':
      case 'ticket:recalled': {
        S.state = C.applyTicketEvent(S.state, name, p);
        renderAll();
        if (p.announce !== false) maybeAnnounce('ticket', p, p.ticket && p.ticket.number, p.counter && (p.counter.number != null ? p.counter.number : p.counter), name === 'ticket:recalled');
        break;
      }
      case 'display:announcement':
        maybeAnnounce('announcement', p, p.ticketNumber, p.counterNumber, false);
        break;
      case 'ticket:serving': case 'ticket:completed': case 'ticket:skipped': case 'ticket:cancelled':
        S.state = C.applyTicketEvent(S.state, name, p); renderAll(); break;
      case 'queue:updated':
        S.state = C.applyQueueUpdated(S.state, p); renderAll(); break;
      case 'display:settings_updated':
        if (!S.display || p.displayId == null || Number(p.displayId) === Number(S.display.id)) {
          S.settings = C.normalizeSettings(p.settings);
          if (S.announcer) S.announcer.setSettings(S.settings);
        }
        break;
      case 'advertisement:updated':
        S.ads = Array.isArray(p.ads) ? p.ads : [];
        if (S.adsCtl) S.adsCtl.setAds(S.ads, S.display && S.display.id);
        break;
      default: break;
    }
  }

  /** نقطة النطق الوحيدة: حداثة (<30ث) + دمج ticket/announcement + تسليم للمُعلن إن وُجد. */
  function maybeAnnounce(source, p, ticketNumber, counterNumber, recall) {
    if (!ticketNumber || counterNumber == null) return;
    if (!C.isFresh(p.ts, now(), S.offsetMs)) return;
    if (!S.gate.accept(`${ticketNumber}|${counterNumber}`, source, now())) return;
    if (S.announcer) S.announcer.enqueue({ eventId: p.eventId, ts: p.ts, ticketNumber: String(ticketNumber), counterNumber, recall: !!recall });
  }

  /* ================= الصوت ================= */
  function renderSound(status) {
    const pill = $('sound-status'); const t = S.str;
    pill.hidden = false; pill.dataset.state = status.state;
    pill.textContent = status.state === 'on' ? t.soundOn : status.state === 'off' ? t.soundOff : status.state === 'blocked' ? t.soundBlocked : t.soundNoVoice;
    $('audio-gate').hidden = !status.needsGate;
  }
  function lettersMode() {
    try { return qs.get('letters') || localStorage.getItem('qm.display.letters') || 'latin'; } catch (e) { return 'latin'; }
  }
  function initAudio() {
    const A = window.DisplayAnnouncer;
    if (S.announcer || !A) return;
    try {
      S.announcer = A.create({
        speech: A.createBrowserSpeech(window), clips: A.createBrowserClips(window),
        settings: S.settings, letters: lettersMode(), onStatus: renderSound, log: (e) => console.debug('[audio]', e),
      });
    } catch (e) { console.error('[display] audio init failed', e); }
    setInterval(() => { if (S.announcer) S.announcer.refresh(); }, 1000);
    // أي نقرة/لمسة/مفتاح في أي مكان تفك حظر الصوت (المتصفح يشترط تفاعلاً مرة واحدة)
    const unlockOnce = () => { if (S.announcer) S.announcer.unlock(); };
    ['pointerdown', 'keydown', 'touchstart'].forEach((ev) => document.addEventListener(ev, unlockOnce, { capture: true, passive: true }));
    $('audio-gate-btn').addEventListener('click', () => {
      unlockOnce();
      if (qs.get('kiosk') === '1' || qs.get('fs') === '1') toggleFullscreen();
    });
  }

  /* ================= دورة الحياة ================= */
  let clockTimer = null; let pollTimer = null;
  function teardown() {
    if (S.socket) { try { S.socket.close(); } catch (e) { /* تجاهل */ } S.socket = null; }
    if (S.adsCtl) S.adsCtl.stop();
    clearInterval(clockTimer); clearInterval(pollTimer);
    S.started = false; S.everConnected = false;
  }

  function startRuntime() {
    S.started = true;
    showView('screen');
    renderAll();
    if (!S.adsCtl && window.DisplayAds) {
      S.adsCtl = window.DisplayAds.create({
        stage: window.DisplayStage.createStage($('ad-stage')),
        getContext: () => ({ clinic: S.clinic, lang: S.lang, strings: S.str }),
      });
    }
    if (S.adsCtl) { S.adsCtl.setAds(S.ads, S.display && S.display.id); S.adsCtl.start(); }
    clockTimer = setInterval(tickClock, 1000);
    // مزامنة دورية احتياطية: عند انقطاع Socket تستمر الشاشة بالتحديث عبر REST (بدون نطق)
    pollTimer = setInterval(() => { if (S.conn !== 'online') resync(); }, 10000);
    ensureIo(connectSocket);
  }

  let ioTimer = null;
  function ensureIo(cb) {
    if (window.io) { cb(); return; }
    setConn('offline');
    if (ioTimer) return;
    ioTimer = setInterval(() => {
      if (window.io) { clearInterval(ioTimer); ioTimer = null; cb(); return; }
      const sc = document.createElement('script'); sc.src = 'vendor/socket.io.min.js'; sc.onerror = () => sc.remove();
      document.head.appendChild(sc);
    }, 10000);
  }

  async function start() {
    showView('loading');
    for (;;) {
      try {
        const r = await fetchBootstrap();
        if (r.status === 'unpaired') { showView('pair'); return; }
        applyBootstrap(r.data);
        startRuntime();
        return;
      } catch (e) {
        console.warn('[display] waiting for server…', e.message);
        await new Promise((res) => setTimeout(res, 3000));
      }
    }
  }

  /* ================= الإقران ================= */
  function initPair() {
    const input = $('pair-code'); const err = $('pair-error'); const btn = $('pair-submit');
    input.addEventListener('input', () => {
      let v = input.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
      if (v.length > 4) v = v.slice(0, 4) + '-' + v.slice(4);
      input.value = v; err.hidden = true;
    });
    $('pair-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const code = input.value.trim(); if (!code) return;
      btn.disabled = true; err.hidden = true;
      try {
        const res = await fetch('/api/display/pair', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
        if (res.ok) { input.value = ''; await start(); return; }
        err.textContent = res.status === 429 ? S.str.pairRate : (res.status === 404 || res.status === 400) ? S.str.pairInvalid : S.str.pairNet;
      } catch (e2) { err.textContent = S.str.pairNet; }
      err.hidden = false;
      btn.disabled = false; input.focus(); input.select();
    });
  }

  /* ================= ملء الشاشة / kiosk / منع السكون ================= */
  function toggleFullscreen() {
    if (document.fullscreenElement) { document.exitFullscreen && document.exitFullscreen(); return; }
    const d = document.documentElement;
    if (d.requestFullscreen) d.requestFullscreen().catch(() => {});
  }
  let wakeLock = null;
  async function requestWake() {
    try { if (navigator.wakeLock && document.visibilityState === 'visible') wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { /* غير مدعوم/مرفوض */ }
  }
  function initKiosk() {
    const kiosk = qs.get('kiosk') === '1';
    document.body.classList.toggle('kiosk', kiosk);
    let t = null;
    const wake = () => { document.body.classList.add('show-cursor'); clearTimeout(t); t = setTimeout(() => document.body.classList.remove('show-cursor'), 3000); };
    document.addEventListener('mousemove', wake);
    $('fs-btn').addEventListener('click', toggleFullscreen);
    document.addEventListener('dblclick', (e) => { if (e.target.closest('input,button')) return; toggleFullscreen(); });
    document.addEventListener('keydown', (e) => { if ((e.key === 'f' || e.key === 'F') && !e.target.closest('input')) toggleFullscreen(); });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') requestWake(); });
    requestWake();
  }

  /* ================= تشغيل ================= */
  function init() {
    setLang(S.lang);
    initPair(); initKiosk();
    window.addEventListener('resize', () => { if (S.started) fitHero(); });
    if (window.ResizeObserver) new ResizeObserver(() => { if (S.started) fitHero(); }).observe($('hero-box'));
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { if (S.started) fitHero(); });
    start();
  }
  window.__display = { S, onEvent, resync, renderAll }; // للاختبار/التشخيص فقط
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
}());
