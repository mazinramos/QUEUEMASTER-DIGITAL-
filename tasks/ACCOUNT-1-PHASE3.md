# الحساب 1 — المرحلة 3: تثبيت الإنتاج والجاهزية للعيادة
**الفرع:** `acct-1-core` (حدّثه من main أولاً وادمج PR #1 إن لم يُدمج). التقرير: `reports/acct-1/`.
اقرأ `docs/INTEGRATION-STATUS.md` أولاً (فيه ما وجده المشرف).

## أ. إصلاحات مطلوبة (سريعة)
1. `package.json`: أضف `socket.io-client` في devDependencies، و`firebase-admin` في optionalDependencies، وتأكد أن `multer` على `^2`.
2. `.env.example`: أضف متغيرات SMS وFirebase (راجع `reports/acct-2/` المرحلة 3)، وكل متغير بشرح عربي قصير.
3. **الـ pepper والمفاتيح:** `TICKET_TOKEN_PEPPER` و`PHONE_ENC_KEY` و`SESSION_SECRET` لا تتولد عشوائياً كل تشغيل. في التطوير: تُولّد مرة وتُحفظ في `DATA_DIR/.dev-secrets.json` (خارج Git). في الإنتاج: الإقلاع يفشل برسالة واضحة إن غابت.
4. **الكوكي على شبكة العيادة (HTTP):** `Secure` لا يعمل على http. اجعله `COOKIE_SECURE=auto|true|false`، وافتراضه false مع توثيق متى يفعّل (عند وجود HTTPS). تأكد أن الدخول يعمل من هاتف على `http://192.168.x.x:PORT`.

## ب. قفل الحساب في قاعدة البيانات
الآن في الذاكرة ويتصفر مع restart. أنشئ `002_login_attempts.sql` (جدول `login_attempts`: staff_id/ip, count, locked_until) وانقل المنطق إليه. هذا تعديل مخطط معتمد من المشرف، وحدّث `docs/database.md` بنفسك لهذا الجدول فقط.

## ج. النسخ الاحتياطي (باك إند)
- `services/backup.js`: نسخة SQLite متسقة أثناء التشغيل (`db.backup()` من better-sqlite3)، إلى `DATA_DIR/backups/qm-YYYYMMDD-HHmm.db`، مؤقت يومي قابل للضبط، والاحتفاظ بآخر N نسخة (`BACKUP_KEEP`)، وفحص سلامة (`PRAGMA integrity_check`) بعد كل نسخة.
- مسارات أدمن: `GET /api/admin/backups`, `POST /api/admin/backups` (إنشاء الآن)، `GET /api/admin/backups/:name` (تنزيل). **الاستعادة** عبر سكربت `server/src/database/restore.js` (CLI فقط، السيرفر متوقف) مع نسخة أمان قبل الاستبدال.
- اختبارات: النسخة تُفتح وتحوي نفس التذاكر، والاحتفاظ يحذف الأقدم، ومسار التنزيل لا يقبل `../`.

## د. متانة وويندوز
- **hash كلمات المرور:** اجعل argon2 اختيارياً: إن فشل تحميل الحزمة الأصلية (native) على Windows يُستخدم `scrypt` المدمج في Node بمعاملات قوية، ويُخزن اسم الخوارزمية في الـ hash، والتحقق يدعم الاثنين (ويعيد التشفير عند الدخول إن لزم). اختبار لكل مسار.
- إغلاق نظيف (SIGINT/SIGTERM): يوقف المؤقتات والـ workers، ويغلق Socket.IO وقاعدة البيانات.
- لوج منظم (JSON أو نص) مع request-id، بدون كلمات مرور ولا توكنات ولا أرقام هواتف.
- `GET /api/health` يضيف `db: ok` و`uptime` و`version` (لا أسرار).

## هـ. تعدد العيادات
اختبار عزل موسّع: عيادتان، كل مسار admin/queue/public لا يسرّب بيانات الأخرى. وأضف `POST /api/super/clinics` (دور `owner` أو علم في .env `SUPER_ADMIN_TOKEN`) لإنشاء عيادة جديدة بأدمن أول. اقترح التعديل على العقد في تقريرك.

## قبول
`npm test` أخضر، `npm audit --omit=dev` صفر، وتقرير بنفس القالب مع قسم "ما لم يُجرَّب" (Windows).
