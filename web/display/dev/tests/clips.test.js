'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const CL = require('../../audio/clips.js');

test('تسلسل الملفات لنداء كامل', () => {
  assert.deepEqual(CL.clipSequence('A-025', 2), ['phrase-ticket', 'letter-a', 'n-5', 'n-and-20', 'phrase-counter', 'n-2o']);
  assert.deepEqual(CL.clipSequence('B-110', 12), ['phrase-ticket', 'letter-b', 'n-100', 'n-and-10', 'phrase-counter', 'n-12o', 'n-10b']);
  assert.equal(CL.clipUrls('A-025', 2, { base: '/media/audio' })[0], '/media/audio/ar/phrase-ticket.mp3');
});
test('خارج النطاق أو بادئة غير لاتينية: null', () => {
  assert.equal(CL.clipSequence('A-1000', 2), null); assert.equal(CL.clipSequence('ع-001', 2), null);
  assert.equal(CL.clipSequence('A-001', 100), null); assert.equal(CL.clipSequence('zzz', 1), null);
});
test('كل تذكرة 0..999 وكل شباك 0..99 له ملفات موجودة في المانيفست', () => {
  const have = new Set(CL.manifest().map((m) => m.file));
  for (let n = 0; n <= 999; n++) for (const f of CL.clipSequence(`A-${n}`, 1)) assert.ok(have.has(f), `ناقص ${f} لـ ${n}`);
  for (let c = 0; c <= 99; c++) for (const f of CL.clipSequence('A-1', c)) assert.ok(have.has(f), `ناقص ${f} لشباك ${c}`);
  const m = CL.manifest(); assert.ok(m.length > 80 && m.length < 130, `عدد الملفات ${m.length}`);
  assert.equal(new Set(m.map((x) => x.file)).size, m.length);
  for (const x of m) assert.match(x.file, /^[a-z0-9-]+$/);
});
