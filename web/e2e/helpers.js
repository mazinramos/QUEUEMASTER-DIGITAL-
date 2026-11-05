// E2E helpers. Needs a Chromium: set CHROMIUM_PATH (or on Windows 11 Edge is used automatically via channel).
// Run: cd web && npm i && npm run dev:mock (other terminal) && npm run test:e2e
const { chromium } = require('playwright-core');
const BASE = process.env.QM_BASE || 'http://localhost:3100';
async function launch(args) {
  const opts = { headless: true, args: args || [] };
  if (process.env.CHROMIUM_PATH) opts.executablePath = process.env.CHROMIUM_PATH; else if (process.platform === 'win32') opts.channel = 'msedge';
  return chromium.launch(opts);
}
/* staff API client with a cookie jar, to drive the queue from "another counter" while a patient page is open */
function staffClient(user = 'manager', pass = 'manager123') {
  const jar = {}; let csrf = '';
  async function call(method, path, body) {
    const r = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', Cookie: Object.entries(jar).map(([k, v]) => k + '=' + v).join('; '), 'X-CSRF-Token': csrf }, body: body ? JSON.stringify(body) : undefined });
    for (const c of (r.headers.getSetCookie ? r.headers.getSetCookie() : [])) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i).trim()] = kv.slice(i + 1); }
    return r.json();
  }
  return {
    call,
    async login() { csrf = (await call('GET', '/api/auth/csrf')).data.csrfToken; const r = await call('POST', '/api/auth/login', { username: user, password: pass }); if (!r.ok) throw new Error('login failed'); if (r.data.csrfToken) csrf = r.data.csrfToken; return r.data; }
  };
}
let passed = 0, failed = 0;
async function step(name, fn) { try { await fn(); passed++; console.log('  ok   ' + name); } catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.message || e).split('\n')[0]); } }
function summary() { console.log(`\n${passed} passed, ${failed} failed`); return failed ? 1 : 0; }
const dev = (path, body) => fetch(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }).then(r => r.json());
module.exports = { launch, staffClient, step, summary, dev, BASE };
