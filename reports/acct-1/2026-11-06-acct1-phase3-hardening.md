# تقرير الحساب 1 — المرحلة 3: تثبيت الإنتاج والجاهزية للعيادة

- **الحساب:** acct-1
- **التاريخ:** 2026-11-06
- **الفرع / آخر commit:** acct-1-core (بعد دمج main) / PR #1 مُحدَّث

## ما تم إنجازه
**أ. إصلاحات سريعة**
- `package.json`: `multer ^2.5.0`، `socket.io-client` في devDependencies، `firebase-admin ^14.5.0` و`argon2` في optionalDependencies (فشل بناء argon2 لا يكسر `npm install`)، و`overrides` لـ glob/minimatch (انظر "المشاكل").
- `.env.example` بشرح عربي لكل متغير (SMS بكل متغيرات المحوّل، Firebase `FIREBASE_SERVICE_ACCOUNT_PATH`، النسخ الاحتياطي، اللوج، `SUPER_ADMIN_TOKEN`...). المتغيرات مأخوذة من كود حساب 2 الفعلي.
- **الأسرار:** `config/secrets.js`. التطوير: تُولَّد مرة وتُحفظ في `DATA_DIR/.dev-secrets.json` (0600، خارج Git). الإنتاج: يفشل الإقلاع برسالة عربية/إنجليزية تسمّي كل متغير ناقص وطريقة التوليد. القيم تُكتب في `process.env` لأن كود حساب 2 يقرأها مباشرة من البيئة. أضفت `npm run secrets [-- --write]` يولّد الثلاثة ولا يستبدل الموجود.
- **الكوكي:** `COOKIE_SECURE=auto|true|false` (افتراضي false)، يُقرَّر لكل طلب (`auto` = Secure فقط إذا الطلب HTTPS). تحذير عند الإقلاع إن كان `true` مع `BASE_URL` http.

**ب. قفل الحساب في DB:** `002_login_attempts.sql` + نقل المنطق. مفتاح المستخدم `s:<staff_id>` أو `u:<username>` لاسم غير موجود (لا تسريب لوجود الاسم)، ومفتاح IP بعتبة 5× لإيقاف تجريب أسماء كثيرة. نافذة نسيان العدّاد، `Retry-After`، فك قفل بـ `POST /api/admin/staff/:id/unlock` وعند reset-password. `docs/database.md` محدّث لهذا الجدول فقط.

**ج. النسخ الاحتياطي:** `services/backup.js` (`db.backup()`، `integrity_check` + `foreign_key_check`، مؤقت `BACKUP_INTERVAL_HOURS`، احتفاظ `BACKUP_KEEP`، مهلة أمان، نسخة واحدة فقط عند الطلبات المتزامنة، أسماء تصاعدية دائماً)، المسارات `GET/POST /api/admin/backups` و`GET /api/admin/backups/:name` (أدمن فقط)، و`restore.js` (CLI، يرفض والسيرفر يعمل، يفحص النسخة قبل أي تغيير، نسخة أمان `pre-restore-*`). `npm run backup` و`npm run restore`.

**د. متانة:** argon2 اختياري مع fallback إلى scrypt (N=2^15)، الخوارزمية داخل الـ hash، التحقق يدعم الاثنين، وإعادة تشفير شفافة بعد نجاح الدخول. إغلاق نظيف (SIGINT/SIGTERM/SIGBREAK) يوقف المؤقتات والـ workers (عبر `sockets.close()` لحساب 2) ثم Socket.IO ثم الاتصالات ثم DB. لوج منظم JSON/نص بـ `X-Request-Id`، بلا query string ولا أجسام ولا ترويسات، ويُقنَّع أي مقطع مسار يشبه توكن أو هاتف. `/api/health` يعيد `db` و`uptime` و`version` (و503 إذا DB لا تعمل).

**هـ. تعدد العيادات:** `POST/GET /api/super/clinics` و`PUT /api/super/clinics/:id/active` بترويسة `X-Super-Token` (معطّل 404 إن لم يُضبط الرمز أو قصر عن 32 حرفاً؛ مقارنة ثابتة الزمن؛ rate limit لمحاولات الرمز الخاطئ فقط؛ يُنشئ العيادة والأدمن في معاملة واحدة بكلمة مؤقتة وإلزام تغييرها). اختبارات عزل موسّعة على كل المسارات.
دليل المشغّل: `server/OPERATIONS.md`.

