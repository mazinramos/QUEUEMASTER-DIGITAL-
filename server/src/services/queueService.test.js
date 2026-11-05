'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./queueTestHelpers');
const q = require('./queueDb');
const T = require('./ticketService');
const Q = require('./queueService');
const bus = require('./queueBus');

function fresh() {
  const { db, ids } = H.setup(null);
  q.setClock(() => new Date('2026-03-05T10:00:00Z'));
  const issue = (svc) => T.issueTicket({ clinicId: ids.clinicId, serviceId: svc || ids.A });
  const pid = (r) => db.prepare('SELECT public_id p FROM tickets WHERE token_hash=?').get(q.hashToken(r.token)).p;
  return { db, ids, issue, pid, s1: ids.staff[0], c1: ids.counters[0] };
}

test('call-next: أقدم waiting، ويكتب event + audit + sync', () => {
  const { db, ids, issue, s1, c1 } = fresh();
  issue(); issue();
  const t = Q.callNext({ staffId: s1, counterId: c1 });
  assert.equal(t.number, 'A-001');
  assert.equal(t.status, 'called');
  assert.equal(t.counter.number, 1);
  assert.equal(db.prepare(`SELECT COUNT(*) c FROM ticket_events WHERE type='called'`).get().c, 1);
  assert.equal(db.prepare(`SELECT COUNT(*) c FROM audit_logs WHERE action='ticket.call'`).get().c, 1);
  assert.ok(db.prepare(`SELECT COUNT(*) c FROM sync_outbox`).get().c >= 3); // created×2 + called
  void ids;
});

test('call-next: QUEUE_EMPTY، وشباك مشغول = CONFLICT', () => {
  const { issue, s1, c1 } = fresh();
  assert.throws(() => Q.callNext({ staffId: s1, counterId: c1 }), { code: 'QUEUE_EMPTY' });
  issue(); issue();
  Q.callNext({ staffId: s1, counterId: c1 });
  assert.throws(() => Q.callNext({ staffId: s1, counterId: c1 }), { code: 'CONFLICT' });
});

test('الأولوية ثم الأقدم، وعبر الخدمات', () => {
  const { db, ids, issue, s1, ids: { counters } } = fresh();
  issue(ids.A); issue(ids.B);
  const vip = issue(ids.B);
  db.prepare('UPDATE tickets SET priority=5 WHERE token_hash=?').run(q.hashToken(vip.token));
  assert.equal(Q.callNext({ staffId: s1, counterId: counters[0] }).number, 'B-002'); // vip أولاً
  assert.equal(Q.callNext({ staffId: ids.staff[1], counterId: counters[1] }).number, 'A-001');
  assert.equal(Q.callNext({ staffId: ids.staff[2], counterId: counters[2] }).number, 'B-001');
});

test('الموظف ينادي من خدماته المصرّح بها فقط', () => {
  const { ids, issue, c1 } = fresh();
  issue(ids.B); // onlyA لا يرى B
  assert.throws(() => Q.callNext({ staffId: ids.onlyA, counterId: c1 }), { code: 'QUEUE_EMPTY' });
  assert.throws(() => Q.callNext({ staffId: ids.onlyA, counterId: c1, serviceId: ids.B }), { code: 'FORBIDDEN_SERVICE' });
  issue(ids.A);
  assert.equal(Q.callNext({ staffId: ids.onlyA, counterId: c1 }).number, 'A-001');
});

test('الشباك المرتبط بخدمة معينة يقيّد النداء', () => {
  const { db, ids, issue, s1, c1 } = fresh();
  db.prepare('INSERT INTO counter_services VALUES (?,?)').run(c1, ids.B);
  issue(ids.A); issue(ids.B);
  assert.equal(Q.callNext({ staffId: s1, counterId: c1 }).number, 'B-001');
});

test('دورة حياة كاملة: call → recall → start → complete، وكل إجراء يكتب event', () => {
  const { db, issue, pid, s1, c1 } = fresh();
  const r = issue(); const p = pid(r);
  Q.callNext({ staffId: s1, counterId: c1 });
  Q.recall({ staffId: s1, publicId: p });
  assert.equal(db.prepare('SELECT status s FROM tickets').get().s, 'called'); // recall لا يغيّر الحالة
  Q.start({ staffId: s1, publicId: p });
  const done = Q.complete({ staffId: s1, publicId: p });
  assert.equal(done.status, 'completed');
  const types = db.prepare('SELECT type FROM ticket_events ORDER BY id').all().map((x) => x.type);
  assert.deepEqual(types, ['created', 'called', 'recalled', 'serving', 'completed']);
});

