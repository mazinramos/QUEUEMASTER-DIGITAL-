'use strict';
const { test, before, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
process.env.LOGIN_RATE_MAX = '100000';
const pw = require('../../src/utils/password');
const h = require('./helpers');

afterEach(() => pw._forceScrypt(false));

test('argon2id path (when the native package is available)', async (t) => {
  if (!pw.argonAvailable()) return t.skip('argon2 not installed here');
  const hash = await pw.hashPassword('Correct-Horse-1');
  assert.equal(pw.algorithm(hash), 'argon2id');
  assert.equal(await pw.verifyPassword(hash, 'Correct-Horse-1'), true);
  assert.equal(await pw.verifyPassword(hash, 'Correct-Horse-2'), false);
  assert.equal(pw.needsRehash(hash), false);
});

test('scrypt fallback: hash, verify, wrong password, unique salts, algorithm stored in the hash', async () => {
  pw._forceScrypt(true);
  const a = await pw.hashPassword('Correct-Horse-1'); const b = await pw.hashPassword('Correct-Horse-1');
  assert.match(a, /^\$scrypt\$ln=15,r=8,p=1\$/);
  assert.equal(pw.algorithm(a), 'scrypt'); assert.notEqual(a, b);
  assert.equal(await pw.verifyPassword(a, 'Correct-Horse-1'), true);
  assert.equal(await pw.verifyPassword(a, 'correct-horse-1'), false);
  assert.equal(await pw.verifyPassword(a, ''), false);
  assert.equal(pw.needsRehash(a), false);
});

test('verification supports BOTH formats regardless of which is preferred', async (t) => {
  if (!pw.argonAvailable()) return t.skip('argon2 not installed here');
  const argonHash = await pw.hashPassword('Mixed-Pass-123');
  pw._forceScrypt(true);
  const scryptHash = await pw.hashPassword('Mixed-Pass-123');
  for (const f of [true, false]) {
    pw._forceScrypt(f);
    assert.equal(await pw.verifyPassword(argonHash, 'Mixed-Pass-123'), true, `argon hash, forceScrypt=${f}`);
    assert.equal(await pw.verifyPassword(scryptHash, 'Mixed-Pass-123'), true, `scrypt hash, forceScrypt=${f}`);
    assert.equal(await pw.verifyPassword(scryptHash, 'nope'), false);
  }
});

test('needsRehash: scrypt -> argon2 when available; never downgrades argon2 -> scrypt; weak scrypt params flagged', async (t) => {
  pw._forceScrypt(true);
  const s = await pw.hashPassword('Pass-Word-123');
  const weak = s.replace('ln=15', 'ln=12');
  {
    pw._forceScrypt(false);
    if (pw.argonAvailable()) assert.equal(pw.needsRehash(s), true);
    const a = pw.argonAvailable() ? await pw.hashPassword('Pass-Word-123') : null;
    pw._forceScrypt(true);
    if (a) assert.equal(pw.needsRehash(a), false);
  }
  pw._forceScrypt(true);
  assert.equal(pw.needsRehash(weak), true);
  assert.equal(pw.needsRehash('garbage'), false);
});

test('malformed / hostile hashes verify false and never throw or burn memory', async () => {
  for (const bad of ['', 'plain', '$scrypt$', '$scrypt$ln=15,r=8,p=1$@@@$@@@', '$scrypt$ln=30,r=8,p=1$AAAA$AAAA',
    '$scrypt$ln=15,r=999,p=1$AAAA$AAAA', '$argon2id$garbage', null, undefined, 42]) {
    assert.equal(await pw.verifyPassword(bad, 'x'), false, String(bad));
  }
});

test('login on a fallback-only machine: argon2 missing (module cannot load) -> scrypt end to end', () => {
  const code = `
    const Module = require('module'); const orig = Module._load;
    Module._load = function (req, ...rest) { if (req === 'argon2') { const e = new Error("Cannot find module 'argon2'"); e.code = 'MODULE_NOT_FOUND'; throw e; } return orig.call(this, req, ...rest); };
    process.env.NODE_ENV = 'test'; process.env.DB_PATH = ':memory:';
    const pw = require('./src/utils/password');
    (async () => {
      const h = await pw.hashPassword('Windows-Fallback-1');
      console.log(JSON.stringify({ alg: pw.algorithm(h), pref: pw.preferred(), avail: pw.argonAvailable(), ok: await pw.verifyPassword(h, 'Windows-Fallback-1'), bad: await pw.verifyPassword(h, 'x'),
        argonHashRejected: await pw.verifyPassword('$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$aGFzaGhhc2hoYXNoaGFzaA', 'x') }));
    })();`;
  const r = spawnSync(process.execPath, ['-e', code], { cwd: path.join(__dirname, '..', '..'), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { alg: 'scrypt', pref: 'scrypt', avail: false, ok: true, bad: false, argonHashRejected: false });
});

test('login with a scrypt hash works and is transparently upgraded to argon2id when available', async (t) => {
  const app = h.newApp();
  const c = await h.mkClinic('C1');
  pw._forceScrypt(true);
  const scryptHash = await pw.hashPassword(h.PW);
  pw._forceScrypt(false);
  const now = new Date().toISOString();
  const id = h.getDb().prepare(`INSERT INTO staff (clinic_id,username,password_hash,full_name,role,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`)
    .run(c, 'legacy', scryptHash, 'Legacy', 'staff', now, now).lastInsertRowid;
  const wrong = await h.login(app, 'legacy', 'wrong-password-123');
  assert.equal(wrong.res.status, 401);
  assert.match(h.getDb().prepare('SELECT password_hash FROM staff WHERE id=?').get(id).password_hash, /^\$scrypt\$/); // failed login must not rehash
  const ok = await h.login(app, 'legacy');
  assert.equal(ok.res.status, 200);
  const after = h.getDb().prepare('SELECT password_hash FROM staff WHERE id=?').get(id).password_hash;
  if (pw.argonAvailable()) assert.match(after, /^\$argon2id\$/); else assert.match(after, /^\$scrypt\$/);
  assert.equal((await h.login(app, 'legacy')).res.status, 200); // still works after the upgrade
});

test('forcing scrypt for NEW hashes does not break existing argon2 accounts when the package is present', async (t) => {
  if (!pw.argonAvailable()) return t.skip('argon2 not installed here');
  const app = h.newApp();
  const c = await h.mkClinic('C2');
  await h.mkStaff(c, 'argonuser', 'staff'); // hashed with argon2 by the helper
  pw._forceScrypt(true); // only affects NEW hashes; verifying the stored argon2 hash still works
  assert.equal((await h.login(app, 'argonuser')).res.status, 200);
});
