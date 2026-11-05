const test = require('node:test'); const assert = require('node:assert/strict');
const L = require('../logic.js');

test('parseTokenFromSearch accepts safe tokens only', () => {
  assert.equal(L.parseTokenFromSearch('?t=abcDEF0123456789'), 'abcDEF0123456789');
  assert.equal(L.parseTokenFromSearch('?x=1&t=abcDEF0123456789&y=2'), 'abcDEF0123456789');
  assert.equal(L.parseTokenFromSearch('?t=short'), null);
  assert.equal(L.parseTokenFromSearch('?t=<script>alert(1)</script>'), null);
  assert.equal(L.parseTokenFromSearch(''), null);
});
test('normalizeTicketNumber', () => {
  assert.equal(L.normalizeTicketNumber('a25'), 'A-025'); assert.equal(L.normalizeTicketNumber(' A 7 '), 'A-007');
  assert.equal(L.normalizeTicketNumber('B-1042'), 'B-1042'); assert.equal(L.normalizeTicketNumber('A-0025'), 'A-025');
  assert.equal(L.normalizeTicketNumber('25'), null); assert.equal(L.normalizeTicketNumber('ABCD-1'), null); assert.equal(L.normalizeTicketNumber(''), null);
});
test('normalizePhone', () => {
  assert.equal(L.normalizePhone('+20 100-123 4567'), '+201001234567'); assert.equal(L.normalizePhone('0100 123 4567'), '01001234567');
  assert.equal(L.normalizePhone('00249912345678'), '+249912345678'); assert.equal(L.normalizePhone('12345'), null); assert.equal(L.normalizePhone('abc'), null);
});
test('final/active + alert rules', () => {
  assert.equal(L.isFinal('completed'), true); assert.equal(L.isFinal('skipped'), false); assert.equal(L.isActive({ status: 'waiting' }), true); assert.equal(L.isActive({ status: 'cancelled' }), false);
  assert.equal(L.shouldAlert('waiting', 'called'), true); assert.equal(L.shouldAlert('called', 'called'), false);
  assert.equal(L.shouldAlert('called', 'called', 'ticket:recalled'), true); assert.equal(L.shouldAlert('called', 'serving'), false);
});
test('store persists only valid tickets and survives broken storage', () => {
  const m = {}; const st = { getItem: k => m[k] ?? null, setItem: (k, v) => { m[k] = v; }, removeItem: k => { delete m[k]; } };
  const s = L.createStore(st); assert.equal(s.loadTicket(), null);
  s.saveTicket({ token: 'abc', number: 'A-001' }); assert.equal(s.loadTicket().number, 'A-001');
  m[L.STORE_KEY] = '{not json'; assert.equal(s.loadTicket(), null);
  m[L.STORE_KEY] = JSON.stringify({ number: 'x' }); assert.equal(s.loadTicket(), null);
  s.clearTicket(); assert.equal(m[L.STORE_KEY], undefined);
  const bad = L.createStore({ getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } });
  assert.equal(bad.loadTicket(), null); assert.equal(bad.saveTicket({ token: 't' }), false);
});
test('mergeServer / mergeEvent', () => {
  const saved = { token: 't', number: 'A-001', status: 'waiting', service: 'باطنة' };
  const a = L.mergeServer(saved, { status: 'called', ahead: 0, counter: { number: 2 }, service: { name_ar: 'باطنة' } });
  assert.equal(a.status, 'called'); assert.equal(a.token, 't'); assert.equal(L.counterNumber(a.counter), 2);
  const b = L.mergeEvent(saved, 'ticket:called', { ticket: { status: 'called' }, counter: { number: 3, name: 'x' } });
  assert.equal(b.status, 'called'); assert.equal(b.counter.number, 3);
  assert.equal(L.mergeEvent(b, 'ticket:skipped', { ticket: {} }).counter, null);
  assert.equal(L.signature(a, false), L.signature(Object.assign({}, a), false)); assert.notEqual(L.signature(a, false), L.signature(a, true));
});
test('ticketUrl', () => assert.equal(L.ticketUrl('http://h:3000/', 'a b'), 'http://h:3000/patient/?t=a%20b'));
