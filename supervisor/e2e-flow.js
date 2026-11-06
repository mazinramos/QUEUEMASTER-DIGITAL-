#!/usr/bin/env node
/**
 * اختبار تدفق كامل عبر كل الوحدات (لا يملكه حساب واحد):
 * مريض + موظف + شاشة (مقترنة فعلياً) + Socket.IO حقيقي.
 *   node supervisor/e2e-flow.js
 */
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const ROOT = path.resolve(__dirname, '..'), SRV = path.join(ROOT, 'server');
const { io } = require(path.join(SRV, 'node_modules', 'socket.io-client'));
const isWin = process.platform === 'win32';
let failed = 0;
const check = (name, ok, note = '') => { if (!ok) failed++; console.log(`${ok ? ' OK ' : 'FAIL'}  ${name}${note ? ' — ' + note : ''}`); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

class Jar { constructor() { this.c = {}; } set(res) { (res.headers.getSetCookie?.() || []).forEach(s => { const [kv] = s.split(';'); const i = kv.indexOf('='); this.c[kv.slice(0, i)] = kv.slice(i + 1); }); } get() { return Object.entries(this.c).map(([k, v]) => `${k}=${v}`).join('; '); } }

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qm-e2e-'));
  const port = 3800 + Math.floor(Math.random() * 90), B = `http://localhost:${port}`;
  const env = { ...process.env, NODE_ENV: 'development', PORT: String(port), DATA_DIR: dataDir, BASE_URL: B };
  spawnSync('npm', ['run', '-s', 'migrate'], { cwd: SRV, env, shell: isWin });
  const seed = spawnSync('npm', ['run', '-s', 'seed'], { cwd: SRV, env, shell: isWin, encoding: 'utf8' });
  const pw = (u) => ((seed.stdout || '').match(new RegExp(`^\\s*\\S+\\s+${u}\\s+(\\S+)`, 'm')) || [])[1];
  const srv = spawn(process.execPath, ['src/server.js'], { cwd: SRV, env, stdio: 'ignore' });
  const sockets = [];
  try {
    for (let i = 0; i < 40; i++) { try { if ((await fetch(B + '/api/health')).ok) break; } catch {} await sleep(250); }
    const api = async (jar, method, p, body, csrf) => {
      const r = await fetch(B + p, { method, headers: { 'content-type': 'application/json', cookie: jar.get(), ...(csrf ? { 'x-csrf-token': csrf } : {}) }, body: body ? JSON.stringify(body) : undefined });
      jar.set(r); return { status: r.status, body: await r.json().catch(() => null) };
    };
    const login = async (u) => {
      const jar = new Jar(); let r = await api(jar, 'GET', '/api/auth/csrf');
      let csrf = r.body?.data?.csrfToken; r = await api(jar, 'POST', '/api/auth/login', { username: u, password: pw(u) }, csrf);
      if (!r.body?.ok) throw new Error('login failed ' + u);
      r = await api(jar, 'GET', '/api/auth/csrf'); csrf = r.body?.data?.csrfToken || csrf;
      return { jar, csrf, me: (await api(jar, 'GET', '/api/auth/me')).body.data.staff };
    };
    const admin = await login('admin'), staff = await login('staff1');
    // 1) إنشاء شاشة من الأدمن ثم الاقتران
    const cd = await api(admin.jar, 'POST', '/api/admin/displays', { name: 'شاشة الاختبار' }, admin.csrf);
    const code = cd.body?.data?.pairingCode || cd.body?.data?.code || cd.body?.data?.display?.pairingCode || cd.body?.data?.display?.code;
    check('الأدمن ينشئ شاشة ويحصل على كود إقران', !!code, code ? '' : JSON.stringify(cd.body).slice(0, 160));
    const dj = new Jar(); const pr = await api(dj, 'POST', '/api/display/pair', { code });
    check('اقتران الشاشة بالكود (كوكي qm.display)', pr.body?.ok === true && !!dj.c['qm.display']);
    const bs = await api(dj, 'GET', '/api/display/bootstrap');
    check('display/bootstrap يعمل بكوكي الشاشة', bs.body?.ok === true);

    // 2) اتصالات Socket.IO
    const mk = (cookie) => { const s = io(B, { extraHeaders: cookie ? { cookie } : {}, transports: ['websocket'], reconnection: false }); sockets.push(s); return s; };
    const rec = (s) => { const log = []; s.onAny((ev, p) => log.push({ ev, p, t: Date.now() })); return log; };
    const sd = mk(dj.get()), ss = mk(staff.jar.get()), sp1 = mk(), sp2 = mk();
    const ld = rec(sd), ls = rec(ss), lp1 = rec(sp1), lp2 = rec(sp2);
    await Promise.all([sd, ss, sp1, sp2].map(s => new Promise((res, rej) => { s.on('connect', res); s.on('connect_error', rej); setTimeout(() => rej(new Error('socket timeout')), 5000); })));
    check('اتصال الشاشة والموظف والمريضين', true);

    // 3) مريضان يصدران تذكرتين ويراقبانهما
    const svc = (await api(new Jar(), 'GET', '/api/public/clinic')).body.data.services[0];
    const t1 = (await api(new Jar(), 'POST', '/api/public/tickets', { serviceKey: svc.key })).body.data;
    const t2 = (await api(new Jar(), 'POST', '/api/public/tickets', { serviceKey: svc.key })).body.data;
    const watch = (s, token) => new Promise(r => s.emit('ticket:watch', { token }, r));
    const w1 = await watch(sp1, t1.token), w2 = await watch(sp2, t2.token);
    check('ticket:watch للمريضين', w1?.ok !== false && w2?.ok !== false);
    await sleep(300);
    check('الشاشة والموظف استلما ticket:created', ld.some(x => x.ev === 'ticket:created') && ls.some(x => x.ev === 'ticket:created'));

    // 3b) إعلان: رفع من الأدمن ← يظهر في bootstrap ← يُخدَّم عبر /media ← بث advertisement:updated للشاشة
    const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const fd = new FormData(); fd.append('title', 'إعلان اختبار'); fd.append('media_type', 'image'); fd.append('duration_sec', '10');
    fd.append('file', new Blob([PNG], { type: 'image/png' }), 'a.png');
    const up = await fetch(B + '/api/admin/ads', { method: 'POST', headers: { cookie: admin.jar.get(), 'x-csrf-token': admin.csrf }, body: fd });
    const upj = await up.json().catch(() => null);
    check('رفع إعلان صورة من الأدمن', up.status === 201 && upj?.ok, `HTTP ${up.status} ${upj?.ok ? '' : JSON.stringify(upj?.error)}`);
    const adUrl = upj?.data?.ad?.url;
    if (adUrl) {
      const mr = await fetch(B + adUrl);
      check('الملف المرفوع يُخدَّم عبر /media للشاشة', mr.status === 200 && mr.headers.get('content-type') === 'image/png', `HTTP ${mr.status}`);
      await sleep(400);
      check('الشاشة تستلم advertisement:updated', ld.some(x => x.ev === 'advertisement:updated'));
      const bs2 = await api(dj, 'GET', '/api/display/bootstrap');
      check('الإعلان ضمن bootstrap الشاشة', JSON.stringify(bs2.body?.data?.ads || []).includes('إعلان اختبار'));
    }

    // 4) نداء
    const counterId = staff.me.counter?.id ?? (await api(staff.jar, 'GET', '/api/queue/state')).body?.data?.counter?.id;
    const cn = await api(staff.jar, 'POST', '/api/queue/call-next', { counterId }, staff.csrf);
    check('call-next ينادي التذكرة الأولى', cn.body?.ok && cn.body.data.ticket.number === t1.ticket.number, cn.body?.data?.ticket?.number);
    await sleep(500);
    const called = ld.filter(x => x.ev === 'ticket:called'), ann = ld.filter(x => x.ev === 'display:announcement');
    check('الشاشة تستلم ticket:called', called.length === 1);
    check('الشاشة تستلم display:announcement (رقم الشباك)', ann.length === 1, JSON.stringify(ann[0]?.p || {}).slice(0, 120));
    check('المريض 1 يستلم ticket:called لتذكرته', lp1.some(x => x.ev === 'ticket:called'));
    check('المريض 2 لا يستلم نداء تذكرة غيره', !lp2.some(x => x.ev === 'ticket:called'));
    check('كل حدث له eventId فريد', new Set(ld.map(x => x.p?.eventId).filter(Boolean)).size === ld.filter(x => x.p?.eventId).length);

    // 5) إعادة نداء = نطق جديد
    await api(staff.jar, 'POST', `/api/queue/tickets/${cn.body.data.ticket.publicId}/recall`, {}, staff.csrf);
    await sleep(500);
    check('recall يعيد النطق (إعلان ثانٍ)', ld.filter(x => x.ev === 'display:announcement').length === 2);

    // 6) بدء/إنهاء لا ينطقان
    const pid = cn.body.data.ticket.publicId;
    await api(staff.jar, 'POST', `/api/queue/tickets/${pid}/start`, {}, staff.csrf);
    await api(staff.jar, 'POST', `/api/queue/tickets/${pid}/complete`, {}, staff.csrf);
    await sleep(500);
    check('start/complete لا يولّدان نطقاً', ld.filter(x => x.ev === 'display:announcement').length === 2);
    check('المريض 1 يستلم completed', lp1.some(x => x.ev === 'ticket:completed'));

    // 7) انقطاع الشاشة وعودتها: لقطة بلا نطق قديم
    sd.disconnect(); await sleep(300);
    await api(staff.jar, 'POST', '/api/queue/call-next', { counterId }, staff.csrf); // ينادي التذكرة الثانية أثناء غياب الشاشة
    await sleep(300);
    const sd2 = mk(dj.get()); const ld2 = rec(sd2);
    await new Promise((res, rej) => { sd2.on('connect', res); sd2.on('connect_error', rej); setTimeout(() => rej(new Error('reconnect timeout')), 5000); });
    await sleep(1500);
    check('بعد العودة: الشاشة تستلم لقطة queue:updated', ld2.some(x => x.ev === 'queue:updated'));
    check('بعد العودة: لا يُعاد نطق نداء فاتها (قاعدة 2)', !ld2.some(x => x.ev === 'display:announcement'), 'إن فشل فالعميل مطالَب بالتصفية بعمر الحدث < 30ث');
  } catch (e) { check('تنفيذ التدفق', false, String(e.stack || e).split('\n').slice(0,3).join(' | ')); }
  finally { sockets.forEach(s => s.close()); srv.kill(); console.log(failed ? `\nفشل ${failed}` : '\nكل الفحوصات نجحت'); process.exit(failed ? 1 : 0); }
})();