## ما تم اختباره (الأمر + النتيجة)
- `cd server && npm test` على فرعي: **104 اختبار، 92 ناجح، 0 فشل، 12 مُتخطّى** (مجموعة العزل الخاصة بمسارات حساب 2/3/5 تتخطى نفسها حيث لا توجد هذه المسارات).
- نفس الاختبارات على **نسخة مدمجة مؤقتة** (كودي + كود `integration` لحساب 2/3/5، لم تُرفع): **159 اختبار، 158 ناجح، 0 فشل، 1 مُتخطّى** (فحص git يحتاج ريبو)، وتشمل اختبارات حساب 2 نفسها (طابور، SMS، sockets، restart) ومجموعة العزل كاملة (13/13: public وqueue وtickets وreports وads وdisplays).
- `npm audit` و`npm audit --omit=dev`: **0 ثغرات**.
- **clone نظيف** من الفرع: `npm ci` ثم `npm test` أخضر ثم لا ملفات زائدة في `git status`.
- **تشغيل حقيقي** (production، `npm run secrets -- --write`): health، setup، login، إنشاء خدمة، `POST /api/admin/backups` وتنزيل النسخة وفتحها (`integrity_check=ok`)، محاولات `../` و`..%2f` = 404، السجل لا يحوي كلمة المرور، وSIGTERM ← `bye exitCode:0`.
- **الدخول من IP غير loopback على HTTP** بـ curl وجرة كوكي (curl يرفض إعادة إرسال كوكي Secure على http، فهو اختبار حقيقي لسيناريو الهاتف): login=200 ثم `/me`=200.
- **نسخ ثم استعادة حقيقية:** الاستعادة رُفضت والسيرفر يعمل، ونجحت بعده وأعادت البيانات، ونسخة الأمان ملف واحد.
- استمرار القفل عبر **إعادة تشغيل فعلية** (عمليتا node منفصلتان على DB ملف).

## الحالة
- **منفذ ومختبر:** كل بنود أ–هـ أعلاه.
- **منفذ ويحتاج credentials/بيئة:** Firebase (`firebase-admin` يُحمَّل لكن لم يُجرَّب مع مشروع حقيقي)، ومزود SMS حقيقي (من نطاق حساب 2).
- **غير منفذ:** انظر "ما لم يُجرَّب".

## ما لم يُجرَّب
- **Windows 11 فعلياً** (لا بيئة Windows هنا): مسار scrypt مُختبر بمحاكاة فشل تحميل argon2 وبـ `FORCE_SCRYPT`، لكن لم يُجرَّب `npm install` الحقيقي ولا تشغيل الخدمة هناك. نقاط الحذر: قفل ملف SQLite عند الاستعادة (أوقف السيرفر تماماً)، وسلوك `SIGBREAK/SIGINT` في cmd/PowerShell، ومساراتها في `DATA_DIR`.
- **HTTPS خلف reverse proxy حقيقي:** `COOKIE_SECURE=auto` مُختبر بترويسة `X-Forwarded-Proto` من loopback فقط (`trust proxy=loopback`)؛ إن كان البروكسي على جهاز آخر لن يُوثق به (يحتاج ضبط).
- متصفح هاتف فعلي (اختُبر بمحاكاة curl لا بمتصفح).
- حجم DB كبير (نسخ/استعادة بمئات الميغابايت)، وتزامن نسخ مع حمل كتابة عالٍ جداً.
- `firebase-admin` مع `overrides` لـ glob/minimatch: يُحمَّل بلا أخطاء، لكن لم يُشغَّل فعلياً.

