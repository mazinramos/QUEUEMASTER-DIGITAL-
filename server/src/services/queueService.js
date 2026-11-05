'use strict';
const q = require('./queueDb');
const { QueueError } = require('./queueErrors');
const ev = require('./ticketEvents');
const stats = require('./queueStats');
const bus = require('./queueBus');
const T = require('./ticketService');

// جدول الانتقالات المسموحة (database.md) — action -> { from:[...], to }
const TRANSITIONS = {
  call:     { from: ['waiting'], to: 'called' },
  recall:   { from: ['called'], to: 'called' },            // لا يغيّر الحالة
  start:    { from: ['called'], to: 'serving' },
  complete: { from: ['serving'], to: 'completed' },
  skip:     { from: ['called'], to: 'skipped' },
  return:   { from: ['skipped'], to: 'waiting' },
  cancel:   { from: ['waiting', 'called', 'serving'], to: 'cancelled' },
  transfer: { from: ['waiting', 'called'], to: 'waiting' }, // في خدمة أخرى
};
const EVENT_TYPE = {
  call: 'called', recall: 'recalled', start: 'serving', complete: 'completed',
  skip: 'skipped', return: 'returned', cancel: 'cancelled', transfer: 'transferred',
};

function assertTransition(action, from) {
  const tr = TRANSITIONS[action];
  if (!tr || !tr.from.includes(from)) {
    throw new QueueError('INVALID_TRANSITION', `Cannot ${action} a ticket that is ${from}`);
  }
  return tr;
}

// ---------- الموظف وصلاحياته (من الـ DB دائماً، لا نثق بما في الجلسة) ----------
function loadStaff(db, staffId) {
  const s = db.prepare('SELECT * FROM staff WHERE id=?').get(staffId);
  if (!s || !s.is_active) throw new QueueError('UNAUTHENTICATED', 'Staff not found or inactive');
  const privileged = s.role === 'admin' || s.role === 'manager';
  const serviceIds = privileged
    ? db.prepare('SELECT id FROM services WHERE clinic_id=? AND is_active=1').all(s.clinic_id).map((r) => r.id)
    : db.prepare(`SELECT ss.service_id AS id FROM staff_services ss JOIN services v ON v.id=ss.service_id
        WHERE ss.staff_id=? AND v.clinic_id=? AND v.is_active=1`).all(s.id, s.clinic_id).map((r) => r.id);
  return {
    id: s.id, clinicId: s.clinic_id, role: s.role, defaultCounterId: s.default_counter_id,
    serviceIds: new Set(serviceIds),
    can: {
      returnSkipped: privileged || !!s.can_skip_return,
      cancel: privileged || !!s.can_cancel,
      transfer: privileged || !!s.can_transfer,
    },
  };
}

function loadTicket(db, publicId, staff) {
  const t = db.prepare('SELECT * FROM tickets WHERE public_id=? AND clinic_id=?').get(String(publicId || ''), staff.clinicId);
  if (!t) throw new QueueError('NOT_FOUND', 'Ticket not found');
  if (!staff.serviceIds.has(t.service_id)) throw new QueueError('FORBIDDEN_SERVICE', 'Not authorized for this service');
  return t;
}

function setting(db, clinicId, key) {
  const r = db.prepare('SELECT value FROM clinic_settings WHERE clinic_id=? AND key=?').get(clinicId, key);
  return r ? r.value : null;
}

// ---------- تنفيذ + نشر بعد commit ----------
function fire(clinic, ticketRow, event, extra) {
  const db = q.getDb();
  const data = Object.assign({ ticket: stats.brief(db, ticketRow) }, extra || {});
  bus.publish({
    clinicId: clinic.id, event, rooms: ['staff', 'display', 'ticket'],
    ticketPublicId: ticketRow.public_id, data,
  });
}

