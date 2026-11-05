'use strict';
// مساعدات الاختبار فقط. المخطط: مهاجرات حساب 1 إن وُجدت، وإلا كتلة SQL من docs/database.md (العقد الملزم).
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const q = require('./queueDb');

const ROOT = path.resolve(__dirname, '../../..');

function schemaSql() {
  const migDir = path.join(ROOT, 'server/src/database/migrations');
  if (fs.existsSync(migDir)) {
    const files = fs.readdirSync(migDir).filter((f) => f.endsWith('.sql')).sort();
    if (files.length) return files.map((f) => fs.readFileSync(path.join(migDir, f), 'utf8')).join('\n');
  }
  const md = fs.readFileSync(path.join(ROOT, 'docs/database.md'), 'utf8');
  const m = /```sql\n([\s\S]*?)```/.exec(md);
  if (!m) throw new Error('no sql block in docs/database.md');
  return m[1];
}

function openDb(file) {
  const db = new Database(file || ':memory:');
  db.pragma('foreign_keys = ON');
  if (file) { db.pragma('journal_mode = WAL'); db.pragma('busy_timeout = 10000'); }
  return db;
}

function migrate(db) {
  const has = db.prepare("SELECT name FROM sqlite_master WHERE name='tickets'").get();
  if (!has) db.exec(schemaSql());
}

const T0 = '2026-01-10T00:00:00.000Z';
function seed(db, o = {}) {
  const tz = o.timezone || 'UTC';
  const c = db.prepare(`INSERT INTO clinics (name_ar, name_en, timezone, created_at, updated_at) VALUES (?,?,?,?,?)`)
    .run(o.name || 'عيادة', 'Clinic', tz, T0, T0).lastInsertRowid;
  const mkSvc = (name, prefix, est = 10) => db.prepare(`INSERT INTO services (clinic_id,name_ar,name_en,prefix,est_duration_min,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`)
    .run(c, name, name + '-en', prefix, est, T0, T0).lastInsertRowid;
  const A = mkSvc('عيادة عامة', 'A'); const B = mkSvc('أسنان', 'B');
  const mkCounter = (n) => db.prepare(`INSERT INTO counters (clinic_id,name_ar,number,created_at,updated_at) VALUES (?,?,?,?,?)`).run(c, 'شباك ' + n, n, T0, T0).lastInsertRowid;
  const counters = []; for (let i = 1; i <= (o.counters || 5); i++) counters.push(mkCounter(i));
  const mkStaff = (u, role, svcs, flags = {}) => {
    const id = db.prepare(`INSERT INTO staff (clinic_id,username,password_hash,full_name,role,can_skip_return,can_cancel,can_transfer,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(c, u, 'x', u, role, flags.ret ? 1 : 0, flags.cancel ? 1 : 0, flags.transfer ? 1 : 0, T0, T0).lastInsertRowid;
    for (const s of svcs) db.prepare('INSERT INTO staff_services (staff_id, service_id) VALUES (?,?)').run(id, s);
    return id;
  };
  const staff = [];
  for (let i = 1; i <= (o.staff || 5); i++) staff.push(mkStaff('s' + i, 'staff', [A, B]));
  return {
    clinicId: c, A, B, counters, staff,
    onlyA: mkStaff('onlyA', 'staff', [A]),
    perms: mkStaff('perms', 'staff', [A, B], { ret: true, cancel: true, transfer: true }),
    manager: mkStaff('mgr', 'manager', []),
    mkStaff, mkSvc, mkCounter,
  };
}

function setup(file, opts) {
  process.env.TICKET_TOKEN_PEPPER = process.env.TICKET_TOKEN_PEPPER || 'test-pepper-0123456789abcdef';
  process.env.QM_SILENT = process.env.QM_SILENT || '1';
  const db = openDb(file);
  migrate(db);
  q.setDb(db);
  return { db, ids: file && opts && opts.noSeed ? null : (opts && opts.noSeed ? null : seed(db, opts)) };
}

module.exports = { openDb, migrate, seed, setup, schemaSql, ROOT };
