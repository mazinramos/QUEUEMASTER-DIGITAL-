"""E2E المرحلة 1: الإقران، التخطيط، الأحداث الحية، إعادة الاتصال، المقاسات."""
from playwright.sync_api import sync_playwright
from common import *

mock = Mock()
try:
    with sync_playwright() as pw:
        br = pw.chromium.launch()
        ctx = br.new_context(viewport={'width': 1920, 'height': 1080})
        page = ctx.new_page()
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.on('console', lambda m: errors.append(m.text + ' @ ' + m.location.get('url', '')) if m.type == 'error' and '/api/display/' not in m.location.get('url', '') and '/media/audio/' not in m.location.get('url', '') else None)

        # ---- الإقران ----
        page.goto(mock.base + '/display/')
        page.wait_for_selector('#pair-code', state='visible')
        check('صفحة الإقران تظهر لشاشة غير مقترنة', page.is_visible('#view-pair') and not page.is_visible('#view-screen'))
        check('الاتجاه RTL افتراضياً', page.evaluate('document.documentElement.dir') == 'rtl')
        page.screenshot(path=f'{SHOTS}/pair-1920x1080.png')
        page.fill('#pair-code', 'zzzz9999')
        check('الكود يُنسّق XXXX-XXXX بأحرف كبيرة', page.input_value('#pair-code') == 'ZZZZ-9999')
        page.click('#pair-submit')
        page.wait_for_selector('#pair-error', state='visible')
        check('كود خاطئ يعرض رسالة خطأ', 'غير صحيح' in page.inner_text('#pair-error'))
        page.fill('#pair-code', mock.code)
        page.click('#pair-submit')
        page.wait_for_selector('#view-screen', state='visible')
        check('الإقران الصحيح يفتح الشاشة', page.is_visible('#queue-panel') and page.is_visible('#ads-panel'))
        cookies = {c['name']: c for c in ctx.cookies()}
        check('كوكي qm.display HttpOnly', 'qm.display' in cookies and cookies['qm.display']['httpOnly'])
        check('لا وصول JS للكوكي', 'qm.display' not in page.evaluate('document.cookie'))

        # ---- بيانات ----
        for n in range(1, 8): mock.post('/dev/ticket', {'service': 'A'})
        mock.post('/dev/ticket', {'service': 'B'})
        mock.post('/dev/call', {'counter': 1})            # A-001 @1
        mock.post('/dev/serve', {'number': 'A-001'})
        mock.post('/dev/call', {'counter': 2})            # A-002 @2
        page.wait_for_function("document.getElementById('hero-number').textContent === 'A-002'", timeout=5000)
        check('البطاقة الرئيسية تتبع آخر نداء', page.inner_text('#hero-number') == 'A-002')
        check('رقم الشباك يظهر', page.inner_text('#hero-counter') == 'الشباك 2', page.inner_text('#hero-counter'))
        check('وميض التنبيه عند نداء جديد', 'is-new' in (page.get_attribute('#hero', 'class') or ''))
        check('جاري الخدمة يعرض الشباك الآخر', page.is_visible('#at-counters') and 'A-001' in page.inner_text('#at-counters-list'))
        nxt = page.inner_text('#next-list')
        check('التالي: 3 تذاكر بالترتيب', all(x in nxt for x in ['A-003', 'A-004', 'A-005']) and 'A-006' not in nxt, nxt)
        check('عدّاد الانتظار', 'في الانتظار: 6' in page.inner_text('#waiting-count'), page.inner_text('#waiting-count'))
        check('حالة الاتصال متصل', page.get_attribute('#conn-status', 'data-state') == 'online')
        check('اسم العيادة', 'عيادة الأمل' in page.inner_text('#clinic-name'))
        check('الساعة تعمل', ':' in page.inner_text('#clock'))
        pos = page.evaluate("""() => { const q=document.getElementById('queue-panel').getBoundingClientRect(), a=document.getElementById('ads-panel').getBoundingClientRect(); return {qx:q.x,qw:q.width,ax:a.x}; }""")
        check('RTL: الطابور على اليمين (البداية) والإعلانات يساراً', pos['qx'] > pos['ax'], str(pos))

        # ---- تدفق: إكمال/إلغاء ----
        mock.post('/dev/complete', {'number': 'A-001'})
        page.wait_for_function("!document.getElementById('at-counters-list').textContent.includes('A-001')", timeout=5000)
        check('اكتمال التذكرة يزيلها من جاري الخدمة', True)
        mock.post('/dev/complete', {'number': 'A-002'})
        page.wait_for_function("document.getElementById('hero-number').textContent === '—'", timeout=5000)
        check('عند عدم وجود نداء تظهر حالة فارغة', page.inner_text('#hero-counter') == 'لا يوجد نداء حالياً')

        # ---- منع التكرار ومنع حدث عيادة أخرى ----
        base_seq = page.evaluate('window.__display.S.state.focusSeq')
        ev = {'event': 'ticket:called', 'raw': True, 'payload': {'eventId': 'dup-1', 'ts': '2099-01-01T00:00:00Z', 'clinicId': 1, 'ticket': {'number': 'A-009', 'service': 'x'}, 'counter': {'number': 1}, 'announce': True}}
        mock.post('/dev/emit', ev); mock.post('/dev/emit', ev)
        page.wait_for_function("window.__display.S.state.focusSeq > %d" % base_seq, timeout=5000)
        time.sleep(0.4)
        check('نفس eventId لا يُطبّق مرتين', page.evaluate('window.__display.S.state.focusSeq') == base_seq + 1)
        ev2 = dict(ev, payload=dict(ev['payload'], eventId='other-clinic', clinicId=999, ticket={'number': 'Z-777'}))
        mock.post('/dev/emit', ev2); time.sleep(0.4)
        check('حدث عيادة أخرى يُتجاهل', page.inner_text('#hero-number') == 'A-009')
        mock.post('/dev/complete', {'number': 'A-009'}) if False else None

        # ---- إعادة الاتصال: أحداث فائتة تُستعاد بالـ bootstrap ----
        mock.post('/dev/reset')
        for n in range(1, 4): mock.post('/dev/ticket', {'service': 'B'})
        page.wait_for_function("document.getElementById('hero-number').textContent === '—'", timeout=5000)
        mock.post('/dev/drop')
        page.wait_for_function("document.getElementById('conn-status').dataset.state !== 'online'", timeout=5000)
        check('عند الانقطاع يظهر مؤشر غير متصل', True)
        check('الطابور يبقى ظاهراً أثناء الانقطاع', page.is_visible('#queue-panel'))
        mock.post('/dev/call', {'counter': 2})  # يحدث أثناء الانقطاع أو بعده مباشرة
        page.wait_for_function("document.getElementById('conn-status').dataset.state === 'online'", timeout=15000)
        page.wait_for_function("document.getElementById('hero-number').textContent === 'B-001'", timeout=10000)
        check('إعادة اتصال تلقائية واستعادة الحالة', page.inner_text('#hero-number') == 'B-001')

        # ---- المقاسات ----
        mock.post('/dev/reset')
        for n in range(1, 9): mock.post('/dev/ticket', {'service': 'A'})
        mock.post('/dev/call', {'counter': 1}); mock.post('/dev/call', {'counter': 2}); mock.post('/dev/call', {'counter': 1})
        sizes = [('1920x1080', 1920, 1080), ('1366x768', 1366, 768), ('3840x2160', 3840, 2160), ('1080x1920-portrait', 1080, 1920), ('390x844-phone', 390, 844)]
        for name, w, h in sizes:
            page.set_viewport_size({'width': w, 'height': h}); time.sleep(0.9)
            m = page.evaluate("""() => { const r=(id)=>document.getElementById(id).getBoundingClientRect(); const q=r('queue-panel'), hn=r('hero-number'), hb=r('hero-box'), l=r('next-list'), rc=r('recent-list'), a=r('ads-panel');
              return {q:[q.x,q.y,q.width,q.height], hnW:hn.width, hbW:hb.width, hnH:hn.height, hbH:hb.height, vw:innerWidth, vh:innerHeight, sw:document.documentElement.scrollWidth, sh:document.documentElement.scrollHeight,
                      fs:parseFloat(getComputedStyle(document.getElementById('hero-number')).fontSize), qOver:document.getElementById('queue-panel').scrollHeight-document.getElementById('queue-panel').clientHeight, a:[a.x,a.y,a.width,a.height]}; }""")
            check(f'{name}: الطابور ظاهر داخل الإطار', m['q'][0] >= -1 and m['q'][1] >= -1 and m['q'][0] + m['q'][2] <= w + 1 and m['q'][2] > 0 and m['q'][3] > 0, str(m['q']))
            check(f'{name}: رقم التذكرة يتسع في صندوقه', m['hnW'] <= m['hbW'] + 1 and m['hnH'] <= m['hbH'] + 1, f"{m['hnW']:.0f}/{m['hbW']:.0f} {m['hnH']:.0f}/{m['hbH']:.0f}")
            if w > 600: check(f'{name}: لا تمرير أفقي أو عمودي للصفحة', m['sw'] <= w and m['sh'] <= h + 1, f"{m['sw']}x{m['sh']}")
            check(f'{name}: لا فيض داخل لوحة الطابور', m['qOver'] <= 2, str(m['qOver']))
            check(f'{name}: الرقم كبير (>= 10% من ارتفاع الشاشة)' if w > 600 else f'{name}: الرقم مقروء', m['fs'] >= (0.10 * h if w > 600 else 40), f"fs={m['fs']:.0f}")
            page.screenshot(path=f'{SHOTS}/display-{name}.png')
        # LTR
        page.set_viewport_size({'width': 1920, 'height': 1080})
        page.goto(mock.base + '/display/?lang=en'); page.wait_for_selector('#view-screen', state='visible'); time.sleep(0.8)
        pos = page.evaluate("""() => ({q:document.getElementById('queue-panel').getBoundingClientRect().x, a:document.getElementById('ads-panel').getBoundingClientRect().x, dir:document.documentElement.dir})""")
        check('LTR: الطابور على اليسار', pos['dir'] == 'ltr' and pos['q'] < pos['a'], str(pos))
        check('نصوص إنجليزية', page.inner_text('#hero-label') == 'Now Calling')
        page.screenshot(path=f'{SHOTS}/display-en-1920x1080.png')
        check('لا أخطاء JS في الكونسول', not errors, str(errors[:3]))
        br.close()
finally:
    mock.close()
summary()
