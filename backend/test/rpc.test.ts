/**
 * Dual-RPC failover tests: routing, cooldown/failback, chain-identity
 * pinning, URL redaction (stub fetch) plus a server-level run where a dead
 * primary fails over to a stub fallback for a real ticket read, visible in
 * rpc-status, metrics and the stuck digest delivered to a stub webhook.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createRpcPool, redactRpcUrl, RpcError } from "../src/rpc.ts";
import { base58Encode } from "../src/economy.ts";
import { authenticate, getJson, makeWallet, startTestApp } from "./helpers.ts";

// Public Solana chain constants (not secrets): devnet / mainnet genesis.
const DEVNET = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const MAINNET = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";

interface SeenCall { url: string; method: string }

type StubOutcome = unknown | Error
  | { __http: number }
  | { __rpcError: { code: number; message: string } }
  | { __badJson: true };

function stubFetch(handler: (url: string, method: string) => StubOutcome): {
  fetchFn: typeof fetch; seen: SeenCall[];
} {
  const seen: SeenCall[] = [];
  const fetchFn = (async (url: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(String(init?.body)) as { method: string };
    seen.push({ url: String(url), method: body.method });
    const outcome = handler(String(url), body.method);
    if (outcome instanceof Error) throw outcome;
    if (typeof outcome === "object" && outcome !== null && "__http" in outcome) {
      return { ok: false, status: (outcome as { __http: number }).__http, json: async () => ({}) };
    }
    if (typeof outcome === "object" && outcome !== null && "__badJson" in outcome) {
      return { ok: true, status: 200, json: async () => { throw new SyntaxError("bad json"); } };
    }
    if (typeof outcome === "object" && outcome !== null && "__rpcError" in outcome) {
      const error = (outcome as { __rpcError: unknown }).__rpcError;
      return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, error }) };
    }
    return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result: outcome }) };
  }) as unknown as typeof fetch;
  return { fetchFn, seen };
}

test("single provider passes calls through and tracks health", async () => {
  const { fetchFn, seen } = stubFetch((url, method) =>
    method === "getGenesisHash" ? DEVNET : 42);
  const pool = createRpcPool({ primary: "http://primary:8899", fetchFn });
  assert.equal(await pool.call("getSlot", []), 42);
  // Cold endpoint verifies its chain identity first, then serves.
  assert.deepEqual(seen.map((c) => c.method), ["getGenesisHash", "getSlot"]);
  assert.equal(await pool.call("getSlot", []), 42);
  assert.equal(seen.length, 3); // genesis is cached, not re-fetched
  const status = pool.getStatus();
  assert.equal(status.active, "primary");
  assert.equal(status.single_provider, true);
  assert.equal(status.failovers_total, 0);
  assert.equal(status.endpoints.primary.requests, 3);
  assert.equal(status.endpoints.primary.errors, 0);
  assert.equal(status.endpoints.primary.ok, true);
  assert.equal(status.endpoints.primary.genesis, DEVNET);
  assert.equal(status.endpoints.fallback, null);
});

test("transport failure fails over to fallback and records the event", async () => {
  const now = 1_000_000;
  const { fetchFn } = stubFetch((url, method) => {
    if (url.includes("primary")) throw new Error("connect ECONNREFUSED 10.0.0.1:8899");
    return method === "getGenesisHash" ? DEVNET : "fallback-result";
  });
  const pool = createRpcPool({
    primary: "http://primary:8899", fallback: "http://fallback:8899",
    fetchFn, nowFn: () => now,
  });
  assert.equal(await pool.call("getSlot", []), "fallback-result");
  const status = pool.getStatus();
  assert.equal(status.active, "fallback");
  assert.equal(status.failovers_total, 1);
  assert.equal(status.last_failover_at, now);
  assert.equal(status.endpoints.primary.errors, 1);
  assert.equal(status.endpoints.primary.consecutive_failures, 1);
  assert.equal(status.endpoints.primary.ok, false);
  assert.ok((status.endpoints.primary.last_error as string).includes("ECONNREFUSED"));
  assert.equal(status.endpoints.fallback?.ok, true);
});

test("http 500, bad json and node-behind errors all trigger failover", async () => {
  const primaries: StubOutcome[] = [
    { __http: 500 },
    { __badJson: true },
    { __rpcError: { code: -32009, message: "Node is behind by 42 slots" } },
  ];
  for (const primaryOutcome of primaries) {
    const { fetchFn } = stubFetch((url, method) => {
      if (url.includes("primary") && method !== "getGenesisHash") return primaryOutcome;
      return method === "getGenesisHash" ? DEVNET : "ok";
    });
    const pool = createRpcPool({
      primary: "http://primary:8899", fallback: "http://fallback:8899", fetchFn,
    });
    assert.equal(await pool.call("getSlot", []), "ok");
    assert.equal(pool.getStatus().failovers_total, 1);
  }
});

test("all endpoints failing throws; timeouts carry their own code", async () => {
  const { fetchFn } = stubFetch(() => { throw new Error("boom"); });
  const pool = createRpcPool({
    primary: "http://primary:8899", fallback: "http://fallback:8899", fetchFn,
  });
  await assert.rejects(() => pool.call("getSlot", []), /boom/);
  const status = pool.getStatus();
  assert.equal(status.active, null);
  assert.equal(status.failovers_total, 0);
  assert.ok(status.endpoints.primary.errors >= 1);
  assert.ok((status.endpoints.fallback?.errors ?? 0) >= 1);

  const timeout = Object.assign(new Error("The operation was aborted"), { name: "TimeoutError" });
  const slow = stubFetch(() => { throw timeout; });
  const single = createRpcPool({ primary: "http://primary:8899", fetchFn: slow.fetchFn });
  const err = await single.call("getSlot", []).then(
    () => { throw new Error("should have thrown"); },
    (e: unknown) => e as RpcError);
  assert.ok(err instanceof RpcError);
  assert.equal(err.code, "rpc-timeout");
  assert.match(err.message, /timed out/);
});

test("cooldown pins traffic to fallback until primary recovers", async () => {
  let now = 1_000_000;
  let primaryUp = false;
  const { fetchFn, seen } = stubFetch((url, method) => {
    if (method === "getGenesisHash") return DEVNET;
    if (url.includes("primary") && !primaryUp) throw new Error("primary down");
    return "ok";
  });
  const pool = createRpcPool({
    primary: "http://primary:8899", fallback: "http://fallback:8899",
    cooldownMs: 30_000, fetchFn, nowFn: () => now,
  });
  assert.equal(await pool.call("getSlot", []), "ok");
  assert.equal(pool.getStatus().active, "fallback");
  const primarySeen = seen.filter((c) => c.url.includes("primary")).length;
  assert.ok(primarySeen > 0);

  now += 5_000; // inside the cooldown: primary is not even attempted
  assert.equal(await pool.call("getSlot", []), "ok");
  assert.equal(seen.filter((c) => c.url.includes("primary")).length, primarySeen);
  assert.equal(pool.getStatus().failovers_total, 1);

  now += 30_000; // cooldown expired and primary is back: fail back
  primaryUp = true;
  assert.equal(await pool.call("getSlot", []), "ok");
  const status = pool.getStatus();
  assert.equal(status.active, "primary");
  assert.equal(status.last_failback_at, now);
  assert.equal(status.failovers_total, 1);
  assert.equal(status.endpoints.primary.ok, true);
  assert.ok(seen.filter((c) => c.url.includes("primary")).length > primarySeen);
});

test("fallback serving another chain is rejected, then heals", async () => {
  let now = 2_000_000;
  let primaryUp = true;
  let fallbackGenesis: string = MAINNET;
  const { fetchFn } = stubFetch((url, method) => {
    if (method === "getGenesisHash") return url.includes("primary") ? DEVNET : fallbackGenesis;
    if (url.includes("primary") && !primaryUp) throw new Error("primary down");
    return "ok";
  });
  const pool = createRpcPool({
    primary: "http://primary:8899", fallback: "http://fallback:8899",
    cooldownMs: 30_000, fetchFn, nowFn: () => now,
  });
  assert.equal(await pool.call("getSlot", []), "ok"); // pins the pool to devnet

  primaryUp = false;
  now += 1_000;
  const mismatch = await pool.call("getSlot", []).then(
    () => { throw new Error("should have thrown"); },
    (e: unknown) => e as RpcError);
  assert.equal(mismatch.code, "chain-mismatch");
  let status = pool.getStatus();
  assert.equal(status.endpoints.fallback?.chain_rejected, true);
  assert.ok((status.endpoints.fallback?.last_error as string).includes(MAINNET));
  assert.ok((status.endpoints.fallback?.last_error as string).includes(DEVNET));
  assert.equal(status.active, "primary"); // last success still stands
  assert.equal(status.failovers_total, 0);

  fallbackGenesis = DEVNET; // operator repoints the fallback at devnet
  now += 30_000;
  assert.equal(await pool.call("getSlot", []), "ok");
  status = pool.getStatus();
  assert.equal(status.active, "fallback");
  assert.equal(status.failovers_total, 1);
  assert.equal(status.endpoints.fallback?.chain_rejected, false);
  assert.equal(status.chain.match, true);
});

test("expected genesis pins every endpoint to one chain", async () => {
  const { fetchFn } = stubFetch((url, method) => {
    if (method === "getGenesisHash") return url.includes("primary") ? MAINNET : DEVNET;
    return "ok";
  });
  const pool = createRpcPool({
    primary: "http://primary:8899", fallback: "http://fallback:8899",
    expectedGenesis: DEVNET, fetchFn,
  });
  // Wrong-chain primary is skipped; the compliant fallback serves.
  assert.equal(await pool.call("getSlot", []), "ok");
  const status = pool.getStatus();
  assert.equal(status.active, "fallback");
  assert.equal(status.failovers_total, 1);
  assert.equal(status.endpoints.primary.chain_rejected, true);
  assert.equal(status.chain.expected, DEVNET);

  const lone = createRpcPool({
    primary: "http://primary:8899", expectedGenesis: DEVNET,
    fetchFn: stubFetch(() => MAINNET).fetchFn,
  });
  await assert.rejects(() => lone.call("getSlot", []), /unexpected chain/);
  assert.equal(lone.getStatus().endpoints.primary.chain_rejected, true);
});

test("required genesis verification never falls through after a transient failure", async () => {
  let genesisCalls = 0;
  let now = 1_000_000;
  const { fetchFn } = stubFetch((url, method) => {
    if (method === "getGenesisHash") {
      genesisCalls += 1;
      throw new Error("genesis temporarily unavailable");
    }
    return "money-path-must-not-run";
  });
  const pool = createRpcPool({
    primary: "http://primary:8899", expectedGenesis: DEVNET,
    requireGenesis: true, cooldownMs: 30_000, nowFn: () => now, fetchFn,
  });
  await assert.rejects(() => pool.call("getSlot", []), /cannot verify/);
  now += 1_000;
  await assert.rejects(() => pool.call("getSlot", []), /cannot verify/);
  assert.equal(genesisCalls, 1);
  assert.equal(pool.getStatus().endpoints.primary.requests, 1);

  now += 30_000;
  await assert.rejects(() => pool.call("getSlot", []), /cannot verify/);
  assert.equal(genesisCalls, 2);
});

test("endpoint urls are redacted in status output", () => {
  const pool = createRpcPool({
    primary: "https://mainnet.helius-rpc.com/?api-key=LIVESECRET123",
    fallback: "https://neonray.quiknode.pro/abc123def456/",
  });
  const status = pool.getStatus();
  const text = JSON.stringify(status);
  assert.ok(!text.includes("LIVESECRET123"));
  assert.ok(!text.includes("abc123def456"));
  assert.equal(status.endpoints.primary.url, "https://mainnet.helius-rpc.com");
  assert.equal(status.endpoints.fallback?.url, "https://neonray.quiknode.pro/…");
  assert.equal(redactRpcUrl("not a url"), "(invalid-url)");
});

function startJsonServer(
  handler: (msg: { id: number; method: string; params: unknown[] }) => { result?: unknown; error?: unknown },
): Promise<{ url: string; calls: string[]; close: () => Promise<void> }> {
  const calls: string[] = [];
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const msg = JSON.parse(body) as { id: number; method: string; params: unknown[] };
      calls.push(msg.method);
      const reply = handler(msg);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, ...reply }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        calls,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

/** A port that is guaranteed to refuse connections (bound, then released). */
async function deadUrl(): Promise<string> {
  const server: Server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((done) => server.close(() => done()));
  return `http://127.0.0.1:${port}`;
}

