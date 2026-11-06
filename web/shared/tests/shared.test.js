const test = require('node:test'); const assert = require('node:assert/strict');
const { createI18n, BASE } = require('../i18n.js');
const { createApi, ApiError } = require('../api.js');
const { createDeduper, createPoller } = require('../socket-client.js');
const { icons, icon } = require('../icons.js');

test('deduper ignores repeated eventIds and keeps only the last N', () => {
  const d = createDeduper(200);
  assert.equal(d.seen('e1'), false); assert.equal(d.seen('e1'), true);
  for (let i = 0; i < 250; i++) d.seen('x' + i);
  assert.equal(d.size(), 200);
  assert.equal(d.seen('e1'), false, 'oldest id was evicted');
  assert.equal(d.seen(undefined), false, 'events without id are never deduped');
});

test('i18n: ar and en base dictionaries have identical keys', () => {
  assert.deepEqual(Object.keys(BASE.ar).sort(), Object.keys(BASE.en).sort());
});
test('i18n: default ar/rtl, switching, interpolation, fallback, persistence', () => {
  const store = {}; const storage = { getItem: k => store[k] ?? null, setItem: (k, v) => { store[k] = v; } };
  const i = createI18n({ storage });
  assert.equal(i.lang, 'ar'); assert.equal(i.dir(), 'rtl');
  assert.equal(i.t('common.min', { n: 5 }), '5 د');
  i.extend({ ar: { 'x.only': 'عربي' }, en: {} });
  i.setLang('en'); assert.equal(i.dir(), 'ltr'); assert.equal(store['qm.lang'], 'en');
  assert.equal(i.t('x.only'), 'عربي', 'falls back to the other language');
  assert.equal(i.t('missing.key'), 'missing.key');
  assert.equal(createI18n({ storage }).lang, 'en', 'language persists');
});
test('i18n: clinic default applies only when visitor has not chosen', () => {
  const store = {}; const storage = { getItem: k => store[k] ?? null, setItem: (k, v) => { store[k] = v; } };
  const a = createI18n({ storage }); a.setDefault('en'); assert.equal(a.lang, 'en'); assert.equal(store['qm.lang'], undefined);
  const b = createI18n({ storage }); b.setLang('ar'); b.setDefault('en'); assert.equal(b.lang, 'ar');
});
test('i18n: Arabic plural categories and Latin digits', () => {
  const i = createI18n({}); i.extend({ ar: { 'p.other': '{n} أشخاص', 'p.one': 'شخص واحد', 'p.two': 'شخصان' }, en: { 'p.other': '{n} people', 'p.one': '1 person' } });
  assert.equal(i.plural('p', 1), 'شخص واحد'); assert.equal(i.plural('p', 2), 'شخصان'); assert.equal(i.plural('p', 7), '7 أشخاص');
  i.setLang('en'); assert.equal(i.plural('p', 3), '3 people');
  assert.match(i.fmtTime('2026-01-01T10:05:00Z', 'UTC'), /10:05/);
});
test('i18n: pick() and errorMessage()', () => {
  const i = createI18n({});
  assert.equal(i.pick({ name_ar: 'باطنة', name_en: 'Internal' }), 'باطنة');
  i.setLang('en'); assert.equal(i.pick({ name_ar: 'باطنة', name_en: 'Internal' }), 'Internal'); assert.equal(i.pick({ name_ar: 'باطنة' }), 'باطنة');
  assert.match(i.errorMessage({ code: 'ALREADY_CALLED' }), /already called/);
  assert.match(i.errorMessage({ code: 'WHATEVER' }), /unexpected/);
});

