#!/usr/bin/env python3
"""Local-only 206 Range fixture: python3 tools/async-io/range-server.py.

Open http://127.0.0.1:8765/range-concurrency.html in a browser. This is an
independent browser transport baseline, NOT a DuckDB filesystem benchmark.
"""

from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import os
import re
import time
from urllib.parse import urlsplit

SIZE = 8 * 1024 * 1024
DELAY_SECONDS = 0.2
RANGE_RE = re.compile(r"bytes=(\d+)-(\d+)\Z")


class Handler(SimpleHTTPRequestHandler):
    def _fixture(self, head_only=False):
        match = RANGE_RE.fullmatch(self.headers.get("Range", ""))
        if not head_only and (not match or int(match[1]) > int(match[2]) or int(match[2]) >= SIZE):
            self.send_response(416)
            self.send_header("Content-Range", f"bytes */{SIZE}")
            self.send_header("Content-Length", "0")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Expose-Headers", "Content-Range")
            self.end_headers()
            return
        if head_only:
            self.send_response(200)
            self.send_header("Content-Length", str(SIZE))
            self.send_header("Accept-Ranges", "bytes")
            self.end_headers()
            return
        start, end = map(int, match.groups())
        # A deliberate, bounded latency makes the overlap measurable even on
        # localhost. The fixture is read-only and only binds to loopback.
        time.sleep(DELAY_SECONDS)
        body = bytes(i & 255 for i in range(start, end + 1))
        self.send_response(206)
        self.send_header("Content-Range", f"bytes {start}-{end}/{SIZE}")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Expose-Headers", "Content-Range")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if urlsplit(self.path).path == "/fixture.bin":
            self._fixture()
        else:
            super().do_GET()

    def do_HEAD(self):
        if urlsplit(self.path).path == "/fixture.bin":
            self._fixture(head_only=True)
        else:
            super().do_HEAD()


if __name__ == "__main__":
    port = int(os.getenv("RANGE_TEST_PORT", "8765"))
    directory = Path(__file__).resolve().parent
    server = ThreadingHTTPServer(("127.0.0.1", port), partial(Handler, directory=str(directory)))
    print(f"Range fixture: http://127.0.0.1:{port}/range-concurrency.html", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
