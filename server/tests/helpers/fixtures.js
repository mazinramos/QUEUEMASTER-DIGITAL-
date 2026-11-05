'use strict';
// ملفات وسائط صغيرة صحيحة الـ magic bytes للاختبار
const png = () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const jpg = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 2)]);
const webp = () => Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x24, 0, 0, 0]), Buffer.from('WEBP'), Buffer.alloc(32, 3)]);
const mp4 = (brand = 'isom') => Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftyp'), Buffer.from(brand), Buffer.alloc(32, 4)]);
const exe = () => Buffer.concat([Buffer.from('MZ'), Buffer.alloc(64, 5)]);
const svg = () => Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>');
const html = () => Buffer.from('<html><script>alert(1)</script></html>');
const php = () => Buffer.from('<?php system($_GET["c"]); ?>');
module.exports = { png, jpg, webp, mp4, exe, svg, html, php };
