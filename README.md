# QueueMaster Digital

نظام طوابير إلكتروني للعيادات والمراكز الطبية. المريض يستخدم هاتفه، الموظف يستخدم أي جهاز، وشاشة الانتظار تعرض الأرقام والإعلانات وتنطق النداء بالعربية والإنجليزية. يعمل محلياً بدون إنترنت.

Electronic queue management for clinics. Local-first (Node.js + Express + SQLite + Socket.IO), vanilla JS front-ends, optional Firebase sync.

## الحالة / Status
المشروع قيد البناء بنظام 5 حسابات تحت إشراف مشرف واحد. راجع `docs/workflow.md` و`tasks/`.

| الحساب | المهمة | الفرع |
|---|---|---|
| 1 | قاعدة البيانات، المصادقة، الصلاحيات، الأمان، إدارة الكيانات | `acct-1-core` |
| 2 | محرك الطوابير، QR، Socket.IO، SMS، المزامنة | `acct-2-queue` |
| 3 | واجهة المريض + واجهة الموظف | `acct-3-patient-staff` |
| 4 | شاشة الانتظار + الإعلان الصوتي | `acct-4-display` |
| 5 | لوحة الأدمن + الإعلانات + التقارير + الاختبارات + التوثيق | `acct-5-admin-qa` |

## الوثائق
- `docs/SPEC-SUMMARY.md` ملخص المتطلبات
- `docs/workflow.md` طريقة العمل والتقارير
- `docs/architecture.md` المعمارية وملكية الملفات
- `docs/database.md` مخطط قاعدة البيانات (عقد ملزم)
- `docs/api-contract.md` عقد الـ REST API (عقد ملزم)
- `docs/socket-events.md` أحداث Socket.IO (عقد ملزم)