function publishAfter(msgs, clinicId) {
  for (const m of msgs) {
    fire(m.clinic, m.ticket, m.event, m.extra);
    if (m.announce) {
      bus.publish({
        clinicId: m.clinic.id, event: 'display:announcement', rooms: ['display'],
        data: { ticketNumber: m.ticket.display_number, counterNumber: m.counter ? m.counter.number : null, lang: m.clinic.default_language },
      });
    }
  }
  T.publishQueueUpdated(clinicId);
}

// ---------- call-next ----------
function callNext({ staffId, counterId, serviceId }) {
  const db = q.getDb();
  const pending = [];
  const ticket = db.transaction(() => {
    const staff = loadStaff(db, staffId);
    const clinic = T.getClinic(db, staff.clinicId);
    const cid = counterId != null ? counterId : staff.defaultCounterId;
    if (cid == null) throw new QueueError('VALIDATION', 'counterId is required');
    const counter = db.prepare('SELECT * FROM counters WHERE id=? AND clinic_id=? AND is_active=1').get(cid, staff.clinicId);
    if (!counter) throw new QueueError('NOT_FOUND', 'Counter not found');

    // الخدمات المؤهلة = خدمات الموظف ∩ خدمات الشباك (إن حُددت) ∩ الخدمة المطلوبة
    let eligible = [...staff.serviceIds];
    const counterSvcs = db.prepare('SELECT service_id FROM counter_services WHERE counter_id=?').all(counter.id).map((r) => r.service_id);
    if (counterSvcs.length) eligible = eligible.filter((id) => counterSvcs.includes(id));
    if (serviceId != null) {
      if (!staff.serviceIds.has(Number(serviceId)) || !eligible.includes(Number(serviceId))) {
        throw new QueueError('FORBIDDEN_SERVICE', 'Not authorized for this service');
      }
      eligible = [Number(serviceId)];
    }
    if (!eligible.length) throw new QueueError('FORBIDDEN_SERVICE', 'No services available for this staff/counter');

    // قرار: لا يُنادى تذكرة جديدة وعلى الشباك تذكرة called/serving (إلا لو ضُبط allow_multiple_active)
    if (!['1', 'true'].includes(String(setting(db, staff.clinicId, 'allow_multiple_active')).toLowerCase())) {
      const busy = db.prepare(`SELECT display_number FROM tickets WHERE counter_id=? AND clinic_id=? AND status IN ('called','serving')`)
        .get(counter.id, staff.clinicId);
      if (busy) throw new QueueError('CONFLICT', `Counter already has active ticket ${busy.display_number}`);
    }

    const today = T.todayFor(clinic);
    const marks = eligible.map(() => '?').join(',');
    const cand = db.prepare(`SELECT t.* FROM tickets t
      WHERE t.clinic_id=? AND t.business_date=? AND t.status='waiting' AND t.service_id IN (${marks})
      ORDER BY ${stats.ORDER_SQL} LIMIT 5`).all(staff.clinicId, today, ...eligible);
    const at = q.nowIso();
    for (const c of cand) {
      const r = db.prepare(`UPDATE tickets SET status='called', counter_id=?, called_by=?, called_at=?, updated_at=?
        WHERE id=? AND status='waiting'`).run(counter.id, staff.id, at, at, c.id);
      if (r.changes !== 1) continue; // سبقنا أحد (لا يحدث داخل IMMEDIATE لكنه حارس إضافي)
      const t = db.prepare('SELECT * FROM tickets WHERE id=?').get(c.id);
      ev.addEvent(db, { clinicId: clinic.id, ticketId: t.id, type: 'called', staffId: staff.id, counterId: counter.id, from: 'waiting', to: 'called', at });
      ev.addAudit(db, { clinicId: clinic.id, staffId: staff.id, action: 'ticket.call', entity: 'ticket', entityId: t.public_id, at });
      ev.enqueueSync(db, { clinicId: clinic.id, entity: 'ticket', entityUid: t.public_id, payload: ev.ticketSyncPayload(t), at });
      pending.push({ clinic, ticket: t, event: 'ticket:called', counter, announce: true, extra: { counter: stats.counterBrief(counter), announce: true } });
      return t;
    }
    throw new QueueError('QUEUE_EMPTY', 'No waiting tickets');
  }).immediate();
  publishAfter(pending, ticket.clinic_id);
  return view(ticket);
}

