# عقد REST API (ملزم)

الصيغة: JSON. نجاح `{ ok:true, data }`، فشل `{ ok:false, error:{ code, message } }`.
المصادقة: جلسة بكوكي `qm.sid` (HttpOnly, SameSite=Lax). طلبات التعديل من الموظفين تحتاج هيدر `X-CSRF-Token` (من `GET /api/auth/csrf`).
الأدوار: `admin` > `manager` > `staff`. كل مسار يذكر الحد الأدنى للدور. العيادة تُؤخذ من جلسة الموظف؛ للمسارات العامة تُؤخذ من `clinic` (slug أو `?clinic=` وللعيادة الواحدة الافتراضية).
الحقل **[ح1]** إلخ يوضح الحساب المسؤول عن التنفيذ.

## عام / صحة
- `GET /api/health` -> `{ status:'ok', time, version }` [ح1]

## المصادقة [ح1]
- `GET /api/auth/csrf` -> `{ csrfToken }`
- `POST /api/auth/login` `{ username, password }` -> `{ staff:{ id, fullName, role, permissions, services:[...], counter } }`
- `POST /api/auth/logout`
- `GET /api/auth/me` -> نفس بيانات login أو 401
- `POST /api/auth/change-password` `{ currentPassword, newPassword }`
- `POST /api/auth/setup` (مرة واحدة فقط عند عدم وجود admin) `{ clinicName, username, password }`

## المريض (عام، بدون جلسة) [ح2]
- `GET /api/public/clinic` -> `{ name_ar, name_en, logoUrl, language, services:[{ id, name_ar, name_en, prefix, waiting }] }` (id هنا = `publicKey` للخدمة وليس رقم DB؛ استخدم `key`)
- `POST /api/public/tickets` `{ serviceKey }` -> `{ ticket:{ number, serviceName, issuedAt, status, ahead, estimatedWaitMin|null }, token }` (التوكن يظهر مرة واحدة هنا فقط ويُستخدم في QR)
- `GET /api/public/tickets/:token` -> حالة التذكرة الحالية `{ number, service, status, ahead, estimatedWaitMin, counter, issuedAt }`
- `POST /api/public/tickets/:token/sms` `{ phone }` -> `{ queued:true }` (اختياري)
- `POST /api/public/tickets/recover` `{ number, phoneLast4? }` -> آلية الاسترجاع الآمنة (يُحدد المشرف التفاصيل مع حساب 2)
- QR التذكرة يحتوي الرابط `{BASE_URL}/patient/?t=<token>`
- `GET /api/public/qr/portal.svg` و`/api/public/qr/wifi.svg` لرموز العيادة

## الموظف (جلسة، دور staff فأعلى) [ح2]
- `GET /api/queue/state` -> `{ counter, currentTicket, waiting:[...], stats:{ waitingCount, avgWaitMin } }` حسب خدمات الموظف
- `POST /api/queue/call-next` `{ counterId, serviceId? }` -> `{ ticket }` أو 404 `QUEUE_EMPTY`
- `POST /api/queue/tickets/:publicId/recall`
- `POST /api/queue/tickets/:publicId/start`
- `POST /api/queue/tickets/:publicId/complete`
- `POST /api/queue/tickets/:publicId/skip`
- `POST /api/queue/tickets/:publicId/return` (صلاحية `can_skip_return`)
- `POST /api/queue/tickets/:publicId/cancel` (صلاحية `can_cancel`)
- `POST /api/queue/tickets/:publicId/transfer` `{ serviceId }` (صلاحية `can_transfer`)
- `GET /api/queue/lookup?number=A-025` و`POST /api/queue/verify` `{ token }` (مسح QR)
- أكواد الأخطاء: `FORBIDDEN_SERVICE`, `INVALID_TRANSITION`, `ALREADY_CALLED`, `QUEUE_EMPTY`, `NOT_FOUND`

## الأدمن [ح1: الكيانات | ح5: الباقي]
- CRUD `[ح1]` : `/api/admin/clinic` (GET/PUT), `/api/admin/services`, `/api/admin/counters`, `/api/admin/staff` (+ `POST /:id/reset-password`)، تعيين الخدمات والشبابيك ضمن body
- `GET /api/admin/tickets?date=&serviceId=&status=&q=&page=` و`GET /api/admin/tickets/:publicId/events` [ح2]
- `POST /api/admin/tickets/:publicId/cancel` `{ reason }` و`POST /api/admin/queue/reset-day` `{ confirm:true }` [ح2]
- `GET /api/admin/audit?...` [ح1]
- الإعلانات [ح5]: `GET/POST /api/admin/ads` (multipart `file`, الحقول من `advertisements`)، `PUT/DELETE /api/admin/ads/:id`، `GET /api/admin/ads/:id/preview`
- الشاشات [ح4]: `GET/POST /api/admin/displays`، `PUT /api/admin/displays/:id/settings`
- التقارير [ح5]: `GET /api/admin/reports/summary?from=&to=`, `/daily`, `/weekly`, `/monthly`, `/services`, `/waiting-times`, `/staff`, وكل واحد يقبل `&format=csv`
- `GET /api/admin/stats/overview` [ح5] لبطاقات لوحة التحكم

## الشاشة [ح4]
- `POST /api/display/pair` `{ code }` -> يضبط كوكي شاشة `qm.display` (HttpOnly)
- `GET /api/display/bootstrap` -> `{ clinic, settings, current:[...], next:[...], recent:[...], ads:[...] }` عند أول تحميل وعند إعادة الاتصال
- `GET /media/:file` يخدم ملفات الإعلانات من `server/uploads/` بعد التحقق من الاسم (حساب 5 يملك الرفع، حساب 4 يملك الخدمة)

## الأخطاء العامة
`400 VALIDATION`, `401 UNAUTHENTICATED`, `403 FORBIDDEN`, `404 NOT_FOUND`, `409 CONFLICT`, `429 RATE_LIMITED`, `500 INTERNAL`.
