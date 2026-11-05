'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const N = require('../../audio/numbers.js');

const AR = {
  0: 'صفر', 1: 'واحد', 2: 'اثنان', 3: 'ثلاثة', 9: 'تسعة', 10: 'عشرة', 11: 'أحد عشر', 12: 'اثنا عشر', 13: 'ثلاثة عشر', 19: 'تسعة عشر',
  20: 'عشرون', 21: 'واحد وعشرون', 22: 'اثنان وعشرون', 25: 'خمسة وعشرون', 30: 'ثلاثون', 48: 'ثمانية وأربعون', 99: 'تسعة وتسعون',
  100: 'مائة', 101: 'مائة وواحد', 110: 'مائة وعشرة', 111: 'مائة وأحد عشر', 125: 'مائة وخمسة وعشرون', 200: 'مائتان', 215: 'مائتان وخمسة عشر',
  300: 'ثلاثمائة', 450: 'أربعمائة وخمسون', 999: 'تسعمائة وتسعة وتسعون',
  1000: 'ألف', 1001: 'ألف وواحد', 2000: 'ألفان', 2500: 'ألفان وخمسمائة', 3000: 'ثلاثة آلاف', 10000: 'عشرة آلاف', 11000: 'أحد عشر ألفاً',
  21000: 'واحد وعشرون ألفاً', 100000: 'مائة ألف', 123456: 'مائة وثلاثة وعشرون ألفاً وأربعمائة وستة وخمسون',
};
const EN = {
  0: 'zero', 5: 'five', 13: 'thirteen', 20: 'twenty', 21: 'twenty-one', 25: 'twenty-five', 99: 'ninety-nine', 100: 'one hundred', 101: 'one hundred one',
  110: 'one hundred ten', 125: 'one hundred twenty-five', 999: 'nine hundred ninety-nine', 1000: 'one thousand', 1234: 'one thousand two hundred thirty-four',
  20000: 'twenty thousand', 999999: 'nine hundred ninety-nine thousand nine hundred ninety-nine',
};

test('عربي: أرقام مرجعية (رفع)', () => { for (const [n, w] of Object.entries(AR)) assert.equal(N.numberToWords(+n, 'ar'), w, `n=${n}`); });
test('English: reference numbers', () => { for (const [n, w] of Object.entries(EN)) assert.equal(N.numberToWords(+n, 'en'), w, `n=${n}`); });

test('عربي: حالة الجر لرقم الشباك (اثنين...)', () => {
  const o = (n) => N.numberToWords(n, 'ar', { oblique: true });
  assert.equal(o(1), 'واحد'); assert.equal(o(2), 'اثنين'); assert.equal(o(3), 'ثلاثة'); assert.equal(o(12), 'اثني عشر');
  assert.equal(o(20), 'عشرين'); assert.equal(o(22), 'اثنين وعشرين'); assert.equal(o(25), 'خمسة وعشرين'); assert.equal(o(200), 'مائتين');
  assert.equal(o(2000), 'ألفين');
});

test('نطاق كامل 0..9999: لا فراغ ولا undefined، وكل رقم له نص فريد', () => {
  for (const lang of ['ar', 'en']) {
    const seen = new Map();
    for (let n = 0; n <= 9999; n++) {
      const w = N.numberToWords(n, lang);
      assert.ok(w && !/undefined|NaN|null/.test(w) && w.trim() === w && !/ {2}/.test(w), `${lang} ${n}: "${w}"`);
      assert.ok(!seen.has(w), `${lang}: ${n} و${seen.get(w)} لهما نفس النص "${w}"`);
      seen.set(w, n);
    }
  }
});

test('مدخلات خارج النطاق/غير صحيحة تعاد كما هي ولا ترمي', () => {
  assert.equal(N.numberToWords(-1, 'ar'), '-1'); assert.equal(N.numberToWords(1.5, 'en'), '1.5');
  assert.equal(N.numberToWords(1000000, 'ar'), '1000000'); assert.equal(N.numberToWords('abc', 'ar'), 'abc'); assert.equal(N.numberToWords(null, 'en'), 'null');
});

test('parseTicket', () => {
  assert.deepEqual(N.parseTicket('A-025'), { prefix: 'A', number: 25 });
  assert.deepEqual(N.parseTicket('b-001'), { prefix: 'B', number: 1 });
  assert.deepEqual(N.parseTicket('ABC-120'), { prefix: 'ABC', number: 120 });
  assert.deepEqual(N.parseTicket('A025'), { prefix: 'A', number: 25 });
  assert.deepEqual(N.parseTicket('A 7'), { prefix: 'A', number: 7 });
  assert.deepEqual(N.parseTicket('ع-010'), { prefix: 'ع', number: 10 });
  assert.deepEqual(N.parseTicket('A-000'), { prefix: 'A', number: 0 });
  for (const bad of ['', null, undefined, 'A-', '025', 'ABCD-1', 'A-1x', '<b>', 'A--1']) assert.equal(N.parseTicket(bad), null, String(bad));
});

test('النص العربي الحرفي حسب المواصفة', () => {
  assert.equal(N.announcementText('ar', 'A-025', 2), 'الرقم A خمسة وعشرون، الرجاء التوجه إلى الشباك رقم اثنين.');
});
test('النص الإنجليزي الحرفي حسب المواصفة', () => {
  assert.equal(N.announcementText('en', 'A-025', 2), 'Ticket A twenty-five, please proceed to counter number two.');
});
test('أمثلة إضافية وأحرف عربية بديلة', () => {
  assert.equal(N.announcementText('ar', 'B-001', 12), 'الرقم B واحد، الرجاء التوجه إلى الشباك رقم اثني عشر.');
  assert.equal(N.announcementText('ar', 'A-025', 2, { letters: 'arabic' }), 'الرقم إيه خمسة وعشرون، الرجاء التوجه إلى الشباك رقم اثنين.');
  assert.equal(N.announcementText('en', 'C-110', 11), 'Ticket C one hundred ten, please proceed to counter number eleven.');
  assert.equal(N.announcementText('en', 'weird', 3), 'Ticket weird, please proceed to counter number three.', 'نمط غير معروف لا يرمي');
});
test('buildUtterances: ar / en / both بالترتيب', () => {
  assert.deepEqual(N.buildUtterances('A-025', 2, 'ar').map((u) => u.lang), ['ar']);
  assert.deepEqual(N.buildUtterances('A-025', 2, 'en').map((u) => u.lang), ['en']);
  const both = N.buildUtterances('A-025', 2, 'both');
  assert.deepEqual(both.map((u) => u.lang), ['ar', 'en']);
  assert.equal(both[0].text, N.announcementText('ar', 'A-025', 2)); assert.equal(both[1].text, N.announcementText('en', 'A-025', 2));
  assert.deepEqual(N.buildUtterances('A-025', 2, 'zzz').map((u) => u.lang), ['ar', 'en']);
});
