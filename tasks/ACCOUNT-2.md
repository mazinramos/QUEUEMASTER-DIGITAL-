# الحساب 2 — محرك الطوابير والتذاكر والوقت الحقيقي
**الفرع:** `acct-2-queue`  |  يعتمد على حساب 1 (package.json, الـ DB). ابدأ بالمنطق والاختبارات ضد مخطط `database.md` ثم اربط.

## قبل أي شيء
1. اقرأ بالترتيب: `README.md`، `docs/SPEC-SUMMARY.md`، `docs/workflow.md`، `docs/architecture.md`، `docs/database.md`، `docs/api-contract.md`، `docs/socket-events.md`.
2. اعمل على فرعك فقط، وفي ملفاتك فقط (جدول الملكية في `architecture.md`).
3. نفّذ ملفات حقيقية واختبرها فعلياً. لا أزرار وهمية، ولا إعلان اكتمال قبل الاختبار.
4. ارفع شغلك على فرعك باستمرار، وافتح Pull Request نحو `main` عند كل مرحلة، وأضف تقريراً في `reports/acct-N/` من `reports/TEMPLATE.md`.
5. البيئة: Node 20+، Windows 11 هو هدف الاختبار (مسارات متوافقة، لا أوامر bash فقط في scripts؛ وفّر بدائل npm scripts).

## المهام
### المرحلة 1: المحرك
- `services/ticketService.js`: إصدار تذكرة داخل transaction واحدة (`BEGIN IMMEDIATE`): زيادة `daily_sequences` ذرياً، توليد `display_number` (A-025)، توكن عشوائي 32 بايت (base64url)، تخزين SHA-256(token + pepper) فقط، كتابة `ticket_events` + `sync_outbox`. التصفير اليومي حسب `clinics.timezone` (احسب `business_date` بـ Intl، لا تعتمد على توقيت السيرفر).
- `services/queueService.js`: call-next (يختار أقدم waiting حسب priority ثم seq من خدمات الموظف المصرّح بها فقط، ويحدّثه إلى called بشرط `WHERE status='waiting'` وتتحقق من عدد الصفوف المتأثرة)، recall، start، complete، skip، return، cancel، transfer، lookup، verify. جدول الانتقالات المسموحة في `database.md`. كل إجراء يكتب event واحداً على الأقل.
- حساب الانتظار: عدد من قبلك، والزمن المقدّر (متوسط الخدمة الفعلي لآخر N تذاكر إن كفى، وإلا `est_duration_min`، وإلا `null`).
- `services/qr.js`: توليد QR (مكتبة `qrcode`، SVG) لرابط التذكرة، ولرابط بوابة العيادة، ولـ Wi-Fi (`WIFI:T:WPA;S:...;P:...;;`).
- المسارات حسب `api-contract.md`: `public.js`, `queue.js`, واستعلامات الأدمن للتذاكر (`/api/admin/tickets...`, reset-day, cancel).
### المرحلة 2: الوقت الحقيقي
- `sockets/index.js`: `init(httpServer)`, مصادقة الاتصال (موظف/شاشة/مريض)، الغرف، `emitToClinic`. نفّذ كل الأحداث في `socket-events.md` بـ `eventId` فريد، والبث **بعد commit**.
### المرحلة 3: SMS والمزامنة
- `services/sms/`: واجهة adapter (`send({to, body}) -> {ok, providerId|error}`) + adapter تجريبي `console` + adapter قالب HTTP عام. عامل خلفي يعالج `sms_outbox` بإعادة محاولة تصاعدية، ويحذف الأرقام بعد `purge_after`، وتشفير الرقم AES-256-GCM. فشل الرسالة لا يؤثر على التذكرة.
- `services/sync/`: عامل خلفي لـ `sync_outbox` نحو Firebase Admin SDK (يُحمّل فقط عند وجود credentials في .env). بدونها: يبقى الطابور معلقاً ويُسجل "pending integration"، ولا يُعلن أنها تعمل. ترتيب الأحداث محفوظ، idempotent، مع سياسة تعارض موثقة. `GET /api/admin/sync/status`.

### قبول
- اختبار تزامن: 20 استدعاء call-next متوازي من 5 موظفين على نفس الخدمة، لا تذكرة تُنادى مرتين وكل الأرقام فريدة ومتسلسلة، وعبر أكثر من خدمة.
- اختبار إعادة تشغيل السيرفر: التذاكر باقية. اختبار تغيير اليوم (تصفير الترقيم).
- اختبار أن التوكن الخام غير موجود في DB ولا في الـ logs.
- كل الانتقالات غير المسموحة تُرفض بـ `INVALID_TRANSITION`.
