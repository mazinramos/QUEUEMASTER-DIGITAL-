# تقرير التكامل الآلي

التاريخ: 2026-11-05T05:40:43.705Z

| الفحص | النتيجة | ملاحظة |
|---|---|---|
| server npm test | نجح | pass 171, fail 0 |
| server npm audit (prod) | نجح | 0 vulnerabilities |
| web npm test | فشل | pass 40, fail 1 |
| GET /api/health | نجح |  |
| GET /api/public/clinic | نجح | 4 خدمات |
| إصدار 3 تذاكر بأرقام فريدة | نجح | A-001,A-002,A-003 |
| صفحة /patient/ | نجح | HTTP 200 |
| صفحة /staff/ | تحذير | HTTP 404 |
| صفحة /admin/ | تحذير | HTTP 404 |
| صفحة /display/ | نجح | HTTP 200 |
| POST /api/auth/login (staff1) | نجح |  |
| GET /api/queue/state | نجح |  |
| POST /api/queue/call-next | نجح | A-001 |