// ---------- باقي الإجراءات (قالب موحد) ----------
function act(action, { staffId, publicId, reason, serviceId }) {
  const db = q.getDb();
  const pending = [];
  const t = db.transaction(() => {
    const staff = loadStaff(db, staffId);
    const clinic = T.getClinic(db, staff.clinicId);
    const cur = loadTicket(db, publicId, staff);
    // الصلاحية أولاً (لا نكشف حالة التذكرة لغير المخوّل)، ثم جدول الانتقالات
    if (action === 'return' && !staff.can.returnSkipped) throw new QueueError('FORBIDDEN', 'Missing permission: return skipped');
    if (action === 'cancel' && !staff.can.cancel) throw new QueueError('FORBIDDEN', 'Missing permission: cancel');
    if (action === 'transfer' && !staff.can.transfer) throw new QueueError('FORBIDDEN', 'Missing permission: transfer');
    const tr = assertTransition(action, cur.status);

    const at = q.nowIso();
    const meta = {};
    let sql; let params;
    switch (action) {
      case 'recall':
        // لا تغيير حالة: حدث recalled فقط (يعيد النطق عمداً)
        sql = `UPDATE tickets SET updated_at=? WHERE id=? AND status=?`; params = [at, cur.id, cur.status]; break;
      case 'start':
        sql = `UPDATE tickets SET status='serving', serving_at=?, updated_at=? WHERE id=? AND status=?`; params = [at, at, cur.id, cur.status]; break;
      case 'complete':
        sql = `UPDATE tickets SET status='completed', completed_at=?, updated_at=? WHERE id=? AND status=?`; params = [at, at, cur.id, cur.status]; break;
      case 'skip':
        sql = `UPDATE tickets SET status='skipped', updated_at=? WHERE id=? AND status=?`; params = [at, cur.id, cur.status]; break;
      case 'return':
        sql = `UPDATE tickets SET status='waiting', counter_id=NULL, called_at=NULL, updated_at=? WHERE id=? AND status=?`; params = [at, cur.id, cur.status]; break;
      case 'cancel':
        if (reason) meta.reason = String(reason).slice(0, 300);
        sql = `UPDATE tickets SET status='cancelled', updated_at=? WHERE id=? AND status=?`; params = [at, cur.id, cur.status]; break;
      case 'transfer': {
        const target = db.prepare('SELECT * FROM services WHERE id=? AND clinic_id=? AND is_active=1').get(Number(serviceId), staff.clinicId);
        if (!target) throw new QueueError('NOT_FOUND', 'Target service not found');
        if (target.id === cur.service_id) throw new QueueError('VALIDATION', 'Target service is the same service');
        // رقم جديد من تسلسل الخدمة الهدف (UNIQUE(clinic,service,date,seq))؛ يحتفظ بـ issued_at وpriority
        const seq = T.nextSequence(db, staff.clinicId, target.id, cur.business_date);
        const display = `${target.prefix}-${q.pad(seq)}`;
        meta.fromNumber = cur.display_number; meta.toNumber = display;
        meta.fromServiceId = cur.service_id; meta.toServiceId = target.id;
        sql = `UPDATE tickets SET status='waiting', service_id=?, seq_number=?, display_number=?, counter_id=NULL, called_at=NULL, updated_at=?
               WHERE id=? AND status=?`;
        params = [target.id, seq, display, at, cur.id, cur.status];
        break;
      }
      default: throw new QueueError('INTERNAL', 'Unknown action');
    }
    const r = db.prepare(sql).run(...params);
    if (r.changes !== 1) throw new QueueError('INVALID_TRANSITION', 'Ticket state changed concurrently');

    const t2 = db.prepare('SELECT * FROM tickets WHERE id=?').get(cur.id);
    const counter = stats.counterOf(db, t2.counter_id || cur.counter_id);
    ev.addEvent(db, { clinicId: clinic.id, ticketId: t2.id, type: EVENT_TYPE[action], staffId: staff.id,
      counterId: cur.counter_id || null, from: cur.status, to: tr.to, meta: Object.keys(meta).length ? meta : null, at });
    ev.addAudit(db, { clinicId: clinic.id, staffId: staff.id, action: `ticket.${action}`, entity: 'ticket', entityId: t2.public_id, details: meta, at });
    ev.enqueueSync(db, { clinicId: clinic.id, entity: 'ticket', entityUid: t2.public_id, payload: ev.ticketSyncPayload(t2), at });

    const socketEvent = {
      recall: 'ticket:recalled', start: 'ticket:serving', complete: 'ticket:completed', skip: 'ticket:skipped',
      cancel: 'ticket:cancelled',
    }[action];
    if (socketEvent) {
      const isRecall = action === 'recall';
      const extra = {};
      if (['recall', 'start'].includes(action)) extra.counter = stats.counterBrief(counter);
      if (isRecall) extra.announce = true;
      if (action === 'cancel' && meta.reason) extra.reason = meta.reason;
      pending.push({ clinic, ticket: t2, event: socketEvent, counter, announce: isRecall, extra });
    }
    return t2;
  }).immediate();
  publishAfter(pending, t.clinic_id);
  return view(t);
}

