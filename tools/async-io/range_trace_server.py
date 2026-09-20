#!/usr/bin/env python3
"""Local HTTP Range fixture and concurrency trace for real DuckDB browser SQL.

This server is an *instrument*, not proof of DuckDB async I/O by itself. Serve a
real Parquet fixture via --file, run ONE SQL query against /fixture.parquet, and
inspect GET /__trace. Do not count synthetic requests as DuckDB-originated.
"""
import argparse
import json
import re
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

RANGE = re.compile(r"^bytes=(\d*)-(\d*)$")


class TraceState:
    def __init__(self, data: bytes, delay_ms: int = 0):
        self.data = data
        self.delay_ms = delay_ms
        self.lock = threading.Lock()
        self.events = []
        self.inflight = 0
        self.max_inflight = 0
        self.next_id = 0

    def begin(self, method, path, range_header):
        with self.lock:
            self.next_id += 1
            event = dict(id=self.next_id, method=method, path=path,
                         range=range_header, start_ns=time.monotonic_ns(),
                         end_ns=None, status=None, bytes=0)
            self.events.append(event)
            self.inflight += 1
            self.max_inflight = max(self.max_inflight, self.inflight)
            return event

    def finish(self, event, status, byte_count):
        with self.lock:
            event.update(end_ns=time.monotonic_ns(), status=status, bytes=byte_count)
            self.inflight -= 1

    def snapshot(self):
        with self.lock:
            events = [dict(event) for event in self.events]
            # Derive the overlap only from completed GETs with actual Range headers.
            ranges = [event for event in events if event['method'] == 'GET' and
                      event['range'] and event['end_ns'] is not None]
            boundaries = sorted([(event['start_ns'], 1) for event in ranges] +
                                [(event['end_ns'], -1) for event in ranges])
            active = peak = 0
            for _, delta in boundaries:
                active += delta
                peak = max(peak, active)
            return dict(events=events, max_inflight=self.max_inflight,
                        max_overlapping_ranges=peak, completed_range_gets=len(ranges))

    def reset(self):
        with self.lock:
            if self.inflight:
                return False
            self.events = []
            self.max_inflight = 0
            self.next_id = 0
            return True


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def send_common(self, status, length, extra=()):
        self.send_response(status)
        self.send_header('Content-Length', str(length))
        self.send_header('Accept-Ranges', 'bytes')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Range, Content-Type')
        self.send_header('Access-Control-Expose-Headers', 'Accept-Ranges, Content-Length, Content-Range')
        self.send_header('Cross-Origin-Resource-Policy', 'cross-origin')
        self.send_header('Cache-Control', 'no-store')
        for key, value in extra:
            self.send_header(key, value)
        self.end_headers()

    def do_OPTIONS(self):
        self.send_common(204, 0)

    def do_GET(self):
        self.serve(head=False)

    def do_HEAD(self):
        self.serve(head=True)

    def serve(self, head):
        path = urlsplit(self.path).path
        state = self.server.trace_state
        if path == '/__trace':
            body = json.dumps(state.snapshot(), separators=(',', ':')).encode()
            self.send_common(200, len(body), [('Content-Type', 'application/json')])
            if not head:
                self.wfile.write(body)
            return
        if path == '/__reset':
            status = 200 if state.reset() else 409
            self.send_common(status, 0)
            return
        if path != '/fixture.parquet':
            self.send_common(404, 0)
            return
        raw_range = self.headers.get('Range')
        event = state.begin('HEAD' if head else 'GET', path, raw_range)
        status = 500
        byte_count = 0
        try:
            data = state.data
            size = len(data)
            first, last = 0, size - 1
            if raw_range:
                match = RANGE.fullmatch(raw_range.strip())
                if not match or not size or (not match[1] and not match[2]):
                    self.send_common(416, 0, [('Content-Range', f'bytes */{size}')])
                    status = 416
                    return
                if match[1]:
                    first = int(match[1])
                    last = int(match[2]) if match[2] else size - 1
                else:
                    suffix = int(match[2])
                    first = max(0, size - suffix)
                if first >= size or last < first or (not match[1] and not int(match[2])):
                    self.send_common(416, 0, [('Content-Range', f'bytes */{size}')])
                    status = 416
                    return
                last = min(last, size - 1)
                status = 206
                extra = [('Content-Range', f'bytes {first}-{last}/{size}')]
            else:
                status, extra = 200, []
            body = data[first:last + 1]
            if state.delay_ms and not head:
                time.sleep(state.delay_ms / 1000)
            self.send_common(status, len(body), extra + [('Content-Type', 'application/octet-stream')])
            if not head:
                self.wfile.write(body)
                byte_count = len(body)
        finally:
            state.finish(event, status, byte_count)
            print(json.dumps(event, separators=(',', ':')), flush=True)


def make_server(data: bytes, port=0, delay_ms=0):
    server = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    server.daemon_threads = True
    server.trace_state = TraceState(data, delay_ms)
    return server


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--file', type=Path, required=True, help='local Parquet fixture only')
    parser.add_argument('--port', type=int, default=8767)
    parser.add_argument('--delay-ms', type=int, default=0, help='deterministic per-request delay for overlap tests')
    args = parser.parse_args()
    if args.delay_ms < 0:
        parser.error('--delay-ms must be nonnegative')
    data = args.file.read_bytes()
    if not data:
        parser.error('--file must not be empty')
    with make_server(data, args.port, args.delay_ms) as server:
        print(f'Range fixture: http://127.0.0.1:{server.server_port}/fixture.parquet', flush=True)
        server.serve_forever()


if __name__ == '__main__':
    main()
