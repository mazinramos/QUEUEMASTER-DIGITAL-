# تقرير الحساب 2 — المرحلة 1: محرك الطوابير والتذاكر

- **الحساب:** acct-2
- **التاريخ:** 2026-11-05
- **الفرع / آخر commit:** acct-2-queue

## ما تم إنجازه
- `services/queueDb.js` (وصول DB/ساعة/توكن/businessDate بـ Intl/serviceKey)، `queueErrors.js`، `queueLog.js` (يحجب التوكن)، `queueBus.js` (نشر بعد commit).
- `services/ticketService.js`: إصدار داخل `BEGIN IMMEDIATE` (`.immediate()`)، تسلسل ذري عبر `INSERT … ON CONFLICT DO UPDATE … RETURNING`، `A-025`، توكن 32 بايت base64url، تخزين `SHA-256(token+pepper)` فقط، `ticket_events` + `sync_outbox` في نفس المعاملة، حالة المريض العامة، استرجاع (مرحلة 3 تكمله بـ smsStore).
- `services/queueService.js`: call-next، recall، start، complete، skip، return، cancel، transfer، lookup، verify، getState، adminCancel، resetDay، listTickets، ticketEvents. كل إجراء: event + audit + sync في معاملة واحدة، والبث بعد commit.
- `services/queueStats.js`: من قبلك + الزمن المقدّر + لقطة `queue:updated`.
- `services/qr.js` (QR تذكرة/بوابة/Wi-Fi بالتهريب الصحيح، SVG)، `queueAuth.js`، `queueRateLimit.js`.
- المسارات: `routes/public.js`، `routes/queue.js`، `routes/tickets.js` (أدمن: tickets, events, cancel, reset-day).
- اختبارات: `services/*.test.js` (35 اختباراً) + `queueConcurrency.worker.js` + `queueRestart.child.js` + `queueTestHelpers.js` (يحمّل المخطط من مهاجرات ح1 إن وُجدت وإلا من كتلة SQL في `docs/database.md` نفسها، فلا نسخة مكررة).

## ما تم اختباره (الأمر + النتيجة)
`cd server/src/services && node --test` (Node 22 محلياً؛ مشغَّل مرتين متتاليتين، ومرة ثالثة أثناء التطوير):
- 35/35 ناجحة.
- **التزامن (فعلي، ليس في thread واحد):** كل worker thread له اتصال DB مستقل على نفس ملف WAL:
  - 8 threads × 24 إصداراً على خدمتين → 192 رقماً فريداً، متسلسلة 1..96 لكل خدمة بلا فجوات.
  - **20 call-next متوازٍ من 5 موظفين** على خدمتين (call→start→complete لكل نداء): 20 تذكرة مختلفة، لا حدث `called` مكرر لأي تذكرة، الترقيم فريد ومتسلسل.
- **إعادة تشغيل:** عملية Node جديدة تقرأ نفس الملف: التذكرة باقية، التوكن صالح، الترقيم يكمل A-003. وتأكيد أن تغيير الـ pepper يُبطل التوكنات (فالـ pepper يجب أن يثبت في `.env`).
- **تغيير اليوم:** عيادتان بمنطقتين (UTC / Asia/Karachi) على نفس اللحظة تعطيان `business_date` مختلفاً، والتصفير يحدث عند منتصف ليل كل عيادة.
- **التوكن الخام:** مسح كل جداول DB + مخرجات اللوج (بما فيها سطر يحوي `/tickets/<token>?t=<token>`) → لا يظهر.
- **الانتقالات:** مصفوفة كاملة (6 حالات × 7 إجراءات = 42 حالة): غير المسموح → `INVALID_TRANSITION` بلا event وبلا تغيير حالة.
- HTTP حقيقي على express: أكواد وأشكال الاستجابة، 401/403/404/409/429، QR SVG.

## الحالة
- منفذ ومختبر: كل ما سبق (المرحلة 1).
- منفذ ويحتاج بيئة: ربط حقيقي مع `server/src/database/index.js` وجلسات ح1 (مختبر فقط بقاعدة مؤقتة وجلسة محاكاة).
- غير منفذ: `recover` الكامل (يحتاج مرحلة 3)، SMS، sockets، sync (المراحل 2–3).

