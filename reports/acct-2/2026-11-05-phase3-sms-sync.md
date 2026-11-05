# تقرير الحساب 2 — المرحلة 3: SMS والمزامنة

- **الحساب:** acct-2
- **التاريخ:** 2026-11-05
- **الفرع / آخر commit:** acct-2-queue

## ما تم إنجازه
- `services/sms/`: واجهة adapter (`send({to, body}) -> {ok, providerId|error}`)، `adapters/console` (يسجل رقماً مقنّعاً فقط)، `adapters/http` (قالب عام: URL/method/headers/body مع `{{to}}` `{{body}}`، هروب JSON أو URL، نمط نجاح، مسار معرّف الرسالة، timeout)، `smsCrypto` (AES-256-GCM، IV عشوائي، يرفض العبث والمفتاح الخاطئ)، `smsStore`، `smsService`، `smsWorker` (إعادة محاولة تصاعدية 30ث→60→120→240 ثم `failed` بعد 5، وحذف الأرقام بعد `purge_after`).
- `services/sync/`: `syncWorker` (عامل `sync_outbox`)، `firestoreSink` (معاملة Firestore بحارس إصدار)، و`routes/sync.js` → `GET /api/admin/sync/status` (manager+).
- الاسترجاع الآمن للتذكرة `POST /api/public/tickets/recover`.
- `services/queueWorkers.js` (`startAll/stopAll`) ويُشغَّل تلقائياً من `sockets.init()` لأن `server.js` عند ح1 لا يعرفه.

## ما تم اختباره (الأمر + النتيجة)
`cd server/src/services && node --test` → 54/54 (و`npm test` المدمج مع فرع ح1: 85/85 مرتين). الجديد في هذه المرحلة:
- التشفير: ذهاب وإياب، عبث بآخر بايت يفشل، مفتاح آخر يفشل، مفتاح قصير مرفوض.
- **لا هاتف صريح ولا توكن خام في أي جدول**، ونص الرسالة لا يحوي التوكن (قرار تصميم، انظر أدناه).
- حد 3 رسائل لكل تذكرة؛ `sms_enabled=0` → 403؛ `SMS_PROVIDER=none` أو غياب المفتاح → 503 واضح (لا صفوف عالقة).
- العامل: نجاح عبر console؛ فشل دائم بتأخيرات `[30000, 60000, 120000, 240000]` بالضبط ثم `failed` بعد 5 محاولات؛ لا إعادة إرسال قبل الموعد؛ استثناء من الـ adapter = فشل لا انهيار؛ `last_error` بلا أرقام؛ **التذكرة تبقى `waiting` ويمكن نداؤها بعد فشل رسالتها**.
- الاحتفاظ: بعد `purge_after` يُفرغ الرقم، المعلّق يصير `expired` ولا يُرسل أبداً.
- HTTP adapter ضد سيرفر محلي حقيقي: قالب JSON مع علامات اقتباس وسطر جديد وعربي، هيدر Authorization، معرّف من `data.id`، 503 → فشل، نمط نجاح غير مطابق → فشل، timeout (200ms)، GET بـ URL-encode.
- الاسترجاع: تدوير التوكن عند تطابق آخر 4 أرقام، القديم يبطل، كل الفشل `NOT_FOUND` موحد (رقم خاطئ/آخر 4 خاطئة/معطّل/بلا SMS/منتهية)، المحدّد: 5 محاولات لنفس الرقم ثم 429.
- المزامنة (sink مزيف): الترتيب محفوظ، لا توكن/hash في الحمولة، إعادة التشغيل idempotent (كلها `stale` والمخزن لا يتغير)؛ فشل كيان يحجب لاحقاته فقط ويمضي غيره؛ استنفاد المحاولات (8) يفك الحجب؛ بعد عودة الاتصال تُكتب الحالة الأخيرة.
- Firestore sink مع **Firestore مُحاكى**: حارس الإصدار، tombstone للحذف، لا إحياء بإصدار أقدم.
- `/api/admin/sync/status`: 401 / 403 / `pending_integration` + `firebaseConfigured:false`.

## الحالة
- منفذ ومختبر: كل ما سبق (SMS بالـ console وHTTP المحلي، التشفير، الاحتفاظ، الاسترجاع، منطق المزامنة وسياسة التعارض).
- **منفذ ويحتاج credentials/بيئة:**
  - مزامنة Firebase الفعلية: كود `firestoreSink` + تحميل `firebase-admin` بشرط وجود `FIREBASE_SERVICE_ACCOUNT_PATH` مكتوب، **لكنه لم يُجرَّب على Firebase حقيقي** (لا credentials، و`firebase-admin` غير مثبّت). بدونها: الطابور يبقى `pending` والحالة `pending_integration` والسجل يقول ذلك، ولا يُدّعى أنها تعمل.
  - مزود SMS حقيقي: adapter الـ HTTP مجرَّب على سيرفر محلي فقط، لا على مزود فعلي.
