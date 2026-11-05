/* صفحة اختبار الصوت: تشخيص الأصوات، نداء تجريبي بنفس المُعلن الفعلي، فحص البديل المسجّل. textContent فقط. */
(function () {
  'use strict';
  const A = window.DisplayAnnouncer; const N = window.DisplayNumbers; const CL = window.DisplayClips;
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

  const speech = A.createBrowserSpeech(window);
  const clips = A.createBrowserClips(window);
  let ann = null; let lastStatus = null; const events = [];
  const settings = () => ({ announce_lang: $('lang').value, audio_enabled: true, volume: +$('volume').value, speech_rate: +$('rate').value, speech_pitch: +$('pitch').value, repeat_count: +$('repeat').value || 1, repeat_delay_ms: +$('delay').value || 0 });

  function build() {
    ann = A.create({ speech, clips, settings: settings(), letters: $('letters').value, log: (e) => { events.push(e); if (events.length > 30) events.shift(); renderDiag(); },
      onStatus: (s) => { lastStatus = s; const p = $('state'); p.textContent = s.state + (s.needsGate ? ' (يحتاج نقرة)' : ''); p.className = 'pill ' + (s.state === 'on' ? 'ok' : s.state === 'off' ? '' : 'warn'); renderVerdict(); renderDiag(); } });
  }
  function renderTexts() {
    const box = $('texts'); box.textContent = '';
    N.buildUtterances($('ticket').value, $('counter').value, $('lang').value, { letters: $('letters').value }).forEach((u) => {
      const d = el('div', 'text-out'); d.dir = u.lang === 'ar' ? 'rtl' : 'ltr'; d.textContent = u.text; box.appendChild(d);
    });
  }
  function renderVoices() {
    const vs = speech.getVoices() || [];
    $('v-count').textContent = vs.length;
    const tb = $('voices'); tb.textContent = '';
    vs.forEach((v) => { const tr = el('tr'); tr.appendChild(el('td', null, v.name)); tr.appendChild(el('td', null, v.lang)); tr.appendChild(el('td', v.localService ? 'ok' : 'warn', v.localService ? 'نعم' : 'لا (يحتاج إنترنت)')); tb.appendChild(tr); });
    const info = ann ? ann.voiceInfo() : { ar: null, en: null };
    $('v-ar').textContent = info.ar ? `${info.ar.name} (${info.ar.lang}${info.ar.localService ? '' : '، بعيد'})` : 'لا يوجد'; $('v-ar').className = info.ar ? 'ok' : 'bad';
    $('v-en').textContent = info.en ? `${info.en.name} (${info.en.lang}${info.en.localService ? '' : '، بعيد'})` : 'لا يوجد'; $('v-en').className = info.en ? 'ok' : 'bad';
    renderVerdict();
  }
  function renderVerdict() {
    const v = $('verdict'); v.textContent = '';
    if (!speech.supported) { v.appendChild(el('div', 'bad', 'هذا المتصفح لا يدعم speechSynthesis؛ سيعتمد النداء على البديل المسجّل فقط.')); return; }
    const info = ann ? ann.voiceInfo() : {};
    if (!info.total) v.appendChild(el('div', 'warn', 'لا توجد أصوات حالياً (قد تُحمَّل بعد ثوانٍ، أو النظام بلا أصوات TTS).'));
    else if (!info.ar) v.appendChild(el('div', 'bad', 'لا يوجد صوت عربي في هذا النظام: ثبّت حزمة صوت عربي (Windows: الإعدادات > الوقت واللغة > الكلام) أو فعّل البديل المسجّل.'));
    else if (!info.ar.localService) v.appendChild(el('div', 'warn', 'الصوت العربي المتاح يحتاج إنترنت؛ لن يعمل في عيادة بلا اتصال. ثبّت صوتاً محلياً.'));
    else v.appendChild(el('div', 'ok', 'يوجد صوت عربي محلي. اضغط «نطق الآن» وتأكد بأذنيك من الجودة.'));
  }
  function renderDiag() {
    const info = ann ? ann.voiceInfo() : {};
    const ua = navigator.userActivation;
    const d = {
      time: new Date().toISOString(), userAgent: navigator.userAgent, platform: navigator.platform, language: navigator.language,
      speechSynthesisSupported: speech.supported, voicesTotal: info.total, arabicVoice: info.ar ? `${info.ar.name} ${info.ar.lang} local=${!!info.ar.localService}` : null,
      englishVoice: info.en ? `${info.en.name} ${info.en.lang} local=${!!info.en.localService}` : null, clipsOk: info.clipsOk,
      userActivation: ua ? { hasBeenActive: ua.hasBeenActive, isActive: ua.isActive } : 'unsupported', status: lastStatus, recentEvents: events.slice(-8),
      arabicVoicesList: (speech.getVoices() || []).filter((v) => /^ar/i.test(v.lang)).map((v) => `${v.name} ${v.lang} local=${v.localService}`),
    };
    $('diag').textContent = JSON.stringify(d, null, 2);
  }
  function renderEnv() {
    $('env').textContent = `${navigator.userAgent} | speechSynthesis: ${speech.supported ? 'مدعوم' : 'غير مدعوم'}`;
  }

  async function checkClips() {
    const out = $('clips-out'); out.textContent = 'جاري الفحص…'; out.className = '';
    const list = CL.manifest(); const missing = [];
    await Promise.all(list.map(async (m) => { const ok = await clips.available([`/media/audio/ar/${m.file}.mp3`]); if (!ok) missing.push(m.file); }));
    if (!missing.length) { out.textContent = `كل الملفات موجودة (${list.length}/${list.length})`; out.className = 'ok'; }
    else { out.textContent = `ناقص ${missing.length} من ${list.length}: ${missing.slice(0, 12).join(', ')}${missing.length > 12 ? ' …' : ''}`; out.className = 'bad'; }
  }

  ['rate', 'pitch', 'volume'].forEach((id) => $(id).addEventListener('input', () => { $(id + '-o').textContent = $(id).value; }));
  ['ticket', 'counter', 'lang', 'letters'].forEach((id) => $(id).addEventListener('input', renderTexts));
  $('speak').addEventListener('click', () => {
    if (ann) ann.clear();
    build(); // مُعلن جديد بالإعدادات والحرف الحاليين
    ann.unlock(); // النقرة نفسها هي التفاعل الذي يشترطه المتصفح
    ann.enqueue({ ticketNumber: $('ticket').value, counterNumber: Number($('counter').value) });
  });
  $('stop').addEventListener('click', () => { if (ann) ann.clear(); });
  $('clips-check').addEventListener('click', checkClips);
  $('copy').addEventListener('click', () => { navigator.clipboard && navigator.clipboard.writeText($('diag').textContent); });
  $('n-in').addEventListener('input', () => { const n = Number($('n-in').value); $('n-ar').textContent = N.numberToWords(n, 'ar'); $('n-en').textContent = N.numberToWords(n, 'en'); });

  build(); renderEnv(); renderTexts(); renderVoices(); renderDiag();
  $('n-in').dispatchEvent(new Event('input'));
  speech.onVoicesChanged(() => { renderVoices(); renderDiag(); });
  setTimeout(() => { renderVoices(); renderDiag(); }, 1500);
}());
