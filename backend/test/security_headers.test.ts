import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.ts";
import { loadConfig } from "../src/config.ts";

function request(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  return new Promise((resolve, reject) => {
    import("node:http").then(({ request }) => {
      const req = request({ hostname: "127.0.0.1", port, path, method: "GET", headers }, (res) => {
        let data = "";
        res.on("data", (c) => data += c);
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers as Record<string, string>, body: data }));
      });
      req.on("error", reject);
      req.end();
    });
  });
}

test("security headers are present on every JSON response (checklist 3.1-3.2)", async () => {
  const config = loadConfig({ NEONRELAY_DB: ":memory:", NEONRELAY_CORS_ORIGINS: "https://example.com" });
  const app = createApp(config);
  const port = await app.listen(0);
  try {
    const res = await request(port, "/v1/health");
    assert.equal(res.status, 200);
    // HSTS
    assert.match(String(res.headers["strict-transport-security"] ?? ""), /max-age=31536000/);
    // CSP
    const csp = String(res.headers["content-security-policy"] ?? "");
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /object-src 'none'/);
    // Other headers
    assert.equal(res.headers["x-content-type-options"], "nosniff");
    assert.equal(res.headers["x-frame-options"], "DENY");
    assert.match(String(res.headers["referrer-policy"] ?? ""), /strict-origin/);
    assert.match(String(res.headers["permissions-policy"] ?? ""), /camera=\(\)/);
    assert.equal(res.headers["cross-origin-opener-policy"], "same-origin");
    assert.equal(res.headers["cache-control"], "no-store");
    // No version leak
    assert.equal(res.headers["server"], "NeonRelay");
    assert.equal(res.headers["x-powered-by"], undefined);
  } finally {
    await app.close();
  }
});

test("CORS allowlist is enforced, wildcard without credentials (3.4.1)", async () => {
  const config = loadConfig({ NEONRELAY_DB: ":memory:", NEONRELAY_CORS_ORIGINS: "https://example.com,https://other.example" });
  const app = createApp(config);
  const port = await app.listen(0);
  try {
    const allowed = await request(port, "/v1/health", { Origin: "https://example.com" });
    assert.equal(allowed.headers["access-control-allow-origin"], "https://example.com");
    assert.equal(allowed.headers["vary"], "Origin");

    const denied = await request(port, "/v1/health", { Origin: "https://evil.com" });
    assert.equal(denied.headers["access-control-allow-origin"], undefined);

    // Wildcard
    const wcConfig = loadConfig({ NEONRELAY_DB: ":memory:", NEONRELAY_CORS_ORIGINS: "*" });
    const wcApp = createApp(wcConfig);
    const wcPort = await wcApp.listen(0);
    try {
      const wcRes = await request(wcPort, "/v1/health", { Origin: "https://any.example" });
      assert.equal(wcRes.headers["access-control-allow-origin"], "*");
      assert.equal(wcRes.headers["access-control-allow-credentials"], undefined);
    } finally {
      await wcApp.close();
    }

    // Preflight
    const preflight = await new Promise<{ status: number; headers: Record<string, string> }>((resolve, reject) => {
      import("node:http").then(({ request }) => {
        const req = request({ hostname: "127.0.0.1", port, path: "/v1/health", method: "OPTIONS", headers: { Origin: "https://example.com", "Access-Control-Request-Method": "POST" } }, (res) => {
          res.on("data", () => {});
          res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers as Record<string, string> }));
        });
        req.on("error", reject);
        req.end();
      });
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers["access-control-allow-origin"], "https://example.com");
  } finally {
    await app.close();
  }
});

test("well-known security.txt and robots.txt are served as text/plain", async () => {
  const config = loadConfig({ NEONRELAY_DB: ":memory:" });
  const app = createApp(config);
  const port = await app.listen(0);
  try {
    const sec = await request(port, "/.well-known/security.txt");
    assert.equal(sec.status, 200);
    assert.match(sec.headers["content-type"] ?? "", /text\/plain/);
    assert.match(sec.body, /Contact: mailto:security@/);
    assert.match(sec.body, /Canonical:/);

    const robots = await request(port, "/robots.txt");
    assert.equal(robots.status, 200);
    assert.match(robots.body, /Disallow: \/v1\/admin\//);
    assert.match(robots.headers["content-type"] ?? "", /text\/plain/);
  } finally {
    await app.close();
  }
});

test("errors do not leak stack traces and still carry security headers", async () => {
  const config = loadConfig({ NEONRELAY_DB: ":memory:" });
  const app = createApp(config);
  const port = await app.listen(0);
  try {
    const notFound = await request(port, "/no-such-route");
    assert.equal(notFound.status, 404);
    const body = JSON.parse(notFound.body);
    assert.equal(body.error.code, "not-found");
    assert.equal(notFound.headers["x-content-type-options"], "nosniff");
    assert.equal(notFound.headers["server"], "NeonRelay");
    // No stack in body
    assert.equal(body.stack, undefined);
    assert.equal(body.error.message.includes("at "), false);
  } finally {
    await app.close();
  }
});
