/* البديل المسجّل للعربية (عند عدم وجود صوت عربي في النظام): ملفات صوت قصيرة تُركَّب بالتتابع.
   كل كلمة رقم = ملف (ذرّة) فيكفي ~100 ملف لتغطية التذاكر 0..999 والشبابيك 0..99. المولّد يشتق الأسماء من نفس numbers.js. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./numbers.js'));
  else root.DisplayClips = factory(root.DisplayNumbers);
}(typeof self !== 'undefined' ? self : this, function (N) {
  'use strict';
  const MAX_TICKET = 999; const MAX_COUNTER = 99;

  // مفتاح ASCII لكل كلمة رقم (بدون واو العطف). الصيغ المجرورة تنتهي بـ o.
  const BASE = {
    'واحد': '1', 'اثنان': '2', 'ثلاثة': '3', 'أربعة': '4', 'خمسة': '5', 'ستة': '6', 'سبعة': '7', 'ثمانية': '8', 'تسعة': '9', 'عشرة': '10',
    'أحد': '11a', 'اثنا': '12a', 'عشر': '10b',
    'عشرون': '20', 'ثلاثون': '30', 'أربعون': '40', 'خمسون': '50', 'ستون': '60', 'سبعون': '70', 'ثمانون': '80', 'تسعون': '90',
    'مائة': '100', 'مائتان': '200', 'ثلاثمائة': '300', 'أربعمائة': '400', 'خمسمائة': '500', 'ستمائة': '600', 'سبعمائة': '700', 'ثمانمائة': '800', 'تسعمائة': '900',
    'اثنين': '2o', 'اثني': '12o', 'عشرين': '20o', 'ثلاثين': '30o', 'أربعين': '40o', 'خمسين': '50o', 'ستين': '60o', 'سبعين': '70o', 'ثمانين': '80o', 'تسعين': '90o', 'مائتين': '200o',
    'صفر': '0',
  };
  const PHRASES = { ticket: { file: 'phrase-ticket', text: 'الرقم' }, counter: { file: 'phrase-counter', text: 'الرجاء التوجه إلى الشباك رقم' } };

  function tokenFile(token) {
    if (BASE[token] !== undefined) return `n-${BASE[token]}`;
    if (token[0] === 'و' && BASE[token.slice(1)] !== undefined) return `n-and-${BASE[token.slice(1)]}`;
    throw new Error('كلمة رقم بلا ملف: ' + token);
  }
  /** أسماء الملفات (بدون الامتداد) لقراءة رقم بالعربية. */
  function numberFiles(n, obl) { return N.numberToWords(n, 'ar', { oblique: obl }).split(' ').map(tokenFile); }

  /** تسلسل الملفات لنداء كامل أو null إن تعذّر (بادئة غير A–Z أو رقم خارج النطاق). */
  function clipSequence(ticketNumber, counterNumber) {
    const t = N.parseTicket(ticketNumber); const c = Number(counterNumber);
    if (!t || !/^[A-Z]{1,3}$/.test(t.prefix) || t.number > MAX_TICKET || !Number.isInteger(c) || c < 0 || c > MAX_COUNTER) return null;
    return [PHRASES.ticket.file]
      .concat(t.prefix.split('').map((ch) => `letter-${ch.toLowerCase()}`))
      .concat(numberFiles(t.number, false))
      .concat([PHRASES.counter.file])
      .concat(numberFiles(c, true));
  }
  function clipUrls(ticketNumber, counterNumber, opts) {
    const seq = clipSequence(ticketNumber, counterNumber);
    if (!seq) return null;
    const base = (opts && opts.base) || '/media/audio'; const ext = (opts && opts.ext) || 'mp3';
    return seq.map((f) => `${base}/ar/${f}.${ext}`);
  }

  /** قائمة كل الملفات المطلوبة مع النص الذي يُسجَّل في كل ملف. */
  function manifest() {
    const map = new Map();
    const add = (file, text) => { if (!map.has(file)) map.set(file, text); };
    add(PHRASES.ticket.file, PHRASES.ticket.text); add(PHRASES.counter.file, PHRASES.counter.text);
    for (let i = 0; i < 26; i++) { const ch = String.fromCharCode(97 + i); add(`letter-${ch}`, ch.toUpperCase()); }
    const addWords = (n, obl) => {
      const words = N.numberToWords(n, 'ar', { oblique: obl }).split(' ');
      words.forEach((w) => add(tokenFile(w), w)); // النص كما يُنطق (مع واو العطف إن وُجدت)
    };
    for (let n = 0; n <= MAX_TICKET; n++) addWords(n, false);
    for (let n = 0; n <= MAX_COUNTER; n++) addWords(n, true);
    return Array.from(map, ([file, text]) => ({ file, text })).sort((a, b) => a.file.localeCompare(b.file, 'en', { numeric: true }));
  }
  return { clipSequence, clipUrls, manifest, tokenFile, PHRASES, MAX_TICKET, MAX_COUNTER };
}));
