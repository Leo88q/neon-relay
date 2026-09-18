#!/usr/bin/env python3
"""Real loopback TLS tests; temporary CA added only to disposable CI trust store."""
import collections
import http.server
import json
import os
import pathlib
import ssl
import subprocess
import sys
import tempfile
import threading
import time
import uuid


def run(*args):
    subprocess.run(args, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)


with tempfile.TemporaryDirectory(prefix="neon-https-") as tmp:
    root = pathlib.Path(tmp)
    ca_path = pathlib.Path("/usr/local/share/ca-certificates") / ("neon-test-" + uuid.uuid4().hex + ".crt")
    servers = []
    counts = collections.Counter()
    lock = threading.Lock()
    plain_url = ""
    good_url = ""

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass  # never log credentials

        def do_POST(self):
            body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
            with lock:
                counts[self.path] += 1
            try:
                if self.path in ("/redirect", "/downgrade"):
                    self.send_response(307)
                    self.send_header("Location", (good_url if self.path == "/redirect" else plain_url) + "/redirect-target")
                    self.end_headers()
                    return
                if self.path == "/slow":
                    time.sleep(1)
                self.send_response(200)
                self.end_headers()
                if self.path == "/large":
                    self.wfile.write(b"x" * 5000)  # no Content-Length: enforce streaming limit
                elif self.path == "/v2/game/redeem":
                    request = json.loads(body)
                    reply = dict(domain="game.example", player_id="registered-test-account",
                                 wallet="A" * 42 + "E", session_id="12345678-1234-1234-1234-123456789abc",
                                 wallet_binding_id="abcdef01-1234-1234-1234-123456789abc",
                                 connection_nonce=request["connection_nonce"],
                                 authentication_expires_at=int(time.time() * 1000) + 60000,
                                 explicit_link_confirmed=True, admissionEnabled=False)
                    self.wfile.write(json.dumps(reply).encode())
                else:
                    self.wfile.write(b"ok")
            except (BrokenPipeError, ConnectionResetError, ssl.SSLError):
                pass  # expected when client aborts or hits response cap

    def serve(cert=None):
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        server.daemon_threads = True
        if cert:
            ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            ctx.load_cert_chain(str(root / (cert + ".crt")), str(root / (cert + ".key")))
            server.socket = ctx.wrap_socket(server.socket, server_side=True)
        servers.append(server)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        return ("https" if cert else "http") + "://127.0.0.1:" + str(server.server_port)

    try:
        run("openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=Neon isolated test CA",
            "-keyout", str(root / "ca.key"), "-out", str(root / "ca.crt"), "-addext", "basicConstraints=critical,CA:TRUE")
        for name, san in (("good", "IP:127.0.0.1"), ("wrong", "DNS:wrong.invalid")):
            run("openssl", "req", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=" + name,
                "-keyout", str(root / (name + ".key")), "-out", str(root / (name + ".csr")))
            (root / "ext").write_text("subjectAltName=" + san + "\nextendedKeyUsage=serverAuth\n")
            run("openssl", "x509", "-req", "-in", str(root / (name + ".csr")), "-CA", str(root / "ca.crt"),
                "-CAkey", str(root / "ca.key"), "-CAcreateserial", "-days", "1", "-extfile", str(root / "ext"), "-out", str(root / (name + ".crt")))
        run("openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=untrusted",
            "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", str(root / "bad.key"), "-out", str(root / "bad.crt"))
        run("sudo", "-n", "install", "-m", "644", str(root / "ca.crt"), str(ca_path))
        run("sudo", "-n", "update-ca-certificates")
        plain_url = serve()
        good_url = serve("good")
        bad_url, wrong_url = serve("bad"), serve("wrong")
        result = subprocess.run([sys.argv[1], good_url, plain_url, bad_url, wrong_url], capture_output=True, text=True, timeout=45)
        output = result.stdout + result.stderr
        assert result.returncode == 0, output[-3500:]
        assert "PRIVATE-PAIRING-MARKER-DO-NOT-LOG" not in output, "sensitive header leaked to debug logs"
        assert "PUBLIC-CONTROL-MARKER" in output, "debug-log positive control missing"
        assert counts["/redirect-target"] == 0 and counts["/forbidden"] == 0, "redirect/downgrade reached server"
        assert counts["/ok"] == 1, "bad certificate or hostname was accepted"
        assert counts["/control"] == 1 and counts["/v2/game/redeem"] >= 1
        # Same temporary CA, but now use real backend routes instead of mock replies.
        env = dict(os.environ, NODE_EXTRA_CA_CERTS=str(root / "ca.crt"))
        subprocess.run(["node", "--experimental-strip-types", "scripts/test_native_backend_https.ts",
                        sys.argv[1], str(root / "good.crt"), str(root / "good.key")],
                       check=True, env=env, timeout=90)
        print("PASS: real native worker + local trusted/untrusted TLS, hostname, redirect, downgrade, streaming cap, timeout, log privacy and pairing adapter")
    finally:
        for server in servers:
            server.shutdown()
            server.server_close()
        if ca_path.exists():
            run("sudo", "-n", "rm", "-f", str(ca_path))
            run("sudo", "-n", "update-ca-certificates")
