'use strict';
// Socket.IO — أحداث socket-events.md (عقد ملزم). مالك الملف: حساب 2.
//
// الاستعمال (من server.js — حساب 1):
//   const sockets = require('./sockets');
//   sockets.init(httpServer, { sessionMiddleware, resolveDisplay });
//
//  - sessionMiddleware: نفس middleware الجلسات في express (يُركَّب على handshake ليقرأ كوكي qm.sid).
//  - resolveDisplay(cookieValue) -> { displayId, clinicId } | null : يتحقق من كوكي qm.display (حساب 4 يملك الاقتران).
//    إن لم يُمرَّر، نحاول require('../services/displayAuth').resolveDisplay ثم نرفض اتصالات الشاشات.
// باقي الأكواد تستدعي emitToClinic / emitToRoom ولا تلمس Socket.IO مباشرة.
const { Server } = require('socket.io');
const bus = require('../services/queueBus');
const q = require('../services/queueDb');
const log = require('../services/queueLog');
const { staffIdFrom } = require('../services/queueAuth');
const T = require('../services/ticketService');

let io = null;
let unsubscribe = null;

const MAX_WATCHES_PER_SOCKET = 5;
const FLOOD_WINDOW_MS = 10000;
const FLOOD_MAX_EVENTS = 20; // واردة لكل socket / 10 ثوانٍ

const rooms = {
  staff: (clinicId) => `clinic:${clinicId}:staff`,
  display: (clinicId) => `clinic:${clinicId}:display`,
  ticket: (publicId) => `ticket:${publicId}`,
};

function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i < 0) return;
    const k = part.slice(0, i).trim();
    if (!k) return;
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch (_) { out[k] = part.slice(i + 1).trim(); }
  });
  return out;
}

function defaultResolveDisplay() {
  try { return require('../services/displayAuth').resolveDisplay; } catch (_) { return null; }
}

function envelope(clinicId, data) {
  return Object.assign({ eventId: q.uuid(), ts: q.nowIso(), clinicId }, data || {});
}

// ---------- واجهة البث للآخرين ----------
function emitToRoom(room, event, payload, clinicId) {
  if (!io) return false;
  io.to(room).emit(event, envelope(clinicId == null ? null : clinicId, payload));
  return true;
}
// staff + display لعيادة (يستعمله ح4/ح5 لـ display:settings_updated وadvertisement:updated مع emitToRoom للشاشات فقط)
function emitToClinic(clinicId, event, payload) {
  if (!io) return false;
  io.to([rooms.staff(clinicId), rooms.display(clinicId)]).emit(event, envelope(clinicId, payload));
  return true;
}
function emitToDisplays(clinicId, event, payload) { return emitToRoom(rooms.display(clinicId), event, payload, clinicId); }
function emitToStaff(clinicId, event, payload) { return emitToRoom(rooms.staff(clinicId), event, payload, clinicId); }

// رسالة من queueBus (نُشرت بعد commit) -> بث واحد لكل الغرف المعنية (حدث واحد = eventId واحد)
function deliver(msg) {
  if (!io) return;
  const targets = [];
  for (const r of msg.rooms || []) {
    if (r === 'staff') targets.push(rooms.staff(msg.clinicId));
    else if (r === 'display') targets.push(rooms.display(msg.clinicId));
    else if (r === 'ticket' && msg.ticketPublicId) targets.push(rooms.ticket(msg.ticketPublicId));
  }
  if (!targets.length) return;
  io.to(targets).emit(msg.event, envelope(msg.clinicId, msg.data));
}

// ---------- التهيئة ----------
function init(httpServer, opts = {}) {
  if (io) return io;
  io = new Server(httpServer, {
    path: '/socket.io',
    serveClient: false,
    cors: opts.cors || undefined, // نفس الأصل افتراضياً
    maxHttpBufferSize: 4 * 1024, // لا حاجة لحمولات كبيرة من العملاء
    pingInterval: 20000, pingTimeout: 20000,
  });
  const resolveDisplay = opts.resolveDisplay || defaultResolveDisplay();
  if (opts.sessionMiddleware) io.engine.use(opts.sessionMiddleware);

  io.use((socket, next) => {
    try {
      const req = socket.request;
      const cookies = parseCookies(req.headers.cookie);
      socket.data.kind = 'patient';
      socket.data.watches = new Set();

      if (cookies['qm.display']) {
        const d = resolveDisplay && resolveDisplay(cookies['qm.display']);
        if (!d || !d.clinicId) return next(new Error('UNAUTHENTICATED'));
        socket.data.kind = 'display'; socket.data.clinicId = d.clinicId; socket.data.displayId = d.displayId;
        return next();
      }
      const staffId = staffIdFrom(req);
      if (staffId) {
        const row = q.getDb().prepare('SELECT id, clinic_id, role, is_active FROM staff WHERE id=?').get(staffId);
        if (!row || !row.is_active) return next(new Error('UNAUTHENTICATED'));
        socket.data.kind = 'staff'; socket.data.clinicId = row.clinic_id; socket.data.staffId = row.id;
      }
      return next(); // بدون هوية = مريض (ticket:watch فقط)
    } catch (e) {
      log.error('socket auth failed', { message: e.message });
      return next(new Error('INTERNAL'));
    }
  });

  io.on('connection', (socket) => {
    const { kind, clinicId } = socket.data;
    if (kind === 'staff') socket.join(rooms.staff(clinicId));
    if (kind === 'display') socket.join(rooms.display(clinicId));

    // تحديد معدل الأحداث الواردة (أي حدث، حتى غير المعروف)
    let stamps = [];
    socket.onAny(() => {
      const now = Date.now();
      stamps = stamps.filter((t) => now - t < FLOOD_WINDOW_MS);
      stamps.push(now);
      if (stamps.length > FLOOD_MAX_EVENTS) { log.warn('socket flood, disconnecting', { kind }); socket.disconnect(true); }
    });

    // المريض فقط: ticket:watch { token } — لا يُقبل من غيره أي حدث وارد
    socket.on('ticket:watch', (payload, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      if (kind !== 'patient') return reply({ ok: false, error: { code: 'FORBIDDEN', message: 'Not allowed' } });
      try {
        const token = payload && payload.token;
        const t = T.getTicketByToken(token);
        if (!socket.data.watches.has(t.public_id)) {
          if (socket.data.watches.size >= MAX_WATCHES_PER_SOCKET) return reply({ ok: false, error: { code: 'RATE_LIMITED', message: 'Too many watched tickets' } });
          socket.data.watches.add(t.public_id);
          socket.join(rooms.ticket(t.public_id));
        }
        const { _publicId, ...status } = T.publicStatus(token);
        reply({ ok: true, data: status }); // لقطة حالية (تفيد بعد إعادة الاتصال)
      } catch (e) {
        reply({ ok: false, error: { code: e.code || 'INTERNAL', message: e.code === 'NOT_FOUND' ? 'Ticket not found' : 'Error' } });
      }
    });
  });

  unsubscribe = bus.subscribe(deliver);
  return io;
}

async function close() {
  if (unsubscribe) { unsubscribe(); unsubscribe = null; }
  if (io) { const s = io; io = null; await new Promise((r) => s.close(r)); }
}

module.exports = {
  init, close, emitToClinic, emitToRoom, emitToDisplays, emitToStaff, rooms, parseCookies,
  _getIo: () => io, FLOOD_MAX_EVENTS, MAX_WATCHES_PER_SOCKET,
};
