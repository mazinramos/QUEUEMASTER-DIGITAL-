# تشغيل QueueMaster Digital على شبكة العيادة (حساب 1)

## أول تشغيل
```bash
cd server
npm install
npm run secrets -- --write     # يضيف SESSION_SECRET / TICKET_TOKEN_PEPPER / PHONE_ENC_KEY إلى server/.env (لا يستبدل الموجود)
# عدّل BASE_URL في .env إلى http://<IP الجهاز>:3000 ليظهر صحيحاً في رمز QR
NODE_ENV=production npm start
```
أول دخول: افتح `/api/auth/setup` (أو معالج الإعداد في واجهة الأدمن) لإنشاء العيادة والأدمن الأول. يعمل مرة واحدة فقط.
عيادة إضافية: `POST /api/super/clinics` بترويسة `X-Super-Token` (فعّله بضبط `SUPER_ADMIN_TOKEN` بطول 32+ حرفاً).

## الأسرار (لا تضيعها)
- `PHONE_ENC_KEY`: فقدانه = تعذر فك أرقام الهواتف المخزنة. احتفظ بنسخة خارج الجهاز.
- `TICKET_TOKEN_PEPPER`: تغييره يُبطل كل التذاكر/الروابط القائمة.
- في production يرفض السيرفر الإقلاع إن غاب أحدها. في التطوير تُحفظ تلقائياً في `data/.dev-secrets.json`.

## الكوكي (HTTP على الشبكة المحلية)
`COOKIE_SECURE=false` (الافتراضي) يعمل على `http://192.168.x.x`. فعّل `auto` أو `true` فقط عند وجود HTTPS؛ `true` على HTTP يجعل المتصفح يُسقط الجلسة.

## النسخ الاحتياطي والاستعادة
- تلقائي كل `BACKUP_INTERVAL_HOURS` (24) والاحتفاظ بآخر `BACKUP_KEEP` (7) في `data/backups/qm-YYYYMMDD-HHmm.db` (وقت UTC).
- يدوي: زر/مسار `POST /api/admin/backups`، أو `npm run backup`. تنزيل: `GET /api/admin/backups/:name` (أدمن فقط).
- **استعادة (السيرفر متوقف):**
  ```bash
  npm run restore -- --list
  npm run restore -- qm-20261105-1030.db --yes
  ```
  تُحفظ نسخة أمان `data/backups/pre-restore-*.db` قبل الاستبدال، وتُرفض أي نسخة تالفة دون تغيير شيء.
- انسخ مجلد `data/backups` دورياً إلى قرص/جهاز آخر؛ النسخ على نفس القرص لا تحمي من تلفه.

## الأعطال الشائعة
| العَرَض | السبب / الحل |
|---|---|
| موظف لا يستطيع الدخول بعد محاولات | قفل مؤقت (15 د). الأدمن: `POST /api/admin/staff/:id/unlock` |
| فشل `npm install` بسبب argon2 على Windows | اختياري: يعمل النظام بـ scrypt تلقائياً. الحسابات المنشأة بـ argon2 على جهاز آخر لن تدخل هنا إلا بإعادة تعيين كلمة المرور |
| `/api/health` يعيد 503 | قاعدة البيانات لا تُفتح (قفل ملف/قرص ممتلئ). راجع اللوج بحثاً عن `reqId` |

## اللوج
`LOG_FORMAT=json|text` و`LOG_LEVEL`. كل طلب سطر واحد برقم `X-Request-Id` (يظهر أيضاً في ترويسة الرد للتتبع). لا كلمات مرور ولا توكنات ولا هواتف ولا query string.
