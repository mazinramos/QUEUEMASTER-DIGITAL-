const assert = require('node:assert/strict'); const fs = require('fs'); const path = require('path');
const { launch, staffClient, step, summary, dev, BASE } = require('./helpers');
const SHOTS = process.env.SHOTS_DIR || path.join(__dirname, '..', '..', 'reports', 'acct-3', 'screens');
fs.mkdirSync(SHOTS, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, acceptDownloads: true, locale: 'ar-EG' });
  const page = await ctx.newPage();
  const external = [], consoleErrors = [];
  page.on('request', r => { const u = r.url(); if (!u.startsWith(BASE) && !u.startsWith('data:') && !u.startsWith('blob:')) external.push(u); });
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', e => consoleErrors.push('pageerror: ' + e.message));
  const shot = (n) => page.screenshot({ path: path.join(SHOTS, n + '.png') });

  await step('welcome renders in Arabic RTL with local fonts only', async () => {
    await page.goto(BASE + '/patient/'); await page.waitForSelector('[data-act="start"]');
    assert.equal(await page.getAttribute('html', 'dir'), 'rtl'); assert.equal(await page.getAttribute('html', 'lang'), 'ar');
    assert.match(await page.textContent('.pt-h1'), /أهلاً بك/);
    const fonts = await page.evaluate(async () => { await document.fonts.ready; return [...document.fonts].filter(f => f.status === 'loaded').map(f => f.family.replace(/"/g, '')); });
    assert.ok(fonts.some(f => /IBM Plex Sans Arabic/.test(f)), 'Plex Arabic loaded: ' + fonts);
    await shot('patient-ar-1-welcome');
  });
  await step('services list shows waiting counts; issue disabled until a service is picked', async () => {
    await dev('/dev/seed', { count: 2, serviceKey: 'svc-a' });
    await page.click('[data-act="start"]'); await page.waitForSelector('.pt-svc');
    assert.equal(await page.locator('.pt-svc').count(), 3);
    assert.equal(await page.isDisabled('[data-act="issue"]'), true);
    assert.match(await page.locator('.pt-svc').first().textContent(), /في الانتظار/);
    await page.click('.pt-svc >> nth=0'); assert.equal(await page.isDisabled('[data-act="issue"]'), false);
    await shot('patient-ar-2-services');
  });
  let number;
  await step('issuing shows the success screen with the ticket number', async () => {
    await page.click('[data-act="issue"]'); await page.waitForSelector('.pt-success');
    assert.match(await page.textContent('.pt-h1'), /تم إصدار تذكرتك بنجاح/);
    number = (await page.textContent('.pt-success .pt-bignum')).trim(); assert.match(number, /^A-\d{3}$/);
    await shot('patient-ar-3-success');
  });
  await step('digital ticket: number, QR, status, ahead/wait; saved in localStorage', async () => {
    await page.click('[data-act="open-ticket"]'); await page.waitForSelector('.pt-ticket .pt-qr svg');
    assert.equal((await page.textContent('#tk-number')).trim(), number);
    assert.match(await page.textContent('.pt-ticket .qm-badge'), /في الانتظار/);
    assert.match(await page.textContent('.pt-stats'), /من قبلك/);
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('qm.patient.ticket')));
    assert.equal(stored.number, number); assert.ok(stored.token.length >= 16);
    assert.equal(await page.evaluate(() => location.search), '', 'no token left in the URL');
    await shot('patient-ar-4-ticket-waiting');
  });
  await step('reload restores the same ticket (no new issue)', async () => {
    await page.reload(); await page.waitForSelector('#tk-number'); assert.equal((await page.textContent('#tk-number')).trim(), number);
  });
  await step('saved ticket image in Arabic renders RTL text (visual sample kept in reports)', async () => {
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('[data-act="save"]')]);
    const p = await dl.path(); assert.ok(fs.statSync(p).size > 20000); fs.copyFileSync(p, path.join(SHOTS, 'patient-ar-saved-ticket-image.png'));
  });
  await step('QR link ?t=<token> opens the ticket on a fresh device and strips the token from the URL', async () => {
    const token = await page.evaluate(() => JSON.parse(localStorage.getItem('qm.patient.ticket')).token);
    const p2 = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
    await p2.goto(BASE + '/patient/?t=' + token); await p2.waitForSelector('#tk-number');
    assert.equal((await p2.textContent('#tk-number')).trim(), number); assert.equal(await p2.evaluate(() => location.search), '');
    await p2.context().close();
  });
  await step('live: staff calls the ticket -> patient sees "your turn" without reloading (socket)', async () => {
    const staff = staffClient(); await staff.login();
    // call tickets ahead of us first, then ours
    for (let i = 0; i < 10; i++) {
      const r = await staff.call('POST', '/api/queue/call-next', { counterId: 1, serviceId: 1 });
      if (!r.ok) throw new Error('call-next failed ' + JSON.stringify(r));
      if (r.data.ticket.number === number) break;
      const id = r.data.ticket.publicId; await staff.call('POST', `/api/queue/tickets/${id}/start`, {}); await staff.call('POST', `/api/queue/tickets/${id}/complete`, {});
    }
    await page.waitForSelector('.pt-alert--called', { timeout: 6000 });
    assert.match(await page.textContent('.pt-alert--called'), /حان دورك.*شباك 1/);
    assert.match(await page.title(), /حان دورك/);
    await shot('patient-ar-5-ticket-called');
    const id = (await staff.call('GET', '/api/queue/lookup?number=' + number)).data.ticket.publicId;
    await staff.call('POST', `/api/queue/tickets/${id}/start`, {}); await page.waitForSelector('.pt-alert--serving', { timeout: 6000 });
  });
  await step('connection loss: warning banner with last-update time, cached ticket stays visible, recovers automatically', async () => {
    await dev('/dev/offline', { on: true }); await dev('/dev/drop-sockets').catch(() => {});
    await page.waitForSelector('#conn-banner .qm-banner--warn', { timeout: 9000 });
    assert.match(await page.textContent('#conn-banner'), /لا يوجد اتصال/); assert.equal((await page.textContent('#tk-number')).trim(), number);
    await shot('patient-ar-6-offline');
    await fetch(BASE + '/dev/offline', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"on":false}' }).catch(() => {});
  });
  await step('after recovery the banner disappears', async () => { await page.waitForFunction(() => !document.querySelector('#conn-banner .qm-banner'), null, { timeout: 12000 }); });
  await step('language switch to English: ltr, texts translated, number unchanged', async () => {
    await page.click('.qm-lang button[data-lang="en"]');
    assert.equal(await page.getAttribute('html', 'dir'), 'ltr'); assert.equal(await page.getAttribute('html', 'lang'), 'en');
    assert.match(await page.textContent('.pt-alert'), /being served/); assert.equal((await page.textContent('#tk-number')).trim(), number);
    await shot('patient-en-1-ticket-serving');
  });
  await step('SMS (optional): invalid phone rejected, valid accepted, phone not stored locally', async () => {
    await page.click('#sms-details summary'); await page.fill('#sms-phone', '12'); await page.click('[data-act="sms"]');
    await page.waitForSelector('#sms-err'); await page.fill('#sms-phone', '+20 100 123 4567'); await page.click('[data-act="sms"]');
    await page.waitForSelector('.qm-banner--ok'); assert.match(await page.textContent('#sms-details'), /Requested/);
    const dump = await page.evaluate(() => JSON.stringify(localStorage)); assert.ok(!/1001234567/.test(dump));
  });
  await step('save as image: downloads a real PNG of the ticket', async () => {
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('[data-act="save"]')]);
    const p = await dl.path(); const buf = fs.readFileSync(p);
    assert.equal(buf.slice(1, 4).toString(), 'PNG'); assert.ok(buf.length > 20000, 'png size ' + buf.length); assert.match(dl.suggestedFilename(), /^ticket-A-\d{3}\.png$/);
    fs.copyFileSync(p, path.join(SHOTS, 'patient-saved-ticket-image.png'));
  });
  await step('print / PDF sheet: print stylesheet shows only the ticket sheet', async () => {
    await page.evaluate(() => { window.__printed = 0; window.print = () => { window.__printed++; }; });
    await page.click('[data-act="print"]'); await page.waitForFunction(() => window.__printed === 1);
    await page.emulateMedia({ media: 'print' });
    assert.equal(await page.isVisible('.pt-shell'), false); assert.equal(await page.isVisible('#print-sheet .ps-num'), true);
    assert.match(await page.textContent('#print-sheet .ps-num'), /A-\d{3}/); assert.ok(await page.locator('#print-sheet svg').count() === 1);
    const pdf = await page.pdf({ format: 'A4' }); assert.equal(pdf.slice(0, 4).toString(), '%PDF'); fs.writeFileSync(path.join(SHOTS, 'patient-print-sample.pdf'), pdf);
    await page.emulateMedia({ media: 'screen' });
  });
  await step('share falls back to copying the link when navigator.share is missing', async () => {
    await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
    await page.evaluate(() => { Object.defineProperty(navigator, 'share', { value: undefined, configurable: true }); });
    await page.click('[data-act="share"]'); await page.waitForSelector('.qm-toast');
    const clip = await page.evaluate(() => navigator.clipboard.readText()); assert.match(clip, /\/patient\/\?t=[0-9a-f]{16,}/);
  });
  await step('share uses navigator.share when available', async () => {
    await page.evaluate(() => { window.__shared = null; Object.defineProperty(navigator, 'share', { value: async d => { window.__shared = d; }, configurable: true }); });
    await page.click('[data-act="share"]'); await page.waitForFunction(() => window.__shared);
    assert.match(await page.evaluate(() => window.__shared.url), /\/patient\/\?t=/);
  });
  await step('finished ticket offers a new ticket; completed state shown', async () => {
    const staff = staffClient(); await staff.login(); const id = (await staff.call('GET', '/api/queue/lookup?number=' + number)).data.ticket.publicId;
    await staff.call('POST', `/api/queue/tickets/${id}/complete`, {}); await page.waitForSelector('.pt-alert--completed', { timeout: 6000 });
    assert.match(await page.textContent('.pt-alert--completed'), /complete/i);
  });
  await step('recover: wrong number -> not found; right number -> ticket opens', async () => {
    const p3 = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
    await p3.goto(BASE + '/patient/'); await p3.waitForSelector('[data-act="recover"]'); await p3.click('[data-act="recover"]');
    await p3.fill('#rec-number', 'zz'); await p3.fill('#rec-last4', '4567'); await p3.click('[data-act="do-recover"]'); await p3.waitForSelector('.qm-banner--error');
    await p3.fill('#rec-number', number); await p3.fill('#rec-last4', ''); await p3.click('[data-act="do-recover"]'); await p3.waitForFunction(() => /4 أرقام/.test(document.querySelector('.qm-banner--error').textContent));
    await p3.fill('#rec-last4', '4567');
    await p3.fill('#rec-number', 'Z-999'); await p3.fill('#rec-last4', '4567'); await p3.click('[data-act="do-recover"]'); await p3.waitForFunction(() => /لم نجد/.test(document.body.textContent));
    await p3.fill('#rec-number', number.toLowerCase().replace('-', '')); await p3.fill('#rec-last4', '4567'); await p3.click('[data-act="do-recover"]'); await p3.waitForSelector('#tk-number');
    assert.equal((await p3.textContent('#tk-number')).trim(), number); await p3.context().close();
  });
  await step('unknown/expired token shows the expired notice and returns to welcome', async () => {
    const p4 = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
    await p4.goto(BASE + '/patient/?t=deadbeefdeadbeefdeadbeef'); await p4.waitForSelector('.qm-banner--info', { timeout: 8000 });
    assert.match(await p4.textContent('.qm-banner--info'), /لم نعد نجد/); await p4.waitForSelector('[data-act="start"]');
    await p4.context().close();
  });
  await step('English welcome/services screenshots (LTR design)', async () => {
    const p5 = await (await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 })).newPage();
    await p5.goto(BASE + '/patient/'); await p5.waitForSelector('[data-act="start"]'); await p5.click('.qm-lang button[data-lang="en"]');
    await p5.screenshot({ path: path.join(SHOTS, 'patient-en-0-welcome.png') });
    await p5.click('[data-act="start"]'); await p5.waitForSelector('.pt-svc'); await p5.click('.pt-svc >> nth=1');
    await p5.screenshot({ path: path.join(SHOTS, 'patient-en-2-services.png') });
    await p5.click('[data-act="issue"]'); await p5.waitForSelector('.pt-success'); await p5.screenshot({ path: path.join(SHOTS, 'patient-en-3-success.png') });
    await p5.click('[data-act="open-ticket"]'); await p5.waitForSelector('#tk-number'); await p5.screenshot({ path: path.join(SHOTS, 'patient-en-4-ticket-waiting.png'), fullPage: true });
    await p5.context().close();
  });
  await step('no external network requests and no console errors', async () => {
    assert.deepEqual(external, []); const real = consoleErrors.filter(e => !/net::ERR|Failed to load resource|ERR_/.test(e)); assert.deepEqual(real, []);
  });
  await browser.close(); process.exit(summary());
})();
