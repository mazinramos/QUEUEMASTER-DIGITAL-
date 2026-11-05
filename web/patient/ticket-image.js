/* Renders the digital ticket to a PNG (canvas, no libraries). Uses the local fonts, waits for them before drawing. */
(function () {
  var W = 1080, H = 1720;
  var C = { navy: '#0b2545', green: '#087a55', mint: '#e8f7f0', gray: '#5a6674', line: '#dce3e9', white: '#ffffff' };

  function fit(ctx, text, maxW, size, weight, family) {
    var s = size; do { ctx.font = weight + ' ' + s + 'px ' + family; if (ctx.measureText(text).width <= maxW || s <= 24) break; s -= 2; } while (true);
    return s;
  }
  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }
  async function loadFonts() {
    if (!document.fonts || !document.fonts.load) return;
    try { await Promise.all([document.fonts.load('700 48px "IBM Plex Sans Arabic"', 'أبج'), document.fonts.load('500 48px "IBM Plex Sans Arabic"', 'أبج'),
      document.fonts.load('700 48px Inter', 'A-0123'), document.fonts.load('500 48px Inter', 'A-0123')]); } catch (e) {}
  }

  /* d: { clinicName, serviceName, number, issuedText, statusText, url, labels:{service, issued, status, scan}, dir } */
  async function render(d) {
    await loadFonts();
    var cv = document.createElement('canvas'); cv.width = W; cv.height = H; var ctx = cv.getContext('2d');
    var fam = '"IBM Plex Sans Arabic", Inter, sans-serif', latin = 'Inter, "IBM Plex Sans Arabic", sans-serif';
    ctx.direction = d.dir === 'rtl' ? 'rtl' : 'ltr'; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = C.navy; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = C.white; roundRect(ctx, 56, 56, W - 112, H - 112, 44); ctx.fill();
    // header band
    ctx.save(); roundRect(ctx, 56, 56, W - 112, H - 112, 44); ctx.clip(); ctx.fillStyle = C.mint; ctx.fillRect(56, 56, W - 112, 230); ctx.restore();
    ctx.fillStyle = C.navy; var s1 = fit(ctx, d.clinicName, W - 220, 58, 700, fam); ctx.font = '700 ' + s1 + 'px ' + fam; ctx.fillText(d.clinicName, W / 2, 150);
    ctx.fillStyle = C.green; var s2 = fit(ctx, d.serviceName, W - 220, 50, 600, fam); ctx.font = '600 ' + s2 + 'px ' + fam; ctx.fillText(d.serviceName, W / 2, 230);
    // number
    ctx.fillStyle = C.gray; ctx.font = '500 36px ' + fam; ctx.fillText(d.labels.number, W / 2, 380);
    ctx.fillStyle = C.navy; ctx.direction = 'ltr'; ctx.font = '700 250px ' + latin; ctx.fillText(d.number, W / 2, 610);
    ctx.direction = d.dir === 'rtl' ? 'rtl' : 'ltr';
    // status pill
    ctx.font = '600 38px ' + fam; var label = d.labels.status + ': ' + d.statusText; var tw = ctx.measureText(label).width + 90;
    ctx.fillStyle = C.mint; roundRect(ctx, (W - tw) / 2, 660, tw, 78, 39); ctx.fill(); ctx.fillStyle = C.green; ctx.fillText(label, W / 2, 712);
    // divider
    ctx.strokeStyle = C.line; ctx.lineWidth = 4; ctx.setLineDash([16, 14]); ctx.beginPath(); ctx.moveTo(130, 800); ctx.lineTo(W - 130, 800); ctx.stroke(); ctx.setLineDash([]);
    // QR
    var QS = 620, qx = (W - QS) / 2, qy = 850; ctx.fillStyle = C.white; ctx.fillRect(qx - 6, qy - 6, QS + 12, QS + 12);
    QM.qr.draw(ctx, d.url, qx, qy, QS, { margin: 3, fg: C.navy, bg: C.white });
    ctx.strokeStyle = C.line; ctx.lineWidth = 3; ctx.strokeRect(qx - 6, qy - 6, QS + 12, QS + 12);
    // footer info
    ctx.fillStyle = C.gray; ctx.font = '500 34px ' + fam; ctx.fillText(d.labels.scan, W / 2, 1545);
    ctx.fillStyle = C.navy; ctx.font = '600 36px ' + fam; ctx.fillText(d.labels.issued + ': ' + d.issuedText, W / 2, 1620);
    return new Promise(function (res, rej) { cv.toBlob(function (b) { b ? res(b) : rej(new Error('toBlob failed')); }, 'image/png'); });
  }
  window.QM = window.QM || {}; window.QM.ticketImage = { render: render, W: W, H: H };
})();
