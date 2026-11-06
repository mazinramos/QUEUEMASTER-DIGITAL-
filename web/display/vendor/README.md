# vendor/

`socket.io.min.js` — Socket.IO client 4.8.x (MIT License, © Guillermo Rauch). نسخة محلية لأن سيرفر المشروع يعمل بـ `serveClient:false`
(لا يخدم `/socket.io/socket.io.js`)، ولتعمل الشاشة بلا إنترنت. لتحديثها: `cp dev/node_modules/socket.io-client/dist/socket.io.min.js vendor/`
بعد `npm install` في `dev/` (يجب أن يبقى الإصدار الرئيسي 4.x مطابقاً لـ `socket.io` في `server/package.json`).
