// E2E against the REAL backend (accounts 1+2). Needs a freshly seeded DB; credentials come from the seed output:
//   QM_BASE=http://localhost:3000 QM_CREDS="staff1:<pw>,staff2:<pw>,manager:<pw>" CHROMIUM_PATH=... node e2e/real.e2e.js
const assert = require('node:assert/strict'); const fs = require('fs'); const os = require('os'); const path = require('path');
const { launch, staffClient, step, summary, BASE } = require('./helpers');
const SHOTS = process.env.SHOTS_DIR || path.join(__dirname, '..', '..', 'reports', 'acct-3', 'screens'); fs.mkdirSync(SHOTS, { recursive: true });
const creds = Object.fromEntries((process.env.QM_CREDS || '').split(',').filter(Boolean).map(x => { const i = x.indexOf(':'); return [x.slice(0, i), x.slice(i + 1)]; }));
if (!creds.staff1 || !creds.staff2 || !creds.manager) { console.error('QM_CREDS="staff1:pw,staff2:pw,manager:pw" is required'); process.exit(2); }
const QR = require('../shared/qr.js').create(require('../shared/vendor/qrcode.js'));
function makeQrY4m(text, file) {
  const W = 640, H = 480, m = QR.matrix(text), margin = 4, total = m.size + margin * 2, cell = Math.floor(Math.min(W, H) / total), off = [Math.floor((W - cell * total) / 2), Math.floor((H - cell * total) / 2)];
  const Y = Buffer.alloc(W * H, 255);
  for (let r = 0; r < m.size; r++) for (let c = 0; c < m.size; c++) if (m.isDark(r, c)) for (let dy = 0; dy < cell; dy++) for (let dx = 0; dx < cell; dx++) Y[(off[1] + (r + margin) * cell + dy) * W + off[0] + (c + margin) * cell + dx] = 0;
  const U = Buffer.alloc(W * H / 4, 128), parts = [Buffer.from(`YUV4MPEG2 W${W} H${H} F30:1 Ip A1:1 C420jpeg\n`)];
  for (let i = 0; i < 20; i++) parts.push(Buffer.from('FRAME\n'), Y, U, U); fs.writeFileSync(file, Buffer.concat(parts));
}
const J = { 'Content-Type': 'application/json' };
async function issue(prefix) {
  const clinic = (await (await fetch(BASE + '/api/public/clinic')).json()).data; const svc = clinic.services.find(s => s.prefix === prefix);
  const r = await (await fetch(BASE + '/api/public/tickets', { method: 'POST', headers: J, body: JSON.stringify({ serviceKey: svc.key }) })).json(); assert.ok(r.ok, JSON.stringify(r)); return r.data;
}

