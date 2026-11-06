"""تكامل حقيقي: سيرفر حساب1+حساب2+حساب4 الفعلي (مجلد دمج مؤقت) + شاشة في Chromium.
الاستخدام: python integration.py <مسار مجلد الدمج>  (يحتاج npm install في server/)"""
import http.cookiejar, json, os, re, subprocess, sys, time, urllib.request, urllib.error
from playwright.sync_api import sync_playwright
from common import *

ROOT = sys.argv[1] if len(sys.argv) > 1 else '/tmp/integ'
PORT = 3200
BASE = f'http://127.0.0.1:{PORT}'
DATA = '/tmp/integ-data'
env = dict(os.environ, NODE_ENV='development', PORT=str(PORT), DATA_DIR=DATA, DB_PATH=f'{DATA}/q.db', BASE_URL=BASE, API_RATE_MAX='100000')
subprocess.run(['rm', '-rf', DATA]); os.makedirs(DATA)
seed = subprocess.run(['node', 'src/database/seed-dev.js'], cwd=f'{ROOT}/server', env=env, capture_output=True, text=True).stdout
creds = {m.group(2): m.group(3) for m in re.finditer(r'^\s+(\w+)\s+(\w+)\s+(\S+)$', seed, re.M)}
srv = subprocess.Popen(['node', 'src/server.js'], cwd=f'{ROOT}/server', env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
for _ in range(60):
    try: urllib.request.urlopen(BASE + '/api/health', timeout=1); break
    except Exception: time.sleep(0.25)

class Api:
    def __init__(self):
        self.jar = http.cookiejar.CookieJar()
        self.op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar))
        self.csrf = None
    def req(self, method, path, body=None, csrf=True):
        h = {'content-type': 'application/json'}
        if csrf and self.csrf: h['X-CSRF-Token'] = self.csrf
        r = urllib.request.Request(BASE + path, data=json.dumps(body).encode() if body is not None else None, headers=h, method=method)
        try:
            with self.op.open(r, timeout=10) as resp: return resp.status, json.loads(resp.read() or b'{}')
        except urllib.error.HTTPError as e:
            try: return e.code, json.loads(e.read() or b'{}')
            except Exception: return e.code, {}
    def multipart(self, path, fields, fname=None, fdata=None, ctype='image/png', method='POST'):
        import uuid
        b = uuid.uuid4().hex; parts = []
        for k, v in fields.items(): parts.append(f'--{b}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode())
        if fname: parts.append(f'--{b}\r\nContent-Disposition: form-data; name="file"; filename="{fname}"\r\nContent-Type: {ctype}\r\n\r\n'.encode() + fdata + b'\r\n')
        parts.append(f'--{b}--\r\n'.encode())
        r = urllib.request.Request(BASE + path, data=b''.join(parts), headers={'content-type': f'multipart/form-data; boundary={b}', 'X-CSRF-Token': self.csrf}, method=method)
        try:
            with self.op.open(r, timeout=15) as resp: return resp.status, json.loads(resp.read() or b'{}')
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read() or b'{}')
    def login(self, user):
        _, c = self.req('GET', '/api/auth/csrf'); self.csrf = c['data']['csrfToken']
        st, r = self.req('POST', '/api/auth/login', {'username': user, 'password': creds[user]})
        if st != 200: raise RuntimeError(f'login {user}: {st} {r}')
        d = r['data']
        if d.get('csrfToken'): self.csrf = d['csrfToken']
        if d.get('mustChangePassword'):
            newpw = 'Integration-Test-1234'
            st, r = self.req('POST', '/api/auth/change-password', {'currentPassword': creds[user], 'newPassword': newpw})
            assert st == 200, r
            creds[user] = newpw
            return self.login(user)
        return d

FAKE = open(os.path.join(os.path.dirname(__file__), 'fake_speech.js'), encoding='utf8').read()

