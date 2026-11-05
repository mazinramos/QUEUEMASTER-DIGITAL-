const assert = require('node:assert/strict'); const fs = require('fs'); const os = require('os'); const path = require('path');
const { launch, staffClient, step, summary, dev, BASE } = require('./helpers');
const SHOTS = process.env.SHOTS_DIR || path.join(__dirname, '..', '..', 'reports', 'acct-3', 'screens'); fs.mkdirSync(SHOTS, { recursive: true });
const QR = require('../shared/qr.js').create(require('../shared/vendor/qrcode.js'));

/* a Y4M clip of a QR code so Chromium's fake camera "shows" it to the scanner (real decode path: BarcodeDetector or the local jsQR) */
function makeQrY4m(text, file) {
  const W = 640, H = 480, m = QR.matrix(text), margin = 4, total = m.size + margin * 2, cell = Math.floor(Math.min(W, H) / total), off = [Math.floor((W - cell * total) / 2), Math.floor((H - cell * total) / 2)];
  const Y = Buffer.alloc(W * H, 255);
  for (let r = 0; r < m.size; r++) for (let c = 0; c < m.size; c++) if (m.isDark(r, c)) for (let dy = 0; dy < cell; dy++) for (let dx = 0; dx < cell; dx++) Y[(off[1] + (r + margin) * cell + dy) * W + off[0] + (c + margin) * cell + dx] = 0;
  const U = Buffer.alloc(W * H / 4, 128), parts = [Buffer.from(`YUV4MPEG2 W${W} H${H} F30:1 Ip A1:1 C420jpeg\n`)];
  for (let i = 0; i < 20; i++) parts.push(Buffer.from('FRAME\n'), Y, U, U);
  fs.writeFileSync(file, Buffer.concat(parts));
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  // a real ticket whose QR the fake camera will show
  const issued = await (await fetch(BASE + '/api/public/tickets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ serviceKey: 'svc-c' }) })).json();
  const scanToken = issued.data.token, scanNumber = issued.data.ticket.number;
  const y4m = path.join(os.tmpdir(), 'qm-qr.y4m'); makeQrY4m(`${BASE}/patient/?t=${scanToken}`, y4m);

  const browser = await launch(['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--use-file-for-fake-video-capture=' + y4m]);
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: 'ar-EG', permissions: ['camera'] });
  const page = await ctx.newPage();
  const external = [], consoleErrors = [], stateReqs = [];
  page.on('request', r => { const u = r.url(); if (!u.startsWith(BASE) && !u.startsWith('data:') && !u.startsWith('blob:')) external.push(u); if (/\/api\/queue\/state/.test(u)) stateReqs.push(u); });
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', e => consoleErrors.push('pageerror: ' + e.message));
  const shot = (n, p = page, o = {}) => p.screenshot(Object.assign({ path: path.join(SHOTS, n + '.png') }, o));
  const toastText = async () => (await page.locator('.qm-toast').last().textContent()).trim();
  const cur = () => page.locator('#cur-num');
  const doBtn = (id, ctxName = 'current') => page.locator(`[data-act="do"][data-id="${id}"][data-ctx="${ctxName}"]`);
  const login = async (u, p) => { await page.fill('#lg-user', u); await page.fill('#lg-pass', p); await page.click('#login-form button[type=submit]'); };
  const clearToasts = () => page.evaluate(() => document.querySelectorAll('.qm-toast').forEach(e => e.remove()));

  await step('login screen: Arabic RTL, empty and wrong credentials rejected with clear messages', async () => {
    await page.goto(BASE + '/staff/'); await page.waitForSelector('#login-form');
    assert.equal(await page.getAttribute('html', 'dir'), 'rtl'); await shot('staff-ar-1-login');
    await page.click('#login-form button[type=submit]'); await page.waitForSelector('.qm-banner--error'); assert.match(await page.textContent('.qm-banner--error'), /أدخل اسم المستخدم/);
    await login('staff', 'wrong'); await page.waitForFunction(() => /غير صحيحة/.test(document.body.textContent));
    await page.click('[data-act="toggle-pass"]'); assert.equal(await page.getAttribute('#lg-pass', 'type'), 'text');
  });
  await step('login as staff (no extra permissions) opens the desk on the default counter', async () => {
    await page.fill('#lg-pass', 'staff123'); await page.click('#login-form button[type=submit]'); await page.waitForSelector('#stat-waiting');
    assert.match(await page.textContent('#st-header'), /نور الهدى/); assert.match(await page.textContent('.st-chip'), /شباك 1/);
  });
  await step('live: new tickets appear without reload (socket) and counts update', async () => {
    const before = Number((await page.textContent('#stat-waiting')).trim());
    await dev('/dev/seed', { count: 3, serviceKey: 'svc-a' }); await dev('/dev/seed', { count: 1, serviceKey: 'svc-b' });
    await page.waitForFunction(b => Number(document.querySelector('#stat-waiting').textContent) === b + 4, before, { timeout: 7000 });
    assert.ok(await page.locator('.st-list li').count() >= 4); assert.match(await page.textContent('#st-header'), /مباشر/); await shot('staff-ar-2-desk-waiting');
  });
  let first;
  await step('call next: current ticket shown with only the buttons allowed for this account', async () => {
    await page.click('[data-act="do"][data-id="call-next"]'); await page.waitForSelector('#cur-num');
    first = (await cur().textContent()).trim(); assert.match(first, /^[AB]-\d{3}$/);
    assert.equal(await doBtn('start').count(), 1); assert.equal(await doBtn('recall').count(), 1); assert.equal(await doBtn('skip').count(), 1);
    assert.equal(await doBtn('cancel').count(), 0, 'no cancel without can_cancel'); assert.equal(await doBtn('transfer').count(), 0, 'no transfer without can_transfer');
    assert.match(await page.textContent('.st-timer'), /\d\d:\d\d/); await shot('staff-ar-3-desk-called');
  });
  await step('recall keeps the ticket called; start -> serving; complete -> back to empty', async () => {
    await doBtn('recall').click(); await page.waitForFunction(() => /أُعيد نداء/.test(document.body.textContent)); assert.match(await page.textContent('.st-cur .qm-badge'), /تم النداء/);
    await doBtn('start').click(); await page.waitForFunction(() => /قيد الخدمة/.test(document.querySelector('.st-cur .qm-badge').textContent));
    assert.equal(await doBtn('complete').count(), 1); await shot('staff-ar-4-desk-serving');
    await doBtn('complete').click(); await page.waitForSelector('.st-cur__num--empty'); assert.equal(await page.locator('[data-act="do"][data-id="call-next"]').count(), 1);
  });
  await step('skip asks for confirmation; skipped ticket cannot be returned without can_skip_return', async () => {
    await page.click('[data-act="do"][data-id="call-next"]'); await page.waitForSelector('#cur-num'); const n = (await cur().textContent()).trim();
    await doBtn('skip').click(); await page.waitForSelector('.qm-modal'); assert.match(await page.textContent('.qm-modal'), new RegExp(n)); await page.click('.qm-modal__actions .qm-btn:last-child');
    await page.waitForSelector('.st-cur__num--empty'); await page.waitForSelector('#sk-h'); assert.match(await page.textContent('#sk-h'), /المتخطّاة/);
    assert.equal(await page.locator('[data-act="do"][data-id="return"]').count(), 0);
    await page.fill('#lookup-input', n.toLowerCase().replace('-', '')); await page.click('[data-act="lookup"]'); await page.waitForSelector('#lookup-result');
    assert.match(await page.textContent('#lookup-result'), /تم التخطي/); assert.equal(await page.locator('#lookup-result [data-act="do"]').count(), 0);
  });
  await step('invalid lookup input shows a message; unknown ticket shows not-found', async () => {
    await page.fill('#lookup-input', 'hello'); await page.click('[data-act="lookup"]'); await page.waitForFunction(() => /أدخل رقماً صحيحاً/.test(document.body.textContent));
    await page.fill('#lookup-input', 'Z-999'); await page.click('[data-act="lookup"]'); await page.waitForFunction(() => /غير موجود/.test(document.body.textContent));
  });
  await step('service filter: calling from a chosen service only', async () => {
    await page.selectOption('#svc-filter', '2'); await page.click('[data-act="do"][data-id="call-next"]'); await page.waitForSelector('#cur-num');
    assert.match((await cur().textContent()).trim(), /^B-/); await doBtn('start').click(); await page.waitForFunction(() => /قيد الخدمة/.test(document.querySelector('.st-cur .qm-badge').textContent)); await doBtn('complete').click(); await page.waitForSelector('.st-cur__num--empty');
  });
  await step('INVALID_TRANSITION (ticket changed elsewhere) shows a clear message and the desk refreshes', async () => {
    await page.selectOption('#svc-filter', ''); await page.click('[data-act="do"][data-id="call-next"]'); await page.waitForSelector('#cur-num'); const n = (await cur().textContent()).trim();
    await page.route('**/api/queue/state*', r => r.abort());                       // keep the UI stale on purpose
    const mgr = staffClient(); await mgr.login(); const id = (await mgr.call('GET', '/api/queue/lookup?number=' + n)).data.ticket.publicId; await mgr.call('POST', `/api/queue/tickets/${id}/cancel`, {});
    await clearToasts(); await doBtn('start').click(); await page.waitForFunction(() => /لا يمكن تنفيذ هذا الإجراء/.test(document.body.textContent), null, { timeout: 5000 });
    await page.unroute('**/api/queue/state*'); await page.waitForSelector('.st-cur__num--empty', { timeout: 12000 });
  });
  await step('ALREADY_CALLED and QUEUE_EMPTY map to understandable messages', async () => {
    await page.route('**/api/queue/call-next', r => r.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { code: 'ALREADY_CALLED', message: 'x' } }) }));
    await clearToasts(); await page.click('[data-act="do"][data-id="call-next"]'); await page.waitForFunction(() => /تم نداء هذه التذكرة بالفعل/.test(document.body.textContent)); await page.unroute('**/api/queue/call-next');
    await page.route('**/api/queue/call-next', r => r.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { code: 'QUEUE_EMPTY', message: 'x' } }) }));
    await clearToasts(); await page.click('[data-act="do"][data-id="call-next"]'); await page.waitForFunction(() => /لا يوجد منتظرون الآن/.test(document.body.textContent)); await page.unroute('**/api/queue/call-next');
  });
  await step('QR scan with the camera decodes the ticket link and verifies the ticket', async () => {
    await page.click('[data-act="scan"]'); await page.waitForSelector('#scan-video');
    await page.waitForSelector('#lookup-result', { timeout: 15000 }); assert.equal((await page.textContent('#lookup-result .st-result__num')).trim(), scanNumber);
  });
  await step('scan modal falls back to manual entry when the camera is unavailable', async () => {
    await page.evaluate(() => { Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true }); });
    await page.click('[data-act="scan"]'); await page.waitForSelector('#scan-hint'); assert.match(await page.textContent('#scan-hint'), /HTTPS|الكاميرا/); await shot('staff-ar-6-scan-fallback');
    await page.fill('#scan-manual', `${BASE}/patient/?t=${scanToken}`); await page.keyboard.press('Enter'); await page.waitForSelector('#lookup-result'); assert.equal((await page.textContent('#lookup-result .st-result__num')).trim(), scanNumber);
  });
  await step('change counter (two counters): header chip updates and state is requested for that counter', async () => {
    await page.click('[data-act="change-counter"]'); await page.waitForSelector('.qm-modal [data-pick]'); await page.click('.qm-modal [data-pick="2"]');
    await page.waitForFunction(() => /شباك 2/.test(document.querySelector('.st-chip').textContent)); await page.waitForTimeout(500);
    assert.ok(stateReqs.some(u => /counterId=2/.test(u)), 'state requested with counterId=2');
  });
  await step('session expiry: next action returns to the login screen with an explanation', async () => {
    await ctx.clearCookies(); await page.click('[data-act="do"][data-id="call-next"]'); await page.waitForSelector('#login-form', { timeout: 8000 });
    assert.match(await page.textContent('.qm-banner--error'), /انتهت جلستك/); assert.equal(await page.locator('#st-header').isVisible(), false);
  });
  await step('manager: cancel (with reason), transfer, return of a skipped ticket are available', async () => {
    await login('manager', 'manager123'); await page.waitForSelector('#stat-waiting');
    await dev('/dev/seed', { count: 3, serviceKey: 'svc-a' }); await page.waitForFunction(() => document.querySelectorAll('.st-list li').length >= 3);
    await page.click('[data-act="do"][data-id="call-next"]'); await page.waitForSelector('#cur-num');
    assert.equal(await doBtn('cancel').count(), 1); assert.equal(await doBtn('transfer').count(), 1); await shot('staff-ar-5-desk-manager');
    await doBtn('transfer').click(); await page.waitForSelector('#tr-svc'); assert.equal(await page.locator('#tr-svc option').count(), 2); await page.selectOption('#tr-svc', { index: 1 }); await page.click('.qm-modal__actions .qm-btn:last-child');
    await page.waitForSelector('.st-cur__num--empty'); assert.match(await toastText(), /حُوّلت/);
    await page.click('[data-act="do"][data-id="call-next"]'); await page.waitForSelector('#cur-num'); const n = (await cur().textContent()).trim();
    await doBtn('cancel').click(); await page.waitForSelector('#cx-reason'); await page.fill('#cx-reason', 'مريض غادر'); await page.click('.qm-modal__actions .qm-btn:last-child');
    await page.waitForSelector('.st-cur__num--empty'); assert.match(await toastText(), new RegExp('أُلغيت ' + n));
    await page.click('[data-act="do"][data-id="call-next"]'); await page.waitForSelector('#cur-num'); const m = (await cur().textContent()).trim();
    await doBtn('skip').click(); await page.click('.qm-modal__actions .qm-btn:last-child'); await page.waitForSelector('.st-cur__num--empty');
    await page.waitForSelector(`[data-act="do"][data-id="return"][data-ctx^="sk:"]`); await page.locator(`[data-act="do"][data-id="return"][data-ctx^="sk:"]`).first().click();
    await page.waitForFunction(() => /أُعيدت/.test(document.body.textContent));
  });
  await step('English / LTR layout of the desk', async () => {
    await page.click('.qm-lang button[data-lang="en"]'); assert.equal(await page.getAttribute('html', 'dir'), 'ltr');
    await page.waitForFunction(() => /Waiting list/.test(document.body.textContent)); assert.match(await page.textContent('[data-act="do"][data-id="call-next"]'), /Call next/); await shot('staff-en-1-desk');
  });
  await step('connection loss: warning banner shows, recovers automatically', async () => {
    await dev('/dev/offline', { on: true }); await page.waitForSelector('#conn-banner .qm-banner--warn', { timeout: 15000 }); await shot('staff-en-2-offline');
    await fetch(BASE + '/dev/offline', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"on":false}' });
    await page.waitForFunction(() => !document.querySelector('#conn-banner .qm-banner'), null, { timeout: 15000 });
  });
  await step('desktop layout (1280x800) and tablet', async () => {
    const d = await (await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'ar-EG' })).newPage();
    await d.goto(BASE + '/staff/'); await d.fill('#lg-user', 'manager'); await d.fill('#lg-pass', 'manager123'); await d.click('#login-form button[type=submit]'); await d.waitForSelector('#stat-waiting');
    await d.click('[data-act="do"][data-id="call-next"]').catch(() => {}); await d.waitForTimeout(600);
    assert.ok(await d.locator('.st-grid').evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length === 2), 'two columns on desktop');
    await shot('staff-ar-7-desktop', d, { fullPage: true }); await d.context().close();
  });
  await step('logout asks for confirmation and ends the session', async () => {
    await page.click('[data-act="logout"]'); await page.waitForSelector('.qm-modal'); await page.click('.qm-modal__actions .qm-btn:last-child'); await page.waitForSelector('#login-form');
    const me = await ctx.request.get(BASE + '/api/auth/me'); assert.equal(me.status(), 401);
  });
  await step('no external requests and no unexpected console errors', async () => {
    assert.deepEqual(external, []); const real = consoleErrors.filter(e => !/net::ERR|Failed to load resource|ERR_/.test(e)); assert.deepEqual(real, []);
  });
  await browser.close(); process.exit(summary());
})();