## المشاكل والقرارات المتخذة
1. **ح1 لم يسلّم بعد**: لا `package.json` ولا DB. كتبت ضد العقد. افتراضاتي عن ح1: `require('../database')` يعيد instance من better-sqlite3 أو `{ db }` أو `{ getDb() }`؛ هوية الموظف في `req.session.staffId` (أو `req.staff.id` / `req.user.id`)، وأحمّل الصلاحيات من الـ DB دائماً.
2. **ترتيب الطابور:** `priority DESC, issued_at ASC, seq_number ASC`. المتخطى العائد (return) والمحوَّل يحتفظان بـ `issued_at` الأصلي (لا يعودان لآخر الطابور).
3. **شباك واحد = تذكرة نشطة واحدة:** call-next يرفض بـ `409 CONFLICT` إن كان على الشباك called/serving، إلا لو `clinic_settings.allow_multiple_active=1`.
4. **الصلاحيات:** admin/manager لهم كل الخدمات والصلاحيات الثلاث؛ staff حسب `staff_services` و`can_*`. فحص الصلاحية قبل فحص الانتقال.
5. **الزمن المقدّر** = (من قبلك × المتوسط) ÷ عدد الشبابيك النشطة المرتبطة بالخدمة (≥1). المتوسط: آخر 20 مكتملة إن وُجدت 3 على الأقل، وإلا `est_duration_min`.
6. **تذكرة نشطة من يوم سابق:** تظهر للمريض `expired` (افتراضية للعرض فقط) ولا تُنادى أبداً.
7. **transfer:** رقم جديد من تسلسل الخدمة الهدف (بسبب `UNIQUE(clinic,service,date,seq)`)، والرقم القديم في `meta` للحدث.
8. **reset-day:** يلغي التذاكر النشطة لليوم فقط. **لا يمكن إعادة الترقيم داخل نفس اليوم** بسبب قيد UNIQUE على `tickets` — الترقيم يتصفر تلقائياً غداً.
9. **مفتاح الخدمة العام** = HMAC(pepper, id) مقتطع (12 حرفاً)، فلا يظهر رقم DB للمريض. والعيادة تُحدد بـ `clinic_settings.slug` أو id رقمي أو العيادة الوحيدة (لا يوجد عمود slug في العقد).

## طلبات من حسابات أخرى / تعديل عقود
- **ح1:** (أ) `.env.example`: `TOKEN_PEPPER` (≥16 حرفاً، ثابت)، `BASE_URL`، `SMS_ENCRYPTION_KEY` (32 بايت hex)، `TICKET_ISSUE_MAX_PER_10MIN`. (ب) لوجر الطلبات **يجب** أن يحجب `/api/public/tickets/:token` و`?t=` — استخدم `require('./services/queueLog').redact(str)`. (ج) الاعتماديات: `better-sqlite3 express socket.io qrcode zod` (+`socket.io-client` للاختبار). (د) سكربت `npm test` يشمل `server/src/services` — مثلاً `node --test src/services` لا يعمل على Node 22 كمجلد؛ استخدم `node --test` من داخل المجلد أو glob. (هـ) `app.js` يحمّل `routes/public.js` (ليس في جدول الملكية، سمّيته حسب `tasks/ACCOUNT-2.md`).
- **المشرف (عقد):** (1) إضافة `GET /api/public/tickets/:token/qr.svg`. (2) نوع حدث `recovered` ضمن `ticket_events.type`. (3) `GET /api/public/clinic` يعيد `key` + `id` (نفس المفتاح العام). (4) قرار على reset-day (بند 8) وعلى ترتيب العائد (بند 2). (5) حالة افتراضية `expired` في استجابة حالة المريض. (6) إضافة `public.js` لجدول الملكية.

## الخطوة التالية المقترحة
المرحلة 2: `sockets/index.js` ثم المرحلة 3: SMS + المزامنة.
