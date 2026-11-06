# عقد المرحلة 5 (إضافات ملزمة فوق العقود الأصلية)

أرقام المايجريشن المحجوزة (لا تتعارضوا): **حساب 1: 003 إلى 005**، **حساب 2: 006**، **حساب 4: 007**، **حساب 5: 008**.

## الإعدادات (clinic_settings، مفتاح/قيمة نصية)
واجهة: `GET/PUT /api/admin/clinic/settings` **[ح1]** مع تحقق Zod وقيم افتراضية، وتُقرأ منها كل الحسابات عبر `settingsService.get(clinicId, key)`.

| المفتاح | القيم | الافتراضي | يستخدمه |
|---|---|---|---|
| `staff_flow_mode` | `simple` أو `detailed` | `simple` | ح2 (الباك إند)، ح3 (واجهة الموظف) |
| `no_show_seconds` | عدد صحيح، 0 = معطل | 120 | ح2، ح3 |
| `no_show_action` | `prompt` أو `auto_skip` | `prompt` | ح2 |
| `notify_ahead` | عدد التذاكر قبل الدور للتنبيه المبكر (0 = معطل) | 2 | ح2، ح3 |
| `brand_color` | لون hex | `#0F8F6B` | كل الواجهات |
| `brand_name_ar` / `brand_name_en` | نص | اسم العيادة | كل الواجهات |
| `voice_mode` | `clips` أو `speech` | `clips` | ح4 |
| `voice_letter_map` | JSON: `{"A":{"ar":"أَيْ","en":"A"}}` | يُملأ تلقائياً من بادئات الخدمات | ح4 |
| `display_burnin_guard` | `on` أو `off` | `on` | ح4 |
| `adverts_proof_of_play` | `on` أو `off` | `on` | ح4، ح5 |

`GET /api/public/clinic` (ح2) يُرجع كتلة `branding: { name_ar, name_en, logoUrl, color }` و`notify: { ahead }` و`flow: { mode }`.

## الباك إند للطابور [ح2]
- `POST /api/queue/complete-and-next` `{ counterId, serviceId? }` ← يُنهي التذكرة الحالية ويُنادي التالية **في معاملة واحدة** (ضغطة واحدة)، ويرجع `{ completed, next|null }`. إن لم تكن هناك تذكرة حالية يتصرف كـ call-next.
- في الوضع `simple`: `call-next` يكتب حدثي `called` ثم `serving` تلقائياً (يبثّ `ticket:called` مع `announce:true` ثم `ticket:serving`). في الوضع `detailed` السلوك الحالي.
- `GET /api/queue/verify-detail?number=A-025` و`POST /api/queue/verify-detail { token }` ← يرجع:
  `{ verdict, ticket, events:[...], ahead, waitedMin, estimatedWaitMin, actions:[...] }`
  حيث `verdict` ∈ `valid_waiting | called_here | in_service | completed | cancelled | skipped | other_service | previous_day | not_found`. الفاشلة (`not_found`، `previous_day`، توكن مشوّه) تُسجَّل في `audit_logs` بالإجراء `verify.fail` وعنوان IP.
  `actions` قائمة الأفعال المسموحة للموظف الحالي على هذه التذكرة (call_now, start, complete, skip, return, cancel, transfer, mark_present).
- `POST /api/queue/tickets/:publicId/mark-present` ← يكتب حدث `present` (لا يغيّر الحالة).
- حدث Socket جديد `ticket:approaching` إلى غرفة التذكرة: `{ ticketNumber, ahead }` مرة واحدة لكل تذكرة عند بلوغ `ahead === notify_ahead`، ويُضاف إلى `docs/socket-events.md`.
- حدث `ticket:noshow_prompt` للموظفين عند انتهاء `no_show_seconds` إن `no_show_action=prompt`؛ أو تخطي تلقائي مع `ticket:skipped` (`reason:'no_show'`).
- كل اتصال socket جديد يستلم لقطة `queue:updated` فوراً (إلزامي، بند عالق من المرحلة 4).

## الشاشة [ح4]
- `POST /api/display/impressions` (كوكي الشاشة) `{ items:[{ adId, shownAt, durationMs }] }` دفعات ≤ 100، وجدول `ad_impressions` (مايجريشن 007: id, clinic_id, display_id, ad_id, shown_at, duration_ms).
- الصوت المسجل: `GET /media/audio/manifest.json` ← قائمة المقاطع المتاحة، والملفات تحت `/media/audio/<lang>/<name>.mp3`. تسمية الملفات في `docs/display-audio-clips.md` (يحدّثها ح4).

## الأدمن [ح5]
- `GET /api/admin/ads/stats?from=&to=&adId=` ← عدد مرات العرض ومجموع زمن العرض لكل إعلان/شاشة/يوم، مع CSV.
- `GET /api/admin/verify-failures?from=&to=` ← من `audit_logs`.
- شاشات إعدادات: وضع الموظف، المهلة، التنبيه المبكر، العلامة التجارية، خريطة نطق الحروف، الترخيص.

## الترخيص والعيادات [ح1]
- ملف `license.json` موقّع (Ed25519) يحوي: `licenseId, clinicName, maxCounters, maxDisplays, features[], issuedAt, expiresAt, signature`. المفتاح **العام** مضمّن في الكود، والمفتاح **الخاص** لا يدخل الريبو أبداً (يُحفظ عند المالك فقط).
- `GET /api/admin/license` (الحالة) و`POST /api/admin/license` (رفع ملف).
- بلا ترخيص أو منتهٍ: **وضع تجريبي** (شباكان وشاشة واحدة وعلامة "نسخة تجريبية" صغيرة)، **ولا يتوقف الطابور أبداً**.
- `POST /api/auth/login` و`GET /api/auth/me` يرجعان `counters:[{id,number,nameAr,nameEn}]` المتاحة للمستخدم (للأدمن والمدير: كل الشبابيك الفعّالة)، بدل رسالة "لا يوجد شباك".
