#!/usr/bin/env node
'use strict';
/**
 * أداة البديل المسجّل للعربية:
 *   node tools/audio-clips.js list                 قائمة كل الملفات والنص المطلوب تسجيله (Markdown)
 *   node tools/audio-clips.js csv                  نفس القائمة CSV
 *   node tools/audio-clips.js scaffold <dir>       ينشئ <dir>/ar/ مع clips-to-record.csv و README
 *   node tools/audio-clips.js check <dir> [ext]    يتحقق أن <dir>/ar/ فيه كل الملفات (الافتراضي mp3) ويعيد 1 عند النقص
 * <dir> عادةً server/uploads/audio
 */
const fs = require('fs');
const path = require('path');
const CL = require('../../audio/clips.js');

const [cmd, dir, extArg] = process.argv.slice(2);
const list = CL.manifest();
const ext = extArg || 'mp3';

if (cmd === 'list') {
  console.log(`| # | الملف | النص المطلوب نطقه |\n|---|---|---|`);
  list.forEach((m, i) => console.log(`| ${i + 1} | \`${m.file}.${ext}\` | ${m.text} |`));
} else if (cmd === 'csv') {
  console.log('file,text'); list.forEach((m) => console.log(`${m.file}.${ext},${m.text}`));
} else if (cmd === 'scaffold' && dir) {
  const ar = path.join(dir, 'ar'); fs.mkdirSync(ar, { recursive: true });
  fs.writeFileSync(path.join(ar, 'clips-to-record.csv'), '\uFEFFfile,text\n' + list.map((m) => `${m.file}.${ext},${m.text}`).join('\n') + '\n');
  fs.writeFileSync(path.join(ar, 'README.txt'), `ضع هنا ${list.length} ملف صوت (${ext}) بالأسماء الموجودة في clips-to-record.csv. راجع docs/display-audio-fallback.md\n`);
  console.log(`تم إنشاء ${ar} (${list.length} ملف مطلوب). الخطوة التالية: سجّل الملفات ثم node tools/audio-clips.js check ${dir}`);
} else if (cmd === 'check' && dir) {
  const ar = path.join(dir, 'ar'); let missing = 0; let empty = 0;
  if (!fs.existsSync(ar)) { console.error(`المجلد غير موجود: ${ar}`); process.exit(1); }
  const have = new Set(fs.readdirSync(ar));
  for (const m of list) {
    const f = `${m.file}.${ext}`;
    if (!have.has(f)) { missing += 1; console.error(`ناقص: ${f}  (${m.text})`); continue; }
    if (fs.statSync(path.join(ar, f)).size < 200) { empty += 1; console.error(`فارغ/صغير جداً: ${f}`); }
  }
  const known = new Set(list.map((m) => `${m.file}.${ext}`));
  const extra = [...have].filter((f) => /\.(mp3|ogg|wav)$/i.test(f) && !known.has(f));
  if (extra.length) console.warn(`ملفات زائدة (تُتجاهل): ${extra.join(', ')}`);
  console.log(`${list.length - missing - empty}/${list.length} ملف جاهز`);
  process.exit(missing || empty ? 1 : 0);
} else {
  console.error('الاستخدام: node tools/audio-clips.js list|csv|scaffold <dir>|check <dir> [ext]'); process.exit(2);
}
