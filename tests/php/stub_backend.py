#!/usr/bin/env python3
"""Echo backend for the PHP-proxy behavioral smoke.

Answers every request with a JSON description of what it received —
method, path, query, body, and the headers the proxy is contractually
required to set (X-Forwarded-For, Content-Type). /api/ping returns the
shape ensure_backend() expects so api.php never tries to auto-start a
real server.py. session_id=gone answers 404, so the smoke can check
that the proxy forwards backend status codes.
"""
import json
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer


class Echo(BaseHTTPRequestHandler):
    def _reply(self):
        status = 200
        if self.path.split("?")[0] == "/api/ping":
            body = json.dumps({"ok": True, "version": "stub"}).encode()
        elif "session_id=gone" in self.path:
            status = 404
            body = json.dumps({"error": "session not found"}).encode()
        else:
            n = int(self.headers.get("Content-Length") or 0)
            body = json.dumps({
                "method": self.command,
                "path": self.path.split("?")[0],
                "query": (self.path.split("?", 1) + [""])[1],
                "body": self.rfile.read(n).decode("utf-8", "replace"),
                "xff": self.headers.get("X-Forwarded-For", ""),
                "ctype": self.headers.get("Content-Type", ""),
            }).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    do_GET = do_POST = do_DELETE = lambda self: self._reply()

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    # Port 0 = kernel-assigned; print the real port for the caller.
    srv = HTTPServer(("127.0.0.1", int(sys.argv[1]) if len(sys.argv) > 1 else 0), Echo)
    print(srv.server_address[1], flush=True)
    srv.serve_forever()
