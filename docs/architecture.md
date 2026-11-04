# المعمارية وملكية الملفات

```
هاتف المريض -> Wi-Fi الضيوف -> الراوتر -> سيرفر QueueMaster المحلي
                                            |- SQLite (المرجع الوحيد للطابور)
                                            |- REST API + Socket.IO
                                            |- sms_outbox / sync_outbox (طوابير خلفية)
                                            |- web/patient, staff, admin, display (ملفات static)
```

السيرفر المحلي هو المرجع. Firebase اختياري ولا يعتمد عليه إصدار أو نداء التذاكر.

## قواعد مشتركة
- ES modules غير مطلوب. استخدم CommonJS (`require`) في السيرفر لتبسيط التسليم.
- SQLite عبر `better-sqlite3` (متزامن، transactions بسيطة وآمنة). الوصول للـ DB عبر `server/src/database/index.js` فقط.
- **تحميل الراوترات تلقائياً:** كل ملف في `server/src/routes/*.js` يصدّر `{ path, router }` (مثال: `module.exports = { path: '/api/tickets', router }`). `app.js` (حساب 1) يحمّلها كلها. بهذا لا يتعارض حسابان على `app.js`.
- **الأحداث الحية:** `server/src/sockets/index.js` (حساب 2) يصدّر `emitToClinic(clinicId, event, payload)` و`emitToRoom`. باقي الأكواد تستدعيها ولا تلمس Socket.IO مباشرة.
- كل استجابة JSON: نجاح `{ ok: true, data }`، فشل `{ ok: false, error: { code, message } }`.
- كل الأوقات تُخزن UTC بصيغة ISO-8601 وتُعرض بمنطقة العيادة.
- الواجهات تستخدم `web/shared/` (CSS tokens، i18n، api client). **مالكه حساب 3** وباقي الحسابات تقرأ منه فقط.

## ملكية الملفات

| المسار | المالك |
|---|---|
| `server/package.json`, `server/.env.example`, `server/src/app.js`, `server/src/server.js`, `server/src/config/`, `server/src/database/`, `server/src/middleware/` | حساب 1 |
| `server/src/routes/auth.js`, `staff.js`, `services.js`, `counters.js`, `clinic.js`, `audit.js` + الـ controllers/services المقابلة | حساب 1 |
| `server/src/services/queue*.js`, `ticket*.js`, `qr.js`, `sms/`, `sync/`, `server/src/sockets/`, `routes/tickets.js`, `queue.js`, `staff-queue.js`, `sms.js`, `sync.js` | حساب 2 |
| `web/patient/`, `web/staff/`, `web/shared/` | حساب 3 |
| `web/display/`, `routes/display.js`, `services/display*.js` | حساب 4 |
| `web/admin/`, `routes/ads.js`, `routes/reports.js`, `services/ads*.js`, `services/reports*.js`, `server/tests/`, `docs/*` (ما عدا العقود), `scripts/` | حساب 5 |
| `docs/database.md`, `docs/api-contract.md`, `docs/socket-events.md`, `docs/architecture.md`, `docs/workflow.md`, `tasks/` | المشرف |

## ترتيب الاعتمادية
1. حساب 1 يسلّم أولاً: package.json، app/server، الـ DB والـ migrations، الـ seed، المصادقة، الـ middleware.
2. حساب 2 يبني فوق قاعدة حساب 1. إن لم يكن جاهزاً بعد، يكتب منطقه ضد العقد ويختبره بقاعدة بيانات مؤقتة من `database.md`.
3. حسابات 3 و4 و5 تبني الواجهات على `api-contract.md` و`socket-events.md`.
