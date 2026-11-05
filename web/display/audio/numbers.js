/* تحويل الأرقام لكلمات + بناء نصوص النداء. دوال نقية (بدون DOM) تعمل في المتصفح وNode. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DisplayNumbers = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------------- العربية ---------------- */
  const AR_UNITS = ['صفر', 'واحد', 'اثنان', 'ثلاثة', 'أربعة', 'خمسة', 'ستة', 'سبعة', 'ثمانية', 'تسعة', 'عشرة',
    'أحد عشر', 'اثنا عشر', 'ثلاثة عشر', 'أربعة عشر', 'خمسة عشر', 'ستة عشر', 'سبعة عشر', 'ثمانية عشر', 'تسعة عشر'];
  const AR_TENS = ['', '', 'عشرون', 'ثلاثون', 'أربعون', 'خمسون', 'ستون', 'سبعون', 'ثمانون', 'تسعون'];
  const AR_HUNDREDS = ['', 'مائة', 'مائتان', 'ثلاثمائة', 'أربعمائة', 'خمسمائة', 'ستمائة', 'سبعمائة', 'ثمانمائة', 'تسعمائة'];

  /** حالة الجر/النصب (ين) بدل الرفع (ون/ان): "اثنين"، "عشرين"، "مائتين"، "اثني عشر". */
  function oblique(word) {
    return word.replace(/^اثنان/, 'اثنين').replace(/^اثنا عشر/, 'اثني عشر')
      .replace(/ون$/, 'ين').replace(/مائتان$/, 'مائتين');
  }

  function ar999(n, obl) { // 1..999
    const parts = [];
    const h = Math.floor(n / 100); const r = n % 100;
    if (h) parts.push(obl ? oblique(AR_HUNDREDS[h]) : AR_HUNDREDS[h]);
    if (r) {
      if (r < 20) parts.push(obl ? oblique(AR_UNITS[r]) : AR_UNITS[r]);
      else {
        const t = Math.floor(r / 10); const u = r % 10;
        const tens = obl ? oblique(AR_TENS[t]) : AR_TENS[t];
        parts.push(u ? `${obl ? oblique(AR_UNITS[u]) : AR_UNITS[u]} و${tens}` : tens);
      }
    }
    return parts.join(' و');
  }

  function arabicWords(n, obl) {
    if (n === 0) return AR_UNITS[0];
    const th = Math.floor(n / 1000); const rest = n % 1000;
    const parts = [];
    if (th) {
      let w;
      if (th === 1) w = 'ألف';
      else if (th === 2) w = obl ? 'ألفين' : 'ألفان';
      else if (th <= 10) w = `${AR_UNITS[th]} آلاف`;
      else { const r100 = th % 100; w = `${ar999(th, obl)} ${(r100 >= 11 && r100 <= 99) ? 'ألفاً' : 'ألف'}`; }
      parts.push(w);
    }
    if (rest) parts.push(ar999(rest, obl));
    return parts.join(' و');
  }

  /* ---------------- English ---------------- */
  const EN_ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
    'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
  const EN_TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
  function en999(n) {
    const parts = []; const h = Math.floor(n / 100); const r = n % 100;
    if (h) parts.push(`${EN_ONES[h]} hundred`);
    if (r) parts.push(r < 20 ? EN_ONES[r] : EN_TENS[Math.floor(r / 10)] + (r % 10 ? `-${EN_ONES[r % 10]}` : ''));
    return parts.join(' ');
  }
  function englishWords(n) {
    if (n === 0) return 'zero';
    const th = Math.floor(n / 1000); const rest = n % 1000;
    const parts = [];
    if (th) parts.push(`${en999(th)} thousand`);
    if (rest) parts.push(en999(rest));
    return parts.join(' ');
  }

  /** n صحيح 0..999999. opts.oblique للعربية (رقم الشباك: "اثنين"). خارج النطاق: الأرقام كما هي. */
  function numberToWords(n, lang, opts) {
    if (n === null || n === undefined || n === '' || typeof n === 'boolean') return String(n);
    const v = Number(n);
    if (!Number.isInteger(v) || v < 0 || v > 999999) return String(n);
    return lang === 'en' ? englishWords(v) : arabicWords(v, !!(opts && opts.oblique));
  }

  /* ---------------- التذكرة والنداء ---------------- */
  const AR_LETTERS = { A: 'إيه', B: 'بي', C: 'سي', D: 'دي', E: 'إي', F: 'إف', G: 'جي', H: 'إتش', I: 'آي', J: 'جاي', K: 'كي', L: 'إل', M: 'إم',
    N: 'إن', O: 'أو', P: 'بي', Q: 'كيو', R: 'آر', S: 'إس', T: 'تي', U: 'يو', V: 'في', W: 'دبليو', X: 'إكس', Y: 'واي', Z: 'زد' };

  /** "A-025" => { prefix:'A', number:25 } ؛ يقبل "A025" و"A 25" وبادئة حتى 3 أحرف. */
  function parseTicket(display) {
    const m = /^\s*([A-Za-z\u0621-\u064A]{1,3})[\s-]?0*(\d{1,6})\s*$/.exec(String(display == null ? '' : display));
    if (!m) return null;
    return { prefix: m[1].toUpperCase(), number: Number(m[2]) };
  }

  /** نص التذكرة المنطوق. opts.letters: 'latin' (الافتراضي حسب المواصفة: "A") أو 'arabic' ("إيه"). */
  function ticketWords(display, lang, opts) {
    const t = parseTicket(display);
    if (!t) return String(display);
    const letters = t.prefix.split('').map((ch) => (lang === 'ar' && opts && opts.letters === 'arabic' && AR_LETTERS[ch]) ? AR_LETTERS[ch] : ch).join(' ');
    return `${letters} ${numberToWords(t.number, lang)}`;
  }

  /** الجملة الكاملة بلغة واحدة. */
  function announcementText(lang, ticketNumber, counterNumber, opts) {
    if (lang === 'en') {
      return `Ticket ${ticketWords(ticketNumber, 'en', opts)}, please proceed to counter number ${numberToWords(Number(counterNumber), 'en')}.`;
    }
    return `الرقم ${ticketWords(ticketNumber, 'ar', opts)}، الرجاء التوجه إلى الشباك رقم ${numberToWords(Number(counterNumber), 'ar', { oblique: true })}.`;
  }

  /** announceLang: ar | en | both  =>  [{lang, text}, ...] (العربية أولاً). */
  function buildUtterances(ticketNumber, counterNumber, announceLang, opts) {
    const langs = announceLang === 'ar' ? ['ar'] : announceLang === 'en' ? ['en'] : ['ar', 'en'];
    return langs.map((lang) => ({ lang, text: announcementText(lang, ticketNumber, counterNumber, opts) }));
  }

  return { numberToWords, parseTicket, ticketWords, announcementText, buildUtterances, AR_LETTERS };
}));
