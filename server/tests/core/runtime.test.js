'use strict';
const { test, before, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
process.env.LOGIN_RATE_MAX = '100000';
const h = require('./helpers');
const logger = require('../../src/utils/logger');

const SERVER = path.join(__dirname, '..', '..');
let app; const lines = [];
before(async () => {
  app = h.newApp();
  const c = await h.mkClinic('C1');
  await h.mkStaff(c, 'adm', 'admin');
});
afterEach(() => { logger._setSink(null); lines.length = 0; });
const capture = () => logger._setSink((line, rec) => lines.push({ line, rec }));

test('health: ok, db ok, uptime, version; no secrets', async () => {
  const r = await h.request(app).get('/api/health');
  assert.equal(r.status, 200); assert.equal(r.body.ok, true);
  assert.equal(r.body.data.status, 'ok'); assert.equal(r.body.data.db, 'ok');
  assert.equal(typeof r.body.data.uptime, 'number'); assert.match(r.body.data.version, /^\d+\.\d+\.\d+/);
  assert.deepEqual(Object.keys(r.body.data).sort(), ['db', 'status', 'time', 'uptime', 'version']);
});

test('health reports 503 when the database is unreachable', async () => {
  const db = require('../../src/database');
  const { createApp } = require('../../src/app');
  const a = createApp({ autoMigrate: false });
  const handle = db.getDb();
  const orig = handle.prepare.bind(handle);
  handle.prepare = (sql) => { if (/^SELECT 1$/.test(sql)) throw new Error('db down'); return orig(sql); };
  try {
    const r = await h.request(a).get('/api/health');
    assert.equal(r.status, 503); assert.equal(r.body.ok, false); assert.equal(r.body.data.db, 'error');
    assert.ok(!JSON.stringify(r.body).includes('db down'));
  } finally { handle.prepare = orig; }
});

test('X-Request-Id: generated, echoed when valid, replaced when hostile', async () => {
  const a = await h.request(app).get('/api/health');
  assert.match(a.headers['x-request-id'], /^[0-9a-f-]{36}$/);
  const b = await h.request(app).get('/api/health').set('X-Request-Id', 'client-req-12345');
  assert.equal(b.headers['x-request-id'], 'client-req-12345');
  const c = await h.request(app).get('/api/health').set('X-Request-Id', 'bad id\twith spaces & <script>');
  assert.match(c.headers['x-request-id'], /^[0-9a-f-]{36}$/);
});

test('request log: one line per request with reqId/status/ms/path, in JSON', async () => {
  process.env.LOG_FORMAT = 'json'; capture();
  const r = await h.request(app).get('/api/nope');
  delete process.env.LOG_FORMAT;
  const rec = lines.map((l) => l.rec).find((x) => x.msg === 'request');
  assert.ok(rec);
  assert.equal(rec.reqId, r.headers['x-request-id']); assert.equal(rec.status, 404);
  assert.equal(rec.method, 'GET'); assert.equal(rec.path, '/api/nope'); assert.equal(typeof rec.ms, 'number');
  assert.equal(rec.level, 'warn');
});

test('LOGS NEVER CONTAIN passwords, tokens, phones, cookies, CSRF or query strings', async () => {
  const PASSWORD = 'Sup3r-Secret-Passw0rd!'; const TOKEN = 'tok_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcd'; const PHONE = '01012345678';
  process.env.LOG_FORMAT = 'json'; capture();
  const agent = h.request.agent(app);
  const csrf = (await agent.get('/api/auth/csrf')).body.data.csrfToken;
  await agent.post('/api/auth/login').set('X-CSRF-Token', csrf).send({ username: 'adm', password: PASSWORD, phone: PHONE });
  const ok = await h.login(app, 'adm');
  await ok.get(`/api/public/tickets/${TOKEN}?t=${TOKEN}&phone=${PHONE}`);
  await ok.get(`/api/admin/audit?action=${PHONE}`);
  await h.request(app).get('/api/health').set('Authorization', `Bearer ${TOKEN}`).set('Cookie', `qm.sid=${TOKEN}`).set('X-CSRF-Token', csrf);
  delete process.env.LOG_FORMAT;
  const all = lines.map((l) => l.line).join('\n');
  assert.ok(lines.length >= 5);
  for (const secret of [PASSWORD, TOKEN, PHONE, csrf, h.PW]) assert.ok(!all.includes(secret), `leaked: ${secret}`);
  assert.match(all, /\/api\/public\/tickets\/:id/); // the id segment is masked, the route stays readable
});

test('logger.redact masks sensitive keys at any depth; safePath masks ids and phone-like segments', () => {
  const out = logger.redact({ user: 'a', password: 'x', nested: { phoneNumber: '1', ok: 1, deep: [{ authorization: 'Bearer z' }] }, csrfToken: 'c' });
  assert.deepEqual(out, { user: 'a', password: '[redacted]', nested: { phoneNumber: '[redacted]', ok: 1, deep: [{ authorization: '[redacted]' }] }, csrfToken: '[redacted]' });
  assert.equal(logger.safePath('/api/public/tickets/abcdefghijklmnopqrstuvwxyz012345?x=1'), '/api/public/tickets/:id');
  assert.equal(logger.safePath('/api/admin/staff/12?q=1#h'), '/api/admin/staff/12');
  assert.equal(logger.safePath('/x/01012345678/y'), '/x/:id/y');
});

test('500 errors: generic body, request id, stack goes to the log only', () => {
  capture();
  const { errorHandler } = require('../../src/middleware/errorHandler');
  const res = { headersSent: false, headers: {}, set(k, v) { this.headers[k] = v; return this; }, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  const err = new Error('SQLITE secret detail: password=hunter2'); 
  errorHandler(err, { id: 'req-123456789', originalUrl: '/api/x?token=abc' }, res, () => {});
  assert.equal(res.code, 500); assert.deepEqual(res.body, { ok: false, error: { code: 'INTERNAL', message: 'Internal server error' } });
  assert.equal(res.headers['X-Request-Id'], 'req-123456789');
  const rec = lines.map((l) => l.rec).find((x) => x.msg === 'unhandled error');
  assert.equal(rec.reqId, 'req-123456789'); assert.ok(rec.stack); assert.equal(rec.path, '/api/x');
});

// ---------- graceful shutdown on a real process ----------
function startServer(extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qm-srv-'));
  const env = { PATH: process.env.PATH, HOME: dir, NODE_ENV: 'development', DATA_DIR: dir, PORT: '0', LOG_FORMAT: 'json', BACKUP_ENABLED: 'true', ...extraEnv };
  const p = spawn(process.execPath, ['src/server.js'], { cwd: SERVER, env });
  let out = ''; let err = '';
  p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
  let stopWaiting = () => {};
  const ready = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`server did not start: ${out}${err}`)), 15000);
    const iv = setInterval(() => {
      const m = /"msg":"listening".*?"port":(\d+)/.exec(out);
      if (m) { stopWaiting(); resolve(Number(m[1])); }
    }, 50);
    stopWaiting = () => { clearInterval(iv); clearTimeout(t); };
    p.on('close', () => { stopWaiting(); reject(new Error('server exited before listening')); });
  });
  ready.catch(() => {}); // avoid unhandled rejection when the process is expected to die
  const exited = new Promise((resolve) => p.on('close', (code, sig) => resolve({ code, sig })));
  return { p, dir, ready, exited, logs: () => out + err };
}