- غير منفذ: إشعار SMS عند النداء/اقتراب الدور (الهاتف محفوظ فقط للتأكيد والاسترجاع).

## المشاكل والقرارات المتخذة
1. **نص الـ SMS بلا توكن:** `sms_outbox.body` مخزّن في DB وقاعدة القبول تمنع التوكن الخام فيها. فالرسالة تحمل رقم التذكرة ورابط البوابة، والاسترجاع بـ«الرقم + آخر 4 أرقام» يعطي توكناً جديداً (القديم يبطل). بديل (تشفير التوكن في DB) رفضته لأنه يلغي فكرة «hash فقط».
2. **الاسترجاع** مشروط بـ`clinic_settings.ticket_recovery_enabled` وبأن تكون التذكرة قد أُرسل لها SMS ولم يُحذف رقمها بعد؛ تذكرة بلا SMS لا تُسترجع (وهذا مقصود: لا طريق آخر لإثبات الملكية).
3. **سياسة التعارض (موثقة في `syncWorker.js`):** المحلي يفوز؛ كتابات بإصدار `_version = id الصف المحلي`؛ الـ sink يتجاهل الأقدم/المساوي؛ الحذف = tombstone؛ لا قراءة من Firebase للمحلي إطلاقاً (تعديل يدوي هناك يُستبدل عند أول upsert).
4. **ترتيب المزامنة:** عام بـ id، وحجب لكل كيان عند الفشل (ليس حجباً عاماً حتى لا يعطل صف واحد تالف كل شيء). `sync_outbox` بلا عمود `next_attempt_at` فالتأخير في الذاكرة (يضيع عند إعادة التشغيل: إعادة محاولة فورية، وهو آمن لأن الكتابة idempotent).
5. **`UNIQUE(entity, entity_uid, created_at)`** في `sync_outbox`: أزيح `created_at` بمقدار 1ms عند التكرار بدل ضياع التحديث.
6. أسماء متغيرات البيئة وُحِّدت مع ح1: `TICKET_TOKEN_PEPPER` و`PHONE_ENC_KEY` و`SMS_PROVIDER=none|console|http` (+ `TOKEN_PEPPER`/`SMS_ENCRYPTION_KEY` كبدائل).

## طلبات من حسابات أخرى / تعديل عقود
- **ح1:** (أ) `server/.env.example`: أضف `SMS_HTTP_URL SMS_HTTP_METHOD SMS_HTTP_CONTENT_TYPE SMS_HTTP_HEADERS SMS_HTTP_BODY SMS_HTTP_SUCCESS_REGEX SMS_HTTP_ID_PATH SMS_HTTP_TIMEOUT_MS`، و`FIREBASE_SERVICE_ACCOUNT_PATH` (مسار ملف JSON؛ الاسم `firebase-service-account*.json` ممنوع أصلاً في `.gitignore`)، و`TICKET_ISSUE_MAX_PER_10MIN`. متغيرات `FIREBASE_PROJECT_ID/CLIENT_EMAIL/PRIVATE_KEY` عندك لا أستعملها (اخترت ملف خدمة واحد). (ب) `package.json`: `socket.io-client` في devDependencies (اختباراتي)، و`firebase-admin` في optionalDependencies. (ج) في التطوير يولّد `config` قيمة pepper عشوائية لكل تشغيل فتبطل التوكنات بعد كل إعادة تشغيل؛ يُفضّل تثبيتها (ملف في `server/data/` مثلاً) أو توليد `.env` في سكربت الإعداد.
- **المشرف:** (1) عند دمج الفرعين سيحدث تعارض add/add في `server/src/sockets/index.js` (stub ح1 مقابل ملفي): **يؤخذ ملفي** (جرّبته: دمج + حل بهذا الشكل + `npm test` = 85/85). (2) عقد: `GET /api/admin/sync/status` يعيد `{mode, firebaseConfigured, sink, pending, synced, failed, oldestPendingAt, lastSyncedAt, lastError, conflictPolicy}`. (3) عقد: `POST /api/public/tickets/:token/sms` يعيد 202، و503 عند عدم التهيئة.

## الخطوة التالية المقترحة
دمج PR، ثم ح5 يبني تقارير على `ticket_events`، وح3/ح4 يربطان الواجهات بالأحداث. أقترح لاحقاً إشعار SMS عند النداء.
