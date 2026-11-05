'use strict';
const crypto = require('crypto');
const ts = () => new Date().toISOString();

function seedService(db, clinicId, prefix, nameAr = `خدمة ${prefix}`, order = 0) {
  return Number(db.prepare('INSERT INTO services (clinic_id,name_ar,prefix,display_order,created_at,updated_at) VALUES (?,?,?,?,?,?)').run(clinicId, nameAr, prefix, order, ts(), ts()).lastInsertRowid);
}
function seedCounter(db, clinicId, number) {
  return Number(db.prepare('INSERT INTO counters (clinic_id,name_ar,number,created_at,updated_at) VALUES (?,?,?,?,?)').run(clinicId, `شباك ${number}`, number, ts(), ts()).lastInsertRowid);
}
let seqCounter = 0;
function seedTicket(db, t) {
  seqCounter += 1;
  const seq = t.seq ?? seqCounter;
  const id = Number(db.prepare(`INSERT INTO tickets (public_id,clinic_id,service_id,business_date,seq_number,display_number,token_hash,status,counter_id,called_by,
      issued_at,called_at,serving_at,completed_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(crypto.randomBytes(8).toString('hex'), t.clinicId, t.serviceId, t.date, seq, `${t.prefix || 'A'}-${String(seq).padStart(3, '0')}`,
      crypto.randomBytes(16).toString('hex'), t.status, t.counterId ?? null, t.calledBy ?? null,
      t.issued, t.called ?? null, t.serving ?? null, t.completed ?? null, t.issued, t.issued).lastInsertRowid);
  return id;
}
function seedEvent(db, { clinicId, ticketId, type, staffId }) {
  db.prepare('INSERT INTO ticket_events (event_uid,clinic_id,ticket_id,type,staff_id,created_at) VALUES (?,?,?,?,?,?)')
    .run(crypto.randomUUID(), clinicId, ticketId, type, staffId ?? null, ts());
}
module.exports = { seedService, seedCounter, seedTicket, seedEvent };
