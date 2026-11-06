'use strict';
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawnSync } = require('node:child_process');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'qm-bk-'));
process.env.DATA_DIR = DATA;          // before anything loads config
process.env.BACKUP_KEEP = '3';
process.env.LOGIN_RATE_MAX = '100000';
const h = require('./helpers');
const Database = require('better-sqlite3');
const backup = require('../../src/services/backup');

const SERVER = path.join(__dirname, '..', '..');
let app; let c1; let svcId;
const mkTicket = (n, status = 'waiting') => {
  const now = new Date().toISOString();
  h.getDb().prepare(`INSERT INTO tickets (public_id,clinic_id,service_id,business_date,seq_number,display_number,token_hash,status,issued_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(`pub-${n}-${Math.random()}`, c1, svcId, '2026-11-05', n, `A-${String(n).padStart(3, '0')}`, `hash-${n}-${Math.random()}`, status, now, now, now);
};
const wipe = () => { for (const f of fs.existsSync(backup.backupsDir()) ? fs.readdirSync(backup.backupsDir()) : []) fs.unlinkSync(path.join(backup.backupsDir(), f)); };

before(async () => {
  app = h.newApp();
  c1 = await h.mkClinic('C1');
  await h.mkStaff(c1, 'adm', 'admin'); await h.mkStaff(c1, 'mgr', 'manager'); await h.mkStaff(c1, 'stf', 'staff');
  svcId = h.mkService(c1, 'A');
  for (let i = 1; i <= 25; i++) mkTicket(i);
});
beforeEach(wipe);
after(() => { backup.stopScheduler(); fs.rmSync(DATA, { recursive: true, force: true }); });

test('backup opens as a valid DB and holds the same data', async () => {
  const r = await backup.createBackup();
  assert.match(r.name, /^qm-\d{8}-\d{4}(-\d+)?\.db$/);
  assert.equal(r.integrity, 'ok'); assert.equal(r.tickets, 25);
  const copy = new Database(path.join(backup.backupsDir(), r.name), { readonly: true });
  try {
    assert.equal(copy.prepare('SELECT COUNT(*) c FROM tickets').get().c, 25);
    assert.deepEqual(copy.prepare('SELECT public_id, display_number, status FROM tickets ORDER BY id').all(),
      h.getDb().prepare('SELECT public_id, display_number, status FROM tickets ORDER BY id').all());
    assert.equal(copy.prepare('SELECT COUNT(*) c FROM staff').get().c, 3);
    assert.equal(copy.pragma('integrity_check', { simple: true }), 'ok');
  } finally { copy.close(); }
});

test('a backup is ONE self-contained file: journal_mode=DELETE, no -wal/-shm left behind, also after retention', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qm-side-'));
  const live = new Database(path.join(dir, 'live.db')); live.pragma('journal_mode = WAL');
  require('../../src/database/migrate').runMigrations(live);
  const names = [];
  for (let i = 0; i < 5; i++) names.push((await backup.createBackup({ db: live })).name);
  const files = fs.readdirSync(backup.backupsDir());
  assert.deepEqual(files.filter((f) => !/^qm-\d{8}-\d{4}(-\d+)?\.db$/.test(f)), [], `stray files: ${files}`);
  assert.equal(files.length, 3); // BACKUP_KEEP=3, and removed ones took their sidecars with them
  const copy = new Database(path.join(backup.backupsDir(), names[4]), { readonly: true });
  assert.equal(copy.pragma('journal_mode', { simple: true }), 'delete');
  copy.close();
  assert.deepEqual(fs.readdirSync(backup.backupsDir()).filter((f) => /-(wal|shm)$/.test(f)), []);
  live.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test('consistent while the DB is being written to during the backup (real file DB)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qm-live-'));
  const live = new Database(path.join(dir, 'live.db'));
  live.pragma('journal_mode = WAL'); live.pragma('foreign_keys = ON');
  require('../../src/database/migrate').runMigrations(live);
  const now = new Date().toISOString();
  live.prepare("INSERT INTO clinics (name_ar,created_at,updated_at) VALUES ('c',?,?)").run(now, now);
  live.prepare("INSERT INTO services (clinic_id,name_ar,prefix,created_at,updated_at) VALUES (1,'s','A',?,?)").run(now, now);
  const ins = live.prepare(`INSERT INTO tickets (public_id,clinic_id,service_id,business_date,seq_number,display_number,token_hash,issued_at,created_at,updated_at)
    VALUES (?,1,1,'2026-11-05',?,?,?,?,?,?)`);
  let n = 0;
  const add = () => { n++; ins.run(`p${n}`, n, `A-${n}`, `h${n}`, now, now, now); };
  live.transaction(() => { for (let i = 0; i < 6000; i++) add(); })();
  const before = n;
  let stop = false;
  const writer = (async () => { while (!stop) { add(); await new Promise((r) => setImmediate(r)); } })();
  const r = await backup.createBackup({ db: live });
  stop = true; await writer;
  const check = backup.verifyBackup(path.join(backup.backupsDir(), r.name));
  assert.equal(check.ok, true);
  assert.ok(check.tickets >= before && check.tickets <= n, `backup=${check.tickets} before=${before} final=${n}`);
  assert.ok(n > before, 'writer really ran concurrently');
  live.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test('retention keeps the newest BACKUP_KEEP and deletes older ones', async () => {
  const made = [];
  for (let i = 0; i < 5; i++) made.push((await backup.createBackup()).name);
  const left = backup.listBackups().map((b) => b.name);
  assert.equal(left.length, 3);
  assert.deepEqual(left, made.slice(2).reverse()); // newest first; the 2 oldest are gone
  for (const gone of made.slice(0, 2)) assert.equal(fs.existsSync(path.join(backup.backupsDir(), gone)), false);
});

test('a backup that fails the integrity check is quarantined and never listed', async () => {
  const bad = { backup: async (file) => { fs.writeFileSync(file, Buffer.from('this is not a sqlite database at all'.repeat(200))); } };
  await assert.rejects(() => backup.createBackup({ db: bad }));
  assert.equal(backup.listBackups().length, 0);
  assert.ok(fs.readdirSync(backup.backupsDir()).some((f) => f.endsWith('.corrupt')));
  assert.ok(!fs.readdirSync(backup.backupsDir()).some((f) => f.endsWith('.partial')));
});

test('concurrent requests produce a single backup', async () => {
  const [a, b] = await Promise.all([backup.createBackup(), backup.createBackup()]);
  assert.equal(a.name, b.name); assert.equal(backup.listBackups().length, 1);
});

test('API: admin only; create, list, download identical bytes', async () => {
  assert.equal((await h.request(app).get('/api/admin/backups')).status, 401);
  for (const u of ['stf', 'mgr']) {
    const s = await h.login(app, u);
    assert.equal((await s.get('/api/admin/backups')).status, 403, u);
    assert.equal((await s.post('/api/admin/backups', {})).status, 403, u);
  }
  const a = await h.login(app, 'adm');
  const created = await a.post('/api/admin/backups', {});
  assert.equal(created.status, 201); assert.equal(created.body.data.tickets >= 25, true);
  const list = await a.get('/api/admin/backups');
  assert.equal(list.body.data.items.length, 1); assert.equal(list.body.data.keep, 3);
  const dl = await a.agent.get(`/api/admin/backups/${created.body.data.name}`).buffer(true).parse((res, cb) => {
    const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks)));
  });
  assert.equal(dl.status, 200);
  assert.match(dl.headers['content-disposition'], /attachment/);
  assert.deepEqual(dl.body, fs.readFileSync(path.join(backup.backupsDir(), created.body.data.name)));
  assert.equal(dl.body.subarray(0, 15).toString(), 'SQLite format 3');
  const audit = (await a.get('/api/admin/audit?action=backup.')).body.data.items.map((i) => i.action);
  assert.ok(audit.includes('backup.create') && audit.includes('backup.download'));
});

test('download rejects traversal and any name not produced by the backup service', async () => {
  const a = await h.login(app, 'adm');
  fs.writeFileSync(path.join(DATA, 'secret.db'), 'TOP-SECRET');
  fs.writeFileSync(path.join(backup.backupsDir(), 'notes.txt'), 'x');
  const r = await backup.createBackup();
  const evil = ['..%2fsecret.db', '..%2f..%2fetc%2fpasswd', '%2e%2e%2fsecret.db', '..%5csecret.db', '....//secret.db', 'secret.db',
    'notes.txt', 'QM-20261105-1030.DB', `${r.name}.partial`, `${r.name}.corrupt`, `${r.name}%00.txt`, 'qm-20261105-1030.db%2f..%2f..%2fsecret.db',
    encodeURIComponent('/etc/passwd'), 'pre-restore-x.db'];
  for (const name of evil) {
    const res = await a.agent.get(`/api/admin/backups/${name}`);
    assert.ok([400, 404].includes(res.status), `${name} -> ${res.status}`);
    assert.ok(!JSON.stringify(res.body).includes('TOP-SECRET') && !String(res.text).includes('TOP-SECRET'));
  }
  assert.equal(backup.resolveBackupPath('../secret.db'), null);
  assert.equal(backup.resolveBackupPath(r.name) !== null, true);
});

test('scheduler runs backups on its interval and stops cleanly', async () => {
  assert.equal(backup.startScheduler({ allowMemory: true, intervalMs: 150, log: { log() {}, error() {} } }), true);
  assert.equal(backup.startScheduler({ allowMemory: true, intervalMs: 150 }), false); // already running
  await new Promise((r) => setTimeout(r, 700));
  backup.stopScheduler();
  assert.ok(backup.listBackups().length >= 1);
  const n = backup.listBackups().length;
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(backup.listBackups().length, n); // stopped
  process.env.BACKUP_ENABLED = 'false';
  assert.equal(backup.startScheduler({ allowMemory: true, intervalMs: 150 }), false);
  delete process.env.BACKUP_ENABLED;
});

// ---------- restore (real file DB, separate processes, like production) ----------
function nodeIn(env, code) {
  return spawnSync(process.execPath, ['-e', code], { cwd: SERVER, env: { PATH: process.env.PATH, HOME: env.DATA_DIR, NODE_ENV: 'development', ...env }, encoding: 'utf8' });
}
const cli = (env, script, ...args) => spawnSync(process.execPath, [script, ...args], { cwd: SERVER, env: { PATH: process.env.PATH, HOME: env.DATA_DIR, NODE_ENV: 'development', ...env }, encoding: 'utf8' });
const countTickets = (env) => Number(nodeIn(env, `const {getDb}=require('./src/database');console.log(getDb().prepare('SELECT COUNT(*) c FROM tickets').get().c)`).stdout.trim());

function prepareFileDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qm-rs-'));
  const env = { DATA_DIR: dir, PORT: '0' };
  const r = nodeIn(env, `
    const {getDb,nowIso}=require('./src/database');require('./src/database/migrate').runMigrations(getDb());
    const db=getDb();const n=nowIso();
    db.prepare("INSERT INTO clinics (name_ar,created_at,updated_at) VALUES ('c',?,?)").run(n,n);
    db.prepare("INSERT INTO services (clinic_id,name_ar,prefix,created_at,updated_at) VALUES (1,'s','A',?,?)").run(n,n);
    for(let i=1;i<=7;i++)db.prepare("INSERT INTO tickets (public_id,clinic_id,service_id,business_date,seq_number,display_number,token_hash,issued_at,created_at,updated_at) VALUES (?,1,1,'2026-11-05',?,?,?,?,?,?)").run('p'+i,i,'A-00'+i,'h'+i,n,n,n);`);
  assert.equal(r.status, 0, r.stderr);
  return { dir, env };
}

test('restore: backup -> lose data -> restore brings it back and keeps a safety copy', () => {
  const { dir, env } = prepareFileDb();
  const b = cli(env, 'src/services/backup.js'); assert.equal(b.status, 0, b.stderr);
  const name = JSON.parse(b.stdout).name;
  nodeIn(env, `require('./src/database').getDb().prepare('DELETE FROM tickets').run()`);
  assert.equal(countTickets(env), 0);

  assert.equal(cli(env, 'src/database/restore.js', name).status, 2);          // refuses without --yes
  assert.equal(countTickets(env), 0);
  const r = cli(env, 'src/database/restore.js', name, '--yes');
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(countTickets(env), 7);
  const safety = fs.readdirSync(path.join(dir, 'backups')).filter((f) => f.startsWith('pre-restore-'));
  assert.equal(safety.length, 1);
  const s = new Database(path.join(dir, 'backups', safety[0]), { readonly: true });
  assert.equal(s.prepare('SELECT COUNT(*) c FROM tickets').get().c, 0);       // safety copy = the state before restoring
  s.close();
  assert.ok(!fs.readdirSync(dir).some((f) => f.endsWith('.restoring')));
  assert.deepEqual(fs.readdirSync(path.join(dir, 'backups')).filter((f) => /-(wal|shm)$/.test(f)), [], 'no sidecar files next to backups');
  assert.equal(countTickets(env), 7); // the restored DB opens normally afterwards (switches back to WAL)
});

test('restore refuses an invalid backup and leaves the database untouched', () => {
  const { dir, env } = prepareFileDb();
  fs.mkdirSync(path.join(dir, 'backups'), { recursive: true });
  const bogus = path.join(dir, 'backups', 'qm-20260101-0000.db');
  fs.writeFileSync(bogus, 'not a database'.repeat(500));
  const r = cli(env, 'src/database/restore.js', bogus, '--yes');
  assert.equal(r.status, 1); assert.match(r.stderr, /not valid|file is not a database|FAILED/i);
  assert.equal(countTickets(env), 7);
  assert.equal(cli(env, 'src/database/restore.js', 'qm-19990101-0000.db', '--yes').status, 1); // missing
});

test('restore refuses while a server is answering on the port', async () => {
  const { env } = prepareFileDb();
  const b = JSON.parse(cli(env, 'src/services/backup.js').stdout).name;
  const srv = http.createServer((q, s) => s.end('ok'));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const out = await new Promise((resolve) => {
      const { spawn } = require('node:child_process');
      const p = spawn(process.execPath, ['src/database/restore.js', b, '--yes'], { cwd: SERVER, env: { PATH: process.env.PATH, HOME: env.DATA_DIR, NODE_ENV: 'development', DATA_DIR: env.DATA_DIR, PORT: String(srv.address().port) } });
      let err = ''; p.stderr.on('data', (d) => { err += d; }); p.on('close', (code) => resolve({ code, err }));
    });
    assert.equal(out.code, 1); assert.match(out.err, /Stop it first/);
  } finally { srv.close(); }
});

test('names stay monotonic after retention deletes older ones and when the clock goes backwards', async () => {
  const names = [];
  for (let i = 0; i < 6; i++) names.push((await backup.createBackup()).name);
  const sorted = [...names].sort((a, b) => {
    const p = (n) => /^qm-(\d{8}-\d{4})(?:-(\d+))?\.db$/.exec(n); const [x, y] = [p(a), p(b)];
    return x[1] === y[1] ? Number(x[2] || 1) - Number(y[2] || 1) : (x[1] < y[1] ? -1 : 1);
  });
  assert.deepEqual(names, sorted);                          // each new name sorts after every older one
  assert.equal(new Set(names).size, 6);
  assert.equal(backup.listBackups()[0].name, names[5]);     // newest is never the one retention removes
  // a future-dated backup already exists (clock moved back): the next one must still sort newest
  fs.writeFileSync(path.join(backup.backupsDir(), 'qm-20991231-2359.db'), fs.readFileSync(path.join(backup.backupsDir(), names[5])));
  const after = await backup.createBackup();
  assert.equal(backup.listBackups()[0].name, after.name);
  assert.match(after.name, /^qm-20991231-2359-2\.db$/);
});
