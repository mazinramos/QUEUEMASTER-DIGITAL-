# تقرير الحساب 1 — النواة: قاعدة البيانات والمصادقة والأمان (المرحلتان 1 و2)

- **الحساب:** acct-1
- **التاريخ:** 2026-11-05
- **الفرع / آخر commit:** acct-1-core / (انظر PR #1 و PR المرحلة 2)

## ما تم إنجازه
**المرحلة 1:** `server/package.json` (سكربتات start/dev/migrate/seed/test)، `.env.example` بلا قيم، `src/config`، `src/app.js` (تحميل تلقائي لـ `routes/*.js`، static لـ /patient /staff /admin /display /shared، معالج أخطاء موحد، `GET /api/health`)، `src/server.js`، `database/` (WAL + FK، مشغّل migrations، `001_init.sql` مطابق لـ database.md، `seed-dev.js` للتطوير فقط بكلمات مرور عشوائية تُطبع مرة واحدة). `sockets/index.js` stub مؤقت لحساب 2.

**المرحلة 2:**
- مصادقة: `/api/auth/csrf|login|logout|me|change-password|setup`. Argon2id، جلسات في جدول `sessions` (يُخزن SHA-256 للمعرّف فقط)، خمول 30 د + سقف مطلق 12 س، كوكي HttpOnly/SameSite=Lax، تدوير الجلسة عند الدخول، CSRF بهيدر، rate limit، قفل مؤقت بعد 5 محاولات فاشلة.
- Middleware: `requireAuth`, `requireRole`, `requirePermission`, `validate(zod)`, `clinicScope`, `auditLog/writeAudit`.
- CRUD إداري: `/api/admin/clinic|services|counters|staff` (+ `POST staff/:id/reset-password`) و`GET /api/admin/audit`، وكلها تكتب `audit_logs`.
- Helmet + CSP بدون أي مصدر خارجي.

## ما تم اختباره (الأمر + النتيجة)
- `cd server && npm test` → **30/30 نجحت** (node:test + supertest): المصادقة، الصلاحيات (staff لا يصل لمسارات admin، manager قراءة فقط)، تحقق المدخلات (strict zod)، عزل العيادات (قراءة/تعديل/حذف/ربط عبر العيادات كلها 404/400)، CSRF (بدون/مزيف/توكن جلسة أخرى)، rate limit للدخول (429)، القفل المؤقت، تدوير الجلسة، انتهاء الجلسة، إيقاف موظف يقتل جلسته، setup مرة واحدة فقط.
- تشغيل من الصفر: `npm run migrate && npm run seed && npm start` ثم curl حقيقي: `/api/health` 200؛ login بدون CSRF = 403؛ login بالـ CSRF = 200؛ قائمة الخدمات (4)؛ إنشاء شباك؛ ظهور `counter.create` و`auth.login` في `/api/admin/audit`؛ `/api/auth/setup` بعد وجود أدمن = 403.
- `NODE_ENV=production npm run seed` → رفض برسالة واضحة. `NODE_ENV=production npm start` بدون `SESSION_SECRET` → يرفض الإقلاع.

## الحالة
- منفذ ومختبر: كل ما سبق.
- منفذ ويحتاج credentials/بيئة: لا شيء (Firebase/SMS ليسا من نطاق هذا الحساب).
- غير منفذ: اختبار على Windows 11 فعلياً (المسارات عبر `path.join` ولا bash في scripts، لكن لم يُجرَّ الاختبار على Windows). `argon2` و`better-sqlite3` نواتان native: على Windows تتوفر prebuilt عادة، وإن فشل التثبيت يلزم Build Tools أو التحويل إلى bcryptjs.

## المشاكل والقرارات المتخذة
1. **قفل الحساب في الذاكرة:** مخطط `staff` لا يحوي عمود محاولات فاشلة، فالقفل in-memory (يتصفر عند إعادة التشغيل) مع rate limit للـ IP. اقتراح للمشرف: عمودان `failed_attempts`/`locked_until` إن أردتم قفلاً دائماً.
2. **اختبارات في `server/tests/core/`:** المجلد `server/tests/` مملوك لحساب 5، فوضعت اختباراتي في مجلد فرعي. `npm test` يكتشف كل `*.test.js` تلقائياً (متوافق مع Node 20+ وWindows).
3. **الحذف:** الخدمة/الشباك المستخدمان في تذاكر يُعطَّلان بدل الحذف؛ الموظف يُعطَّل فقط (التاريخ يشير إليه). لا يمكن تعطيل/تخفيض آخر أدمن أو تعطيل النفس.
4. **الأدوار:** manager يقرأ العيادة/الخدمات/الشبابيك فقط؛ staff/audit/كل الكتابة للأدمن فقط.
5. **اسم المستخدم فريد لكل عيادة فقط** (حسب المخطط)، فإن تكرر عبر عيادات يطلب login حقل `clinicId`.
6. المستخدم بـ `must_change_password=1` يُمنع من كل API عدا `/api/auth/*` (كود `PASSWORD_CHANGE_REQUIRED`).
7. `csrfProtect` يعفي `/api/public/*` و`/api/display/*` (لهما آلياتهما: توكن التذكرة وكوكي الشاشة).
8. `npm audit` أبلغ عن ثغرة واحدة high في تبعية ولم تُعالج (لم أفحص أيها بعد).

## طلبات من حسابات أخرى / تعديل عقود
- **حساب 2:** استبدال `sockets/index.js` (stub). يمكن استخدام `req.staff` / `req.clinicId` / `requireRole` / `requirePermission('can_cancel')` / `validate` / `writeAudit(req, action, entity, id, details)` من `server/src/middleware`. الجلسة لا تُمرَّر تلقائياً لـ Socket.IO: استخدموا `parseCookies` + `hashSid` من `middleware/session.js` ثم قراءة `sessions`.
- **حساب 3:** الهيدر `X-CSRF-Token` من `GET /api/auth/csrf` أو من حقل `csrfToken` في ردّ login/me. ردّ login يحوي أيضاً `mustChangePassword`.
- **المشرف:** أضيفوا لـ api-contract أن ردّ login/me يحمل `csrfToken` و`mustChangePassword`، وأن `POST /api/admin/staff` و`reset-password` يعيدان `temporaryPassword` مرة واحدة.

## الخطوة التالية المقترحة
دمج PR المرحلة 1 ثم 2، وأن يبدأ حساب 2 فوقهما. أفحص ثغرة `npm audit` وأجرّب التثبيت على Windows إن توفرت بيئة.