try:
    admin = Api(); admin.login('admin')
    st, r = admin.req('GET', '/api/admin/displays')
    check('GET /api/admin/displays عبر middleware حساب 1 الحقيقي', st == 200 and r['data']['displays'] == [], f'{st} {r}')
    unauth = Api()
    st, _ = unauth.req('GET', '/api/admin/displays'); check('بلا جلسة = 401', st == 401, str(st))
    staff = Api(); staff.login('staff1')
    st, _ = staff.req('GET', '/api/admin/displays'); check('موظف عادي = 403', st == 403, str(st))
    st, _ = admin.req('POST', '/api/admin/displays', {'name': 'x'}, csrf=False); check('بلا CSRF = 403 (CSRF حساب 1)', st == 403, str(st))
    st, r = admin.req('POST', '/api/admin/displays', {'name': 'شاشة الصالة', 'settings': {'announce_lang': 'both', 'repeat_count': 1, 'repeat_delay_ms': 200}})
    check('إنشاء شاشة يعيد كود الإقران', st == 201 and re.match(r'^[A-Z2-9]{4}-[A-Z2-9]{4}$', r['data']['pairingCode'] or ''), f'{st} {r}')
    code = r['data']['pairingCode']; did = r['data']['display']['id']

    with sync_playwright() as pw:
        br = pw.chromium.launch()
        ctx = br.new_context(viewport={'width': 1920, 'height': 1080}, bypass_csp=True); ctx.add_init_script(FAKE)  # Playwright يستعمل eval في الانتظار؛ CSP يُفحص في سياق منفصل أدناه
        page = ctx.new_page(); errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.on('console', lambda m: errors.append(m.text + ' @ ' + m.location.get('url', '')) if m.type == 'error' and '/api/display/' not in m.location.get('url', '') and '/media/audio/' not in m.location.get('url', '') else None)
        page.goto(BASE + '/display/'); page.wait_for_selector('#pair-code', state='visible')
        page.fill('#pair-code', code); page.click('#pair-submit')
        page.wait_for_selector('#view-screen', state='visible', timeout=8000)
        check('الإقران عبر السيرفر الحقيقي (CSP/helmet/CSRF-exempt)', True)
        page.wait_for_function("document.getElementById('conn-status').dataset.state === 'online'", timeout=10000)
        check('اتصال Socket.IO الحقيقي مصادَق بكوكي الشاشة (resolveDisplay)', True)
        check('اسم العيادة من البذرة', 'الأمل' in page.inner_text('#clinic-name'), page.inner_text('#clinic-name'))

        # المريض يصدر تذاكر
        st, r = unauth.req('GET', '/api/public/clinic'); services = r['data']['services']
        svc_b = next(s for s in services if s['prefix'] == 'B')
        nums = []
        for _ in range(4):
            st, r = unauth.req('POST', '/api/public/tickets', {'serviceKey': svc_b['key']}, csrf=False); assert st == 201, r
            nums.append(r['data']['ticket']['number'] if 'ticket' in r['data'] else r['data'].get('number'))
        print('issued:', nums)
        page.wait_for_function("document.getElementById('waiting-count').textContent.includes('4')", timeout=6000)
        check('queue:updated الحقيقي يحدّث عدّاد الانتظار', True)
        check('قائمة التالي من لقطة حساب 2 (حتى 3)', len(page.query_selector_all('#next-list li:not(.empty)')) == 3, page.inner_text('#next-list'))

        # الموظف ينادي
        st, r = staff.req('GET', '/api/queue/state'); print('state keys:', list((r.get('data') or {}).keys())[:8])
        me = staff.req('GET', '/api/auth/me')[1]['data']
        counter_id = (me.get('counter') or me.get('defaultCounter') or {}).get('id') or 1
        base = page.evaluate('window.__spoken.length')
        st, r = staff.req('POST', '/api/queue/call-next', {'counterId': counter_id, 'serviceId': None})
        check('call-next الحقيقي ينجح', st == 200, f'{st} {r}')
        called = r['data']['ticket']['number'] if st == 200 else None
        page.wait_for_function(f"document.getElementById('hero-number').textContent === '{called}'", timeout=6000)
        check('البطاقة الرئيسية تعرض التذكرة المنادى عليها فوراً', page.inner_text('#hero-number') == called)
        check('رقم الشباك صحيح', re.search(r'\d', page.inner_text('#hero-counter')) is not None, page.inner_text('#hero-counter'))
        page.screenshot(path=f'{SHOTS}/integration-called.png')
        # النطق: called + display:announcement الحقيقيان يُدمجان (لغتان × تكرار 1)
        page.wait_for_function(f'window.__spoken.length >= {base + 2}', timeout=8000); time.sleep(1.2)
        sp = page.evaluate('window.__spoken')[base:]
        print('spoken:', [s['text'] for s in sp])
        check('نداء حقيقي = نطق واحد لكل لغة (دمج called+announcement)', len(sp) == 2 and sp[0]['lang'].startswith('ar') and sp[1]['lang'].startswith('en'), str(len(sp)))
        check('النص العربي يحوي رقم التذكرة', called.split('-')[0] in sp[0]['text'])

        # إعادة النداء
        n = page.evaluate('window.__spoken.length')
        st, _ = staff.req('POST', f"/api/queue/tickets/{r['data']['ticket'].get('publicId') or r['data']['ticket'].get('public_id')}/recall")
        check('recall الحقيقي ينجح', st == 200, str(st))
        page.wait_for_function(f'window.__spoken.length >= {n + 2}', timeout=8000)
        check('إعادة النداء تُنطق من جديد', True)

        # إعدادات حية من الأدمن عبر emitToDisplays الحقيقي
        n = page.evaluate('window.__spoken.length')
        st, _ = admin.req('PUT', f'/api/admin/displays/{did}/settings', {'announce_lang': 'en', 'volume': 0.3, 'repeat_count': 1})
        check('PUT settings ينجح', st == 200, str(st))
        time.sleep(0.5)
        pid = r['data']['ticket'].get('publicId') or r['data']['ticket'].get('public_id')
        st1, _ = staff.req('POST', f'/api/queue/tickets/{pid}/start'); st2, _ = staff.req('POST', f'/api/queue/tickets/{pid}/complete')
        check('start + complete الحقيقيان ينجحان', st1 == 200 and st2 == 200, f'{st1} {st2}')
        page.wait_for_function("document.getElementById('hero-number').textContent === '—'", timeout=6000)
        check('إكمال التذكرة يفرّغ البطاقة الرئيسية (ticket:completed + queue:updated)', True)
        n = page.evaluate('window.__spoken.length')
        st, rr = staff.req('POST', '/api/queue/call-next', {'counterId': counter_id, 'serviceId': None})
        check('call-next الثاني ينجح', st == 200, f'{st} {rr}')
        page.wait_for_function(f'window.__spoken.length >= {n + 1}', timeout=8000); time.sleep(1.0)
        sp2 = page.evaluate('window.__spoken')[n:]
        check('display:settings_updated الحقيقي يغيّر اللغة والصوت حياً', len(sp2) == 1 and sp2[0]['lang'].startswith('en') and abs(sp2[0]['volume'] - 0.3) < 1e-6, str(sp2))

        # ---- الإعلانات الحقيقية (حساب 5): رفع من لوحة الأدمن -> advertisement:updated -> عرض على الشاشة ----
        import io
        from PIL import Image
        buf = io.BytesIO(); Image.new('RGB', (800, 450), (20, 120, 200)).save(buf, 'PNG')
        st, ad = admin.multipart('/api/admin/ads', {'title': 'إعلان اختبار', 'media_type': 'image', 'duration_sec': '4', 'priority': '5'}, 'promo.png', buf.getvalue())
        check('رفع إعلان صورة عبر API حساب 5 الحقيقي', st == 201, f'{st} {ad}')
        ad_id = ad['data']['ad']['id']; ad_url = ad['data']['ad']['url']
        print('ad url:', ad_url)
        page.wait_for_selector('#ad-stage img.is-in', timeout=8000)
        ok_img = page.evaluate("(() => { const i = document.querySelector('#ad-stage img.is-in'); return i && i.complete && i.naturalWidth === 800 && i.getAttribute('src'); })()")
        check('الإعلان المرفوع يظهر فوراً على الشاشة من /media (800px)', ok_img == ad_url, str(ok_img))
        page.screenshot(path=f'{SHOTS}/integration-ad-image.png')
        st, _ = admin.multipart('/api/admin/ads', {'title': 'نص', 'media_type': 'text', 'body_text': 'مرحباً بكم', 'duration_sec': '4', 'priority': '1'})
        check('إنشاء إعلان نصي', st == 201, str(st))
        st, _ = admin.req('PUT', f'/api/admin/ads/{ad_id}', {'is_active': False})
        if st != 200: st, _ = admin.multipart(f'/api/admin/ads/{ad_id}', {'is_active': 'false'}, method='PUT')
        check('تعطيل الإعلان', st == 200, str(st))
        page.wait_for_function("!document.querySelector('#ad-stage img.is-in')", timeout=8000)
        page.wait_for_selector('#ad-stage .ad-text.is-in', timeout=8000)
        check('الإعلان المعطّل يختفي والنصي يحل مكانه', 'مرحباً' in page.inner_text('#ad-stage .ad-text.is-in'))
        st, _ = admin.req('DELETE', f'/api/admin/ads/{ad_id}'); check('حذف الإعلان', st == 200, str(st))
        # ملفات الوسائط عبر السيرفر الحقيقي
        st = urllib.request.urlopen(BASE + '/display/vendor/socket.io.min.js').status; check('عميل socket.io المحلي يُخدم', st == 200)
        try: urllib.request.urlopen(BASE + '/media/..%2F..%2Fpackage.json'); ok = False
        except urllib.error.HTTPError as e: ok = e.code == 404
        check('/media يمنع traversal على السيرفر الحقيقي', ok)
        try: urllib.request.urlopen(BASE + '/media/package.json'); ok = False
        except urllib.error.HTTPError as e: ok = e.code == 404
        check('/media يمنع امتداد json', ok)

        try: urllib.request.urlopen(BASE + '/display/dev/package.json'); ok = False
        except urllib.error.HTTPError as e: ok = e.code == 404
        check('/display/dev محجوب على السيرفر الحقيقي', ok)

        # تعطيل/إعادة ضبط الكود يفصل الشاشة
        st, r2 = admin.req('POST', f'/api/admin/displays/{did}/reset-pairing', {})
        check('reset-pairing ينجح ويعيد كوداً جديداً', st == 200 and r2['data']['pairingCode'] != code, str(st))
        page.reload(); page.wait_for_selector('#pair-code', state='visible', timeout=8000)
        check('الكود القديم يبطل الكوكي: تعود صفحة الإقران', True)
        check('لا أخطاء JS في الكونسول', not errors, str(errors[:4]))

        # ---- سياق ثانٍ بلا bypass: CSP الحقيقي لحساب 1 يُطبَّق على صفحتي ----
        ctx2 = br.new_context(viewport={'width': 1920, 'height': 1080})
        ctx2.add_init_script("window.__csp = []; document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(e.violatedDirective + ' ' + e.blockedURI));")
        p2 = ctx2.new_page()
        resp_headers = {}
        p2.on('response', lambda r: resp_headers.update({r.url: r.headers}) if r.url.endswith('/display/') else None)
        p2.goto(BASE + '/display/'); p2.wait_for_selector('#pair-code', state='visible')
        p2.fill('#pair-code', r2['data']['pairingCode']); p2.click('#pair-submit')
        p2.wait_for_selector('#view-screen', state='visible', timeout=8000)
        p2.wait_for_selector('#conn-status[data-state=online]', timeout=10000)
        ast, _ = admin.req('POST', '/api/admin/displays', {'name': 'x2'})
        csp = p2.evaluate('window.__csp')
        check('CSP الحقيقي مفعّل على /display/', any('content-security-policy' in k.lower() for h in resp_headers.values() for k in h), str(list(resp_headers.values())[:1]))
        check('صفحة الشاشة تعمل كاملة تحت CSP بلا أي انتهاك (سكربتات/ستايل/وسائط/websocket)', csp == [], str(csp))
        p2.screenshot(path=f'{SHOTS}/integration-csp-context.png')
        br.close()
finally:
    srv.terminate()
    try: srv.wait(5)
    except Exception: srv.kill()
summary()
