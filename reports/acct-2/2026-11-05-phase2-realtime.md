# تقرير الحساب 2 — المرحلة 2: الوقت الحقيقي (Socket.IO)

- **الحساب:** acct-2
- **التاريخ:** 2026-11-05
- **الفرع / آخر commit:** acct-2-queue

## ما تم إنجازه
`server/src/sockets/index.js`: `init(httpServer, { sessionMiddleware, resolveDisplay })`، `close()`، `emitToClinic`، `emitToRoom`، `emitToDisplays`، `emitToStaff`.
- المصادقة: موظف (كوكي الجلسة عبر `io.engine.use(sessionMiddleware)` ثم تحميل الموظف من DB والتأكد أنه فعّال)، شاشة (كوكي `qm.display` عبر `resolveDisplay`)، مريض (بدون هوية، `ticket:watch` فقط).
- الغرف: `clinic:<id>:staff`، `clinic:<id>:display`، `ticket:<publicId>`.
- كل الأحداث في `socket-events.md`: `ticket:created/called/recalled/serving/completed/skipped/cancelled`، `queue:updated` (لقطة كاملة)، `display:announcement` (مع called/recalled فقط). و`display:settings_updated` / `advertisement:updated` يبثها ح4/ح5 عبر `emitToDisplays/emitToClinic` ونفس الغلاف.
- كل رسالة: `eventId` (UUID) و`ts` و`clinicId`، وحدث واحد يصل لكل الغرف بنفس الـ eventId (لا نسخ مختلفة).
- **البث بعد commit:** الخدمات تنشر على `queueBus` بعد انتهاء المعاملة فقط، والـ sockets تشترك.
- أمان: غرفة المريض لا تُنضم إلا بتوكن صالح؛ الحد الأقصى 5 تذاكر لكل اتصال؛ إغلاق الاتصال عند أكثر من 20 حدثاً واردة/10 ث؛ `maxHttpBufferSize` 4KB؛ الأحداث الواردة من الموظف/الشاشة لا معالجات لها، و`ticket:watch` من غير المريض يرد `FORBIDDEN`.
- `ticket:watch` يرد بلقطة الحالة الحالية (تفيد بعد إعادة الاتصال).

## ما تم اختباره (الأمر + النتيجة)
`cd server/src/services && node --test` → 40/40 (35 للمرحلة 1 + 5 sockets)، شُغّلت مرتين متتاليتين بلا تذبذب. الاختبارات تستخدم `socket.io-client` فعلياً على websocket:
- موظف + شاشة + مريضان: call-next يصل staff (called + queue:updated)، display (called + announcement + queue:updated)، صاحب التذكرة (called فقط)، **والمريض الآخر لا يصله شيء**.
- `recall` يصل مع announcement؛ `queue:updated` لا يحمل announce؛ start/complete تصل للمريض بالترتيب.
- عزل عيادتين: لا تسريب.
- لا بث عند فشل المعاملة (QUEUE_EMPTY → صفر أحداث).
- رفض: كوكي شاشة غير صالح، موظف غير فعّال، موظف غير موجود.
- لا توكن خام في أي payload.
- انقطاع الشاشة: نداء أثناء الانقطاع **لا يُعاد** عند العودة، ولقطة `queue:updated` التالية تستبدل الحالة.

## الحالة
- منفذ ومختبر: كل ما سبق.
- منفذ ويحتاج تكاملاً: ربط `init()` في `server.js` وتمرير `sessionMiddleware` (ح1) و`resolveDisplay` (ح4) — اختُبر بمحاكيات لهما. إذا لم يُمرَّر `resolveDisplay` نحاول `services/displayAuth.js` ثم نرفض الشاشات.
- غير منفذ: قطع اتصال socket فوراً عند تعطيل موظف أثناء الجلسة (يُرفض عند الاتصال التالي فقط).

## المشاكل والقرارات المتخذة
- `display:announcement.lang` = `clinics.default_language` (ar/en)؛ الشاشة تقرر اللغة الفعلية من `display_settings.announce_lang` (قد يُرسل المشرف قراراً آخر).
- `ticket:cancelled` يحمل `reason` للتذاكر الملغاة بسبب؛ reset-day يرسل `reason:'reset-day'`.
- `ticket:created` لا يُبث لغرفة المريض (لا معنى).
- PR: كل المراحل على نفس الفرع، وPR #2 مفتوح مسبقاً، فأضيف تعليقاً لكل مرحلة بدل PR مكرر (GitHub يمنع PR ثانٍ لنفس head/base).

## طلبات من حسابات أخرى / تعديل عقود
- **ح1:** استدعاء `sockets.init(httpServer, { sessionMiddleware, resolveDisplay })` بعد إنشاء السيرفر؛ و`sockets.close()` عند الإيقاف.
- **ح4:** تصدير `resolveDisplay(cookieValue) -> { displayId, clinicId } | null` من `services/displayAuth.js` (أو تمريره لـ init).

## الخطوة التالية المقترحة
المرحلة 3: SMS (adapter + عامل + تشفير) والمزامنة (sync_outbox → Firebase).
