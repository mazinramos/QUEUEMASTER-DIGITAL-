"""E2E: البديل المسجّل للعربية في Chromium حقيقي بلا أصوات نظام (ملفات نغمات مولّدة، لا كلام حقيقي)."""
import json, os, shutil, time, urllib.request
import media
from playwright.sync_api import sync_playwright
from common import *

SPY = """
(() => { window.__clips = []; const Orig = window.Audio;
  window.Audio = function (src) { const a = new Orig(src); const rec = { src, started: null, ended: null, error: false };
    window.__clips.push(rec); a.addEventListener('playing', () => { rec.started = performance.now(); }); a.addEventListener('ended', () => { rec.ended = performance.now(); }); a.addEventListener('error', () => { rec.error = true; }); return a; };
})();
"""

mock = Mock(3119)
try:
    up = json.load(urllib.request.urlopen(mock.base + '/dev/uploads'))['dir']
    os.makedirs(f'{up}/audio/ar', exist_ok=True)
    media.make_tone_clips(f'{up}/audio/ar')
    created = mock.post('/dev/pairing-code', {'name': 'x', 'settings': {'announce_lang': 'ar', 'repeat_count': 1}}); mock.code = created['pairingCode']
    with sync_playwright() as pw:
        br = pw.chromium.launch(args=['--autoplay-policy=no-user-gesture-required'])
        ctx = br.new_context(viewport={'width': 1920, 'height': 1080}); ctx.add_init_script(SPY)
        page = ctx.new_page(); errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        pair(page, mock, mock.base)
        check('Chromium الحقيقي: عدد أصوات النظام', page.evaluate('speechSynthesis.getVoices().length') == 0)
        mock.post('/dev/ticket', {'service': 'A'}); mock.post('/dev/ticket', {'service': 'A'})
        page.wait_for_function("document.getElementById('sound-status').dataset.state === 'on'", timeout=8000)
        check('بلا صوت عربي لكن الملفات موجودة: الحالة "الصوت يعمل" (البديل)', True)
        page.screenshot(path=f'{SHOTS}/audio-fallback-on.png')
        mock.post('/dev/call', {'counter': 2})   # A-001
        page.wait_for_function('window.__clips.length >= 5 && window.__clips.every(c => c.ended)', timeout=10000)
        clips = page.evaluate('window.__clips')
        names = [c['src'].split('/')[-1] for c in clips]
        print('clips:', names)
        check('تسلسل الملفات للنداء A-001 / شباك 2', names == ['phrase-ticket.mp3', 'letter-a.mp3', 'n-1.mp3', 'phrase-counter.mp3', 'n-2o.mp3'], str(names))
        check('كل ملف يبدأ بعد انتهاء السابق (لا تداخل)', all(clips[i + 1]['started'] >= clips[i]['ended'] - 5 for i in range(len(clips) - 1)))
        check('لا أخطاء تحميل', not any(c['error'] for c in clips))
        # ملف ناقص: لا تشغيل جزئي ولا صمت مضلل
        os.remove(f'{up}/audio/ar/n-and-20.mp3')
        time.sleep(1.5)
        page.evaluate('window.__clips.length = 0')
        mock.post('/dev/ticket', {'service': 'A', 'n': 25})
        mock.post('/dev/call', {'counter': 1, 'number': 'A-025'})  # يحتاج n-and-20 الناقص
        page.wait_for_function("document.getElementById('sound-status').dataset.state === 'no-voice'", timeout=6000)
        time.sleep(1.0)
        check('ملف ناقص (n-and-20): لا تشغيل جزئي مضلل', page.evaluate('window.__clips.length') == 0, str(page.evaluate('window.__clips.length')))
        check('...وتظهر حالة "لا يوجد صوت عربي"', page.get_attribute('#sound-status', 'data-state') == 'no-voice')
        page.screenshot(path=f'{SHOTS}/audio-no-arabic-voice.png')
        check('الطابور ظاهر ويعمل رغم غياب الصوت', page.inner_text('#hero-number') == 'A-025')
        check('لا أخطاء JS', not errors, str(errors[:3]))
        br.close()
finally:
    mock.close()
summary()
