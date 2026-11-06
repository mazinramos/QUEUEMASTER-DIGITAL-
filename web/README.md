# web/ — shared + patient + staff (account 3)

Vanilla HTML/CSS/JS, **no build step, no CDN**: fonts, icons, QR encoder/decoder and the socket.io client are vendored (see `shared/vendor`, `shared/fonts` licences).
Served by the backend as `/shared`, `/patient`, `/staff`.

| Path | What |
|---|---|
| `shared/` | `tokens.css`, `fonts.css` (local woff2), `components.css`, `i18n.js` (ar default / en, `dir`+`lang`), `api.js` (CSRF, errors), `socket-client.js` (reconnect, dedupe 200 eventIds, adaptive poller), `icons.js` (Lucide), `qr.js`, `ui.js` |
| `patient/` | `/patient/` — welcome, services, issue, digital ticket (QR, live status), save PNG, print/PDF, share, optional SMS, recover, live (socket + polling fallback) |
| `staff/` | `/staff/` — login/session, counter, live desk, all queue actions by permission, lookup, camera QR scan (BarcodeDetector → local jsQR → manual) |

## Tests (Node 20+, works on Windows: no bash needed)
```
cd web && npm install
npm test            # unit/DOM-less logic tests (node:test): i18n, api, socket dedupe/poller, QR, patient + staff logic
npm run test:e2e    # real-backend browser test (Playwright core + any Chromium/Edge), needs a seeded server:
```
```
cd server && npm run migrate && npm run seed      # prints staff1/staff2/manager passwords once
set QM_BASE=http://localhost:3000
set QM_CREDS=staff1:<pw>,staff2:<pw>,manager:<pw>
set CHROMIUM_PATH=C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe   # optional: Windows uses channel "msedge" by default
npm run test:e2e
```
Use a **fresh** seeded database (the test issues and operates tickets). Screenshots are written to `reports/acct-3/screens/`.
