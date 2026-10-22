"""Review-only static production server; exact checked-in CSP, localhost only."""
import http.server
import mimetypes
from pathlib import Path
import re
import signal
import subprocess
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
DIST = ROOT / 'apps/web/dist'
CSP = re.search(r'Content-Security-Policy "([^"]+)"', (ROOT / 'deploy/security.caddy').read_text())[1]


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path.startswith('/trpc/'):
            request = urllib.request.Request('http://127.0.0.1:3001' + self.path,
                                             headers={k: v for k, v in self.headers.items() if k.lower() != 'host'})
            try:
                response = urllib.request.urlopen(request)
            except urllib.error.HTTPError as error:
                response = error
            self.send_response(response.status)
            for key, value in response.headers.items():
                if key.lower() not in ('transfer-encoding', 'connection', 'content-length'):
                    self.send_header(key, value)
            self.end_headers()
            self.wfile.write(response.read())
            return
        target = (DIST / self.path.split('?')[0].lstrip('/')).resolve()
        if not target.is_relative_to(DIST):
            self.send_error(403)
            return
        if not target.is_file():
            target = DIST / 'index.html'
        self.send_response(200)
        self.send_header('Content-Type', mimetypes.guess_type(target.name)[0] or 'application/octet-stream')
        self.send_header('Content-Security-Policy', CSP)
        self.end_headers()
        self.wfile.write(target.read_bytes())


backend = subprocess.Popen(['pnpm', '--filter', '@opensamguk/server', 'dev'], cwd=ROOT)
import time
for attempt in range(100):
    try:
        urllib.request.urlopen('http://127.0.0.1:3001/trpc/auth.me', timeout=1)
        break
    except urllib.error.HTTPError:
        break
    except OSError:
        time.sleep(0.2)
else:
    backend.terminate()
    raise RuntimeError('review backend did not become ready')
server = http.server.ThreadingHTTPServer(('127.0.0.1', 5173), Handler)

def stop(_signum, _frame):
    raise SystemExit(0)

signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
try:
    print('REVIEW CSP:', CSP, flush=True)
    server.serve_forever()
finally:
    server.server_close()
    backend.terminate()
    try:
        backend.wait(timeout=10)
    except subprocess.TimeoutExpired:
        backend.kill()
        backend.wait()