function mkFetch(routes) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, init });
    const r = routes.shift(); if (r instanceof Error) throw r;
    return { status: r.status, ok: r.status < 400, text: async () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body)) };
  };
  f.calls = calls; return f;
}
test('api: unwraps data, builds query, sends JSON', async () => {
  const f = mkFetch([{ status: 200, body: { ok: true, data: { a: 1 } } }]);
  const api = createApi({ fetch: f });
  assert.deepEqual(await api.get('/api/x', { query: { clinic: 'c1', q: '', z: null } }), { a: 1 });
  assert.equal(f.calls[0].url, '/api/x?clinic=c1');
});
test('api: error envelope becomes ApiError with code/status', async () => {
  const api = createApi({ fetch: mkFetch([{ status: 409, body: { ok: false, error: { code: 'ALREADY_CALLED', message: 'm' } } }]) });
  await assert.rejects(() => api.post('/api/queue/call-next', {}), e => e instanceof ApiError && e.code === 'ALREADY_CALLED' && e.status === 409);
});
test('api: network failure and timeout map to NETWORK / TIMEOUT', async () => {
  const a = createApi({ fetch: mkFetch([new TypeError('failed')]) });
  await assert.rejects(() => a.get('/x'), e => e.code === 'NETWORK');
  const slow = createApi({ timeoutMs: 20, fetch: (u, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('a'), { name: 'AbortError' })))) });
  await assert.rejects(() => slow.get('/x'), e => e.code === 'TIMEOUT');
});
test('api: CSRF token fetched once, sent on mutations, refreshed once on 403', async () => {
  const f = mkFetch([
    { status: 200, body: { ok: true, data: { csrfToken: 't1' } } },
    { status: 403, body: { ok: false, error: { code: 'CSRF', message: 'bad' } } },
    { status: 200, body: { ok: true, data: { csrfToken: 't2' } } },
    { status: 200, body: { ok: true, data: { done: true } } }]);
  const api = createApi({ fetch: f });
  assert.deepEqual(await api.post('/api/queue/call-next', { counterId: 1 }, { csrf: true }), { done: true });
  assert.equal(f.calls[1].init.headers['X-CSRF-Token'], 't1'); assert.equal(f.calls[3].init.headers['X-CSRF-Token'], 't2');
});
test('api: 401 fires unauthenticated handlers (unless silent401)', async () => {
  const api = createApi({ fetch: mkFetch([{ status: 401, body: { ok: false, error: { code: 'UNAUTHENTICATED', message: 'x' } } }, { status: 401, body: '' }]) });
  let n = 0; api.onUnauthenticated(() => n++);
  await assert.rejects(() => api.get('/api/auth/me')); assert.equal(n, 1);
  await assert.rejects(() => api.get('/api/auth/me', { silent401: true })); assert.equal(n, 1);
});

test('poller: adaptive interval, no overlap, stop', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let online = false, runs = 0;
  const p = createPoller({ fn: async () => { runs++; }, isOnline: () => online, fastMs: 100, slowMs: 1000 });
  p.start(false);
  t.mock.timers.tick(99); assert.equal(runs, 0);
  t.mock.timers.tick(1); await Promise.resolve(); await Promise.resolve(); assert.equal(runs, 1);
  online = true; t.mock.timers.tick(100); await Promise.resolve(); await Promise.resolve(); assert.equal(runs, 2);
  t.mock.timers.tick(500); assert.equal(runs, 2, 'slow interval when online');
  p.stop(); t.mock.timers.tick(5000); assert.equal(runs, 2);
});

test('icons: every icon renders an svg and unknown names are empty', () => {
  assert.ok(Object.keys(icons).length >= 50);
  assert.match(icon('ticket', { size: 24 }), /^<svg class="qm-icon"[^>]*width="24"/);
  assert.equal(icon('nope'), '');
});

