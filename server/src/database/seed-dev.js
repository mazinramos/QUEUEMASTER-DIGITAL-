'use strict';
// DEV ONLY. Refuses to run when NODE_ENV=production. Passwords are random and printed once.
const config = require('../config');
if (config.env === 'production') {
  console.error('Refusing to seed: NODE_ENV=production. seed-dev is for development only.');
  process.exit(1);
}
const { getDb, nowIso, close } = require('./index');
const { runMigrations } = require('./migrate');
const { hashPassword, randomPassword } = require('../utils/password');

async function seedDev(db = getDb(), { quiet = false } = {}) {
  runMigrations(db);
  if (db.prepare('SELECT COUNT(*) c FROM clinics').get().c > 0) {
    if (!quiet) console.log('Database already has data; seed skipped. Delete the DB file to re-seed.');
    return null;
  }
  const now = nowIso();
  const creds = [];
  const staffRows = [
    { username: 'admin', full_name: 'مدير النظام', role: 'admin', counter: null, perms: [1, 1, 1], svc: ['A', 'B', 'C', 'D'] },
    { username: 'manager', full_name: 'مدير العيادة', role: 'manager', counter: 1, perms: [1, 1, 1], svc: ['A', 'B', 'C', 'D'] },
    { username: 'staff1', full_name: 'موظف الاستقبال', role: 'staff', counter: 1, perms: [0, 0, 0], svc: ['A', 'B'] },
    { username: 'staff2', full_name: 'موظف الفحص', role: 'staff', counter: 2, perms: [1, 1, 0], svc: ['C', 'D'] },
  ];
  const hashed = [];
  for (const s of staffRows) {
    const pw = randomPassword();
    creds.push({ username: s.username, role: s.role, password: pw });
    hashed.push(await hashPassword(pw));
  }

  const tx = db.transaction(() => {
    const clinicId = db.prepare(
      `INSERT INTO clinics (name_ar, name_en, address, phone, timezone, default_language, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?)`
    ).run('عيادة الأمل (تجريبية)', 'Al-Amal Clinic (demo)', 'القاهرة', '0000000000', 'Africa/Cairo', 'ar', now, now).lastInsertRowid;

    const svcDefs = [
      ['A', 'استقبال', 'Reception', 1], ['B', 'كشف', 'Consultation', 2],
      ['C', 'تحاليل', 'Laboratory', 3], ['D', 'أشعة', 'Radiology', 4],
    ];
    const svcId = {};
    for (const [prefix, ar, en, order] of svcDefs) {
      svcId[prefix] = db.prepare(
        `INSERT INTO services (clinic_id,name_ar,name_en,prefix,display_order,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`
      ).run(clinicId, ar, en, prefix, order, now, now).lastInsertRowid;
    }
    const counterIds = [];
    for (let n = 1; n <= 3; n++) {
      counterIds.push(db.prepare(
        `INSERT INTO counters (clinic_id,name_ar,name_en,number,created_at,updated_at) VALUES (?,?,?,?,?,?)`
      ).run(clinicId, `شباك ${n}`, `Counter ${n}`, n, now, now).lastInsertRowid);
    }
    const cs = db.prepare('INSERT INTO counter_services (counter_id, service_id) VALUES (?,?)');
    for (const p of ['A', 'B']) cs.run(counterIds[0], svcId[p]);
    for (const p of ['B', 'C']) cs.run(counterIds[1], svcId[p]);
    for (const p of ['C', 'D']) cs.run(counterIds[2], svcId[p]);

    staffRows.forEach((s, i) => {
      const id = db.prepare(
        `INSERT INTO staff (clinic_id,username,password_hash,full_name,role,default_counter_id,
          can_skip_return,can_cancel,can_transfer,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`
      ).run(clinicId, s.username, hashed[i], s.full_name, s.role, s.counter ? counterIds[s.counter - 1] : null,
        s.perms[0], s.perms[1], s.perms[2], now, now).lastInsertRowid;
      for (const p of s.svc) db.prepare('INSERT INTO staff_services (staff_id, service_id) VALUES (?,?)').run(id, svcId[p]);
    });
    return clinicId;
  });
  tx();

  if (!quiet) {
    console.log('Dev seed created. Credentials (shown ONCE, dev only):');
    for (const c of creds) console.log(`  ${c.role.padEnd(8)} ${c.username.padEnd(8)} ${c.password}`);
  }
  return creds;
}

module.exports = { seedDev };

if (require.main === module) {
  seedDev().then(() => close()).catch((e) => { console.error(e); process.exit(1); });
}
