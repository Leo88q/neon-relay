/**
 * Tranche-B alert sink tests: generic webhook + Telegram payload shapes,
 * soft failures and the operator test route.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { getJson, postJson, startTestApp } from "./helpers.ts";
import { loadConfig } from "../src/config.ts";
import { alertSinks, formatDigest, sendAlertText } from "../src/alerts.ts";

interface SinkStub {
  url: string;
  requests: { path: string; body: unknown }[];
  telegramOk: { value: boolean };
  webhookStatus: { value: number };
  close: () => Promise<void>;
}

function startSinkStub(): Promise<SinkStub> {
  const requests: { path: string; body: unknown }[] = [];
  const telegramOk = { value: true };
  const webhookStatus = { value: 200 };
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      requests.push({ path: req.url ?? "/", body: JSON.parse(body) });
      if (req.url === "/hook") {
        res.writeHead(webhookStatus.value, { "content-type": "application/json" });
        res.end(JSON.stringify({ received: webhookStatus.value === 200 }));
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(telegramOk.value ? { ok: true } : { ok: false, description: "blocked" }));
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        requests,
        telegramOk,
        webhookStatus,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

test("sinks stay silent without configuration", async () => {
  const config = loadConfig({});
  assert.deepEqual(alertSinks(config), []);
  const result = await sendAlertText(config, "hello");
  assert.equal(result.sent, false);
  assert.deepEqual(result.errors, ["alerts-not-configured"]);
  assert.equal(formatDigest("title", []), "title");
  assert.equal(formatDigest("title", ["a", "b"]), "title\n• a\n• b");
});

test("webhook and telegram payloads match their contracts", async () => {
  const stub = await startSinkStub();
  try {
    const config = loadConfig({
      NEONRELAY_ALERT_WEBHOOK_URL: `${stub.url}/hook`,
      NEONRELAY_TELEGRAM_BOT_TOKEN: "tok123",
      NEONRELAY_TELEGRAM_CHAT_ID: "-42",
    });
    assert.deepEqual(alertSinks(config), ["webhook", "telegram"]);
    const result = await sendAlertText(config, "deploy finished", { telegramBase: stub.url });
    assert.equal(result.sent, true);
    assert.deepEqual(result.sinks, ["webhook", "telegram"]);
    assert.deepEqual(result.errors, []);
    const hook = stub.requests.find((r) => r.path === "/hook");
    assert.deepEqual(
      { ...(hook?.body as Record<string, unknown>), ts: 0 },
      { service: "neonrelay-backend", text: "deploy finished", ts: 0 });
    const tg = stub.requests.find((r) => r.path === "/bottok123/sendMessage");
    assert.ok(tg, "telegram path carries the bot token");
    assert.deepEqual(tg?.body, {
      chat_id: "-42", text: "deploy finished", disable_web_page_preview: true,
    });
  } finally {
    await stub.close();
  }
});

test("sink failures are reported, never thrown", async () => {
  const stub = await startSinkStub();
  try {
    stub.telegramOk.value = false;
    stub.webhookStatus.value = 500;
    const config = loadConfig({
      NEONRELAY_ALERT_WEBHOOK_URL: `${stub.url}/hook`,
      NEONRELAY_TELEGRAM_BOT_TOKEN: "tok",
      NEONRELAY_TELEGRAM_CHAT_ID: "1",
    });
    const result = await sendAlertText(config, "x", { telegramBase: stub.url });
    assert.equal(result.sent, false);
    assert.equal(result.errors.length, 2);
    const dead = await sendAlertText(
      loadConfig({ NEONRELAY_ALERT_WEBHOOK_URL: "http://127.0.0.1:1/unreachable" }), "x");
    assert.equal(dead.sent, false);
    assert.match(dead.errors[0] as string, /webhook: /);
  } finally {
    await stub.close();
  }
});

test("alerts/test route is superadmin-only and needs a sink", async () => {
  const { app, base } = await startTestApp({ operatorToken: "op", superadminToken: "sup" });
  try {
    const denied = await postJson(base, "/v1/admin/alerts/test", {}, "op");
    assert.equal(denied.status, 403);
    const unconfigured = await postJson(base, "/v1/admin/alerts/test", {}, "sup");
    assert.equal(unconfigured.status, 503);
    assert.equal(unconfigured.json.error.code, "alerts-not-configured");
    void getJson;
  } finally {
    await app.close();
  }
  const stub = await startSinkStub();
  const app2 = await startTestApp({
    operatorToken: "op", superadminToken: "sup",
    alertWebhookUrl: `${stub.url}/hook`,
  });
  try {
    const sent = await postJson(app2.base, "/v1/admin/alerts/test", { text: "ping" }, "sup");
    assert.equal(sent.status, 200);
    assert.equal(sent.json.sent, true);
    assert.match((stub.requests[0]?.body as { text: string }).text, /ping/);
  } finally {
    await app2.app.close();
    await stub.close();
  }
});
