"""E2E المرحلة 2: مشغّل الإعلانات (صور/فيديو/نص، أولوية، مدة، انتقال، أعطال، تحديث حي، فشل التحميل)."""
import json, shutil, time
from playwright.sync_api import sync_playwright
from common import *
import media

mock = Mock(3112)
try:
    up = json.load(__import__('urllib.request').request.urlopen(mock.base + '/dev/uploads'))['dir']
    codec = media.make_all(up)
    print('video codec used for test file:', codec)
    with sync_playwright() as pw:
        br = pw.chromium.launch(args=['--autoplay-policy=no-user-gesture-required'])
        ctx = br.new_context(viewport={'width': 1920, 'height': 1080})
        page = ctx.new_page()
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.goto(mock.base + '/display/'); page.wait_for_selector('#pair-code'); page.fill('#pair-code', mock.code); page.click('#pair-submit')
        page.wait_for_selector('#view-screen', state='visible')

        # ---- بدون إعلانات: بطاقات المعلومات ----
        page.wait_for_selector('#ad-stage .info-card', timeout=4000)
        check('بدون إعلانات: بطاقة معلومات/توعية تظهر', 'عيادة الأمل' in page.inner_text('#ad-stage'))
        page.screenshot(path=f'{SHOTS}/ads-fallback-card.png')

        # سجّل كل ما يُعرض على المسرح
        page.evaluate("""() => { window.__log = []; const st = document.getElementById('ad-stage');
          new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) { if (n.nodeType !== 1) continue;
            const media = /^(IMG|VIDEO)$/.test(n.tagName) ? n : (n.querySelector && n.querySelector('video,img'));
            window.__log.push({ t: performance.now(), kind: n.querySelector && (n.matches('.info-card') || n.querySelector('.info-card')) ? 'card' : media ? media.tagName.toLowerCase() : (n.matches('.ad-text') || n.querySelector('.ad-text')) ? 'text' : '?',
              src: media ? (media.getAttribute('src') || '').split('/').pop() : null, text: (n.textContent || '').slice(0, 40) }); } }).observe(st, { childList: true }); }""")
        qrect = lambda: page.evaluate("(() => { const r = document.getElementById('queue-panel').getBoundingClientRect(); return [r.x, r.y, r.width, r.height].map(Math.round).join(','); })()")
        q0 = qrect()

        # ---- إعلانات حية عبر advertisement:updated ----
        mock.post('/dev/ad', {'title': 'منخفض', 'media_type': 'image', 'file_path': 'server/uploads/low.webp', 'duration_sec': 3, 'priority': 0})
        mock.post('/dev/ad', {'title': 'نص', 'media_type': 'text', 'body_text': 'مرحباً بكم في عيادة الأمل\nسلامتكم تهمنا', 'duration_sec': 3, 'priority': 1})
        mock.post('/dev/ad', {'title': 'فيديو', 'media_type': 'video', 'file_path': 'server/uploads/clip.mp4', 'duration_sec': 5, 'priority': 1})
        mock.post('/dev/ad', {'title': 'عالي', 'media_type': 'image', 'file_path': 'server/uploads/hi.jpg', 'duration_sec': 3, 'priority': 9})
        mock.post('/dev/ad', {'title': 'مكسور', 'media_type': 'image', 'file_path': 'server/uploads/missing.png', 'duration_sec': 3, 'priority': 2})
        mock.post('/dev/ad', {'title': 'شاشة أخرى', 'media_type': 'image', 'file_path': 'server/uploads/mid.png', 'duration_sec': 3, 'priority': 5, 'display_ids': [999]})
        mock.post('/dev/ad', {'title': 'منتهي', 'media_type': 'text', 'body_text': 'EXPIRED', 'duration_sec': 3, 'priority': 5, 'ends_at': '2020-01-01T00:00:00Z'})
        mock.post('/dev/ad', {'title': 'مستقبلي', 'media_type': 'text', 'body_text': 'FUTURE', 'duration_sec': 3, 'priority': 5, 'starts_at': '2099-01-01T00:00:00Z'})
        mock.post('/dev/ad', {'title': 'معطل', 'media_type': 'text', 'body_text': 'INACTIVE', 'duration_sec': 3, 'priority': 5, 'is_active': 0})

        page.wait_for_function("window.__log.some(e => e.src === 'hi.jpg')", timeout=15000)
        check('أول إعلان وصل يُعرض فوراً بدل البطاقات', page.evaluate("window.__log.filter(e => e.kind !== 'card').length") >= 1)
        check('المسرح يستخدم عنصر img لصورة JPG', page.evaluate("!!document.querySelector('#ad-stage img[src$=\"hi.jpg\"]')"))
        page.screenshot(path=f'{SHOTS}/ads-image.png')

        # دورة كاملة بدءاً من الأعلى أولوية: hi(9) -> مكسور(2، يُتخطى) -> نص(1) -> فيديو(1) -> low(0)
        page.wait_for_function("(() => { const l = window.__log.filter(e => e.kind !== 'card'); const i = l.findIndex(e => e.src === 'hi.jpg'); return i >= 0 && l.slice(i).length >= 4; })()", timeout=30000)
        seq_all = [e for e in page.evaluate('window.__log') if e['kind'] != 'card']
        i0 = next(i for i, e in enumerate(seq_all) if e['src'] == 'hi.jpg')
        seq = seq_all[i0:]
        names = [e['src'] or e['kind'] for e in seq]
        print('sequence from hi:', names)
        check('الترتيب بالأولوية: عالي ثم نص ثم فيديو ثم منخفض', names[:4] == ['hi.jpg', 'text', 'clip.mp4', 'low.webp'], str(names))
        check('نص وفيديو وصورة WebP كلها عُرضت', {'text', 'clip.mp4', 'low.webp'} <= set(names), str(names))
        check('الإعلان المكسور يُتخطى بلا عرض', 'missing.png' not in json.dumps(seq_all))
        check('المنتهي/المستقبلي/المعطل/شاشة أخرى لا تظهر', not any(x in json.dumps(seq_all, ensure_ascii=False) for x in ['EXPIRED', 'FUTURE', 'INACTIVE']) and 'mid.png' not in json.dumps(seq_all))
        t_hi = seq[0]['t']; t_next = seq[1]['t']
        check('مدة الصورة ≈ 3 ثوان', 2.8 <= (t_next - t_hi) / 1000 <= 4.5, f'{(t_next - t_hi) / 1000:.2f}s')

        # الفيديو
        if 'clip.mp4' in names and len(seq) > names.index('clip.mp4') + 1:
            i = names.index('clip.mp4'); t_v = seq[i]['t']; t_after = seq[i + 1]['t']
            check('مدة الفيديو ≈ 5 ثوان (الفيديو 2ث فيُعاد تشغيله loop)', 4.7 <= (t_after - t_v) / 1000 <= 6.5, f'{(t_after - t_v) / 1000:.2f}s')
        page.wait_for_selector('#ad-stage video.is-in', timeout=40000)
        vinfo = page.evaluate("(() => { const v = document.querySelector('#ad-stage video.is-in'); return v && { muted: v.muted, autoplay: v.autoplay, loop: v.loop, playsInline: v.playsInline, controls: v.controls }; })()")
        check('الفيديو muted+autoplay+loop+playsinline بلا controls', vinfo and vinfo['muted'] and vinfo['autoplay'] and vinfo['loop'] and vinfo['playsInline'] and not vinfo['controls'], str(vinfo))
        time.sleep(1.2)
        vstate = page.evaluate("(() => { const v = document.querySelector('#ad-stage video.is-in'); return v && { paused: v.paused, t: v.currentTime, ready: v.readyState, err: v.error && v.error.code, dur: v.duration, vw: v.videoWidth }; })()")
        check('الفيديو يعمل فعلياً (غير متوقف، يتقدم، له أبعاد)', vstate and not vstate['paused'] and vstate['t'] > 0 and vstate['vw'] > 0, str(vstate))
        page.screenshot(path=f'{SHOTS}/ads-video.png')

        # النص
        page.wait_for_selector('#ad-stage .ad-text', timeout=40000)
        page.screenshot(path=f'{SHOTS}/ads-text.png')
        txt = page.inner_text('#ad-stage .ad-text')
        check('النص يُعرض مع كسر الأسطر', 'مرحباً بكم' in txt and 'سلامتكم' in txt, txt)

        # الانتقال السلس: أثناء التبديل طبقتان بشفافية متدرجة
        saw_two = False
        for _ in range(120):
            n = page.evaluate("document.querySelectorAll('#ad-stage > .ad-layer').length")
            if n >= 2: saw_two = True; break
            time.sleep(0.05)
        check('انتقال سلس: طبقتان تتراكبان لحظة التبديل', saw_two)
        time.sleep(1.2)
        check('بعد الانتقال تُحذف الطبقة القديمة (لا تراكم DOM)', page.evaluate("document.querySelectorAll('#ad-stage > .ad-layer').length") <= 2)
        check('الطابور لم يتحرك/يختفِ طوال التناوب', qrect() == q0 and page.is_visible('#queue-panel'))

        # ---- XSS: النص يُعرض كنص لا HTML ----
        mock.post('/dev/ads/clear')
        mock.post('/dev/ad', {'title': '<img src=x onerror=window.__xss=1>', 'media_type': 'text', 'body_text': '<script>window.__xss=2</script><b>bold</b>', 'duration_sec': 6})
        page.wait_for_selector('#ad-stage .ad-text', timeout=5000); time.sleep(0.4)
        check('XSS: HTML داخل الإعلان لا يُنفّذ', page.evaluate('window.__xss') is None and page.evaluate("document.querySelector('#ad-stage .ad-text b')") is None)
        page.screenshot(path=f'{SHOTS}/ads-xss-as-text.png')

        # ---- حدث بإعلان خارجي/منتهي من الخادم: يتجاهله العميل ----
        mock.post('/dev/emit', {'event': 'advertisement:updated', 'payload': {'ads': [
            {'id': 77, 'title': 'ext', 'mediaType': 'image', 'url': 'https://evil.example/x.png', 'durationSec': 5, 'isActive': True},
            {'id': 78, 'title': 'old', 'mediaType': 'text', 'bodyText': 'STALE-AD', 'durationSec': 5, 'endsAt': '2020-01-01T00:00:00Z'}]}})
        page.wait_for_selector('#ad-stage .info-card', timeout=5000)
        check('إعلان بمصدر خارجي أو منتهي من الحدث لا يُعرض (يعود للبطاقات)', 'evil' not in page.content() and 'STALE-AD' not in page.inner_text('#ad-stage'))

        # ---- إعادة الاتصال تعيد قائمة الإعلانات من bootstrap ----
        mock.post('/dev/ad', {'title': 'بعد', 'media_type': 'text', 'body_text': 'AFTER-AD', 'duration_sec': 20, 'priority': 1})
        page.wait_for_function("document.querySelector('#ad-stage .ad-text') && document.querySelector('#ad-stage .ad-text').textContent.includes('AFTER-AD')", timeout=5000)
        check('إعلان جديد يظهر فور advertisement:updated', True)
        check('لا أخطاء JS', not errors, str(errors[:3]))
        br.close()
finally:
    mock.close()
summary()