(async () => {
  const probe = await issue('A'); const y4m = path.join(os.tmpdir(), 'qm-real-qr.y4m'); makeQrY4m(`${BASE}/patient/?t=${probe.token}`, y4m);
  const browser = await launch(['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--use-file-for-fake-video-capture=' + y4m]);
  const mk = async (o = {}) => (await browser.newContext(Object.assign({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: 'ar-EG', permissions: ['camera'] }, o))).newPage();
  const pat = await mk(), stf = await mk();
  const external = [], errors = [];
  for (const p of [pat, stf]) { p.on('request', r => { const u = r.url(); if (!u.startsWith(BASE) && !/^(data|blob):/.test(u)) external.push(u); }); p.on('pageerror', e => errors.push(e.message)); p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|net::ERR/.test(m.text())) errors.push(m.text()); }); }
  const shot = (p, n, o = {}) => p.screenshot(Object.assign({ path: path.join(SHOTS, n + '.png') }, o));
  const login = async (p, u) => { await p.goto(BASE + '/staff/'); await p.waitForSelector('#login-form'); await p.fill('#lg-user', u); await p.fill('#lg-pass', creds[u]); await p.click('#login-form button[type=submit]'); await p.waitForSelector('#stat-waiting'); };
  const doBtn = (p, id, c = 'current') => p.locator(`[data-act="do"][data-id="${id}"][data-ctx="${c}"]`);
  let number, token;

  await step('REAL patient: clinic + services load from /api/public/clinic, issue C ticket, digital ticket shows', async () => {
    await pat.goto(BASE + '/patient/'); await pat.waitForSelector('[data-act="start"]'); assert.match(await pat.textContent('#brand-name'), /عيادة الأمل/);
    await pat.click('[data-act="start"]'); await pat.waitForSelector('.pt-svc'); assert.equal(await pat.locator('.pt-svc').count(), 4);
    await pat.locator('.pt-svc', { hasText: 'تحاليل' }).click(); await pat.click('[data-act="issue"]'); await pat.waitForSelector('.pt-success');
    number = (await pat.textContent('.pt-success .pt-bignum')).trim(); assert.match(number, /^C-\d{3}$/); assert.match(await pat.textContent('.pt-success'), /تحاليل/);
    await pat.click('[data-act="open-ticket"]'); await pat.waitForSelector('.pt-qr svg'); token = await pat.evaluate(() => JSON.parse(localStorage.getItem('qm.patient.ticket')).token);
    assert.match(await pat.textContent('.pt-ticket__service'), /تحاليل/); await shot(pat, 'real-patient-ar-1-waiting');
  });
  await step('REAL staff2 (skip/return+cancel, no transfer): login, default counter 2, desk loads', async () => {
    await login(stf, 'staff2'); assert.match(await stf.textContent('.st-chip'), /شباك 2/); assert.match(await stf.textContent('#st-header'), /موظف الفحص/);
  });
  await step('REAL call-next: our ticket is called; patient sees it live with the counter; buttons follow permissions', async () => {
    for (let i = 0; i < 15; i++) {
      await stf.click('[data-act="do"][data-id="call-next"]'); await stf.waitForSelector('#cur-num'); const n = (await stf.textContent('#cur-num')).trim(); if (n === number) break;
      await doBtn(stf, 'start').click(); await stf.waitForFunction(() => /قيد الخدمة/.test(document.querySelector('.st-cur .qm-badge').textContent)); await doBtn(stf, 'complete').click(); await stf.waitForSelector('.st-cur__num--empty');
    }
    assert.equal((await stf.textContent('#cur-num')).trim(), number);
    for (const b of ['start', 'recall', 'skip', 'cancel']) assert.equal(await doBtn(stf, b).count(), 1, b); assert.equal(await doBtn(stf, 'transfer').count(), 0);
    const t0 = Date.now(); await pat.waitForSelector('.pt-alert--called', { timeout: 8000 }); assert.ok(Date.now() - t0 < 3000, 'socket push, not polling: ' + (Date.now() - t0) + 'ms'); assert.match(await pat.textContent('.pt-alert--called'), /شباك 2/);
    assert.match(await pat.textContent('.pt-meta'), /تحديث فوري/); assert.match(await stf.getAttribute('.qm-conn', 'class'), /qm-conn--online/); await shot(pat, 'real-patient-ar-2-called'); await shot(stf, 'real-staff-ar-1-called');
  });
  await step('REAL recall -> still called; start -> serving (patient live); lookup + verify show the same ticket', async () => {
    await doBtn(stf, 'recall').click(); await stf.waitForFunction(() => /أُعيد نداء/.test(document.body.textContent));
    await doBtn(stf, 'start').click(); await pat.waitForSelector('.pt-alert--serving', { timeout: 8000 });
    await stf.fill('#lookup-input', number.toLowerCase().replace('-', '')); await stf.click('[data-act="lookup"]'); await stf.waitForSelector('#lookup-result'); assert.match(await stf.textContent('#lookup-result'), /قيد الخدمة/);
  });
  await step('REAL INVALID_TRANSITION: ticket cancelled elsewhere, stale UI action gives a clear message', async () => {
    await stf.route('**/api/queue/state*', r => r.abort());
    const mgr = staffClient('manager', creds.manager); await mgr.login(); const id = (await mgr.call('GET', '/api/queue/lookup?number=' + number)).data.ticket.publicId;
    const cancel = await mgr.call('POST', `/api/queue/tickets/${id}/cancel`, { reason: 'e2e' }); assert.ok(cancel.ok, JSON.stringify(cancel));
    await stf.evaluate(() => document.querySelectorAll('.qm-toast').forEach(e => e.remove())); await doBtn(stf, 'complete').click();
    await stf.waitForFunction(() => /لا يمكن تنفيذ هذا الإجراء|تعذّر تنفيذ الطلب/.test(document.body.textContent), null, { timeout: 6000 });
    await stf.unroute('**/api/queue/state*'); await stf.waitForSelector('.st-cur__num--empty', { timeout: 12000 }); await pat.waitForSelector('.pt-alert--cancelled', { timeout: 8000 });
  });
  await step('REAL camera QR scan verifies a ticket by its link token', async () => {
    await stf.click('[data-act="clear-lookup"]').catch(() => {}); await stf.click('[data-act="scan"]'); await stf.waitForSelector('#scan-video'); await stf.waitForSelector('#lookup-result', { timeout: 15000 });
    assert.equal((await stf.textContent('#lookup-result .st-result__num')).trim(), probe.ticket.number); await shot(stf, 'real-staff-ar-2-verified');
  });
  await step('REAL skip + return by a user who has can_skip_return (staff2) via lookup', async () => {
    await stf.click('[data-act="clear-lookup"]').catch(() => {}); const t2 = await issue('C'); const n = t2.ticket.number;
    for (let i = 0; i < 15; i++) {
      await stf.waitForSelector('[data-act="do"][data-id="call-next"]'); await stf.click('[data-act="do"][data-id="call-next"]'); await stf.waitForSelector('#cur-num'); if ((await stf.textContent('#cur-num')).trim() === n) break;
      await doBtn(stf, 'start').click(); await stf.waitForFunction(() => /قيد الخدمة/.test(document.querySelector('.st-cur .qm-badge').textContent)); await doBtn(stf, 'complete').click(); await stf.waitForSelector('.st-cur__num--empty');
    }
    await doBtn(stf, 'skip').click(); await stf.click('.qm-modal__actions .qm-btn:last-child'); await stf.waitForSelector('.st-cur__num--empty');
    await stf.fill('#lookup-input', n); await stf.click('[data-act="lookup"]'); await stf.waitForSelector('#lookup-result'); assert.match(await stf.textContent('#lookup-result'), /تم التخطي/);
    await doBtn(stf, 'return', 'lookup').click(); await stf.waitForFunction(() => /أُعيدت/.test(document.body.textContent));
  });
  await step('REAL transfer is hidden for staff2; manager sees cancel+transfer', async () => {
    const m = await mk(); await login(m, 'manager'); await issue('A'); await m.waitForFunction(() => document.querySelectorAll('.st-list li').length >= 1, null, { timeout: 8000 });
    await m.click('[data-act="do"][data-id="call-next"]'); await m.waitForSelector('#cur-num'); assert.equal(await doBtn(m, 'cancel').count(), 1); assert.equal(await doBtn(m, 'transfer').count(), 1);
    await doBtn(m, 'transfer').click(); await m.waitForSelector('#tr-svc'); assert.ok(await m.locator('#tr-svc option').count() >= 1); await shot(m, 'real-staff-ar-3-manager-transfer');
    await m.selectOption('#tr-svc', { index: 0 }); await m.click('.qm-modal__actions .qm-btn:last-child');       // REAL transfer: serviceId from the login payload
    await m.waitForSelector('.st-cur__num--empty'); await m.waitForFunction(() => /حُوّلت/.test(document.body.textContent)); await m.context().close();
  });
  await step('REAL staff1 (no extra permissions): only start/recall/skip', async () => {
    const s1 = await mk(); await login(s1, 'staff1'); await issue('A'); await s1.waitForFunction(() => document.querySelectorAll('.st-list li').length >= 1, null, { timeout: 8000 });
    await s1.click('[data-act="do"][data-id="call-next"]'); await s1.waitForSelector('#cur-num');
    for (const b of ['cancel', 'transfer']) assert.equal(await doBtn(s1, b).count(), 0, b); for (const b of ['start', 'recall', 'skip']) assert.equal(await doBtn(s1, b).count(), 1, b);
    await doBtn(s1, 'skip').click(); await s1.click('.qm-modal__actions .qm-btn:last-child'); await s1.waitForSelector('.st-cur__num--empty'); await s1.context().close();
  });
  await step('REAL SMS not configured -> friendly message; recover rules (4 digits required, unknown -> not found)', async () => {
    const t = await issue('B'); const p = await mk(); await p.goto(BASE + '/patient/?t=' + t.token); await p.waitForSelector('#tk-number');
    await p.click('#sms-details summary'); await p.fill('#sms-phone', '+201001234567'); await p.click('[data-act="sms"]'); await p.waitForSelector('#sms-err'); assert.match(await p.textContent('#sms-err'), /غير مفعّلة|الرسائل/);
    await p.click('[data-act="recover"]'); await p.fill('#rec-number', t.ticket.number); await p.click('[data-act="do-recover"]'); await p.waitForFunction(() => /4 أرقام/.test(document.body.textContent));
    await p.fill('#rec-last4', '1234'); await p.click('[data-act="do-recover"]'); await p.waitForFunction(() => /لم نجد/.test(document.body.textContent)); await p.context().close();
  });
  await step('REAL English/LTR screenshots with live data (patient ticket + staff desk)', async () => {
    const t = await issue('B'); const p = await mk({ locale: 'en-GB' }); await p.goto(BASE + '/patient/?t=' + t.token); await p.waitForSelector('#tk-number'); await p.click('.qm-lang button[data-lang="en"]');
    assert.match(await p.textContent('.pt-ticket__service'), /Consultation/); await shot(p, 'real-patient-en-1-waiting', { fullPage: true }); await p.context().close();
    await stf.click('.qm-lang button[data-lang="en"]'); assert.match(await stf.textContent('[data-act="do"][data-id="call-next"]'), /Call next/); assert.match(await stf.textContent('.st-chip'), /Counter 2/); await shot(stf, 'real-staff-en-1-desk'); await stf.click('.qm-lang button[data-lang="ar"]');
  });
  await step('REAL session: logout ends the session; protected endpoint answers 401', async () => {
    await stf.click('[data-act="logout"]'); await stf.waitForSelector('.qm-modal'); await stf.click('.qm-modal__actions .qm-btn:last-child'); await stf.waitForSelector('#login-form');
    const me = await stf.context().request.get(BASE + '/api/auth/me'); assert.equal(me.status(), 401);
    await login(stf, 'staff1'); await stf.context().clearCookies(); await stf.click('[data-act="do"][data-id="call-next"]').catch(() => {}); await stf.waitForSelector('#login-form', { timeout: 8000 }); assert.match(await stf.textContent('.qm-banner--error'), /انتهت جلستك/);
  });
  await step('REAL: no external requests, no console/page errors', async () => { assert.deepEqual(external, []); assert.deepEqual(errors, []); });
  await browser.close(); process.exit(summary());
})();
