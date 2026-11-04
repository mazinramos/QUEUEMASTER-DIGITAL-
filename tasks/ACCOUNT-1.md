# الحساب 1 — النواة: قاعدة البيانات والمصادقة والأمان
**الفرع:** `acct-1-core`  |  **الأولوية:** الأعلى، الحسابات الأخرى تنتظرك.

## قبل أي شيء
1. اقرأ بالترتيب: `README.md`، `docs/SPEC-SUMMARY.md`، `docs/workflow.md`، `docs/architecture.md`، `docs/database.md`، `docs/api-contract.md`، `docs/socket-events.md`.
2. اعمل على فرعك فقط، وفي ملفاتك فقط (جدول الملكية في `architecture.md`).
3. نفّذ ملفات حقيقية واختبرها فعلياً. لا أزرار وهمية، ولا إعلان اكتمال قبل الاختبار.
4. ارفع شغلك على فرعك باستمرار، وافتح Pull Request نحو `main` عند كل مرحلة، وأضف تقريراً في `reports/acct-N/` من `reports/TEMPLATE.md`.
5. البيئة: Node 20+، Windows 11 هو هدف الاختبار (مسارات متوافقة، لا أوامر bash فقط في scripts؛ وفّر بدائل npm scripts).

## المهام
### المرحلة 1 (سلّمها أولاً، ويفضّل خلال أول جلسة)
- `server/package.json` (better-sqlite3, express, socket.io, zod, argon2 أو bcryptjs, helmet, express-rate-limit, multer, qrcode, dotenv, cookie/session store، وأدوات الاختبار: `node:test` + supertest). سكربتات: `start`, `dev`, `migrate`, `seed`, `test`.
- `.env.example` (PORT, BASE_URL, SESSION_SECRET, DATA_DIR, TICKET_TOKEN_PEPPER, PHONE_ENC_KEY, SMS_PROVIDER, FIREBASE_*) بلا قيم حقيقية.
- `src/app.js` و`src/server.js`: Express + http + تهيئة Socket.IO عبر `require('./sockets').init(httpServer)` (حساب 2 يوفّر الملف، ضع stub مؤقتاً إن لم يوجد)، تحميل تلقائي لكل `routes/*.js`، خدمة `web/` كملفات static على `/patient /staff /admin /display` و`/shared`، ومعالج أخطاء موحد، و`GET /api/health`.
- `src/database/`: اتصال better-sqlite3 (WAL + FK)، مشغّل migrations، `001_init.sql` مطابق حرفياً لـ `docs/database.md`، `seed-dev.js` (عيادة تجريبية، 4 خدمات A/B/C/D بالأسماء العربية والإنجليزية، 3 شبابيك، 4 موظفين) ومفصول بوضوح عن الإنتاج ولا يعمل إلا مع `NODE_ENV!=production`.
- اختبار: `npm run migrate && npm run seed && npm start` ثم `curl /api/health`.

### المرحلة 2
- المصادقة: login/logout/me/csrf/change-password و**معالج الإعداد الأول** `/api/auth/setup` (ينشئ العيادة والأدمن عند عدم وجود أدمن، ولا يعمل بعدها).
- كلمات المرور بـ Argon2id (أو bcrypt بتكلفة >=12). جلسات في جدول `sessions`، انتهاء بعد خمول، كوكي HttpOnly/SameSite، CSRF، rate limit للدخول، قفل مؤقت بعد محاولات فاشلة.
- Middleware: `requireAuth`, `requireRole(...)`, `requirePermission('can_cancel')`, `validate(zodSchema)`, `clinicScope`, `auditLog`.
- مسارات CRUD الإدارية للعيادة والخدمات والشبابيك والموظفين (مع إعادة تعيين كلمة المرور، التعطيل، تعيين الخدمات/الشبابيك)، وكلها تكتب `audit_logs`، و`GET /api/admin/audit`.
- Helmet + CSP مناسب (بدون CDN خارجي، التطبيق يعمل offline).

### قبول (Acceptance)
- مجموعة اختبارات آلية: المصادقة، الصلاحيات (staff لا يصل لمسارات admin)، تحقق المدخلات، عزل العيادات (عيادة لا ترى بيانات أخرى)، CSRF، rate limit.
- لا كلمات مرور افتراضية للإنتاج. الـ seed للتطوير فقط وكلمات مروره تُولّد عشوائياً وتُطبع في الـ console.
