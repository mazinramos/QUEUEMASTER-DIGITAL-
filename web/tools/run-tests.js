// Cross-platform test runner (no bash/glob needed): finds every *.test.js under web/ and runs `node --test` on them.
const fs = require('fs'), path = require('path'), { spawnSync } = require('child_process');
function walk(d, out) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, out); else if (e.name.endsWith('.test.js')) out.push(p);
  }
  return out;
}
const files = walk(path.join(__dirname, '..'), []);
if (!files.length) { console.error('no tests found'); process.exit(1); }
const r = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(r.status === null ? 1 : r.status);
