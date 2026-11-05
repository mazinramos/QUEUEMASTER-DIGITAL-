'use strict';
// عامل لاختبار التزامن: كل thread له اتصال DB مستقل على نفس الملف (كما لو كانت عمليات منفصلة).
const { parentPort, workerData } = require('worker_threads');
const H = require('./queueTestHelpers');
const q = require('./queueDb');
const Q = require('./queueService');
const T = require('./ticketService');

const { file, mode, staffId, counterId, rounds, clinicId, serviceIds } = workerData;
process.env.QM_SILENT = '1';
const { db } = H.setup(file, { noSeed: true });
db.pragma('busy_timeout = 30000');
q.setDb(db);

const out = { called: [], issued: [], errors: [] };
function work() {
  if (mode === 'issue') {
    for (let i = 0; i < rounds; i++) {
      try { out.issued.push(T.issueTicket({ clinicId, serviceId: serviceIds[i % serviceIds.length] }).ticket.number); }
      catch (e) { out.errors.push(e.code || e.message); }
    }
  } else {
    let guard = 0;
    while (out.called.length < rounds && guard++ < rounds * 50) {
      try {
        const t = Q.callNext({ staffId, counterId });
        out.called.push(t.number);
        Q.start({ staffId, publicId: t.publicId });
        Q.complete({ staffId, publicId: t.publicId });
      } catch (e) { if (e.code !== 'QUEUE_EMPTY') out.errors.push(e.code || e.message); }
    }
  }
  parentPort.postMessage(out);
}
work();