test("server: ticket reads fail over to fallback RPC and surface everywhere", async () => {
  const rpc = await startJsonServer((msg) =>
    msg.method === "getGenesisHash" ? { result: DEVNET } : { result: { value: null } });
  // The alert webhook posts {service,text,ts} as a plain JSON body, not
  // JSON-RPC: capture raw bodies with a dedicated listener.
  const bodies: string[] = [];
  const hookServer: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      bodies.push(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => hookServer.listen(0, "127.0.0.1", () => resolve()));
  const hookUrl = `http://127.0.0.1:${(hookServer.address() as AddressInfo).port}`;
  try {
    const program = base58Encode(Buffer.alloc(32, 7));
    const { app, base } = await startTestApp({
      economyProgramId: program,
      rpcUrl: await deadUrl(),
      rpcFallbackUrl: rpc.url,
      rpcCooldownMs: 600_000,
      operatorToken: "op-rpc",
      superadminToken: "sup-rpc",
      alertWebhookUrl: hookUrl,
    });
    try {
      const wallet = makeWallet();
      const auth = await authenticate(base, wallet);
      const session = String(auth.json.session_token);
      const res = await fetch(`${base}/v1/economy/ticket?kind=0&epoch=1`, {
        headers: { authorization: `Bearer ${session}` },
      });
      assert.equal(res.status, 200);
      assert.equal((await res.json() as { ticketed: boolean }).ticketed, false);
      assert.ok(rpc.calls.includes("getAccountInfo"));

      const status = await getJson(base, "/v1/admin/rpc-status", "op-rpc");
      assert.equal(status.status, 200);
      assert.equal(status.json.active, "fallback");
      assert.equal(status.json.single_provider, false);
      assert.equal(status.json.failovers_total, 1);
      assert.equal(status.json.endpoints.fallback.genesis, DEVNET);
      assert.ok((status.json.endpoints.primary.errors as number) >= 1);
      // No credentials in the operator-visible output.
      assert.ok(!JSON.stringify(status.json).includes("op-rpc"));

      const metrics = await getJson(base, "/v1/admin/metrics", "op-rpc");
      assert.equal(metrics.json.pipeline.rpc.configured, true);
      assert.equal(metrics.json.pipeline.rpc.active, "fallback");
      assert.equal(metrics.json.pipeline.rpc.failovers_total, 1);

      const stuck = await getJson(base, "/v1/admin/stuck?threshold_hours=1&alert=1", "op-rpc");
      assert.equal(stuck.status, 200);
      assert.equal(stuck.json.alert.alerted, true);
      assert.equal(bodies.length, 1);
      assert.ok((bodies[0] as string).includes("rpc serving from fallback"));
    } finally {
      await app.close();
    }
  } finally {
    await rpc.close();
    await new Promise<void>((done) => hookServer.close(() => done()));
  }
});

test("non-object JSON-RPC replies fail closed as rpc-protocol", async () => {
  const fetchFn = (async () => ({
    ok: true, status: 200, json: async () => [1, 2],
  })) as unknown as typeof fetch;
  const pool = createRpcPool({ primary: "http://primary:8899", fetchFn });
  await assert.rejects(pool.call("getSlot", []),
    (e: Error) => e instanceof RpcError && e.code === "rpc-protocol");
});
