# أحداث Socket.IO (ملزمة)

المسار: `/socket.io`. الاتصال يمر على نوع العميل:
- **موظف/أدمن:** يستخدم كوكي الجلسة. ينضم تلقائياً لغرفة `clinic:<id>:staff`.
- **شاشة:** كوكي `qm.display`. غرفة `clinic:<id>:display`.
- **مريض:** `socket.emit('ticket:watch', { token })` ثم غرفة `ticket:<publicId>` (بدون جلسة).

كل رسالة payload تحمل: `eventId` (UUID فريد)، `ts` (ISO)، `clinicId`. العميل يتجاهل أي `eventId` رآه من قبل (ذاكرة آخر 200 حدث) لمنع التكرار بعد إعادة الاتصال.

| الحدث | الغرف | المحتوى (إضافة للحقول المشتركة) |
|---|---|---|
| `ticket:created` | staff, display | `ticket:{ number, service, status }` |
| `ticket:called` | staff, display, ticket | `ticket:{ number, service }`, `counter:{ number, name }`, `announce:true` |
| `ticket:recalled` | staff, display, ticket | مثل called مع `announce:true` |
| `ticket:serving` | staff, display, ticket | ticket + counter |
| `ticket:completed` | staff, display, ticket | ticket |
| `ticket:skipped` | staff, display, ticket | ticket |
| `ticket:cancelled` | staff, display, ticket | ticket + `reason?` |
| `queue:updated` | staff, display | `{ services:[{ key, waiting }], current:[...], next:[...] }` لقطة كاملة |
| `display:announcement` | display | `{ ticketNumber, counterNumber, lang }` (يُرسل مع called/recalled فقط) |
| `display:settings_updated` | display | `{ displayId, settings }` |
| `advertisement:updated` | display | `{ ads:[...] }` القائمة النشطة الجديدة |

## قواعد
1. الإذاعة تتم **بعد commit** المعاملة فقط.
2. بعد إعادة اتصال العميل ينادي `GET /api/display/bootstrap` (أو `/api/queue/state`) ويستبدل حالته، **ولا يعيد نطق نداءات قديمة**. الشاشة تنطق فقط أحداثاً `eventId` جديدة وبعمر أقل من 30 ثانية.
3. `ticket:recalled` يعيد النطق عمداً، `queue:updated` لا ينطق أبداً.
4. الخادم يحد معدل الأحداث الواردة من العملاء (لا تُقبل من المريض غير `ticket:watch`).