test('SIGTERM: server exits 0 quickly, logs shutdown, checkpoints WAL, even with an idle keep-alive client', async () => {
  const s = startServer();
  const port = await s.ready;
  const sock = net.connect(port, '127.0.0.1'); // keep-alive client that never closes
  await new Promise((r) => sock.on('connect', r));
  sock.write('GET /api/health HTTP/1.1\r\nHost: x\r\nConnection: keep-alive\r\n\r\n');
  await new Promise((r) => setTimeout(r, 300));
  const t0 = Date.now();
  s.p.kill('SIGTERM');
  const { code } = await s.exited;
  sock.destroy();
  assert.equal(code, 0, s.logs());
  assert.ok(Date.now() - t0 < 6000, `took ${Date.now() - t0}ms`);
  assert.match(s.logs(), /"msg":"shutting down"/); assert.match(s.logs(), /"msg":"bye"/);
  assert.equal(fs.existsSync(path.join(s.dir, 'queuemaster.db-wal')), false, 'WAL checkpointed and removed on close');
  assert.equal(fs.existsSync(path.join(s.dir, 'queuemaster.db')), true);
});

test('SIGINT works too, and the process leaves no listener behind', async () => {
  const s = startServer();
  const port = await s.ready;
  const res = await fetch(`http://127.0.0.1:${port}/api/health`);
  assert.equal(res.status, 200); assert.ok(res.headers.get('x-request-id'));
  s.p.kill('SIGINT');
  assert.equal((await s.exited).code, 0);
  await assert.rejects(() => fetch(`http://127.0.0.1:${port}/api/health`));
});

test('production-like boot with missing secrets exits non-zero with a clear message (no stack spam)', async () => {
  const s = startServer({ NODE_ENV: 'production' });
  const r = await Promise.race([s.exited, s.ready.then(() => 'started').catch(() => 'failed')]);
  assert.notEqual(r, 'started');
  const { code } = await s.exited;
  assert.notEqual(code, 0);
  assert.match(s.logs(), /SESSION_SECRET/);
});
