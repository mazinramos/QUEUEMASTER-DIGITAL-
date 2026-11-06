'use strict';
// توليد الأسرار الثلاثة لملف .env:   npm run secrets            (يطبعها فقط)
//                                    npm run secrets -- --write (يضيف الناقص إلى server/.env ولا يستبدل أي قيمة موجودة)
const fs = require('fs');
const path = require('path');
const { SPECS } = require('./secrets');

const envFile = path.join(__dirname, '..', '..', '.env');
const write = process.argv.includes('--write');
const existing = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '';
const has = (k) => new RegExp(`^${k}=\\S+`, 'm').test(existing);

const lines = [];
for (const [name, spec] of Object.entries(SPECS)) {
  if (write && has(name)) { console.log(`${name}: already set in .env (kept)`); continue; }
  lines.push(`${name}=${spec.gen()}`);
}
if (!write) {
  console.log('# انسخ هذه الأسطر إلى server/.env (لا ترفعه إلى Git، واحتفظ بنسخة آمنة من PHONE_ENC_KEY و TICKET_TOKEN_PEPPER)\n' + lines.join('\n'));
} else if (lines.length) {
  const fd = fs.openSync(envFile, 'a', 0o600);
  fs.writeSync(fd, `${existing && !existing.endsWith('\n') ? '\n' : ''}${lines.join('\n')}\n`);
  fs.closeSync(fd);
  console.log(`Added ${lines.length} secret(s) to ${envFile}`);
} else console.log('Nothing to add.');