## المشاكل والقرارات المتخذة
**أخطاء وجدتها اختباراتي أثناء العمل وأصلحتها:** (1) `verifyBackup` كان يرمي استثناءً لملف ليس قاعدة SQLite فيبقى ملف تالف مُدرجاً كنسخة صالحة، (2) بعد حذف الاحتفاظ لأقدم نسخة كانت النسخة التالية تأخذ الاسم نفسه فتُحذف فوراً، (3) النسخ كانت تترك `-wal/-shm` بجانب كل نسخة (اكتُشف بالتشغيل الحقيقي لا بالاختبار) فصارت كل نسخة ملفاً واحداً بـ `journal_mode=DELETE`، (4) limiter رمز مدير النظام كان يحتسب أخطاء التحقق 400 فيحجب عميلاً شرعياً، (5) اختبار لي كان يكتب `server/.env` حقيقياً (أُصلح وحُذف الملف).
**قرارات:**
1. `/api/super/*` برمز في `.env` لا بدور `owner`: عمود `staff.role` مقيّد بـ `CHECK(admin|manager|staff)` وإضافة owner تحتاج migration. الرمز غير تلقائي الإرسال فلا CSRF، ومُستثنى من فحصه.
2. النسخ الاحتياطي لكل DB (كل العيادات) فلذلك **أدمن فقط**. وقت أسماء النسخ UTC.
3. القفل على `staff_id` لا على الاسم (نفس الاسم في عيادتين لا يتأثر)، والاسم غير الموجود يُقفل بالمثل لإخفاء وجوده.
4. `argon2`→`scrypt` تلقائياً عند الدخول فقط، ولا تنزيل عكسي. حساب أُنشئ بـ argon2 على جهاز آخر لا يدخل على جهاز بلا argon2 إلا بإعادة تعيين كلمة المرور.
5. النسخ من DB **in-memory** مع كتابة متزامنة يعلق (خاصية SQLite)؛ DB الإنتاج ملف ولا يتأثر، وأضفت مهلة `BACKUP_TIMEOUT_MS` حتى لا يتجمّد المؤقت.
6. ثغرات `npm audit` الانتقالية (glob/minimatch داخل firebase-admin) عولجت بـ `overrides`؛ إن ظهر خلل في Firebase فهذا أول ما يُراجَع.

## طلبات من حسابات أخرى / تعديل عقود
**مقترح لـ `docs/api-contract.md` (للمشرف):**
- `POST /api/auth/login` و`GET /api/auth/me` يعيدان `{ staff, csrfToken }` وفي `staff`: `mustChangePassword` و`permissions` و`services` و`counter`. `login` يقبل `clinicId` اختيارياً (مطلوب فقط إن تكرر اسم المستخدم بين عيادات).
- `429 RATE_LIMITED` مع ترويسة `Retry-After` (بالثواني) عند القفل. كود `PASSWORD_CHANGE_REQUIRED` (403) لكل API عدا `/api/auth/*`.
- جديد: `POST /api/admin/staff/:id/unlock`، `GET|POST /api/admin/backups`، `GET /api/admin/backups/:name`، `POST|GET /api/super/clinics`، `PUT /api/super/clinics/:id/active` (ترويسة `X-Super-Token`)، وترويسة `X-Request-Id` في كل رد.
- `POST /api/admin/staff` و`reset-password` يعيدان `temporaryPassword` مرة واحدة. `GET /api/health` → `{status, db, uptime, time, version}`.
**حساب 3 (واجهة الموظف/الأدمن):** اعرض زر "فك القفل" ونافذة النسخ الاحتياطي (إنشاء/قائمة/تنزيل)، واحترم `Retry-After`، ووجّه المستخدم لتغيير كلمة المرور عند `mustChangePassword`.
**حساب 2:** الأسرار تُحسم في `config` عند تحميل التطبيق ثم تُكتب في `process.env`؛ أي سكربت مستقل (خارج `src/server.js`) يلزمه `require('./config')` أولاً وإلا لن يرى قيم التطوير المحفوظة. `sockets.close()` عندك يُستدعى عند الإغلاق ويجب أن يوقف الـ workers (يعمل حالياً).
**المشرف:** المسارات الجديدة تُحمَّل تلقائياً من `routes/`. اختبارات `server/tests/core/` لي ولا تتعارض مع `server/tests/` لحساب 5.

## الخطوة التالية المقترحة
دمج PR #1 (المراحل 1–3). ثم تجربة على جهاز Windows فعلي بما فيها `npm install` وتشغيل كخدمة، وتجربة HTTPS خلف Caddy/Nginx، وإن أردتم قفلاً أدق أو دور `owner` فبـ migration إضافية.