test('qr: matrix + svg for a ticket url', () => {
  const qr = require('../qr.js').create(require('../vendor/qrcode.js'));
  const url = 'http://192.168.1.10:3000/patient/?t=0123456789abcdef0123456789abcdef';
  const m = qr.matrix(url); assert.ok(m.size >= 29 && m.size % 4 === 1);
  assert.equal(m.isDark(0, 0), true, 'finder pattern corner is dark');
  const s = qr.svg(url, { margin: 4 }); assert.match(s, /^<svg [^>]*viewBox="0 0 \d+ \d+"/); assert.match(s, /<path fill="#000" d="M/);
});

test('i18n.pick understands every naming style the backend uses', () => {
  const i = createI18n({});
  assert.equal(i.pick({ nameAr: 'تحاليل', nameEn: 'Laboratory' }), 'تحاليل');
  assert.equal(i.pick({ ar: 'تحاليل', en: 'Laboratory' }), 'تحاليل');
  assert.equal(i.pick({ number: 2, name: 'شباك 2', nameEn: 'Counter 2' }), 'شباك 2');
  i.setLang('en');
  assert.equal(i.pick({ nameAr: 'تحاليل', nameEn: 'Laboratory' }), 'Laboratory'); assert.equal(i.pick({ ar: 'تحاليل', en: 'Laboratory' }), 'Laboratory');
  assert.equal(i.pick({ number: 2, name: 'شباك 2', nameEn: 'Counter 2' }), 'Counter 2'); assert.equal(i.pick({ name: 'شباك 2' }), 'شباك 2');
});
test('api.setCsrf is used for the next mutation without another fetch', async () => {
  const f = mkFetch([{ status: 200, body: { ok: true, data: { x: 1 } } }]);
  const api = createApi({ fetch: f }); api.setCsrf('rotated');
  await api.post('/api/queue/call-next', {}, { csrf: true });
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].init.headers['X-CSRF-Token'], 'rotated');
});

test('brand: derived action colour always reaches AA with white text, default included', () => {
  const B = require('../brand.js');
  assert.ok(Math.abs(B.contrast('#000000', '#FFFFFF') - 21) < 0.01);
  for (const c of ['#0F8F6B', '#FFD500', '#00C2FF', '#E91E63', '#1A237E', '#FFFFFF', '#ff0', '#7CB342']) {
    const d = B.derive(c); assert.ok(B.contrast(d.action, '#FFFFFF') >= 4.5, c + ' -> ' + d.action + ' ' + B.contrast(d.action, '#FFFFFF'));
    assert.ok(B.contrast(d.actionHover, '#FFFFFF') >= 4.5); assert.ok(B.contrast(d.soft, '#FFFFFF') < 1.4, 'soft tint stays light');
  }
  assert.equal(B.derive('not-a-colour').brand, B.DEFAULT); assert.equal(B.derive('#1a237e').action, '#1A237E', 'already dark colours are kept');
});
test('brand: apply sets CSS variables, logoSrc only accepts same-origin paths, nameOf picks language', () => {
  const B = require('../brand.js'); const set = {}; const doc = { documentElement: { style: { setProperty: (k, v) => { set[k] = v; } } } };
  B.apply({ color: '#0F8F6B' }, doc); assert.ok(set['--brand'] && set['--brand-action'] && set['--brand-action-hover'] && set['--brand-on'] && set['--brand-soft']);
  assert.equal(B.logoSrc({ logoUrl: '/media/logo.png' }), '/media/logo.png'); assert.equal(B.logoSrc({ logoUrl: 'http://evil/x.png' }), null); assert.equal(B.logoSrc({ logoUrl: '//evil/x.png' }), null);
  assert.equal(B.nameOf({ name_ar: 'عيادة', name_en: 'Clinic' }, 'en'), 'Clinic'); assert.equal(B.nameOf({ name_ar: 'عيادة' }, 'en'), 'عيادة'); assert.equal(B.nameOf(null, 'ar', 'x'), 'x');
});
test('motion: setRolling changes text only when different', () => {
  const M = require('../motion.js'); const el = { textContent: '3', classList: { remove() {}, add() {} }, offsetWidth: 0 };
  assert.equal(M.setRolling(el, 3), false); assert.equal(M.setRolling(el, 2), true); assert.equal(el.textContent, '2');
});
