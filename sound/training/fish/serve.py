"""Local comparison page. Exposes only this report and named sample WAV files."""
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
import json
from pathlib import Path
import re
from paths import ROOT, LAB, ENGINE_ROOT
class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path in ('/','/index.html'):
            path=ROOT/'试听对比.html';kind='text/html; charset=utf-8'
        elif re.fullmatch(r'/samples/(baseline|step50|step100|step200|expression-natural|expression-warm|expression-lively)/(greeting|rest|water|adventure|long)\.wav',self.path):
            path=ROOT/self.path.lstrip('/');kind='audio/wav'
        else:self.send_error(404);return
        data=path.read_bytes();self.send_response(200);self.send_header('Content-Type',kind);self.send_header('Content-Length',str(len(data)));self.send_header('Cache-Control','no-store');self.end_headers();self.wfile.write(data)
    def log_message(self,*a):pass
if __name__=='__main__':
    port=int(__import__('sys').argv[1]) if len(__import__('sys').argv)>1 else 0
    server=ThreadingHTTPServer(('127.0.0.1',port),Handler)
    (ROOT/'report-server.json').write_text(json.dumps(dict(port=server.server_port,pid=__import__('os').getpid())),'utf8')
    server.serve_forever()
