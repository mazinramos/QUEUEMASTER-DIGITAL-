'use strict';
// SESSION_SECRET / TICKET_TOKEN_PEPPER / PHONE_ENC_KEY
//  - production : يجب أن تكون في البيئة/.env، وإلا يفشل الإقلاع برسالة واضحة.
//  - development: تُولَّد مرة واحدة وتُحفظ في DATA_DIR/.dev-secrets.json (خارج Git) فلا تبطل التذاكر بعد restart.
//  - test       : قيم مؤقتة في الذاكرة (لا كتابة ملفات).
// القيم المحسومة تُكتب في process.env لأن وحدات أخرى (طابور/SMS) تقرأها مباشرة من البيئة.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SPECS = {
  SESSION_SECRET: { aliases: [], check: (v) => v.length >= 16, hint: 'min 16 chars', gen: () => crypto.randomBytes(48).toString('hex') },
  TICKET_TOKEN_PEPPER: { aliases: ['TOKEN_PEPPER'], check: (v) => v.length >= 16, hint: 'min 16 chars', gen: () => crypto.randomBytes(48).toString('hex') },
  PHONE_ENC_KEY: { aliases: ['SMS_ENCRYPTION_KEY'], check: (v) => /^[0-9a-fA-F]{64}$/.test(v), hint: '64 hex chars (32 bytes)', gen: () => crypto.randomBytes(32).toString('hex') },
};
const GENERATE_CMD = `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`;

function fromEnv(name, spec) {
  for (const n of [name, ...spec.aliases]) {
    const v = process.env[n];
    if (v !== undefined && v !== '') return { name: n, value: v };
  }
  return null;
}

function readDevFile(file) {
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    return d && typeof d === 'object' ? d : {};
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn(`[config] ${file} unreadable/corrupt, regenerating`);
    return {};
  }
}

function resolveSecrets({ env, dataDir, memoryDb }) {
  const out = {}; const missing = []; const invalid = [];
  const devFile = path.join(dataDir, '.dev-secrets.json');
  let dev = null; let devDirty = false;

  for (const [name, spec] of Object.entries(SPECS)) {
    const e = fromEnv(name, spec);
    if (e) {
      if (!spec.check(e.value)) { invalid.push(`${e.name} (${spec.hint})`); continue; }
      out[name] = e.value; continue;
    }
    if (env === 'production') { missing.push(name); continue; }
    if (env === 'test' || memoryDb) { out[name] = spec.gen(); continue; }
    if (!dev) dev = readDevFile(devFile);
    if (typeof dev[name] !== 'string' || !spec.check(dev[name])) { dev[name] = spec.gen(); devDirty = true; }
    out[name] = dev[name];
  }

  if (invalid.length) throw new Error(`Invalid secret value(s): ${invalid.join(', ')}`);
  if (missing.length) {
    throw new Error(
      `Missing required secrets in production: ${missing.join(', ')}.\n` +
      `الأسرار التالية مطلوبة في بيئة الإنتاج ولم تُضبط: ${missing.join(', ')}\n` +
      `Set them in server/.env (never commit it). Generate each with:\n  ${GENERATE_CMD}`
    );
  }
  if (devDirty) {
    fs.mkdirSync(dataDir, { recursive: true });
    const tmp = `${devFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(dev, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, devFile);
    console.warn(`[config] dev secrets generated once -> ${devFile} (git-ignored; do NOT use in production)`);
  }
  for (const [k, v] of Object.entries(out)) process.env[k] = v;
  return out;
}

module.exports = { resolveSecrets, SPECS };