const recall = (a) => act('recall', a);
const start = (a) => act('start', a);
const complete = (a) => act('complete', a);
const skip = (a) => act('skip', a);
const returnTicket = (a) => act('return', a);
const cancel = (a) => act('cancel', a);
const transfer = (a) => act('transfer', a);

function view(t) {
  const db = q.getDb();
  const s = stats.serviceOf(db, t);
  const c = stats.counterOf(db, t.counter_id);
  return {
    publicId: t.public_id, number: t.display_number, status: t.status,
    service: s ? { key: q.serviceKey(s.id), name_ar: s.name_ar, name_en: s.name_en || null, prefix: s.prefix } : null,
    counter: stats.counterBrief(c), priority: t.priority,
    issuedAt: t.issued_at, calledAt: t.called_at, servingAt: t.serving_at, completedAt: t.completed_at,
  };
}

// ---------- حالة شاشة الموظف ----------
function getState({ staffId, counterId }) {
  const db = q.getDb();
  const staff = loadStaff(db, staffId);
  const clinic = T.getClinic(db, staff.clinicId);
  const today = T.todayFor(clinic);
  const cid = counterId != null ? Number(counterId) : staff.defaultCounterId;
  const counter = cid ? db.prepare('SELECT * FROM counters WHERE id=? AND clinic_id=?').get(cid, staff.clinicId) : null;
  const ids = [...staff.serviceIds];
  let current = null; let waiting = [];
  if (counter) {
    const cur = db.prepare(`SELECT * FROM tickets WHERE counter_id=? AND clinic_id=? AND status IN ('called','serving') ORDER BY id DESC LIMIT 1`).get(counter.id, staff.clinicId);
    current = cur ? view(cur) : null;
  }
  if (ids.length) {
    const marks = ids.map(() => '?').join(',');
    const rows = db.prepare(`SELECT t.* FROM tickets t WHERE t.clinic_id=? AND t.business_date=? AND t.status='waiting' AND t.service_id IN (${marks})
      ORDER BY ${stats.ORDER_SQL} LIMIT 100`).all(staff.clinicId, today, ...ids);
    waiting = rows.map((t) => Object.assign(view(t), { ahead: stats.aheadOf(db, t) }));
  }
  const totalWaiting = ids.length ? db.prepare(`SELECT COUNT(*) AS c FROM tickets WHERE clinic_id=? AND business_date=? AND status='waiting' AND service_id IN (${ids.map(() => '?').join(',')})`).get(staff.clinicId, today, ...ids).c : 0;
  // avgWaitMin = متوسط الانتظار الفعلي (issued -> called) لتذاكر اليوم المنادى عليها
  const w = db.prepare(`SELECT issued_at, called_at FROM tickets WHERE clinic_id=? AND business_date=? AND called_at IS NOT NULL
    ${ids.length ? `AND service_id IN (${ids.map(() => '?').join(',')})` : 'AND 0'}`).all(staff.clinicId, today, ...ids);
  const ws = w.map((r) => (Date.parse(r.called_at) - Date.parse(r.issued_at)) / 60000).filter((n) => Number.isFinite(n) && n >= 0);
  return {
    counter: counter ? stats.counterBrief(counter) && Object.assign({ id: counter.id }, stats.counterBrief(counter)) : null,
    currentTicket: current, waiting,
    stats: { waitingCount: totalWaiting, avgWaitMin: ws.length ? Math.round((ws.reduce((a, b) => a + b, 0) / ws.length) * 10) / 10 : null },
  };
}

