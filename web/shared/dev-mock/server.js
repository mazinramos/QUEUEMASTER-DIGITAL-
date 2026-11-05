/* DEV MOCK — see README.md. Delete before delivery. */
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { Server } = require('socket.io');
const WEB = path.join(__dirname, '..', '..');
const PORT = process.env.PORT || 3100;
const rid = (n = 12) => crypto.randomBytes(n).toString('hex');
const now = () => new Date().toISOString();

const services = [
  { id: 1, key: 'svc-a', prefix: 'A', name_ar: 'باطنة', name_en: 'Internal Medicine', est: 10 },
  { id: 2, key: 'svc-b', prefix: 'B', name_ar: 'أسنان', name_en: 'Dental', est: 15 },
  { id: 3, key: 'svc-c', prefix: 'C', name_ar: 'مختبر', name_en: 'Laboratory', est: 5 }];
const counters = [{ id: 1, number: 1, name: 'شباك 1' }, { id: 2, number: 2, name: 'شباك 2' }];
const users = {
  staff: { id: 1, password: 'staff123', fullName: 'نور الهدى', role: 'staff', can_skip_return: 0, can_cancel: 0, can_transfer: 0, services: [1, 2], counters: [1, 2] },
  manager: { id: 2, password: 'manager123', fullName: 'Manager Sam', role: 'manager', can_skip_return: 1, can_cancel: 1, can_transfer: 1, services: [1, 2, 3], counters: [1, 2] } };
const sessions = new Map();
const tickets = []; const seq = {};
let offline = false;

function pub(t) { // public ticket view
  const ahead = t.status === 'waiting' ? tickets.filter(x => x.service === t.service && x.status === 'waiting' && x.seq < t.seq).length : 0;
  const svc = services.find(s => s.id === t.service);
  return { number: t.number, service: { name_ar: svc.name_ar, name_en: svc.name_en }, serviceName: svc.name_ar, status: t.status, ahead,
    estimatedWaitMin: t.status === 'waiting' ? ahead * svc.est : null, counter: t.counter ? counters.find(c => c.id === t.counter) : null, issuedAt: t.issuedAt };
}
function staffView(t) {
  const svc = services.find(s => s.id === t.service);
  return { publicId: t.publicId, number: t.number, status: t.status, service: { id: svc.id, name_ar: svc.name_ar, name_en: svc.name_en },
    counter: t.counter ? counters.find(c => c.id === t.counter) : null, issuedAt: t.issuedAt, calledAt: t.calledAt || null, servingAt: t.servingAt || null };
}
function issue(svc) {
  seq[svc.id] = (seq[svc.id] || 0) + 1;
  const t = { publicId: rid(6), token: rid(16), service: svc.id, seq: seq[svc.id], number: svc.prefix + '-' + String(seq[svc.id]).padStart(3, '0'), status: 'waiting', issuedAt: now() };
  tickets.push(t); return t;
}

let io;
function emit(type, t, extra) {
  const base = { eventId: crypto.randomUUID(), ts: now(), clinicId: 1, ticket: { number: t.number, service: services.find(s => s.id === t.service).name_ar, status: t.status } };
  const p = Object.assign(base, extra || {});
  io.to('clinic:1:staff').emit(type, p); io.to('ticket:' + t.publicId).emit(type, p);
}

function send(res, status, body, headers) { res.writeHead(status, Object.assign({ 'Content-Type': 'application/json' }, headers || {})); res.end(JSON.stringify(body)); }
const ok = (res, data, h) => send(res, 200, { ok: true, data }, h);
const fail = (res, status, code, message) => send(res, status, { ok: false, error: { code, message: message || code } });
function cookie(req, name) { const m = (req.headers.cookie || '').match(new RegExp('(?:^|; )' + name + '=([^;]*)')); return m && m[1]; }

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png' };
function serveStatic(req, res, url) {
  let p = decodeURIComponent(url.pathname); if (p.endsWith('/')) p += 'index.html';
  const f = path.normalize(path.join(WEB, p));
  if (!f.startsWith(WEB) || f.includes('dev-mock') && !p.startsWith('/shared/dev-mock/never')) { res.writeHead(404); return res.end('not found'); }
  fs.readFile(f, (e, buf) => { if (e) { res.writeHead(404); return res.end('not found'); } res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); res.end(buf); });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (offline && (url.pathname.startsWith('/api') )) return req.socket.destroy();
  if (!url.pathname.startsWith('/api') && !url.pathname.startsWith('/dev')) return serveStatic(req, res, url);
  let raw = ''; req.on('data', c => raw += c); req.on('end', () => {
    let body = {}; try { body = raw ? JSON.parse(raw) : {}; } catch (e) { return fail(res, 400, 'VALIDATION'); }
    try { route(req, res, url, body); } catch (e) { console.error(e); fail(res, 500, 'INTERNAL'); }
  });
});

