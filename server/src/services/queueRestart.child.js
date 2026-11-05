'use strict';
// عملية مستقلة تمثل "سيرفر" يعمل ثم يُقتل: mode=issue يصدر تذكرتين، mode=read يقرأ بعد إعادة التشغيل.
process.env.QM_SILENT = '1';
const H = require('./queueTestHelpers');
const q = require('./queueDb');
const T = require('./ticketService');
const Q = require('./queueService');
const [file, mode, arg] = process.argv.slice(2);
const { db } = H.setup(file, { noSeed: true });
const clinic = db.prepare('SELECT id FROM clinics').get().id;
const svc = db.prepare('SELECT id FROM services ORDER BY id').get().id;
if (mode === 'issue') {
  const a = T.issueTicket({ clinicId: clinic, serviceId: svc });
  const b = T.issueTicket({ clinicId: clinic, serviceId: svc });
  console.log(JSON.stringify({ tokens: [a.token, b.token] }));
} else if (mode === 'read') {
  const s = T.publicStatus(arg);
  const next = T.issueTicket({ clinicId: clinic, serviceId: svc });
  console.log(JSON.stringify({ status: s.status, number: s.number, ahead: s.ahead, nextNumber: next.ticket.number }));
}
