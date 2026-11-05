'use strict';
/**
 * اختبار متصفح حقيقي (Chromium عبر playwright-core) للوحة الأدمن فوق الباك إند المدمج الحقيقي.
 * يُتخطى تلقائياً إن لم تتوفر الفروع المدمجة أو playwright-core أو متصفح Chromium.
 * متغيرات: CHROMIUM_PATH لتحديد مسار المتصفح.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startFixture, available, PW } = require('./fixture');
const fx = require('../helpers/fixtures');

let chromium = null;
try { ({ chromium } = require('playwright-core')); } catch (_) { /* غير مثبت */ }
function findChromium() {
  if (process.env.CHROMIUM_PATH && fs.existsSync(process.env.CHROMIUM_PATH)) return process.env.CHROMIUM_PATH;
  const root = '/opt/pw-browsers';
  if (fs.existsSync(root)) for (const d of fs.readdirSync(root).filter((x) => x.startsWith('chromium-'))) { const p = path.join(root, d, 'chrome-linux64', 'chrome'); if (fs.existsSync(p)) return p; }
  return null;
}
const exe = findChromium();
const skip = !available() ? 'فروع ح1/ح3 غير مدمجة' : !chromium ? 'playwright-core غير مثبت' : !exe ? 'Chromium غير موجود' : false;

