#!/usr/bin/env python3
"""Local test server for the Emscripten (web) build of Neon Relay.

Serves the current directory over HTTP and adds the cross-origin isolation
headers (COOP/COEP) that browsers require before they enable the
SharedArrayBuffer-backed threading the web client uses. Stdlib only;
the port optionally comes from argv[1] (default 8000).
"""

from __future__ import annotations

import sys
from http.server import HTTPServer, SimpleHTTPRequestHandler, test


class IsolatedHandler(SimpleHTTPRequestHandler):
    def end_headers(self) -> None:
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        super().end_headers()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    test(IsolatedHandler, HTTPServer, port=port)
