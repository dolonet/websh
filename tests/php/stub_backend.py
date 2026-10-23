#!/usr/bin/env python3
"""Echo backend for the PHP-proxy behavioral smoke.

Answers every request with a JSON description of what it received —
method, path, query, body, and the headers the proxy is contractually
required to set (X-Forwarded-For, Content-Type). /api/ping returns the
shape ensure_backend() expects so api.php never tries to auto-start a
real server.py. session_id=gone answers 404, so the smoke can check
that the proxy forwards backend status codes. Listens on the Unix
socket given as argv[1], as server.py does under the PHP proxy.
"""
import json
import socket
import socketserver
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer


class UnixHTTPServer(HTTPServer):
    address_family = socket.AF_UNIX

    def server_bind(self):
        # HTTPServer.server_bind would getfqdn() a (host, port) pair.
        socketserver.TCPServer.server_bind(self)
        self.server_name, self.server_port = "localhost", 0


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
    srv = UnixHTTPServer(sys.argv[1], Echo)
    print("ready", flush=True)
    srv.serve_forever()
