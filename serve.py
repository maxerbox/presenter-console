#!/usr/bin/env python3
"""Static file server for the presenter console.

Serves this project's directory on http://localhost:8765 so that:
  - console.html        (presenter console, notes + slide preview)
  - web/viewer.html     (official pdf.js viewer, for the audience)
all load same-origin (required for ES modules, WASM, and postMessage).

Usage:      python serve.py
Then open:  http://localhost:8765/console.html
"""

import http.server
import os
import socketserver
import sys
from pathlib import Path

PORT = 8765
ROOT = Path(__file__).resolve().parent  # this project's directory

# ES modules & wasm need correct MIME types on Windows registry lookups
MIME = {
    ".mjs": "text/javascript",
    ".js": "text/javascript",
    ".wasm": "application/wasm",
    ".html": "text/html; charset=utf-8",
    ".css": "text/css",
    ".json": "application/json",
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
}


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        # let the viewer cache nothing during development
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def guess_type(self, path):
        ext = os.path.splitext(path)[1].lower()
        if ext in MIME:
            return MIME[ext]
        return super().guess_type(path)

    def log_message(self, fmt, *args):
        sys.stderr.write("[%s] %s\n" % (self.log_date_time_string(), fmt % args))


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


if __name__ == "__main__":
    os.chdir(ROOT)
    with Server(("", PORT), Handler) as httpd:
        host, port = httpd.server_address[:2]
        print(f"Serving {ROOT} -> http://localhost:{port}/console.html")
        print("Press Ctrl+C to stop.")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nbye")
