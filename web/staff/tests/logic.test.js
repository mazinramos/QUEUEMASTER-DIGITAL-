const test = require('node:test'); const assert = require('node:assert/strict'); const L = require('../logic.js');
const staff = (p) => ({ role: 'staff', permissions: p || {} });

test('normalizeTicket accepts the variants of the contract', () => {
  const a = L.normalizeTicket({ ticket: { public_id: 'p1', display_number: 'A-001', status: 'called', service: { id: 2, name_ar: 'x' }, counter: { id: 1, number: 1 }, called_at: '2026-01-01T00:00:00Z' } });
  assert.equal(a.publicId, 'p1'); assert.equal(a.number, 'A-001'); assert.equal(a.serviceId, 2); assert.equal(a.counter.id, 1); assert.equal(a.calledAt, '2026-01-01T00:00:00Z');
  const b = L.normalizeTicket({ publicId: 'p2', number: 'B-010', serviceName: 'أسنان', counter: 3 }); assert.equal(b.service.name, 'أسنان'); assert.equal(b.counter.number, 3);
  assert.equal(L.normalizeTicket(null), null);
});
test('perms: object, snake/camel, array; role alone grants nothing', () => {
  assert.deepEqual(L.perms(staff({ can_cancel: true })), { skipReturn: false, cancel: true, transfer: false });
  assert.deepEqual(L.perms(staff({ canTransfer: 1, canSkipReturn: 1 })), { skipReturn: true, cancel: false, transfer: true });
  assert.deepEqual(L.perms(staff(['can_cancel', 'can_transfer'])), { skipReturn: false, cancel: true, transfer: true });
  assert.deepEqual(L.perms({ role: 'admin' }), { skipReturn: false, cancel: false, transfer: false });
});
test('availableActions per status and permission', () => {
  const none = staff(), all = staff({ can_cancel: 1, can_transfer: 1, can_skip_return: 1 }), me = { id: 1 };
  assert.deepEqual(L.availableActions({ status: 'waiting' }, none, me), []);
  assert.deepEqual(L.availableActions({ status: 'waiting' }, all, me), ['cancel', 'transfer']);
  assert.deepEqual(L.availableActions({ status: 'called', counter: { id: 1 } }, none, me), ['start', 'recall', 'skip']);
  assert.deepEqual(L.availableActions({ status: 'called', counter: { id: 1 } }, all, me), ['start', 'recall', 'skip', 'cancel', 'transfer']);
  assert.deepEqual(L.availableActions({ status: 'serving', counter: { id: 1 } }, all, me), ['complete', 'cancel']);
  assert.deepEqual(L.availableActions({ status: 'skipped' }, none, me), []); assert.deepEqual(L.availableActions({ status: 'skipped' }, all, me), ['return']);
  assert.deepEqual(L.availableActions({ status: 'completed' }, all, me), []); assert.deepEqual(L.availableActions({ status: 'cancelled' }, all, me), []);
  assert.deepEqual(L.availableActions({ status: 'called', counter: { id: 2 } }, none, me), [], 'other counter: no operational buttons');
});
test('parseScan: link, bare token, ticket number, junk', () => {
  assert.deepEqual(L.parseScan('http://192.168.1.5:3000/patient/?t=abcdef0123456789abcd'), { token: 'abcdef0123456789abcd' });
  assert.deepEqual(L.parseScan('https://x/patient/?clinic=a&t=abcdef0123456789abcd#x'), { token: 'abcdef0123456789abcd' });
  assert.deepEqual(L.parseScan('abcdef0123456789abcdef0123456789'), { token: 'abcdef0123456789abcdef0123456789' });
  assert.deepEqual(L.parseScan(' a25 '), { number: 'A-025' }); assert.equal(L.parseScan('hello world'), null); assert.equal(L.parseScan(''), null);
});
test('classifyError', () => {
  assert.equal(L.classifyError({ code: 'QUEUE_EMPTY' }).level, 'info'); assert.equal(L.classifyError({ code: 'UNAUTHENTICATED' }).level, 'session');
  assert.equal(L.classifyError({ code: 'ALREADY_CALLED' }).refresh, true); assert.equal(L.classifyError({ code: 'INVALID_TRANSITION' }).refresh, true);
  assert.equal(L.classifyError({ code: 'NETWORK' }).refresh, false);
});
test('elapsed and counters', () => {
  assert.equal(L.elapsed('2026-01-01T00:00:00Z', Date.parse('2026-01-01T00:02:05Z')), '02:05'); assert.equal(L.elapsed('2026-01-01T00:00:00Z', Date.parse('2026-01-01T01:00:01Z')), '1:00:01'); assert.equal(L.elapsed(null), '');
  const s = { counter: { id: 2 }, counters: [{ id: 1 }, { id: 2 }] };
  assert.equal(L.pickCounter(s, 1).id, 1); assert.equal(L.pickCounter(s, 99).id, 2); assert.equal(L.pickCounter({ counters: [{ id: 1 }, { id: 2 }] }, null), null);
  assert.equal(L.pickCounter({ counter: { id: 7 } }, null).id, 7); assert.equal(L.pickCounter({}, null), null);
});

test('normalizeTicket handles the real backend shape (service key/prefix, counter without id, verify flags)', () => {
  const t = L.normalizeTicket({ ticket: { publicId: 'p', number: 'C-002', status: 'called', service: { key: 'k', name_ar: 'تحاليل', name_en: 'Laboratory', prefix: 'C' }, counter: { number: 2, name: 'شباك 2', nameEn: 'Counter 2' }, isToday: false, authorizedForService: false } });
  assert.equal(t.serviceKey, 'k'); assert.equal(t.servicePrefix, 'C'); assert.equal(t.serviceId, null); assert.equal(t.isToday, false); assert.equal(t.authorizedForService, false);
  assert.equal(L.sameCounter(t.counter, { id: 2, number: 2 }), true); assert.equal(L.sameCounter(t.counter, { id: 1, number: 1 }), false);
  assert.deepEqual(L.availableActions(t, staff({ canCancel: true, canTransfer: true }), { id: 2, number: 2 }), ['start', 'recall', 'skip', 'cancel', 'transfer']);
  assert.deepEqual(L.availableActions(t, staff({}), { id: 1, number: 1 }), [], 'other counter');
});