describe('لوحة الأدمن في متصفح حقيقي', { skip }, () => {
  let env; let browser;
  before(async () => { env = await startFixture(); browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] }); });
  after(async () => { if (browser) await browser.close(); if (env) await env.close(); });

  async function open(opts = {}) {
    const ctx = await browser.newContext({ timezoneId: 'Africa/Cairo', locale: opts.locale || 'ar', viewport: opts.viewport || { width: 1280, height: 900 }, acceptDownloads: true });
    const page = await ctx.newPage();
    const problems = []; const bad = [];
    page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
    page.on('console', (m) => { const x = m.text(); if (m.type() === 'error' && !/Failed to load resource/.test(x)) problems.push('console: ' + x); if (/Content Security Policy|Refused to/i.test(x)) problems.push('CSP: ' + x); });
    page.on('response', (r) => { if (r.status() >= 500) bad.push(r.status() + ' ' + r.url()); });
    return { ctx, page, problems, bad };
  }
  async function login(page, user, pw = PW) {
    await page.goto(env.base + '/admin/');
    await page.waitForSelector('input[autocomplete=username]');
    await page.fill('input[autocomplete=username]', user); await page.fill('input[type=password]', pw);
    await page.click('button[type=submit]');
  }
  async function loginAs(user, opts) { const o = await open(opts); await login(o.page, user); await o.page.waitForSelector('.adm-shell'); return o; }
  const clean = (o) => { assert.deepEqual(o.problems, [], 'لا أخطاء JS/CSP'); assert.deepEqual(o.bad, [], 'لا ردود 5xx'); };
  const dialogBtn = (page, text) => page.locator('.qm-modal .qm-btn', { hasText: text }).last();

  test('دخول: كلمة مرور خاطئة تُظهر خطأ، ثم نجاح الدخول ويعرض أرقام اللوحة الصحيحة', async () => {
    const o = await open(); const { page } = o;
    await login(page, 'adm', 'wrong-password-123');
    await page.waitForSelector('.qm-error-text:not([hidden])');
    assert.match(await page.textContent('.qm-error-text'), /غير صحيحة/);
    await page.fill('input[type=password]', PW); await page.click('button[type=submit]');
    await page.waitForSelector('.adm-stats');
    const vals = await page.$$eval('.adm-stat__value', (e) => e.map((x) => x.textContent.trim()));
    assert.deepEqual(vals.slice(0, 6), ['6', '2', '1', '2', '1', '0'], 'اليوم/منتظرون/قيد الخدمة/مكتملة/متخطاة/ملغاة');
    assert.equal(vals[6], '22 د'); assert.equal(vals[7], '20 د');
    assert.equal(await page.locator('.adm-chart').count(), 2);
    clean(o); await o.ctx.close();
  });

  test('XSS: اسم خدمة خبيث يظهر نصاً ولا ينفَّذ في كل الصفحات', async () => {
    const o = await loginAs('adm'); const { page } = o;
    for (const v of ['dashboard', 'services', 'reports', 'queue']) { await page.goto(`${env.base}/admin/#/${v}`); await page.waitForTimeout(400); }
    await page.goto(`${env.base}/admin/#/services`); await page.waitForSelector('.adm-table');
    assert.ok((await page.textContent('.adm-table')).includes('onerror'), 'الحمولة معروضة كنص');
    assert.equal(await page.evaluate(() => window.__xss), undefined);
    assert.equal(await page.locator('.adm-table img[src="x"]').count(), 0);
    clean(o); await o.ctx.close();
  });

  test('كل الصفحات تُفتح بلا أخطاء لمدير النظام (11 صفحة)', async () => {
    const o = await loginAs('adm'); const { page } = o;
    for (const v of ['dashboard', 'queue', 'ads', 'reports', 'clinic', 'services', 'counters', 'staff', 'displays', 'integrations', 'audit']) {
      await page.goto(`${env.base}/admin/#/${v}`);
      await page.waitForSelector(`.adm-nav__link[data-view="${v}"][aria-current="page"]`);
      await page.waitForFunction(() => !document.querySelector('.adm-main .adm-loading') && !document.querySelector('.adm-main .qm-boot'), null, { timeout: 8000 });
      assert.equal(await page.locator('.adm-main .qm-banner--error').count(), 0, `صفحة ${v} بلا أخطاء ظاهرة`);
      assert.ok((await page.locator('.adm-main h1').count()) >= 1, `عنوان ${v}`);
    }
    clean(o); await o.ctx.close();
  });

  test('الصلاحيات: المشرف لا يرى الموظفين/الشاشات/التدقيق وتُمنع صفحاتها، والموظف العادي لا يدخل', async () => {
    const o = await loginAs('mgr'); const { page } = o;
    const links = await page.$$eval('.adm-nav__link', (a) => a.map((x) => x.getAttribute('data-view')));
    assert.ok(!links.includes('staff') && !links.includes('displays') && !links.includes('audit'));
    assert.ok(links.includes('ads') && links.includes('reports'));
    await page.goto(`${env.base}/admin/#/staff`); await page.waitForSelector('.adm-main .qm-banner--error');
    assert.match(await page.textContent('.adm-main'), /صلاحية/);
    await page.goto(`${env.base}/admin/#/services`); await page.waitForSelector('.adm-table');
    assert.equal(await page.locator('.adm-main .qm-btn', { hasText: 'إضافة' }).count(), 0, 'لا زر إضافة للمشرف');
    await o.ctx.close();
    const s = await open(); await login(s.page, 'stf');
    await s.page.waitForSelector('.adm-login__card');
    assert.equal(await s.page.locator('.adm-shell').count(), 0);
    await s.ctx.close();
  });

  test('خدمات: إضافة + تعديل، وبادئة مكررة تُظهر الخطأ داخل الحوار', async () => {
    const o = await loginAs('adm'); const { page } = o;
    await page.goto(`${env.base}/admin/#/services`); await page.waitForSelector('.adm-table');
    await page.click('.adm-pagehead .qm-btn');
    await page.fill('.qm-modal input >> nth=0', 'العيون'); await page.fill('.qm-modal input >> nth=2', 'e');
    await dialogBtn(page, 'حفظ').click();
    await page.waitForSelector('.qm-modal', { state: 'detached' });
    await page.waitForSelector('td:has-text("العيون")');
    await page.click('.adm-pagehead .qm-btn');
    await page.fill('.qm-modal input >> nth=0', 'مكرر'); await page.fill('.qm-modal input >> nth=2', 'A');
    await dialogBtn(page, 'حفظ').click();
    await page.waitForSelector('.qm-modal .qm-error-text:not([hidden])');
    assert.ok((await page.textContent('.qm-modal .qm-error-text')).length > 3);
    assert.equal(await page.locator('.qm-modal').count(), 1, 'الحوار يبقى مفتوحاً');
    await dialogBtn(page, 'إلغاء').click();
    clean(o); await o.ctx.close();
  });

  test('إعلانات: نص + صورة (رفع حقيقي) + معاينة + تعديل + رفض ملف مزيف + حذف يزيل الملف', async () => {
    const o = await loginAs('adm'); const { page } = o;
    await page.goto(`${env.base}/admin/#/ads`); await page.waitForSelector('.adm-pagehead .qm-btn');
    // نص
    await page.click('.adm-pagehead .qm-btn');
    await page.fill('.qm-modal input >> nth=0', 'مرحباً بكم'); await page.selectOption('.qm-modal select >> nth=0', 'text'); await page.fill('.qm-modal textarea', 'نرحب بكم في عيادة النور');
    await dialogBtn(page, 'حفظ').click(); await page.waitForSelector('.qm-modal', { state: 'detached' });
    await page.waitForSelector('td:has-text("مرحباً بكم")');
    // ملف مزيف (exe باسم png)
    await page.click('.adm-pagehead .qm-btn');
    await page.fill('.qm-modal input >> nth=0', 'مزيف');
    await page.setInputFiles('.qm-modal input[type=file]', { name: 'a.png', mimeType: 'image/png', buffer: fx.exe() });
    await dialogBtn(page, 'حفظ').click();
    await page.waitForSelector('.qm-modal .qm-error-text:not([hidden])');
    assert.equal(env.uploads().length, 0, 'لم يُخزَّن شيء');
    // صورة صحيحة
    await page.fill('.qm-modal input >> nth=0', 'عرض الصورة');
    await page.setInputFiles('.qm-modal input[type=file]', { name: 'ok.png', mimeType: 'image/png', buffer: fx.png() });
    await dialogBtn(page, 'حفظ').click(); await page.waitForSelector('.qm-modal', { state: 'detached' });
    await page.waitForSelector('td:has-text("عرض الصورة")');
    assert.equal(env.uploads().length, 1);
    assert.equal(await page.locator('img.adm-thumb').count(), 1);
    // معاينة
    await page.locator('tr', { hasText: 'عرض الصورة' }).locator('.qm-btn', { hasText: 'معاينة' }).click();
    await page.waitForSelector('.qm-modal img.adm-media');
    assert.ok(await page.$eval('.qm-modal img.adm-media', (i) => i.complete && i.naturalWidth >= 0));
    await dialogBtn(page, 'إغلاق').click();
    // تعديل: الأولوية وإيقاف
    await page.locator('tr', { hasText: 'عرض الصورة' }).locator('.qm-btn', { hasText: 'تعديل' }).click();
    await page.fill('.qm-modal input >> nth=0', 'عرض معدّل');
    await dialogBtn(page, 'حفظ').click(); await page.waitForSelector('.qm-modal', { state: 'detached' });
    await page.waitForSelector('td:has-text("عرض معدّل")');
    assert.equal(env.uploads().length, 1, 'الملف محفوظ بعد تعديل بلا ملف جديد');
    // حذف
    await page.locator('tr', { hasText: 'عرض معدّل' }).locator('.qm-btn', { hasText: 'حذف' }).click();
    await dialogBtn(page, 'تأكيد').click(); await page.waitForSelector('td:has-text("عرض معدّل")', { state: 'detached' });
    assert.equal(env.uploads().length, 0, 'الملف حُذف من القرص');
    clean(o); await o.ctx.close();
  });

  test('تقارير: عرض يومي، تنزيل CSV بـ BOM، وصفحة الطباعة', async () => {
    const o = await loginAs('adm'); const { page, ctx } = o;
    await page.goto(`${env.base}/admin/#/reports`); await page.waitForSelector('.adm-table');
    await page.selectOption('.adm-filters select >> nth=0', 'waiting-times'); await page.click('.adm-actions .qm-btn:not(.qm-btn--secondary)');
    await page.waitForSelector('h3:has-text("توزيع")');
    await page.selectOption('.adm-filters select >> nth=0', 'daily'); await page.click('.adm-actions .qm-btn:not(.qm-btn--secondary)');
    await page.waitForSelector('.adm-chart, .adm-table td');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('a:has-text("CSV")')]);
    const buf = fs.readFileSync(await dl.path());
    assert.deepEqual([...buf.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    assert.match(buf.toString('utf8'), /التاريخ,المصدرة/);
    assert.match(dl.suggestedFilename(), /^queuemaster-daily-.*\.csv$/);
    const [pp] = await Promise.all([ctx.waitForEvent('page'), page.click('a:has-text("طباعة")')]);
    await pp.waitForSelector('.adm-print__head');
    assert.match(await pp.textContent('.adm-print__head'), /عيادة النور/);
    await pp.emulateMedia({ media: 'print' });
    assert.equal(await pp.locator('.adm-print__bar').isVisible(), false, 'شريط التحكم مخفي عند الطباعة');
    clean(o); await ctx.close();
  });

  test('الطابور: أحداث التذكرة، إلغاء بسبب، وتصفير اليوم يتطلب الكلمة', async () => {
    const o = await loginAs('adm'); const { page } = o;
    await page.goto(`${env.base}/admin/#/queue`); await page.waitForSelector('.adm-table');
    assert.equal(await page.locator('.adm-table tbody tr').count(), 6);
    await page.selectOption('.adm-filters select >> nth=1', 'skipped'); await page.waitForFunction(() => document.querySelectorAll('.adm-table tbody tr').length === 1);
    await page.locator('.qm-btn', { hasText: 'سجل الأحداث' }).click(); await page.waitForSelector('.qm-modal');
    await dialogBtn(page, 'إغلاق').click();
    await page.selectOption('.adm-filters select >> nth=1', 'waiting'); await page.waitForFunction(() => document.querySelectorAll('.adm-table tbody tr').length === 2);
    await page.locator('.qm-btn', { hasText: 'إلغاء التذكرة' }).first().click();
    await page.fill('.qm-modal input', 'تجربة'); await dialogBtn(page, 'إلغاء التذكرة').click();
    await page.waitForFunction(() => document.querySelectorAll('.adm-table tbody tr').length === 1);
    // تصفير: كلمة خاطئة لا تنفّذ
    await page.click('.adm-pagehead .qm-btn--danger'); await page.fill('.qm-modal input', 'خطأ');
    await dialogBtn(page, 'تصفير اليوم').click(); await page.waitForSelector('.qm-modal .qm-error-text:not([hidden])');
    const still = env.db.prepare("SELECT COUNT(*) c FROM tickets WHERE status IN ('waiting','called','serving')").get().c;
    assert.ok(still >= 2, 'لم يُلغَ شيء بكلمة خاطئة');
    await page.fill('.qm-modal input', 'تصفير'); await dialogBtn(page, 'تصفير اليوم').click(); await page.waitForSelector('.qm-modal', { state: 'detached' });
    assert.equal(env.db.prepare("SELECT COUNT(*) c FROM tickets WHERE status IN ('waiting','called','serving')").get().c, 0);
    clean(o); await o.ctx.close();
  });

  test('اللغة: التبديل للإنجليزية يقلب الاتجاه ويترجم، والحفظ بين التحميلات', async () => {
    const o = await loginAs('adm'); const { page } = o;
    assert.equal(await page.getAttribute('html', 'dir'), 'rtl');
    await page.click('.adm-top .qm-lang button[data-lang=en]');
    await page.waitForFunction(() => document.documentElement.dir === 'ltr');
    assert.equal(await page.textContent('.adm-main h1'), 'Dashboard');
    await page.reload(); await page.waitForSelector('.adm-shell');
    assert.equal(await page.getAttribute('html', 'dir'), 'ltr');
    clean(o); await o.ctx.close();
  });

  test('جوال 375px: لا تمرير أفقي للصفحة في كل الشاشات، والجداول تتحول لبطاقات', async () => {
    const o = await loginAs('adm', { viewport: { width: 375, height: 800 } }); const { page } = o;
    for (const v of ['dashboard', 'queue', 'ads', 'reports', 'services', 'staff', 'integrations']) {
      await page.goto(`${env.base}/admin/#/${v}`); await page.waitForTimeout(500);
      const w = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
      assert.ok(w[0] <= w[1] + 1, `${v}: عرض ${w[0]} > ${w[1]}`);
    }
    await page.goto(`${env.base}/admin/#/services`); await page.waitForSelector('.adm-table td');
    assert.equal(await page.$eval('.adm-table td', (td) => getComputedStyle(td).display), 'flex');
    clean(o); await o.ctx.close();
  });

  test('انتهاء الجلسة: بعد الخروج تعود صفحة الدخول ولا تُعرض بيانات', async () => {
    const o = await loginAs('adm'); const { page } = o;
    await page.click('.adm-top .qm-btn');
    await page.waitForSelector('.adm-login__card');
    await page.goto(`${env.base}/admin/#/staff`); await page.waitForSelector('.adm-login__card');
    assert.equal(await page.locator('.adm-table').count(), 0);
    clean(o); await o.ctx.close();
  });
});
