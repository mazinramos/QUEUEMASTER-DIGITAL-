"""E2E المرحلة 3: ربط الصوت بالشاشة. يحقن speechSynthesis مزيفاً (Chromium headless بلا أصوات) للتحقق من
التسلسل والنصوص والتكرار والحظر والإعدادات الحية والأحداث القديمة. لا يثبت جودة الصوت العربي الحقيقي."""
import json, time
from playwright.sync_api import sync_playwright
from common import *

FAKE = """
(() => {
  window.__gestured = false;
  if (%s) { // محاكاة متصفح يشترط تفاعلاً: التفعيل يصبح true فقط بنقرة/مفتاح/لمس فعلي داخل الصفحة
    ['pointerdown', 'keydown', 'touchstart'].forEach((ev) => addEventListener(ev, () => { window.__gestured = true; }, true));
    Object.defineProperty(navigator, 'userActivation', { get: () => ({ hasBeenActive: window.__gestured, isActive: false }), configurable: true });
  }
  const spoken = []; let activeCount = 0; let maxActive = 0; let queue = []; let busy = false; window.__spoken = spoken; window.__speech = { denyUntilGesture: %s, speakMs: 150 };
  class U { constructor(t) { this.text = t; this.lang = ''; this.voice = null; this.rate = 1; this.pitch = 1; this.volume = 1; } }
  const voices = [ { name: 'Fake Arabic', lang: 'ar-SA', localService: true, default: false }, { name: 'Fake English', lang: 'en-US', localService: true, default: true } ];
  const ss = {
    getVoices: () => voices, addEventListener() {}, resume() {}, cancel() { queue = []; },
    speak(u) {
      if (window.__speech.denyUntilGesture && !window.__gestured) { setTimeout(() => u.onerror && u.onerror({ error: 'not-allowed' }), 0); return; }
      if (u.volume === 0) { setTimeout(() => u.onend && u.onend(), 0); return; }
      activeCount++; maxActive = Math.max(maxActive, activeCount); window.__maxActive = maxActive;
      spoken.push({ t: performance.now(), text: u.text, lang: u.lang, voice: u.voice && u.voice.name, rate: u.rate, pitch: u.pitch, volume: u.volume });
      setTimeout(() => { activeCount--; u.onend && u.onend(); }, window.__speech.speakMs);
    },
  };
  Object.defineProperty(window, 'speechSynthesis', { value: ss, configurable: true });
  window.SpeechSynthesisUtterance = U;
})();
"""

