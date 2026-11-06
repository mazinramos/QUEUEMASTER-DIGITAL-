'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SERVER = path.join(__dirname, '..', '..');
const probe = `const c=require('./src/config');console.log(JSON.stringify({p:c.ticketTokenPepper,s:c.sessionSecret,k:c.phoneEncKey,e:process.env.TICKET_TOKEN_PEPPER,k2:process.env.PHONE_ENC_KEY}))`;
function run(env) {
  const clean = { PATH: process.env.PATH, HOME: os.tmpdir(), ...env };
  const r = spawnSync(process.execPath, ['-e', probe], { cwd: SERVER, env: clean, encoding: 'utf8' });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr };
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'qm-cfg-'));
const HEX64 = 'a'.repeat(64);

test('production: missing secrets -> startup fails naming every missing variable', () => {
  const r = run({ NODE_ENV: 'production', DATA_DIR: tmp() });
  assert.notEqual(r.code, 0);
  for (const n of ['SESSION_SECRET', 'TICKET_TOKEN_PEPPER', 'PHONE_ENC_KEY']) assert.match(r.err, new RegExp(n));
  assert.match(r.err, /randomBytes/); // tells how to generate
});

test('production: all three present -> boots, never touches the dev secrets file', () => {
  const d = tmp();
  const r = run({ NODE_ENV: 'production', DATA_DIR: d, SESSION_SECRET: 's'.repeat(20), TICKET_TOKEN_PEPPER: 'p'.repeat(20), PHONE_ENC_KEY: HEX64 });
  assert.equal(r.code, 0, r.err);
  assert.equal(fs.existsSync(path.join(d, '.dev-secrets.json')), false);
});

test('invalid values are rejected (short pepper, non-hex / wrong-length PHONE_ENC_KEY)', () => {
  const base = { NODE_ENV: 'production', DATA_DIR: tmp(), SESSION_SECRET: 's'.repeat(20), TICKET_TOKEN_PEPPER: 'p'.repeat(20), PHONE_ENC_KEY: HEX64 };
  assert.notEqual(run({ ...base, TICKET_TOKEN_PEPPER: 'short' }).code, 0);
  assert.notEqual(run({ ...base, PHONE_ENC_KEY: 'zz'.repeat(32) }).code, 0);
  assert.notEqual(run({ ...base, PHONE_ENC_KEY: 'ab'.repeat(16) }).code, 0);
});

test('development: secrets generated ONCE, persisted, stable across restarts, file is private', () => {
  const d = tmp();
  const a = run({ NODE_ENV: 'development', DATA_DIR: d });
  assert.equal(a.code, 0, a.err);
  const first = JSON.parse(a.out);
  const file = path.join(d, '.dev-secrets.json');
  assert.ok(fs.existsSync(file));
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o077, 0);
  const b = run({ NODE_ENV: 'development', DATA_DIR: d });
  assert.deepEqual(JSON.parse(b.out), first);          // same values after "restart"
  assert.equal(first.e, first.p); assert.equal(first.k2, first.k); // exported to process.env for other modules
  assert.match(first.k, /^[0-9a-f]{64}$/);
});

test('development: explicit env wins; corrupt file is regenerated; aliases accepted', () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, '.dev-secrets.json'), '{not json');
  const r = run({ NODE_ENV: 'development', DATA_DIR: d, TOKEN_PEPPER: 'alias-pepper-0123456789' });
  assert.equal(r.code, 0, r.err);
  const o = JSON.parse(r.out);
  assert.equal(o.p, 'alias-pepper-0123456789');
  assert.match(o.k, /^[0-9a-f]{64}$/);
});

test('COOKIE_SECURE only accepts auto|true|false', () => {
  assert.notEqual(run({ NODE_ENV: 'development', DATA_DIR: tmp(), COOKIE_SECURE: 'maybe' }).code, 0);
  for (const v of ['auto', 'true', 'false']) assert.equal(run({ NODE_ENV: 'development', DATA_DIR: tmp(), COOKIE_SECURE: v }).code, 0);
});

test('.dev-secrets.json is ignored by git', () => {
  const r = spawnSync('git', ['check-ignore', '-q', 'server/data/.dev-secrets.json'], { cwd: path.join(SERVER, '..') });
  assert.equal(r.status, 0);
});

test('npm run secrets: prints three valid secrets; --write never overwrites existing values', () => {
  const run = (args, cwd) => spawnSync(process.execPath, [path.join(SERVER, 'src/config/gen-secrets.js'), ...args], { cwd, encoding: 'utf8' });
  const out = run([], SERVER).stdout;
  for (const n of ['SESSION_SECRET', 'TICKET_TOKEN_PEPPER', 'PHONE_ENC_KEY']) assert.match(out, new RegExp(`^${n}=\\S{16,}`, 'm'));
  assert.match(out, /^PHONE_ENC_KEY=[0-9a-f]{64}$/m);
  // --write against a temp copy of the server dir layout: src/config/gen-secrets.js resolves ../../.env
  const tmpRoot = tmp();
  fs.mkdirSync(path.join(tmpRoot, 'src', 'config'), { recursive: true });
  for (const f of ['gen-secrets.js', 'secrets.js']) fs.copyFileSync(path.join(SERVER, 'src', 'config', f), path.join(tmpRoot, 'src', 'config', f));
  fs.writeFileSync(path.join(tmpRoot, '.env'), 'PORT=3000\nSESSION_SECRET=keep-this-existing-secret-1234\n');
  const r = spawnSync(process.execPath, [path.join(tmpRoot, 'src/config/gen-secrets.js'), '--write'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const env = fs.readFileSync(path.join(tmpRoot, '.env'), 'utf8');
  assert.match(env, /^SESSION_SECRET=keep-this-existing-secret-1234$/m);
  assert.match(env, /^TICKET_TOKEN_PEPPER=\S{16,}$/m); assert.match(env, /^PHONE_ENC_KEY=[0-9a-f]{64}$/m);
  assert.equal((env.match(/SESSION_SECRET=/g) || []).length, 1);
  assert.equal(fs.existsSync(path.join(SERVER, '.env')), false, 'the test must never touch the real server/.env');
  const again = spawnSync(process.execPath, [path.join(tmpRoot, 'src/config/gen-secrets.js'), '--write'], { encoding: 'utf8' });
  assert.match(again.stdout, /Nothing to add/);
  assert.equal(fs.readFileSync(path.join(tmpRoot, '.env'), 'utf8'), env); // second run changes nothing
  // the generated .env boots a production-mode config
  const boot = spawnSync(process.execPath, ['-e', "const c=require('./src/config');console.log('ok',c.env)"], { cwd: SERVER, encoding: 'utf8',
    env: { PATH: process.env.PATH, NODE_ENV: 'production', DATA_DIR: tmp(), ...Object.fromEntries(env.split('\n').filter((l) => /^(SESSION_SECRET|TICKET_TOKEN_PEPPER|PHONE_ENC_KEY)=/.test(l)).map((l) => l.split('='))) } });
  assert.match(boot.stdout, /ok production/, boot.stderr);
});
