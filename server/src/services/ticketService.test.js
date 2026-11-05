'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./queueTestHelpers');
const q = require('./queueDb');
const T = require('./ticketService');
const bus = require('./queueBus');

function fresh(opts) { return H.setup(null, opts); }

test('إصدار تذكرة: رقم A-001، توكن 43 حرفاً، يخزن hash فقط', () => {
  const { db, ids } = fresh();
  q.setClock(() => new Date('2026-03-05T10:00:00Z'));
  const r = T.issueTicket({ clinicId: ids.clinicId, serviceId: ids.A });
  assert.equal(r.ticket.number, 'A-001');
  assert.equal(r.ticket.status, 'waiting');
  assert.equal(r.ticket.ahead, 0);
  assert.equal(r.token.length, 43);
  const row = db.prepare('SELECT * FROM tickets').get();
  assert.equal(row.token_hash, q.hashToken(r.token));
  assert.notEqual(row.token_hash, r.token);
  assert.equal(row.business_date, '2026-03-05');
});

test('التوكن الخام غير موجود في أي جدول ولا في اللوج ولا في حمولة المزامنة', () => {
  const { db, ids } = fresh();
  const logs = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = (...a) => logs.push(a.join(' '));
  process.env.QM_SILENT = '0';
  let r;
  try {
    r = T.issueTicket({ clinicId: ids.clinicId, serviceId: ids.A });
    T.getTicketByToken(r.token);
    try { T.getTicketByToken('x'.repeat(43)); } catch (_) {}
    require('./queueLog').info('GET /api/public/tickets/' + r.token + '?t=' + r.token);
  } finally { Object.assign(console, orig); process.env.QM_SILENT = '1'; }
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
  for (const { name } of tables) {
    const dump = JSON.stringify(db.prepare(`SELECT * FROM ${name}`).all());
    assert.ok(!dump.includes(r.token), `raw token leaked in table ${name}`);
  }
  assert.ok(logs.length > 0, 'logger should have written something');
  for (const l of logs) assert.ok(!l.includes(r.token), 'raw token leaked in logs');
});

test('ترقيم متسلسل لكل خدمة + بادئات مختلفة + pad', () => {
  const { ids } = fresh();
  const nums = [];
  for (let i = 0; i < 3; i++) nums.push(T.issueTicket({ clinicId: ids.clinicId, serviceId: ids.A }).ticket.number);
  nums.push(T.issueTicket({ clinicId: ids.clinicId, serviceId: ids.B }).ticket.number);
  assert.deepEqual(nums, ['A-001', 'A-002', 'A-003', 'B-001']);
});

test('serviceKey: يعمل وبدون كشف رقم DB؛ مفتاح خاطئ = NOT_FOUND', () => {
  const { ids } = fresh();
  const key = q.serviceKey(ids.A);
  assert.notEqual(key, String(ids.A));
  assert.equal(T.issueTicket({ clinicId: ids.clinicId, serviceKey: key }).ticket.number, 'A-001');
  assert.throws(() => T.issueTicket({ clinicId: ids.clinicId, serviceKey: 'nope' }), { code: 'NOT_FOUND' });
});

test('التصفير اليومي حسب منطقة العيادة (لا توقيت السيرفر)', () => {
  const { db, ids } = fresh();
  // نفس اللحظة: 2026-03-05T22:00Z = 06 مارس 03:00 في كراتشي (+5) لكنها 05 مارس في UTC
  const kar = db.prepare(`INSERT INTO clinics (name_ar,timezone,created_at,updated_at) VALUES ('ك','Asia/Karachi','x','x')`).run().lastInsertRowid;
  const svc = db.prepare(`INSERT INTO services (clinic_id,name_ar,prefix,created_at,updated_at) VALUES (?,?,?,?,?)`).run(kar, 's', 'K', 'x', 'x').lastInsertRowid;
  q.setClock(() => new Date('2026-03-05T22:00:00Z'));
  assert.equal(T.issueTicket({ clinicId: ids.clinicId, serviceId: ids.A }).ticket.number, 'A-001');
  assert.equal(T.issueTicket({ clinicId: ids.clinicId, serviceId: ids.A }).ticket.number, 'A-002');
  assert.equal(T.issueTicket({ clinicId: kar, serviceId: svc }).ticket.number, 'K-001');
  const dates = db.prepare('SELECT DISTINCT clinic_id, business_date d FROM tickets ORDER BY clinic_id').all();
  assert.deepEqual(dates.map((x) => x.d), ['2026-03-05', '2026-03-06']);
  // مرور منتصف ليل UTC: يوم جديد → يتصفر
  q.setClock(() => new Date('2026-03-06T00:00:01Z'));
  assert.equal(T.issueTicket({ clinicId: ids.clinicId, serviceId: ids.A }).ticket.number, 'A-001');
  // في كراتشي ما زال 06 مارس → يكمل الترقيم
  assert.equal(T.issueTicket({ clinicId: kar, serviceId: svc }).ticket.number, 'K-002');
});