def run(deny):
    mock = Mock(3116 if deny else 3117)
    try:
        with sync_playwright() as pw:
            br = pw.chromium.launch()
            ctx = br.new_context(viewport={'width': 1920, 'height': 1080})
            d = 'true' if deny else 'false'
            ctx.add_init_script(FAKE % (d, d))
            page = ctx.new_page(); errors = []
            page.on('pageerror', lambda e: errors.append(str(e)))
            tag = 'محظور' if deny else 'مفتوح'
            # إعدادات الشاشة: both, تكرار 2 بتأخير قصير
            created = mock.post('/dev/pairing-code', {'name': 'x', 'settings': {'announce_lang': 'both', 'repeat_count': 2, 'repeat_delay_ms': 300, 'speech_rate': 0.8, 'speech_pitch': 1.1, 'volume': 0.5}})
            mock.code = created['pairingCode']
            pair(page, mock, mock.base)
            for _ in range(5): mock.post('/dev/ticket', {'service': 'A'})
            if deny:  # kiosk بعد إعادة تحميل: الوثيقة الجديدة بلا أي نقرة (المحاكاة أعلاه)
                page.reload(); page.wait_for_selector('#view-screen', state='visible')
                check('بعد إعادة التحميل لا تفاعل سابق', page.evaluate('navigator.userActivation.hasBeenActive') is False)
            time.sleep(0.5)

            if deny:
                page.wait_for_selector('#audio-gate', state='visible', timeout=5000)
                check(f'[{tag}] تظهر لوحة تفعيل الصوت (autoplay محظور)', True)
                check(f'[{tag}] اللوحة لا تغطي الطابور', page.evaluate("""() => { const g=document.getElementById('audio-gate').getBoundingClientRect(), q=document.getElementById('queue-panel').getBoundingClientRect(); return g.right <= q.left || g.left >= q.right || g.bottom <= q.top || g.top >= q.bottom; }"""))
                page.screenshot(path=f'{SHOTS}/audio-gate.png')
                check(f'[{tag}] حالة الصوت: يحتاج تفعيلاً', page.get_attribute('#sound-status', 'data-state') == 'blocked')
                mock.post('/dev/call', {'counter': 2})   # نداء أثناء الحظر
                time.sleep(0.8)
                check(f'[{tag}] لا نطق قبل التفاعل', page.evaluate('window.__spoken.length') == 0)
                page.click('#audio-gate-btn')
                page.wait_for_function('window.__spoken.length >= 4', timeout=8000)
                check(f'[{tag}] بعد النقرة يُنطق النداء المنتظر (حديث)', True)
                check(f'[{tag}] تختفي اللوحة بعد التفعيل', not page.is_visible('#audio-gate'))
                page.wait_for_function("document.getElementById('sound-status').dataset.state === 'on'", timeout=3000)
                time.sleep(1.5)

            base = page.evaluate('window.__spoken.length')
            mock.post('/dev/call', {'counter': 2})      # A-00X: ticket:called + display:announcement
            page.wait_for_function(f'window.__spoken.length >= {base + 4}', timeout=8000)
            time.sleep(1.0)
            sp = page.evaluate('window.__spoken')[base:]
            texts = [s['text'] for s in sp]
            print('spoken:', texts)
            check(f'[{tag}] called + announcement يُنطقان مرة واحدة (2 لغات x تكرار 2 = 4)', len(sp) == 4, str(len(sp)))
            check(f'[{tag}] الترتيب: عربي، إنجليزي، عربي، إنجليزي', [s['lang'][:2] for s in sp] == ['ar', 'en', 'ar', 'en'], str([s['lang'] for s in sp]))
            check(f'[{tag}] النص العربي حسب المواصفة', texts[0].startswith('الرقم A ') and texts[0].endswith('الرجاء التوجه إلى الشباك رقم اثنين.'), texts[0])
            check(f'[{tag}] النص الإنجليزي حسب المواصفة', texts[1].startswith('Ticket A ') and texts[1].endswith('please proceed to counter number two.'), texts[1])
            check(f'[{tag}] الصوت العربي للعربية والإنجليزي للإنجليزية', sp[0]['voice'] == 'Fake Arabic' and sp[1]['voice'] == 'Fake English')
            check(f'[{tag}] إعدادات الشاشة (سرعة/نبرة/صوت) مطبقة', abs(sp[0]['rate'] - 0.8) < 1e-6 and abs(sp[0]['pitch'] - 1.1) < 1e-6 and abs(sp[0]['volume'] - 0.5) < 1e-6, str(sp[0]))
            check(f'[{tag}] لا تداخل بين الجمل', page.evaluate('window.__maxActive') == 1)
            gap = (sp[2]['t'] - sp[1]['t'])
            check(f'[{tag}] تأخير التكرار ≥ 300ms', gap >= 400, f'{gap:.0f}ms (يشمل زمن النطق 150ms)')

            # إعادة النداء تعيد النطق
            n0 = page.evaluate('window.__spoken.length')
            mock.post('/dev/recall', {'counter': 2, 'number': texts[0] and None})  # لا رقم: يختار أول منتظر
            time.sleep(0.1)
            page.wait_for_function(f'window.__spoken.length >= {n0 + 4}', timeout=8000)
            check(f'[{tag}] نداء ثانٍ/إعادة نداء يعيد النطق', True)
            time.sleep(1.5)

            # تحديث الإعدادات حياً: لغة إنجليزية فقط، تكرار 1
            mock.post('/dev/emit', {'event': 'display:settings_updated', 'payload': {'displayId': page.evaluate('window.__display.S.display.id'), 'settings': {'announce_lang': 'en', 'audio_enabled': True, 'volume': 0.2, 'speech_rate': 1.2, 'speech_pitch': 1, 'repeat_count': 1, 'repeat_delay_ms': 100}}})
            time.sleep(0.4)
            n1 = page.evaluate('window.__spoken.length')
            mock.post('/dev/call', {'counter': 1}); time.sleep(1.5)
            sp2 = page.evaluate('window.__spoken')[n1:]
            check(f'[{tag}] display:settings_updated يطبّق اللغة/التكرار/الصوت حياً', len(sp2) == 1 and sp2[0]['lang'].startswith('en') and abs(sp2[0]['volume'] - 0.2) < 1e-6 and abs(sp2[0]['rate'] - 1.2) < 1e-6, str(sp2))

            # حدث قديم (ts قبل ساعة) لا يُنطق لكنه يحدّث الشاشة
            n2 = page.evaluate('window.__spoken.length')
            old = {'event': 'ticket:called', 'raw': True, 'payload': {'eventId': 'old-1', 'ts': '2020-01-01T00:00:00Z', 'clinicId': 1, 'ticket': {'number': 'A-777', 'service': 'x'}, 'counter': {'number': 3}, 'announce': True}}
            mock.post('/dev/emit', old); time.sleep(0.8)
            check(f'[{tag}] حدث قديم (ts قديم) لا يُنطق', page.evaluate('window.__spoken.length') == n2)
            check(f'[{tag}] لكنه يظهر على الشاشة', page.inner_text('#hero-number') == 'A-777')

            # إعادة الاتصال لا تنطق ما فات
            mock.post('/dev/drop')
            page.wait_for_function("document.getElementById('conn-status').dataset.state !== 'online'", timeout=5000)
            mock.post('/dev/call', {'counter': 2})
            page.wait_for_function("document.getElementById('conn-status').dataset.state === 'online'", timeout=15000)
            time.sleep(1.5)
            spoken_after = page.evaluate('window.__spoken.length') - n2
            check(f'[{tag}] بعد إعادة الاتصال تُستعاد الحالة بصمت (النطق المتكرر ممنوع)', spoken_after <= 1, f'spoken={spoken_after}')
            print('  (ملاحظة: نداء حدث أثناء الانقطاع قد يصل لحظة الاتصال كحدث حي فيُنطق مرة واحدة؛ المسموح ≤1)')

            # تعطيل الصوت من الإدارة
            n3 = page.evaluate('window.__spoken.length')
            mock.post('/dev/emit', {'event': 'display:settings_updated', 'payload': {'displayId': page.evaluate('window.__display.S.display.id'), 'settings': {'audio_enabled': False}}})
            time.sleep(0.3); mock.post('/dev/call', {'counter': 1}); time.sleep(1.0)
            check(f'[{tag}] تعطيل الصوت: لا نطق', page.evaluate('window.__spoken.length') == n3 and page.get_attribute('#sound-status', 'data-state') == 'off')
            page.screenshot(path=f'{SHOTS}/audio-status-off.png')
            check(f'[{tag}] لا أخطاء JS', not errors, str(errors[:3]))
            br.close()
    finally:
        mock.close()

run(deny=False)
run(deny=True)
summary()