// ---------- lookup / verify ----------
function lookup({ staffId, number }) {
  const db = q.getDb();
  const staff = loadStaff(db, staffId);
  const clinic = T.getClinic(db, staff.clinicId);
  const norm = T.normalizeNumber(number);
  if (!norm) throw new QueueError('VALIDATION', 'Invalid ticket number');
  const rows = db.prepare('SELECT * FROM tickets WHERE clinic_id=? AND business_date=? AND display_number=? ORDER BY id DESC')
    .all(staff.clinicId, T.todayFor(clinic), norm);
  const t = rows[0];
  if (!t) throw new QueueError('NOT_FOUND', 'Ticket not found');
  if (!staff.serviceIds.has(t.service_id)) throw new QueueError('FORBIDDEN_SERVICE', 'Not authorized for this service');
  return view(t);
}

function verify({ staffId, token }) {
  const db = q.getDb();
  const staff = loadStaff(db, staffId);
  if (typeof token !== 'string' || token.length < 20 || token.length > 100) throw new QueueError('NOT_FOUND', 'Ticket not found');
  const t = db.prepare('SELECT * FROM tickets WHERE token_hash=? AND clinic_id=?').get(q.hashToken(token), staff.clinicId);
  if (!t) throw new QueueError('NOT_FOUND', 'Ticket not found');
  const clinic = T.getClinic(db, staff.clinicId);
  const v = view(t);
  v.isToday = t.business_date === T.todayFor(clinic);
  v.authorizedForService = staff.serviceIds.has(t.service_id);
  return v;
}

// ---------- أدمن ----------
function requireManager(db, staffId) {
  const s = loadStaff(db, staffId);
  if (s.role !== 'admin' && s.role !== 'manager') throw new QueueError('FORBIDDEN', 'Manager role required');
  return s;
}

function adminCancel({ staffId, publicId, reason }) {
  requireManager(q.getDb(), staffId);
  return cancel({ staffId, publicId, reason });
}

