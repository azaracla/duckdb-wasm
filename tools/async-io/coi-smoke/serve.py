#!/usr/bin/env python3
"""Local-only COI test server; never serves a public repository or AIS data."""
import argparse
import functools
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


class Handler(SimpleHTTPRequestHandler):
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map, '.wasm': 'application/wasm', '.js': 'text/javascript', '.mjs': 'text/javascript'}

    def end_headers(self):
        self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
        self.send_header('Cross-Origin-Embedder-Policy', 'require-corp')
        self.send_header('Cross-Origin-Resource-Policy', 'same-origin')
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('directory', type=Path)
    parser.add_argument('--port', type=int, default=8766)
    args = parser.parse_args()
    directory = args.directory.resolve(strict=True)
    factory = functools.partial(Handler, directory=str(directory))
    with ThreadingHTTPServer(('127.0.0.1', args.port), factory) as server:
        print(f'Smoke server: http://127.0.0.1:{args.port}/smoke.html', flush=True)
        server.serve_forever()
