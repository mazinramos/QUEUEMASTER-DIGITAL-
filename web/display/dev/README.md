# أدوات تطوير شاشة الانتظار (حساب 4)

لا تدخل في الإنتاج. تحتاج Node 20+.

```bash
cd web/display/dev && npm install
npm test                      # 60+ اختبار وحدة/تكامل (node:test): مسارات السيرفر الحقيقية على SQLite بمخطط database.md، الأرقام، المُعلن، الإعلانات، الأحداث
npm run mock                  # سيرفر محاكاة: http://localhost:3100/display/ (يطبع كود الإقران) + نقاط /dev/* لمحاكاة حساب 2
node tools/audio-clips.js ... # أداة البديل المسجّل (list|csv|scaffold|check)
```
E2E بمتصفح حقيقي (اختياري، يحتاج Python + `pip install playwright && playwright install chromium` + ffmpeg):
```bash
cd e2e && python phase1.py && python phase2.py && python phase3.py && python phase3b.py
```
اللقطات تُحفظ في `dev/screenshots/` (مستبعدة من git).