function route(req, res, url, body) {
  const m = req.method, p = url.pathname;
  const sid = cookie(req, 'qm.sid'); const sess = sid && sessions.get(sid);
  // ---- dev
  if (p === '/dev/seed') { for (let i = 0; i < (body.count || 3); i++) { const svc = services.find(s => s.key === body.serviceKey) || services[0]; const t = issue(svc); emit('ticket:created', t); } return ok(res, { total: tickets.length }); }
  if (p === '/dev/drop-sockets') { io.disconnectSockets(true); return ok(res, {}); }
  if (p === '/dev/offline') { offline = !!body.on; return ok(res, { offline }); }
  // ---- public
  if (p === '/api/health') return ok(res, { status: 'ok', time: now(), version: 'mock' });
  if (p === '/api/public/clinic' && m === 'GET') return ok(res, { name_ar: 'عيادة النور التخصصية', name_en: 'Al-Noor Specialty Clinic', logoUrl: null, language: 'ar', timezone: 'Africa/Cairo',
    services: services.map(s => ({ id: s.key, key: s.key, name_ar: s.name_ar, name_en: s.name_en, prefix: s.prefix, waiting: tickets.filter(t => t.service === s.id && t.status === 'waiting').length })) });
  if (p === '/api/public/tickets' && m === 'POST') {
    const svc = services.find(s => s.key === body.serviceKey); if (!svc) return fail(res, 400, 'VALIDATION', 'serviceKey');
    const t = issue(svc); emit('ticket:created', t);
    return ok(res, { ticket: Object.assign({ number: t.number, serviceName: svc.name_ar, issuedAt: t.issuedAt, status: t.status }, { ahead: pub(t).ahead, estimatedWaitMin: pub(t).estimatedWaitMin }), token: t.token });
  }
  let mm;
  if ((mm = p.match(/^\/api\/public\/tickets\/([0-9a-f]+)\/sms$/)) && m === 'POST') {
    const t = tickets.find(x => x.token === mm[1]); if (!t) return fail(res, 404, 'NOT_FOUND');
    if (!/^\+?\d{7,15}$/.test(String(body.phone || ''))) return fail(res, 400, 'VALIDATION'); return ok(res, { queued: true });
  }
  if (p === '/api/public/tickets/recover' && m === 'POST') { const t = tickets.find(x => x.number === body.number); return t ? ok(res, { token: t.token }) : fail(res, 404, 'NOT_FOUND'); }
  if ((mm = p.match(/^\/api\/public\/tickets\/([0-9a-f]+)$/)) && m === 'GET') { const t = tickets.find(x => x.token === mm[1]); return t ? ok(res, pub(t)) : fail(res, 404, 'NOT_FOUND'); }
  // ---- auth
  if (p === '/api/auth/csrf') { if (!sess) { const s = rid(8); sessions.set(s, { csrf: rid(8), user: null }); return ok(res, { csrfToken: sessions.get(s).csrf }, { 'Set-Cookie': 'qm.sid=' + s + '; Path=/; HttpOnly; SameSite=Lax' }); } return ok(res, { csrfToken: sess.csrf }); }
  const userData = u => ({ staff: { id: u.id, fullName: u.fullName, role: u.role, permissions: { can_skip_return: !!u.can_skip_return, can_cancel: !!u.can_cancel, can_transfer: !!u.can_transfer },
    services: u.services.map(i => { const s = services.find(x => x.id === i); return { id: s.id, name_ar: s.name_ar, name_en: s.name_en, prefix: s.prefix }; }),
    counter: counters.find(c => c.id === u.counters[0]), counters: u.counters.map(i => counters.find(c => c.id === i)) } });
  if (p === '/api/auth/login' && m === 'POST') {
    if (!sess || req.headers['x-csrf-token'] !== sess.csrf) return fail(res, 403, 'CSRF');
    const u = users[body.username]; if (!u || u.password !== body.password) return fail(res, 401, 'UNAUTHENTICATED', 'bad credentials');
    sess.user = body.username; return ok(res, userData(u));
  }
  if (p === '/api/auth/me') { if (!sess || !sess.user) return fail(res, 401, 'UNAUTHENTICATED'); return ok(res, userData(users[sess.user])); }
  if (p === '/api/auth/logout') { if (sess) sess.user = null; return ok(res, {}); }
  // ---- staff queue
  const u = sess && sess.user && users[sess.user];
  if (p.startsWith('/api/queue')) {
    if (!u) return fail(res, 401, 'UNAUTHENTICATED');
    if (m !== 'GET' && req.headers['x-csrf-token'] !== sess.csrf) return fail(res, 403, 'CSRF');
    const mine = t => u.services.includes(t.service);
    const counterOf = () => counters.find(c => c.id === (Number(url.searchParams.get('counterId')) || u.counters[0]));
    if (p === '/api/queue/state') {
      const cid = Number(url.searchParams.get('counterId')) || u.counters[0];
      const cur = tickets.find(t => t.counter === cid && (t.status === 'called' || t.status === 'serving'));
      const waiting = tickets.filter(t => t.status === 'waiting' && mine(t)).sort((a, b) => a.seq - b.seq);
      const skipped = tickets.filter(t => t.status === 'skipped' && mine(t));
      return ok(res, { counter: counters.find(c => c.id === cid), currentTicket: cur ? staffView(cur) : null,
        waiting: waiting.map(t => Object.assign(staffView(t), { waitedMin: Math.round((Date.now() - Date.parse(t.issuedAt)) / 60000) })), skipped: skipped.map(staffView),
        stats: { waitingCount: waiting.length, avgWaitMin: waiting.length ? Math.round(waiting.reduce((a, t) => a + (Date.now() - Date.parse(t.issuedAt)) / 60000, 0) / waiting.length) : 0 } });
    }
    if (p === '/api/queue/call-next' && m === 'POST') {
      const cid = body.counterId; if (!counters.find(c => c.id === cid)) return fail(res, 400, 'VALIDATION');
      if (tickets.find(t => t.counter === cid && (t.status === 'called' || t.status === 'serving'))) return fail(res, 409, 'INVALID_TRANSITION');
      if (body.serviceId && !u.services.includes(body.serviceId)) return fail(res, 403, 'FORBIDDEN_SERVICE');
      const t = tickets.filter(t => t.status === 'waiting' && mine(t) && (!body.serviceId || t.service === body.serviceId)).sort((a, b) => a.seq - b.seq)[0];
      if (!t) return fail(res, 404, 'QUEUE_EMPTY');
      t.status = 'called'; t.counter = cid; t.calledAt = now(); emit('ticket:called', t, { counter: counters.find(c => c.id === cid), announce: true }); return ok(res, { ticket: staffView(t) });
    }
    if (p === '/api/queue/lookup') { const n = (url.searchParams.get('number') || '').toUpperCase(); const t = tickets.find(x => x.number === n); return t ? ok(res, { ticket: staffView(t) }) : fail(res, 404, 'NOT_FOUND'); }
    if (p === '/api/queue/verify' && m === 'POST') { const t = tickets.find(x => x.token === body.token); return t ? ok(res, { ticket: staffView(t) }) : fail(res, 404, 'NOT_FOUND'); }
    if ((mm = p.match(/^\/api\/queue\/tickets\/([0-9a-f]+)\/(\w+)$/)) && m === 'POST') {
      const t = tickets.find(x => x.publicId === mm[1]); if (!t) return fail(res, 404, 'NOT_FOUND'); if (!mine(t)) return fail(res, 403, 'FORBIDDEN_SERVICE');
      const act = mm[2];
      const allowed = { recall: ['called'], start: ['called'], complete: ['serving'], skip: ['called'], return: ['skipped'], cancel: ['waiting', 'called', 'serving'], transfer: ['waiting', 'called'] };
      if (!allowed[act]) return fail(res, 404, 'NOT_FOUND');
      if (act === 'return' && !u.can_skip_return || act === 'cancel' && !u.can_cancel || act === 'transfer' && !u.can_transfer) return fail(res, 403, 'FORBIDDEN');
      if (t.counter && (t.status === 'called' || t.status === 'serving') && !counters.find(c => c.id === t.counter)) return fail(res, 409, 'ALREADY_CALLED');
      if (!allowed[act].includes(t.status)) return fail(res, 409, 'INVALID_TRANSITION');
      if (act === 'recall') emit('ticket:recalled', t, { counter: counters.find(c => c.id === t.counter), announce: true });
      if (act === 'start') { t.status = 'serving'; t.servingAt = now(); emit('ticket:serving', t, { counter: counters.find(c => c.id === t.counter) }); }
      if (act === 'complete') { t.status = 'completed'; emit('ticket:completed', t); t.counter = t.counter; }
      if (act === 'skip') { t.status = 'skipped'; emit('ticket:skipped', t); }
      if (act === 'return') { t.status = 'waiting'; t.counter = null; emit('ticket:created', t); }
      if (act === 'cancel') { t.status = 'cancelled'; emit('ticket:cancelled', t, { reason: body.reason }); }
      if (act === 'transfer') { if (!u.services.includes(body.serviceId) || body.serviceId === t.service) return fail(res, 400, 'VALIDATION'); t.service = body.serviceId; t.status = 'waiting'; t.counter = null; emit('ticket:created', t); }
      return ok(res, { ticket: staffView(t) });
    }
  }
  fail(res, 404, 'NOT_FOUND');
}

io = new Server(server, { path: '/socket.io' });
io.on('connection', sock => {
  const sid = cookie({ headers: sock.handshake.headers }, 'qm.sid'); const s = sid && sessions.get(sid);
  if (s && s.user) sock.join('clinic:1:staff');
  sock.on('ticket:watch', ({ token } = {}) => { const t = tickets.find(x => x.token === token); if (t) sock.join('ticket:' + t.publicId); });
});
server.listen(PORT, () => console.log('DEV MOCK on http://localhost:' + PORT + '  (patient: /patient/  staff: /staff/)'));
