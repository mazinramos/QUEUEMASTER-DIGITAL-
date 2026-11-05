# DEV MOCK — يُحذف قبل التسليم / DELETE BEFORE DELIVERY
Temporary in-memory stand-in for the backend, written strictly against docs/api-contract.md and docs/socket-events.md,
used only to exercise web/patient and web/staff while accounts 1-2 are not merged. Not a production path.
Run: `cd web && npm i && npm run dev:mock` then open http://localhost:3100/patient/ and /staff/ (staff / staff123, manager / manager123).
Dev-only endpoints: POST /dev/seed {count,serviceKey}, POST /dev/drop-sockets, POST /dev/offline {on}.