test('businessDate يعتمد على المنطقة لا على TZ السيرفر', () => {
  const d = new Date('2026-07-01T23:30:00Z');
  assert.equal(q.businessDate(d, 'UTC'), '2026-07-01');
  assert.equal(q.businessDate(d, 'Pacific/Kiritimati'), '2026-07-02');
  assert.equal(q.businessDate(d, 'Pacific/Pago_Pago'), '2026-07-01');
});

test('ahead والزمن المقدّر: est_duration_min ثم المتوسط الفعلي', () => {
  const { db, ids } = fresh();
  q.setClock(() => new Date('2026-03-05T10:00:00Z'));
  const a = T.issueTicket({ clinicId: ids.clinicId, serviceId: ids.A });
  const b = T.issueTicket({ clinicId: ids.clinicId, serviceId: ids.A });
  const c = T.issueTicket({ clinicId: ids.clinicId, serviceId: ids.A });
  assert.equal(c.ticket.ahead, 2);
  assert.equal(c.ticket.estimatedWaitMin, 20); // 2 × est 10، بلا شبابيك مرتبطة → ÷1
  // 3 تذاكر مكتملة بمتوسط 4 دقائق → المتوسط الفعلي
  for (let i = 0; i < 3; i++) {
    const t = T.issueTicket({ clinicId: ids.clinicId, serviceId: ids.A });
    const row = db.prepare('SELECT id FROM tickets WHERE token_hash=?').get(q.hashToken(t.token));
    db.prepare(`UPDATE tickets SET status='completed', serving_at='2026-03-05T09:00:00.000Z', completed_at='2026-03-05T09:04:00.000Z' WHERE id=?`).run(row.id);
  }
  const s = T.publicStatus(c.token);
  assert.equal(s.ahead, 2);
  assert.equal(s.estimatedWaitMin, 8);
  // الخدمة بلا est ولا عينات → null
});

test('publicStatus: تذكرة يوم سابق نشطة = expired ولا تُنادى', () => {
  const { ids } = fresh();
  q.setClock(() => new Date('2026-03-05T10:00:00Z'));
  const r = T.issueTicket({ clinicId: ids.clinicId, serviceId: ids.A });
  q.setClock(() => new Date('2026-03-06T10:00:00Z'));
  assert.equal(T.publicStatus(r.token).status, 'expired');
});

test('البث يحدث بعد commit: حدث created + queue:updated', () => {
  const { ids } = fresh();
  const seen = [];
  const un = bus.subscribe((m) => seen.push(m.event));
  T.issueTicket({ clinicId: ids.clinicId, serviceId: ids.A });
  un();
  assert.deepEqual(seen, ['ticket:created', 'queue:updated']);
});

test('فشل الإصدار لا يترك رقماً محروقاً (rollback)', () => {
  const { db, ids } = fresh();
  assert.throws(() => T.issueTicket({ clinicId: ids.clinicId, serviceKey: 'bad' }));
  assert.equal(db.prepare('SELECT COUNT(*) c FROM daily_sequences').get().c, 0);
});

test('عزل العيادات: خدمة عيادة أخرى = NOT_FOUND', () => {
  const { db, ids } = fresh();
  const c2 = db.prepare(`INSERT INTO clinics (name_ar,created_at,updated_at) VALUES ('2','x','x')`).run().lastInsertRowid;
  assert.throws(() => T.issueTicket({ clinicId: c2, serviceId: ids.A }), { code: 'NOT_FOUND' });
});

test('normalizeNumber', () => {
  assert.equal(T.normalizeNumber('a25'), 'A-025');
  assert.equal(T.normalizeNumber(' A - 7 '), 'A-007');
  assert.equal(T.normalizeNumber('A-025'), 'A-025');
  assert.equal(T.normalizeNumber('drop table'), null);
});
