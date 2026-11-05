'use strict';
// يجعل require يجد حزم dev (express, zod, better-sqlite3...) حتى لو لم يجهز server/node_modules بعد. (يعمل على Windows وLinux)
const path = require('path');
const fs = require('fs');
const Module = require('module');
const devModules = path.resolve(__dirname, '..', 'node_modules');
process.env.NODE_PATH = [devModules, process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
Module._initPaths();

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');

/** يستخرج مخطط SQL من كتلة ```sql في docs/database.md (العقد الملزم) */
function loadSchemaSql() {
  const md = fs.readFileSync(path.join(ROOT, 'docs', 'database.md'), 'utf8');
  const m = /```sql\n([\s\S]*?)```/.exec(md);
  if (!m) throw new Error('لم أجد كتلة SQL في database.md');
  return m[1];
}

function createTestDb() {
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(loadSchemaSql());
  return db;
}

const iso = (d = new Date()) => d.toISOString();

/** عيادة + خدمتان + شباكان */
function seedClinic(db, { name = 'عيادة الأمل', tz = 'Africa/Cairo', active = 1 } = {}) {
  const t = iso();
  const clinicId = Number(db.prepare(`INSERT INTO clinics (name_ar,name_en,timezone,is_active,address,phone,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`)
    .run(name, 'Hope Clinic', tz, active, 'شارع النيل 12', '0100000000', t, t).lastInsertRowid);
  const svcA = Number(db.prepare(`INSERT INTO services (clinic_id,name_ar,name_en,prefix,created_at,updated_at) VALUES (?,?,?,?,?,?)`).run(clinicId, 'كشف عام', 'General', 'A', t, t).lastInsertRowid);
  const svcB = Number(db.prepare(`INSERT INTO services (clinic_id,name_ar,name_en,prefix,created_at,updated_at) VALUES (?,?,?,?,?,?)`).run(clinicId, 'تحاليل', 'Lab', 'B', t, t).lastInsertRowid);
  const c1 = Number(db.prepare(`INSERT INTO counters (clinic_id,name_ar,name_en,number,created_at,updated_at) VALUES (?,?,?,?,?,?)`).run(clinicId, 'شباك 1', 'Counter 1', 1, t, t).lastInsertRowid);
  const c2 = Number(db.prepare(`INSERT INTO counters (clinic_id,name_ar,name_en,number,created_at,updated_at) VALUES (?,?,?,?,?,?)`).run(clinicId, 'شباك 2', 'Counter 2', 2, t, t).lastInsertRowid);
  return { clinicId, svcA, svcB, c1, c2 };
}

let seq = 0;
function addTicket(db, clinic, { service = 'A', n, status = 'waiting', counter = null, calledAt = null, date, priority = 0, issuedAt } = {}) {
  const svc = service === 'A' ? clinic.svcA : clinic.svcB;
  const { businessDate } = require('../../../../server/src/services/displayService');
  const tz = db.prepare('SELECT timezone FROM clinics WHERE id=?').get(clinic.clinicId).timezone;
  const bd = date || businessDate(tz);
  const t = iso();
  seq += 1;
  const num = n || seq;
  return db.prepare(`INSERT INTO tickets (public_id,clinic_id,service_id,business_date,seq_number,display_number,token_hash,status,counter_id,priority,issued_at,called_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(`pub${seq}-${Math.random()}`, clinic.clinicId, svc, bd, num, `${service}-${String(num).padStart(3, '0')}`, `h${seq}-${Math.random()}`, status, counter, priority, issuedAt || t, calledAt, t, t).lastInsertRowid;
}

module.exports = { ROOT, loadSchemaSql, createTestDb, seedClinic, addTicket, iso };