// reset-day: يلغي كل التذاكر النشطة لليوم الحالي (waiting/called/serving).
// لا يمكن إعادة ترقيم نفس اليوم: UNIQUE(clinic_id, service_id, business_date, seq_number) — الترقيم يتصفر تلقائياً غداً.
function resetDay({ staffId, confirm }) {
  const db = q.getDb();
  if (confirm !== true) throw new QueueError('VALIDATION', 'confirm:true is required');
  const pending = [];
  const n = db.transaction(() => {
    const staff = requireManager(db, staffId);
    const clinic = T.getClinic(db, staff.clinicId);
    const today = T.todayFor(clinic);
    const rows = db.prepare(`SELECT * FROM tickets WHERE clinic_id=? AND business_date=? AND status IN ('waiting','called','serving')`).all(staff.clinicId, today);
    const at = q.nowIso();
    for (const cur of rows) {
      const r = db.prepare(`UPDATE tickets SET status='cancelled', updated_at=? WHERE id=? AND status=?`).run(at, cur.id, cur.status);
      if (r.changes !== 1) continue;
      const t2 = db.prepare('SELECT * FROM tickets WHERE id=?').get(cur.id);
      ev.addEvent(db, { clinicId: clinic.id, ticketId: t2.id, type: 'cancelled', staffId: staff.id, counterId: cur.counter_id, from: cur.status, to: 'cancelled', meta: { reason: 'reset-day' }, at });
      ev.enqueueSync(db, { clinicId: clinic.id, entity: 'ticket', entityUid: t2.public_id, payload: ev.ticketSyncPayload(t2), at });
      pending.push({ clinic, ticket: t2, event: 'ticket:cancelled', extra: { reason: 'reset-day' } });
    }
    ev.addAudit(db, { clinicId: clinic.id, staffId: staff.id, action: 'queue.reset_day', entity: 'queue', entityId: today, details: { cancelled: rows.length }, at });
    return { cancelled: pending.length, clinicId: clinic.id };
  }).immediate();
  if (pending.length) publishAfter(pending, n.clinicId); else T.publishQueueUpdated(n.clinicId);
  return { cancelled: n.cancelled };
}

// ---------- استعلامات الأدمن ----------
function listTickets({ staffId, date, serviceId, status, q: search, page = 1, pageSize = 50 }) {
  const db = q.getDb();
  const staff = requireManager(db, staffId);
  const clinic = T.getClinic(db, staff.clinicId);
  const where = ['t.clinic_id=?']; const p = [staff.clinicId];
  const d = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : T.todayFor(clinic);
  where.push('t.business_date=?'); p.push(d);
  if (serviceId) { where.push('t.service_id=?'); p.push(Number(serviceId)); }
  if (status) {
    if (!['waiting', 'called', 'serving', 'completed', 'skipped', 'cancelled'].includes(status)) throw new QueueError('VALIDATION', 'Invalid status');
    where.push('t.status=?'); p.push(status);
  }
  if (search) { where.push('t.display_number LIKE ?'); p.push(`%${String(search).replace(/[%_]/g, '').toUpperCase()}%`); }
  const size = Math.min(200, Math.max(1, Number(pageSize) || 50));
  const pg = Math.max(1, Number(page) || 1);
  const total = db.prepare(`SELECT COUNT(*) AS c FROM tickets t WHERE ${where.join(' AND ')}`).get(...p).c;
  const rows = db.prepare(`SELECT t.* FROM tickets t WHERE ${where.join(' AND ')} ORDER BY t.id DESC LIMIT ? OFFSET ?`).all(...p, size, (pg - 1) * size);
  return { items: rows.map(view), total, page: pg, pageSize: size, date: d };
}

function ticketEvents({ staffId, publicId }) {
  const db = q.getDb();
  const staff = requireManager(db, staffId);
  const t = db.prepare('SELECT id FROM tickets WHERE public_id=? AND clinic_id=?').get(String(publicId || ''), staff.clinicId);
  if (!t) throw new QueueError('NOT_FOUND', 'Ticket not found');
  return db.prepare(`SELECT e.type, e.from_status, e.to_status, e.meta, e.created_at, e.staff_id, s.full_name AS staff_name, c.number AS counter_number
    FROM ticket_events e LEFT JOIN staff s ON s.id=e.staff_id LEFT JOIN counters c ON c.id=e.counter_id
    WHERE e.ticket_id=? ORDER BY e.id`).all(t.id).map((r) => ({
    type: r.type, from: r.from_status, to: r.to_status, at: r.created_at,
    staff: r.staff_id ? { id: r.staff_id, name: r.staff_name } : null,
    counter: r.counter_number || null, meta: r.meta ? JSON.parse(r.meta) : null,
  }));
}

module.exports = {
  TRANSITIONS, assertTransition, loadStaff,
  callNext, recall, start, complete, skip, returnTicket, cancel, transfer,
  getState, lookup, verify, adminCancel, resetDay, listTickets, ticketEvents,
};
