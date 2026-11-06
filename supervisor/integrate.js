#!/usr/bin/env node
/**
 * أداة المشرف: دمج كل فروع الحسابات في `integration` ثم اختبار كل شيء بأمر واحد.
 *   node supervisor/integrate.js            (دمج + اختبارات + smoke)
 *   node supervisor/integrate.js --no-merge (اختبار الفرع الحالي فقط)
 *   node supervisor/integrate.js --push     (يدفع integration لـ origin بعد النجاح)
 * يعمل على Windows/Linux (Node 20+ فقط).
 */
const { spawnSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const args = new Set(process.argv.slice(2));
const isWin = process.platform === 'win32';
const results = [];
const rec = (name, ok, note = '') => { results.push({ name, ok, note }); console.log(`${ok === 'warn' ? 'WARN' : ok ? ' OK ' : 'FAIL'}  ${name}${note ? ' — ' + note : ''}`); };

function run(cmd, a, opts = {}) {
  const r = spawnSync(cmd, a, { cwd: ROOT, encoding: 'utf8', shell: isWin, ...opts });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
const git = (...a) => run('git', a);

// نسخ الحل التلقائي للتعارضات المعروفة: الملف -> الفرع صاحب النسخة الصحيحة
const KNOWN = { 'server/src/sockets/index.js': 'theirs-if-acct-2' };

function mergeAll() {
  git('fetch', '--all', '--prune');
  const remote = git('branch', '-r').out.split('\n').map(s => s.trim()).filter(b => /^origin\/acct-/.test(b));
  const order = (b) => (b.match(/acct-(\d)/) || [0, 9])[1] + b; // حساب 1 ثم 2 ... والفروع الفرعية بعد أصلها
  remote.sort((x, y) => order(x).localeCompare(order(y)));
  git('checkout', '-B', 'integration', 'origin/main');
  for (const b of remote) {
    const m = git('merge', '--no-ff', '-m', `supervisor: merge ${b}`, b);
    if (m.code === 0) { rec(`merge ${b}`, true, /Already up to date/.test(m.out) ? 'لا جديد' : ''); continue; }
    const conflicts = git('diff', '--name-only', '--diff-filter=U').out.split('\n').filter(Boolean);
    const unknown = conflicts.filter(f => !(f in KNOWN) || !/acct-2/.test(b));
    if (unknown.length) { git('merge', '--abort'); rec(`merge ${b}`, false, 'تعارض يحتاج قراراً: ' + unknown.join(', ')); continue; }
    for (const f of conflicts) { git('checkout', '--theirs', f); git('add', f); }
    git('commit', '-m', `supervisor: merge ${b} (auto-resolved ${conflicts.join(', ')})`);
    rec(`merge ${b}`, 'warn', 'حُلّ تعارض معروف: ' + conflicts.join(', '));
  }
}

function tests() {
  for (const dir of ['server', 'web']) {
    if (!fs.existsSync(path.join(ROOT, dir, 'package.json'))) { rec(`${dir} tests`, 'warn', 'لا يوجد package.json'); continue; }
    const cwd = path.join(ROOT, dir);
    const hasLock = fs.existsSync(path.join(cwd, 'package-lock.json'));
    const inst = hasLock ? run('npm', ['ci', '--no-audit', '--no-fund'], { cwd }) : { code: 0 };
    if (inst.code !== 0) { rec(`${dir} npm ci`, false, inst.out.split('\n').slice(-4).join(' ')); continue; }
    const t = run('npm', ['test'], { cwd });
    const pass = (t.out.match(/# pass (\d+)/) || [])[1], fail = (t.out.match(/# fail (\d+)/) || [])[1];
    rec(`${dir} npm test`, t.code === 0, pass ? `pass ${pass}, fail ${fail}` : t.out.split('\n').slice(-3).join(' '));
    if (dir === 'server') {
      const a = run('npm', ['audit', '--omit=dev'], { cwd });
      rec('server npm audit (prod)', a.code === 0 ? true : 'warn', a.code === 0 ? '0 vulnerabilities' : a.out.split('\n').slice(-3).join(' '));
    }
  }
}

async function smoke() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qm-smoke-'));
  const port = 3900 + Math.floor(Math.random() * 90);
  const env = { ...process.env, NODE_ENV: 'development', PORT: String(port), DATA_DIR: dataDir, BASE_URL: `http://localhost:${port}` };
  const cwd = path.join(ROOT, 'server');
  if (run('npm', ['run', '-s', 'migrate'], { cwd, env }).code !== 0) return rec('smoke migrate', false);
  const seed = run('npm', ['run', '-s', 'seed'], { cwd, env });
  const cred = (u) => (seed.out.match(new RegExp(`^\\s*\\S+\\s+${u}\\s+(\\S+)`, 'm')) || [])[1];
  const srv = spawn(process.execPath, ['src/server.js'], { cwd, env, stdio: 'ignore' });
  const B = `http://localhost:${port}`;
  try {
    for (let i = 0; i < 30; i++) { try { if ((await fetch(B + '/api/health')).ok) break; } catch {} await new Promise(r => setTimeout(r, 300)); }
    const j = async (p, o) => { const r = await fetch(B + p, o); return { status: r.status, body: await r.json().catch(() => null), headers: r.headers }; };
    const h = await j('/api/health'); rec('GET /api/health', h.body?.ok === true);
    const c = await j('/api/public/clinic'); const svc = c.body?.data?.services?.[0];
    rec('GET /api/public/clinic', !!svc, svc ? `${c.body.data.services.length} خدمات` : '');
    if (svc) {
      const ids = new Set();
      for (let i = 0; i < 3; i++) { const t = await j('/api/public/tickets', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ serviceKey: svc.key }) }); ids.add(t.body?.data?.ticket?.number); }
      rec('إصدار 3 تذاكر بأرقام فريدة', ids.size === 3 && !ids.has(undefined), [...ids].join(','));
    }
    for (const p of ['/patient/', '/staff/', '/admin/', '/display/']) {
      const r = await fetch(B + p); rec(`صفحة ${p}`, r.status === 200 ? true : 'warn', `HTTP ${r.status}`);
    }
    // تسجيل دخول موظف + نداء
    const jar = {}; const cookie = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    const keep = (r) => (r.headers.getSetCookie?.() || []).forEach(s => { const [kv] = s.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i)] = kv.slice(i + 1); });
    let r = await fetch(B + '/api/auth/csrf', { headers: { cookie: cookie() } }); keep(r); let csrf = (await r.json())?.data?.csrfToken;
    const u = 'staff1', pw = cred(u);
    if (!pw || !csrf) return rec('staff login', 'warn', 'تعذّر استخراج بيانات الدخول أو CSRF');
    r = await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf, cookie: cookie() }, body: JSON.stringify({ username: u, password: pw }) }); keep(r);
    const me = await r.json(); rec('POST /api/auth/login (staff1)', me?.ok === true);
    if (me?.ok) {
      // الجلسة تتجدد بعد الدخول: نجلب CSRF جديداً
      const r2 = await fetch(B + '/api/auth/csrf', { headers: { cookie: cookie() } }); keep(r2); csrf = (await r2.json())?.data?.csrfToken || csrf;
      const q = await (await fetch(B + '/api/queue/state', { headers: { cookie: cookie() } })).json();
      rec('GET /api/queue/state', q?.ok === true);
      const counterId = me.data.staff.counter?.id ?? q?.data?.counter?.id;
      const cn = await fetch(B + '/api/queue/call-next', { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf, cookie: cookie() }, body: JSON.stringify({ counterId }) });
      const cnj = await cn.json(); rec('POST /api/queue/call-next', cnj?.ok === true ? true : 'warn', cnj?.ok ? cnj.data.ticket?.number || '' : JSON.stringify(cnj?.error));
    }
  } catch (e) { rec('smoke', false, String(e)); } finally { srv.kill(); }
}

(async () => {
  if (!args.has('--no-merge')) mergeAll();
  tests();
  await smoke();
  const failed = results.filter(r => r.ok === false), warns = results.filter(r => r.ok === 'warn');
  const md = ['# تقرير التكامل الآلي', '', `التاريخ: ${new Date().toISOString()}`, '', '| الفحص | النتيجة | ملاحظة |', '|---|---|---|',
    ...results.map(r => `| ${r.name} | ${r.ok === 'warn' ? 'تحذير' : r.ok ? 'نجح' : 'فشل'} | ${r.note.replace(/\|/g, '/')} |`)].join('\n');
  fs.writeFileSync(path.join(ROOT, 'supervisor', 'LAST-RUN.md'), md + '\n');
  console.log(`\nالنتيجة: ${results.length - failed.length - warns.length} نجح، ${warns.length} تحذير، ${failed.length} فشل`);
  if (args.has('--push') && !failed.length) console.log(git('push', 'origin', 'integration').out);
  process.exit(failed.length ? 1 : 0);
})();