test('كل الانتقالات غير المسموحة تُرفض بـ INVALID_TRANSITION (مصفوفة كاملة)', () => {
  const { db, ids, issue, pid } = fresh();
  const actions = { recall: Q.recall, start: Q.start, complete: Q.complete, skip: Q.skip, return: Q.returnTicket, cancel: Q.cancel };
  const statuses = ['waiting', 'called', 'serving', 'completed', 'skipped', 'cancelled'];
  let checked = 0;
  for (const status of statuses) {
    for (const [name, fn] of Object.entries(actions)) {
      const allowed = Q.TRANSITIONS[name].from.includes(status);
      const r = issue(); const p = pid(r);
      db.prepare('UPDATE tickets SET status=? WHERE public_id=?').run(status, p);
      const before = db.prepare('SELECT COUNT(*) c FROM ticket_events').get().c;
      if (allowed) {
        assert.doesNotThrow(() => fn({ staffId: ids.perms, publicId: p }), `${name} from ${status}`);
      } else {
        assert.throws(() => fn({ staffId: ids.perms, publicId: p }), { code: 'INVALID_TRANSITION' }, `${name} from ${status}`);
        assert.equal(db.prepare('SELECT COUNT(*) c FROM ticket_events').get().c, before, 'no event on rejection');
        assert.equal(db.prepare('SELECT status s FROM tickets WHERE public_id=?').get(p).s, status, 'status unchanged');
      }
      checked++;
    }
  }
  // transfer: waiting|called فقط
  for (const status of statuses) {
    const r = issue(); const p = pid(r);
    db.prepare('UPDATE tickets SET status=? WHERE public_id=?').run(status, p);
    if (['waiting', 'called'].includes(status)) assert.doesNotThrow(() => Q.transfer({ staffId: ids.perms, publicId: p, serviceId: ids.B }));
    else assert.throws(() => Q.transfer({ staffId: ids.perms, publicId: p, serviceId: ids.B }), { code: 'INVALID_TRANSITION' });
    checked++;
  }
  assert.equal(checked, 42);
});

test('skip ثم return بصلاحية فقط؛ العودة تحتفظ بمكانها', () => {
  const { ids, issue, pid, s1, c1 } = fresh();
  const r = issue(); const p = pid(r);
  Q.callNext({ staffId: s1, counterId: c1 });
  Q.skip({ staffId: s1, publicId: p });
  assert.throws(() => Q.returnTicket({ staffId: s1, publicId: p }), { code: 'FORBIDDEN' });
  const t = Q.returnTicket({ staffId: ids.perms, publicId: p });
  assert.equal(t.status, 'waiting'); assert.equal(t.counter, null);
});

test('cancel/transfer بصلاحية؛ transfer يعطي رقماً جديداً في الخدمة الهدف', () => {
  const { db, ids, issue, pid, s1 } = fresh();
  const r = issue(ids.A); const p = pid(r); issue(ids.B);
  assert.throws(() => Q.cancel({ staffId: s1, publicId: p }), { code: 'FORBIDDEN' });
  assert.throws(() => Q.transfer({ staffId: s1, publicId: p, serviceId: ids.B }), { code: 'FORBIDDEN' });
  const t = Q.transfer({ staffId: ids.perms, publicId: p, serviceId: ids.B });
  assert.equal(t.number, 'B-002'); assert.equal(t.status, 'waiting');
  assert.throws(() => Q.transfer({ staffId: ids.perms, publicId: p, serviceId: ids.B }), { code: 'VALIDATION' });
  const ev = db.prepare(`SELECT meta FROM ticket_events WHERE type='transferred'`).get();
  assert.equal(JSON.parse(ev.meta).fromNumber, 'A-001');
  const c = Q.cancel({ staffId: ids.perms, publicId: p, reason: 'x' });
  assert.equal(c.status, 'cancelled');
});

test('FORBIDDEN_SERVICE على تذكرة خدمة غير مصرّح بها، وعزل العيادات', () => {
  const { db, ids, issue, pid } = fresh();
  const r = issue(ids.B); const p = pid(r);
  assert.throws(() => Q.start({ staffId: ids.onlyA, publicId: p }), { code: 'FORBIDDEN_SERVICE' });
  const c2 = db.prepare(`INSERT INTO clinics (name_ar,created_at,updated_at) VALUES ('2','x','x')`).run().lastInsertRowid;
  const other = ids.mkStaff.call(null, 'o', 'manager', []);
  db.prepare('UPDATE staff SET clinic_id=? WHERE id=?').run(c2, other);
  assert.throws(() => Q.cancel({ staffId: other, publicId: p }), { code: 'NOT_FOUND' });
});

