/* QueueMaster i18n: Arabic (default) + English. Sets <html lang dir>. No dependencies. */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.QM = root.QM || {}; root.QM.createI18n = api.createI18n; root.QM.i18n = api.createI18n({ doc: root.document, storage: safeStorage(root), global: true }); }
  function safeStorage(r) { try { return r.localStorage; } catch (e) { return null; } }
})(typeof self !== 'undefined' ? self : this, function () {
  var LANGS = ['ar', 'en'];
  var STORE_KEY = 'qm.lang';

  var BASE = {
    ar: {
      'common.loading': 'جارٍ التحميل…', 'common.retry': 'إعادة المحاولة', 'common.close': 'إغلاق', 'common.cancel': 'تراجع',
      'common.confirm': 'تأكيد', 'common.back': 'رجوع', 'common.save': 'حفظ', 'common.send': 'إرسال', 'common.copy': 'نسخ',
      'common.yes': 'نعم', 'common.no': 'لا', 'common.language': 'اللغة', 'common.min': '{n} د',
      'common.unknown': 'غير معروف', 'common.none': '—',
      'conn.online': 'متصل', 'conn.offline': 'غير متصل', 'conn.connecting': 'جارٍ الاتصال…',
      'status.waiting': 'في الانتظار', 'status.called': 'تم النداء', 'status.serving': 'قيد الخدمة',
      'status.completed': 'اكتملت', 'status.skipped': 'تم التخطي', 'status.cancelled': 'ملغاة',
      'err.VALIDATION': 'البيانات المدخلة غير صحيحة، راجعها وحاول مجدداً.',
      'err.UNAUTHENTICATED': 'انتهت الجلسة، سجّل الدخول من جديد.',
      'err.FORBIDDEN': 'ليست لديك صلاحية لهذا الإجراء.',
      'err.FORBIDDEN_SERVICE': 'هذه الخدمة غير مسندة إليك.',
      'err.NOT_FOUND': 'العنصر المطلوب غير موجود.',
      'err.CONFLICT': 'تعذّر تنفيذ الطلب لوجود تعارض، حدّث الصفحة وحاول مجدداً.',
      'err.RATE_LIMITED': 'محاولات كثيرة في وقت قصير. انتظر قليلاً ثم أعد المحاولة.',
      'err.INTERNAL': 'حدث خطأ في الخادم. حاول بعد قليل.',
      'err.INVALID_TRANSITION': 'لا يمكن تنفيذ هذا الإجراء في الحالة الحالية للتذكرة. حُدّثت البيانات.',
      'err.ALREADY_CALLED': 'تم نداء هذه التذكرة بالفعل من شباك آخر.',
      'err.QUEUE_EMPTY': 'لا يوجد منتظرون الآن.',
      'err.NETWORK': 'تعذّر الاتصال بالخادم. تأكد من الاتصال بشبكة العيادة ثم أعد المحاولة.',
      'err.TIMEOUT': 'استغرق الطلب وقتاً طويلاً. أعد المحاولة.',
      'err.BAD_RESPONSE': 'استجابة غير متوقعة من الخادم.',
      'err.CSRF': 'انتهت صلاحية رمز الحماية. أعد المحاولة.',
      'err.UNKNOWN': 'حدث خطأ غير متوقع.'
    },
    en: {
      'common.loading': 'Loading…', 'common.retry': 'Try again', 'common.close': 'Close', 'common.cancel': 'Cancel',
      'common.confirm': 'Confirm', 'common.back': 'Back', 'common.save': 'Save', 'common.send': 'Send', 'common.copy': 'Copy',
      'common.yes': 'Yes', 'common.no': 'No', 'common.language': 'Language', 'common.min': '{n} min',
      'common.unknown': 'Unknown', 'common.none': '—',
      'conn.online': 'Online', 'conn.offline': 'Offline', 'conn.connecting': 'Connecting…',
      'status.waiting': 'Waiting', 'status.called': 'Called', 'status.serving': 'Being served',
      'status.completed': 'Completed', 'status.skipped': 'Skipped', 'status.cancelled': 'Cancelled',
      'err.VALIDATION': 'Some of the data is invalid. Please check it and try again.',
      'err.UNAUTHENTICATED': 'Your session has ended. Please sign in again.',
      'err.FORBIDDEN': 'You do not have permission for this action.',
      'err.FORBIDDEN_SERVICE': 'This service is not assigned to you.',
      'err.NOT_FOUND': 'The requested item was not found.',
      'err.CONFLICT': 'The request conflicts with the current state. Refresh and try again.',
      'err.RATE_LIMITED': 'Too many attempts in a short time. Please wait a moment and try again.',
      'err.INTERNAL': 'Server error. Please try again shortly.',
      'err.INVALID_TRANSITION': 'This action is not possible in the ticket\'s current state. Data was refreshed.',
      'err.ALREADY_CALLED': 'This ticket was already called by another counter.',
      'err.QUEUE_EMPTY': 'Nobody is waiting right now.',
      'err.NETWORK': 'Cannot reach the server. Check your connection to the clinic network and try again.',
      'err.TIMEOUT': 'The request took too long. Please try again.',
      'err.BAD_RESPONSE': 'Unexpected response from the server.',
      'err.CSRF': 'The security token expired. Please try again.',
      'err.UNKNOWN': 'An unexpected error occurred.'
    }
  };

  function createI18n(opts) {
    opts = opts || {};
    var doc = opts.doc || null, storage = opts.storage || null;
    var dict = { ar: Object.assign({}, BASE.ar), en: Object.assign({}, BASE.en) };
    var listeners = [];
    var lang = 'ar';
    try { var saved = storage && storage.getItem(STORE_KEY); if (LANGS.indexOf(saved) >= 0) lang = saved; } catch (e) {}
    var hasChoice = LANGS.indexOf((function () { try { return storage && storage.getItem(STORE_KEY); } catch (e) { return null; } })()) >= 0;

    function extend(extra) { LANGS.forEach(function (l) { if (extra[l]) Object.assign(dict[l], extra[l]); }); }
    function interpolate(s, params) {
      if (!params) return s;
      return s.replace(/\{(\w+)\}/g, function (m, k) { return params[k] != null ? String(params[k]) : m; });
    }
    function t(key, params) {
      var s = dict[lang][key];
      if (s == null) s = dict[lang === 'ar' ? 'en' : 'ar'][key];
      if (s == null) return key;
      return interpolate(s, params);
    }
    function has(key, l) { return dict[l || lang][key] != null; }
    /* plural: looks for key.zero/one/two/few/many/other via Intl.PluralRules */
    function plural(key, n, params) {
      var cat = 'other';
      try { cat = new Intl.PluralRules(lang).select(n); } catch (e) {}
      var k = has(key + '.' + cat) ? key + '.' + cat : key + '.other';
      return t(k, Object.assign({ n: fmtNumber(n) }, params || {}));
    }
    function dir() { return lang === 'ar' ? 'rtl' : 'ltr'; }
    function apply(rootEl) {
      if (!doc) return;
      var html = doc.documentElement;
      html.setAttribute('lang', lang); html.setAttribute('dir', dir());
      var scope = rootEl || doc;
      Array.prototype.forEach.call(scope.querySelectorAll('[data-i18n]'), function (el) { el.textContent = t(el.getAttribute('data-i18n')); });
      Array.prototype.forEach.call(scope.querySelectorAll('[data-i18n-attr]'), function (el) {
        el.getAttribute('data-i18n-attr').split(';').forEach(function (pair) {
          var p = pair.split(':'); if (p.length === 2) el.setAttribute(p[0].trim(), t(p[1].trim()));
        });
      });
      Array.prototype.forEach.call(scope.querySelectorAll('.qm-lang button[data-lang]'), function (b) {
        b.setAttribute('aria-pressed', b.getAttribute('data-lang') === lang ? 'true' : 'false');
      });
    }
    function setLang(l, persist) {
      if (LANGS.indexOf(l) < 0) return;
      lang = l;
      if (persist !== false) { hasChoice = true; try { storage && storage.setItem(STORE_KEY, l); } catch (e) {} }
      apply();
      listeners.slice().forEach(function (fn) { try { fn(l); } catch (e) { /* listener errors must not break switching */ } });
    }
    /* server/clinic default: applies only if the visitor has not chosen a language yet */
    function setDefault(l) { if (!hasChoice && LANGS.indexOf(l) >= 0 && l !== lang) setLang(l, false); }
    function onChange(fn) { listeners.push(fn); return function () { listeners = listeners.filter(function (f) { return f !== fn; }); }; }

    /* numbers/dates: Latin digits in both languages so ticket numbers, times and counts always match the printed ticket */
    function loc() { return lang === 'ar' ? 'ar-u-nu-latn' : 'en-GB'; }
    function fmtNumber(n) { try { return new Intl.NumberFormat(loc()).format(n); } catch (e) { return String(n); } }
    function fmtTime(iso, timeZone) {
      if (!iso) return '';
      var d = new Date(iso); if (isNaN(d)) return '';
      var o = { hour: '2-digit', minute: '2-digit', hour12: lang === 'ar' };
      if (timeZone) o.timeZone = timeZone;
      try { return new Intl.DateTimeFormat(loc(), o).format(d); } catch (e) { delete o.timeZone; return new Intl.DateTimeFormat(loc(), o).format(d); }
    }
    function fmtDate(iso, timeZone) {
      if (!iso) return '';
      var d = new Date(iso); if (isNaN(d)) return '';
      var o = { year: 'numeric', month: 'long', day: 'numeric' };
      if (timeZone) o.timeZone = timeZone;
      try { return new Intl.DateTimeFormat(loc(), o).format(d); } catch (e) { delete o.timeZone; return new Intl.DateTimeFormat(loc(), o).format(d); }
    }
    /* picks name_ar / name_en (or name) from a server object, falling back to the other language */
    function pick(obj, base) {
      if (!obj) return '';
      if (typeof obj === 'string') return obj;
      base = base || 'name';
      var a = obj[base + '_ar'], e = obj[base + '_en'];
      var v = lang === 'ar' ? (a || e) : (e || a);
      return v || obj[base] || '';
    }
    function errorMessage(err) {
      var code = err && err.code;
      if (code && has('err.' + code)) return t('err.' + code);
      if (err && err.message && err.status && err.status < 500 && err.status !== 401 && !/^[A-Z_]+$/.test(err.message)) return err.message;
      return t('err.UNKNOWN');
    }
    function keys(l) { return Object.keys(dict[l]); }

    var api = { extend: extend, t: t, plural: plural, has: has, dir: dir, apply: apply, setLang: setLang, setDefault: setDefault,
      onChange: onChange, fmtNumber: fmtNumber, fmtTime: fmtTime, fmtDate: fmtDate, pick: pick, errorMessage: errorMessage, keys: keys,
      get lang() { return lang; }, LANGS: LANGS };
    if (doc && opts.global) apply();
    return api;
  }
  return { createI18n: createI18n, BASE: BASE };
});
