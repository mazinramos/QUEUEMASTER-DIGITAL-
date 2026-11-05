'use strict';
/**
 * بيئة e2e: يشغّل createApp الحقيقي (ح1+ح2+ح4+حسابي) على منفذ عشوائي بقاعدة :memory: ويزرع بيانات معروفة.
 * يتطلب أن تكون فروع الحسابات الأخرى مدمجة (وإلا يُتخطى الاختبار).
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const SRC = path.resolve(__dirname, '../../src');
const WEB = path.resolve(__dirname, '../../../web');

const PW = 'Str0ng-Test-Pass!';
const available = () => ['app.js', 'utils/password.js', 'routes/auth.js'].every((f) => fs.existsSync(path.join(SRC, f))) && fs.existsSync(path.join(WEB, 'shared/api.js')) && fs.existsSync(path.join(WEB, 'admin/index.html'));

async function startFixture() {
  process.env.NODE_ENV = 'test'; process.env.DB_PATH = ':memory:';
  // ح2 يقرأ TOKEN_PEPPER بينما .env.example عند ح1 يذكر TICKET_TOKEN_PEPPER (تعارض مُبلَّغ عنه في التقرير): نضبط الاثنين.
  process.env.LOGIN_RATE_MAX = process.env.LOGIN_RATE_MAX || '1000'; // الاختبارات تسجّل دخولاً كثيراً من عنوان واحد
  process.env.TOKEN_PEPPER = process.env.TOKEN_PEPPER || 'e2e-pepper-0123456789abcdef';
  process.env.TICKET_TOKEN_PEPPER = process.env.TICKET_TOKEN_PEPPER || process.env.TOKEN_PEPPER;
  const uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qm-e2e-up-'));
  process.env.UPLOADS_DIR = uploadsDir;
  const { createApp } = require(path.join(SRC, 'app.js'));
  const app = createApp();
  const dbm = require(path.join(SRC, 'database')); const db = dbm.getDb();
  const hash = await require(path.join(SRC, 'utils/password.js')).hashPassword(PW);
  const { businessDate } = require('../../src/services/reportsService');
  const { seedService, seedCounter, seedTicket, seedEvent } = require('../helpers/seed');
  const ts = new Date().toISOString();
  const clinicId = Number(db.prepare('INSERT INTO clinics (name_ar,name_en,timezone,created_at,updated_at) VALUES (?,?,?,?,?)').run('عيادة النور', 'Al Noor Clinic', 'Africa/Cairo', ts, ts).lastInsertRowid);
  const other = Number(db.prepare('INSERT INTO clinics (name_ar,timezone,created_at,updated_at) VALUES (?,?,?,?)').run('عيادة أخرى', 'Africa/Cairo', ts, ts).lastInsertRowid);
  const ins = db.prepare('INSERT INTO staff (clinic_id,username,password_hash,full_name,role,created_at,updated_at) VALUES (?,?,?,?,?,?,?)');
  const adm = Number(ins.run(clinicId, 'adm', hash, 'مدير النظام', 'admin', ts, ts).lastInsertRowid);
  const mgr = Number(ins.run(clinicId, 'mgr', hash, 'المشرفة سلمى', 'manager', ts, ts).lastInsertRowid);
  ins.run(clinicId, 'stf', hash, 'موظف', 'staff', ts, ts);
  ins.run(other, 'adm2', hash, 'مدير آخر', 'admin', ts, ts);
  const XSS = '<img src=x onerror="window.__xss=1">';
  const A = seedService(db, clinicId, 'A', 'الباطنة'); const B = seedService(db, clinicId, 'B', XSS);
  const c1 = seedCounter(db, clinicId, 1); const c2 = seedCounter(db, clinicId, 2);
  seedService(db, other, 'Z', 'خدمة العيادة الأخرى');
  const today = businessDate(new Date(), 'Africa/Cairo');
  const at = (mins) => new Date(Date.now() - mins * 60000).toISOString();
  const mk = (o) => seedTicket(db, { clinicId, serviceId: A, date: today, prefix: 'A', ...o });
  mk({ status: 'completed', issued: at(90), called: at(80), serving: at(79), completed: at(69), counterId: c1, calledBy: adm });
  mk({ status: 'completed', issued: at(85), called: at(65), serving: at(64), completed: at(34), counterId: c1, calledBy: adm });
  const sk = mk({ status: 'skipped', issued: at(80), called: at(50), counterId: c2, calledBy: mgr });
  mk({ status: 'waiting', issued: at(10) }); mk({ status: 'waiting', issued: at(5) });
  mk({ status: 'called', issued: at(30), called: at(2), counterId: c2, calledBy: mgr });
  seedEvent(db, { clinicId, ticketId: sk, type: 'skipped', staffId: mgr });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  return {
    base: `http://127.0.0.1:${server.address().port}`, db, uploadsDir, PW, XSS, clinicId, today,
    uploads: () => fs.readdirSync(uploadsDir).filter((f) => !f.startsWith('.')),
    async close() {
      await new Promise((r) => server.close(r));
      try { require(path.join(SRC, 'routes/ads.js')).getDefaultService().stopScheduler(); } catch (_) {}
      try { dbm.close(); } catch (_) {}
      fs.rmSync(uploadsDir, { recursive: true, force: true });
    },
  };
}
module.exports = { startFixture, available, PW };
