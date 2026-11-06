#!/usr/bin/env node
/**
 * فاحص التصميم (ملف المشرف). يمنع أنماط "شكل الذكاء الاصطناعي" المتفق على منعها في docs/DESIGN-BRIEF.md
 *   node supervisor/design-lint.js            (يطبع كل المخالفات ويرجع 1 إن وُجدت أخطاء)
 *   node supervisor/design-lint.js --summary  (ملخص فقط)
 * يفحص web/**\/*.{html,css,js} ما عدا tests/e2e/dev/node_modules و tools.
 */
const fs = require('node:fs'), path = require('node:path');
const ROOT = path.resolve(__dirname, '..', 'web');
const SKIP = /(^|[\\/])(node_modules|tests?|e2e|dev|dev-mock|tools|screens|vendor)([\\/]|$)/;
const files = [];
(function walk(d) { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); const rel = path.relative(ROOT, p);
  if (SKIP.test(rel)) continue; if (f.isDirectory()) walk(p); else if (/\.(html|css|js|svg)$/.test(f.name) && !/\.min\.js$|\.test\.js$/.test(f.name)) files.push(p); } })(ROOT);

const rules = [
  { id: 'emoji', level: 'error', msg: 'إيموجي ممنوع في الواجهات', re: /(?![\u2190-\u21FF\u2022\u00A9\u00AE\u2122\u2713\u2715])\p{Extended_Pictographic}/gu, only: /\.(html|js|css)$/ },
  { id: 'accent-border', level: 'error', msg: 'حد ملون جانبي/علوي سميك (شكل بطاقة AI)', re: /border-(?:inline-start|inline-end|left|right|top|bottom|block-start)\s*:\s*(?:[3-9]|\d{2,})(?:\.\d+)?px\s+solid\s+(?!transparent)/g },
  { id: 'boxed-chip', level: 'error', msg: 'شارة/وسم بحد ملون حول النص (chip/badge/pill/tag مع border)', re: /\.(?:badge|chip|pill|tag|status)[\w-]*\s*\{[^}]*\bborder\s*:\s*[^;}]*solid(?!\s*transparent)[^;}]*;/g },
  { id: 'tinted-box', level: 'error', msg: 'صندوق بخلفية ملونة وحد ملون (شكل تنبيه/شارة AI). استخدم تعبئة مصمتة أو نصاً بلا إطار', re: /(?!)/g },
  { id: 'gradient', level: 'warn', msg: 'تدرج لوني (مسموح فقط في حالات مبررة موثقة)', re: /(?:linear|radial|conic)-gradient\(/g },
  { id: 'shadow-stack', level: 'warn', msg: 'ظل متعدد الطبقات (أكثر من طبقتين)', re: /box-shadow\s*:\s*[^;{}]*\)\s*,[^;{}]*\)\s*,[^;{}]*\)/g },
  { id: 'blur', level: 'warn', msg: 'تأثير زجاجي/blur (backdrop-filter)', re: /backdrop-filter\s*:/g },
];
const hits = {};
for (const f of files) {
  const txt = fs.readFileSync(f, 'utf8'), rel = path.relative(path.resolve(__dirname, '..'), f);
  for (const r of rules) {
    if (r.only && !r.only.test(f)) continue;
    const m = txt.match(r.re); if (!m) continue;
    (hits[r.id] ||= { rule: r, list: [] }).list.push({ file: rel, count: m.length, sample: [...new Set(m)].slice(0, 3).join(' ') });
  }
}

// قاعدة الصناديق الملونة: كتلة CSS فيها خلفية ملونة (غير شفافة/بيضاء) + حد ملون غير محايد = شكل "تنبيه AI"
const NEUTRAL = /(transparent|none|rgba?\(\s*255\s*,\s*255\s*,\s*255|var\(--[\w-]*(?:border|line|divider|hairline|gray|grey|neutral|stroke)[\w-]*\)|currentcolor|inherit)/i;
const PLAIN_BG = /background(?:-color)?\s*:\s*(?:transparent|none|#fff(?:fff)?\b|white|var\(--[\w-]*(?:surface|bg|white|paper|canvas)[\w-]*\)|rgba?\(\s*255)/i;
for (const f of files.filter(x => x.endsWith('.css'))) {
  const txt = fs.readFileSync(f, 'utf8'), rel = path.relative(path.resolve(__dirname, '..'), f);
  for (const m of txt.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const body = m[2];
    const bg = body.match(/background(?:-color)?\s*:\s*[^;]+/i); if (!bg || PLAIN_BG.test(bg[0])) continue;
    const bd = [...body.matchAll(/border(?:-(?:inline|block)(?:-(?:start|end))?|-left|-right|-top|-bottom)?(?:-color)?\s*:\s*[^;]+/gi)].map(x => x[0]).filter(x => !/(radius|collapse|spacing|image|style|width)/i.test(x.split(':')[0]));
    const colored = bd.filter(x => { const v = x.split(':').slice(1).join(':'); return !/(^|\s)0(\s|$|;)/.test(v) && !NEUTRAL.test(v); });
    if (!colored.length) continue;
    (hits['tinted-box'] ||= { rule: rules.find(r => r.id === 'tinted-box'), list: [] }).list.push({ file: rel, count: 1, sample: m[1].trim().slice(0, 40) + ' { ' + bg[0].slice(0, 28) + ' ; ' + colored[0].slice(0, 36) });
  }
}

const summary = process.argv.includes('--summary');
let errors = 0;
for (const r of rules) {
  const h = hits[r.id]; const total = h ? h.list.reduce((a, b) => a + b.count, 0) : 0;
  if (r.level === 'error') errors += total;
  console.log(`${total ? (r.level === 'error' ? 'FAIL' : 'WARN') : ' OK '}  ${r.id}: ${total}  (${r.msg})`);
  if (!summary && h) h.list.slice(0, 25).forEach(x => console.log(`        ${x.file} x${x.count}  ${x.sample.slice(0, 70)}`));
}
console.log(errors ? `\nمخالفات إلزامية: ${errors}` : '\nلا مخالفات إلزامية');
process.exit(errors ? 1 : 0);