test('موظف غير فعّال = UNAUTHENTICATED', () => {
  const { db, ids, issue, c1 } = fresh();
  issue();
  db.prepare('UPDATE staff SET is_active=0 WHERE id=?').run(ids.staff[0]);
  assert.throws(() => Q.callNext({ staffId: ids.staff[0], counterId: c1 }), { code: 'UNAUTHENTICATED' });
});

test('lookup بالرقم (صيغ مختلفة) و verify بالتوكن', () => {
  const { issue, s1, ids } = fresh();
  const r = issue();
  assert.equal(Q.lookup({ staffId: s1, number: 'a1' }).number, 'A-001');
  assert.throws(() => Q.lookup({ staffId: s1, number: 'A-099' }), { code: 'NOT_FOUND' });
  assert.throws(() => Q.lookup({ staffId: s1, number: '; drop' }), { code: 'VALIDATION' });
  const v = Q.verify({ staffId: s1, token: r.token });
  assert.equal(v.number, 'A-001'); assert.equal(v.isToday, true); assert.equal(v.authorizedForService, true);
  assert.throws(() => Q.verify({ staffId: s1, token: 'y'.repeat(43) }), { code: 'NOT_FOUND' });
  void ids;
});

test('البث بعد commit فقط: لا حدث عند الفشل؛ called يبثّ announce وdisplay:announcement', () => {
  const { issue, s1, c1 } = fresh();
  const seen = [];
  const un = bus.subscribe((m) => seen.push(m));
  assert.throws(() => Q.callNext({ staffId: s1, counterId: c1 }), { code: 'QUEUE_EMPTY' });
  assert.equal(seen.length, 0);
  issue(); seen.length = 0;
  Q.callNext({ staffId: s1, counterId: c1 });
  un();
  const evs = seen.map((m) => m.event);
  assert.deepEqual(evs, ['ticket:called', 'display:announcement', 'queue:updated']);
  const called = seen[0];
  assert.equal(called.data.announce, true);
  assert.equal(called.data.counter.number, 1);
  assert.equal(seen[1].data.ticketNumber, 'A-001');
});

test('reset-day: manager فقط + confirm؛ يلغي النشط ويبقي المكتمل', () => {
  const { db, ids, issue, pid, s1, c1 } = fresh();
  const a = issue(); issue(); issue();
  Q.callNext({ staffId: s1, counterId: c1 });
  Q.start({ staffId: s1, publicId: pid(a) }); Q.complete({ staffId: s1, publicId: pid(a) });
  assert.throws(() => Q.resetDay({ staffId: s1, confirm: true }), { code: 'FORBIDDEN' });
  assert.throws(() => Q.resetDay({ staffId: ids.manager }), { code: 'VALIDATION' });
  assert.equal(Q.resetDay({ staffId: ids.manager, confirm: true }).cancelled, 2);
  assert.equal(db.prepare(`SELECT COUNT(*) c FROM tickets WHERE status='completed'`).get().c, 1);
  assert.equal(db.prepare(`SELECT COUNT(*) c FROM tickets WHERE status='cancelled'`).get().c, 2);
});

test('أدمن: listTickets + events + adminCancel', () => {
  const { ids, issue, pid, s1 } = fresh();
  const r = issue(); issue(ids.B);
  const list = Q.listTickets({ staffId: ids.manager });
  assert.equal(list.total, 2);
  assert.equal(Q.listTickets({ staffId: ids.manager, q: 'b-', serviceId: ids.B }).total, 1);
  assert.throws(() => Q.listTickets({ staffId: s1 }), { code: 'FORBIDDEN' });
  assert.throws(() => Q.listTickets({ staffId: ids.manager, status: 'bogus' }), { code: 'VALIDATION' });
  Q.adminCancel({ staffId: ids.manager, publicId: pid(r), reason: 'dup' });
  const evs = Q.ticketEvents({ staffId: ids.manager, publicId: pid(r) });
  assert.deepEqual(evs.map((e) => e.type), ['created', 'cancelled']);
  assert.equal(evs[1].meta.reason, 'dup');
});

test('getState: الحالي + المنتظرون + إحصاءات', () => {
  const { issue, s1, c1 } = fresh();
  issue(); issue(); issue();
  Q.callNext({ staffId: s1, counterId: c1 });
  const st = Q.getState({ staffId: s1, counterId: c1 });
  assert.equal(st.currentTicket.number, 'A-001');
  assert.equal(st.waiting.length, 2);
  assert.equal(st.waiting[1].ahead, 1);
  assert.equal(st.stats.waitingCount, 2);
});
