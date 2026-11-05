'use strict';
/**
 * قاعدة بيانات مؤقتة للاختبارات.
 * المصدر: migrations حساب 1 إن وُجدت، وإلا كتلة SQL في docs/database.md (العقد الملزم).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const ROOT = path.resolve(__dirname, '../../..');

function loadSchemaSql() {
  const migDir = path.join(ROOT, 'server/src/database/migrations');
  if (fs.existsSync(migDir)) {
    const files = fs.readdirSync(migDir).filter((f) => f.endsWith('.sql')).sort();
    if (files.length) return files.map((f) => fs.readFileSync(path.join(migDir, f), 'utf8')).join('\n');
  }
  const md = fs.readFileSync(path.join(ROOT, 'docs/database.md'), 'utf8');
  const m = md.match(/```sql\n([\s\S]*?)```/);
  if (!m) throw new Error('no sql block in docs/database.md');
  return m[1];
}

function createTestDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qm-test-'));
  const file = path.join(dir, 'test.db');
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(loadSchemaSql());
  const ts = new Date().toISOString();
  for (const name of ['عيادة أ', 'عيادة ب']) {
    db.prepare('INSERT INTO clinics (name_ar, created_at, updated_at) VALUES (?,?,?)').run(name, ts, ts);
  }
  // موظفون ثابتون (مفاتيح أجنبية لـ audit_logs): 1=أدمن عيادة 1، 2=أدمن عيادة 2، 9=موظف عيادة 1
  const st = db.prepare('INSERT INTO staff (id, clinic_id, username, password_hash, full_name, role, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)');
  st.run(1, 1, 'admin1', 'x', 'أدمن 1', 'admin', ts, ts);
  st.run(2, 2, 'admin2', 'x', 'أدمن 2', 'admin', ts, ts);
  st.run(9, 1, 'staff9', 'x', 'موظف 9', 'staff', ts, ts);
  return {
    db, dir, file,
    cleanup() { try { db.close(); } catch (_) {} fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

function seedDisplay(db, clinicId, name = 'شاشة') {
  const ts = new Date().toISOString();
  return Number(db.prepare('INSERT INTO displays (clinic_id, name, pairing_code_hash, created_at, updated_at) VALUES (?,?,?,?,?)')
    .run(clinicId, name, 'x', ts, ts).lastInsertRowid);
}

module.exports = { createTestDb, seedDisplay, loadSchemaSql };
