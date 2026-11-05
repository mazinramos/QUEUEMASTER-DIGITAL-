'use strict';
/**
 * سيرفر محاكاة للتطوير والاختبار فقط (ليس جزءاً من الإنتاج).
 * يشغّل routes/display.js الحقيقي فوق SQLite في الذاكرة بنفس مخطط docs/database.md،
 * ويحاكي ما سيفعله حساب 2: بث أحداث Socket.IO حسب docs/socket-events.md.
 *   npm run mock   ثم افتح  http://localhost:3100/display/   (الكود يُطبع في الطرفية)
 */
const h = require('./tests/_helpers');
const path = require('path');
const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const svc = require('../../../server/src/services/displayService');
const { createDisplayRouter } = require('../../../server/src/routes/display');

async function createMock({ port = 3100, uploadsDir } = {}) {
  const db = h.createTestDb();
  const clinic = h.seedClinic(db);
  const t0 = h.iso();
  db.prepare(`INSERT INTO staff (id,clinic_id,username,password_hash,full_name,role,created_at,updated_at) VALUES (1,?,?,?,?,?,?,?)`).run(clinic.clinicId, 'admin', 'x', 'Admin', 'admin', t0, t0);
  const uploads = uploadsDir || fs.mkdtempSync(path.join(require('os').tmpdir(), 'qm-mock-up-'));
  fs.mkdirSync(path.join(uploads, 'audio', 'ar'), { recursive: true });
  fs.mkdirSync(path.join(uploads, 'audio', 'en'), { recursive: true });

  const app = express();
  const server = http.createServer(app);
  const io = new Server(server);
  const emitToRoom = (room, event, payload) => io.to(room).emit(event, payload);
  const emitClinic = (event, payload, rooms = ['display']) => {
    const msg = { eventId: crypto.randomUUID(), ts: new Date().toISOString(), clinicId: clinic.clinicId, ...payload };
    rooms.forEach((r) => io.to(`clinic:${clinic.clinicId}:${r}`).emit(event, msg));
    return msg;
  };

  // مصادقة Socket.IO كما سيفعل حساب 2: كوكي qm.display
  io.use((socket, next) => {
    const d = svc.authenticateDisplay(db, socket.handshake.headers.cookie);
    if (!d) return next(new Error('unauthorized'));
    socket.data.display = d; return next();
  });
  io.on('connection', (socket) => { socket.join(`clinic:${socket.data.display.clinic_id}:display`); });

  app.use('/dev', express.json());
  app.use(createDisplayRouter({
    getDb: () => db, getUploadsDir: () => uploads, emitToRoom,
    getStaff: (req) => (req.headers['x-dev-admin'] ? { id: 1, role: 'admin', clinicId: clinic.clinicId } : null),
  }));
  app.use('/display/dev', (req, res) => res.status(404).end());
  app.use('/display', express.static(path.resolve(__dirname, '..'), { index: 'index.html' }));
  app.get('/', (req, res) => res.redirect('/display/'));

  /* ---- محاكاة المحرك (حساب 2) ---- */
  const ticketRow = (number) => db.prepare(`SELECT t.*, s.prefix, s.name_ar sn, s.name_en se FROM tickets t JOIN services s ON s.id=t.service_id WHERE t.clinic_id=? AND t.display_number=? AND t.business_date=?`).get(clinic.clinicId, number, svc.businessDate('Africa/Cairo'));
  const counterRow = (n) => db.prepare('SELECT * FROM counters WHERE clinic_id=? AND number=?').get(clinic.clinicId, n);
  const snapshot = () => {
    const d = db.prepare('SELECT * FROM displays WHERE clinic_id=? LIMIT 1').get(clinic.clinicId);
    const b = d ? svc.getBootstrap(db, d) : { current: [], next: [], waitingCount: 0 };
    const per = db.prepare(`SELECT s.prefix key, COUNT(t.id) waiting FROM services s LEFT JOIN tickets t ON t.service_id=s.id AND t.status='waiting' AND t.business_date=? GROUP BY s.id`).all(svc.businessDate('Africa/Cairo'));
    return { services: per, current: b.current, next: b.next };
  };
  const pub = (row, counter) => ({ number: row.display_number, service: { prefix: row.prefix, name_ar: row.sn, name_en: row.se }, status: row.status });
  const bd = () => svc.businessDate('Africa/Cairo');
  let nextSeq = { A: 0, B: 0 };
  const queueUpdated = () => emitClinic('queue:updated', snapshot(), ['display', 'staff']);

  const dev = express.Router();
  dev.post('/pairing-code', (req, res) => { // يُنشئ شاشة جديدة ويعيد كودها
    const r = svc.createDisplay(db, { clinicId: clinic.clinicId, name: req.body.name || 'شاشة اختبار', settings: req.body.settings, staffId: 1 });
    res.json(r);
  });
  dev.post('/ticket', (req, res) => {
    const sv = req.body.service === 'B' ? 'B' : 'A';
    nextSeq[sv] += 1; const n = req.body.n || nextSeq[sv];
    const id = h.addTicket(db, clinic, { service: sv, n, status: 'waiting', priority: req.body.priority || 0 });
    const row = db.prepare('SELECT t.*, s.prefix, s.name_ar sn, s.name_en se FROM tickets t JOIN services s ON s.id=t.service_id WHERE t.id=?').get(id);
    emitClinic('ticket:created', { ticket: pub(row) }, ['display', 'staff']); queueUpdated();
    res.json({ number: row.display_number });
  });
  const call = (recall) => (req, res) => {
    const ctr = counterRow(req.body.counter || 1);
    let row;
    if (req.body.number) row = ticketRow(req.body.number);
    else row = db.prepare(`SELECT t.*, s.prefix, s.name_ar sn, s.name_en se FROM tickets t JOIN services s ON s.id=t.service_id WHERE t.clinic_id=? AND t.business_date=? AND t.status='waiting' ORDER BY t.priority DESC, t.issued_at, t.id LIMIT 1`).get(clinic.clinicId, bd());
    if (!row) return res.status(404).json({ error: 'QUEUE_EMPTY' });
    if (!recall) db.prepare(`UPDATE tickets SET status='called', counter_id=?, called_at=?, updated_at=? WHERE id=?`).run(ctr.id, h.iso(), h.iso(), row.id);
    row = ticketRow(row.display_number); row.prefix = row.prefix; 
    const full = db.prepare('SELECT s.prefix, s.name_ar sn, s.name_en se FROM services s WHERE id=?').get(row.service_id); Object.assign(row, { prefix: full.prefix, sn: full.sn, se: full.se });
    const payload = { ticket: pub(row), counter: { number: ctr.number, name: ctr.name_ar }, announce: true };
    emitClinic(recall ? 'ticket:recalled' : 'ticket:called', payload, ['display', 'staff']);
    emitClinic('display:announcement', { ticketNumber: row.display_number, counterNumber: ctr.number, lang: 'both' });
    queueUpdated();
    res.json({ number: row.display_number, counter: ctr.number });
  };
  dev.post('/call', call(false));
  dev.post('/recall', call(true));
  const move = (status, ev) => (req, res) => {
    const row = ticketRow(req.body.number); if (!row) return res.status(404).json({ error: 'NOT_FOUND' });
    db.prepare(`UPDATE tickets SET status=?, updated_at=? WHERE id=?`).run(status, h.iso(), row.id);
    const full = db.prepare('SELECT s.prefix, s.name_ar sn, s.name_en se FROM services s WHERE id=?').get(row.service_id);
    const c = row.counter_id ? db.prepare('SELECT * FROM counters WHERE id=?').get(row.counter_id) : null;
    emitClinic(ev, { ticket: pub({ ...row, ...full, status }), ...(c ? { counter: { number: c.number, name: c.name_ar } } : {}) }, ['display', 'staff']);
    queueUpdated(); res.json({ ok: true });
  };
  dev.post('/serve', move('serving', 'ticket:serving'));
  dev.post('/complete', move('completed', 'ticket:completed'));
  dev.post('/skip', move('skipped', 'ticket:skipped'));
  dev.post('/cancel', move('cancelled', 'ticket:cancelled'));
  dev.post('/emit', (req, res) => { // بث خام (لاختبار التكرار/القديم)
    const { event, payload, raw } = req.body;
    io.to(`clinic:${clinic.clinicId}:display`).emit(event, raw ? payload : { eventId: crypto.randomUUID(), ts: new Date().toISOString(), clinicId: clinic.clinicId, ...payload });
    res.json({ ok: true });
  });
  dev.post('/ad', (req, res) => {
    const a = req.body; const ts = h.iso();
    const info = db.prepare(`INSERT INTO advertisements (clinic_id,title,media_type,file_path,body_text,duration_sec,priority,starts_at,ends_at,is_active,display_ids,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(clinic.clinicId, a.title || 'إعلان', a.media_type || 'text', a.file_path || null, a.body_text || null, a.duration_sec || 8, a.priority || 0, a.starts_at || null, a.ends_at || null, a.is_active ?? 1, a.display_ids ? JSON.stringify(a.display_ids) : null, ts, ts);
    pushAds(); res.json({ id: Number(info.lastInsertRowid) });
  });
  dev.post('/ads/clear', (req, res) => { db.prepare('DELETE FROM advertisements').run(); pushAds(); res.json({ ok: true }); });
  dev.post('/ads/update/:id', (req, res) => {
    const sets = Object.keys(req.body); if (sets.length) db.prepare(`UPDATE advertisements SET ${sets.map((k) => `${k}=?`).join(',')} WHERE id=?`).run(...sets.map((k) => req.body[k]), req.params.id);
    pushAds(); res.json({ ok: true });
  });
  function pushAds() {
    const d = db.prepare('SELECT * FROM displays WHERE clinic_id=? LIMIT 1').get(clinic.clinicId);
    if (!d) return;
    emitClinic('advertisement:updated', { ads: svc.activeAds(db, d) });
  }
  dev.post('/drop', (req, res) => { io.sockets.sockets.forEach((so) => so.conn.close()); res.json({ ok: true }); }); // يحاكي انقطاع الشبكة (transport close)
  dev.post('/reset', (req, res) => { db.prepare('DELETE FROM tickets').run(); nextSeq = { A: 0, B: 0 }; queueUpdated(); res.json({ ok: true }); });
  dev.get('/uploads', (req, res) => res.json({ dir: uploads }));
  app.use('/dev', dev);

  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  const addr = server.address();
  return {
    db, clinic, io, uploads, port: addr.port, base: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise((r) => { io.close(); server.close(r); db.close(); }),
  };
}

module.exports = { createMock };

if (require.main === module) {
  createMock({ port: Number(process.env.PORT) || 3100 }).then((m) => {
    const { pairingCode } = svc.createDisplay(m.db, { clinicId: m.clinic.clinicId, name: 'شاشة الصالة' });
    console.log(`\nMock server:  ${m.base}/display/\nكود الإقران:   ${pairingCode}\nمحاكاة:       POST ${m.base}/dev/ticket | /dev/call | /dev/recall | /dev/complete  (JSON body)\n`);
  });
}
