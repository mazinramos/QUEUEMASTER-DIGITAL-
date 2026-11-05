"""أدوات مشتركة لاختبارات E2E (Playwright + Chromium). تشغيل اختياري: python dev/e2e/phase1.py"""
import json, os, re, subprocess, sys, time, urllib.request

DEV = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
SHOTS = os.path.join(DEV, 'screenshots')
os.makedirs(SHOTS, exist_ok=True)

class Mock:
    def __init__(self, port=3111):
        self.port = port
        self.base = f'http://127.0.0.1:{port}'
        env = dict(os.environ, PORT=str(port))
        self.p = subprocess.Popen(['node', 'mock-server.js'], cwd=DEV, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        out = ''
        t0 = time.time()
        while time.time() - t0 < 15:
            line = self.p.stdout.readline()
            out += line
            m = re.search(r'كود الإقران:\s+([A-Z0-9]{4}-[A-Z0-9]{4})', line)
            if m:
                self.code = m.group(1); return
        raise RuntimeError('mock لم يبدأ: ' + out)
    def post(self, path, body=None):
        req = urllib.request.Request(self.base + path, data=json.dumps(body or {}).encode(), headers={'content-type': 'application/json'}, method='POST')
        try:
            with urllib.request.urlopen(req, timeout=10) as r: return json.loads(r.read() or b'{}')
        except urllib.error.HTTPError as e:
            return {'status': e.code}
    def close(self):
        self.p.terminate()
        try: self.p.wait(5)
        except Exception: self.p.kill()

CHECKS = []
def check(name, cond, detail=''):
    CHECKS.append((name, bool(cond)))
    print(('PASS ' if cond else 'FAIL ') + name + (f'  [{detail}]' if detail and not cond else ''))
    return cond

def summary():
    bad = [n for n, ok in CHECKS if not ok]
    print(f'\n{len(CHECKS) - len(bad)}/{len(CHECKS)} checks passed')
    if bad: print('FAILED:', *bad, sep='\n  - '); sys.exit(1)

def pair(page, mock, base):
    page.goto(base + '/display/')
    page.wait_for_selector('#pair-code', state='visible')
    page.fill('#pair-code', mock.code)
    page.click('#pair-submit')
    page.wait_for_selector('#view-screen', state='visible')
