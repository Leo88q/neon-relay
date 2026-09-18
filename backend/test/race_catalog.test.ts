import test from "node:test";
import assert from "node:assert/strict";
import { base58Decode, base58Encode } from "../src/economy.ts";
import { loadConfig } from "../src/config.ts";
import { raceLobby, RACE_TIERS, splitEntryPool, topTenShares } from "../src/race_catalog.ts";
import { getJson, postJson, startTestApp } from "./helpers.ts";

// Synthetic PUBLIC addresses only, not official token mints.
const skr = base58Encode(Buffer.alloc(32, 7));
const potato = base58Encode(Buffer.alloc(32, 9));

test("base58 zero and leading-zero inputs round-trip without an extra byte", () => {
  for (const raw of [Buffer.alloc(0), Buffer.alloc(1), Buffer.alloc(32), Buffer.from([0, 0, 9])]) {
    if (raw.length) assert.deepEqual(base58Decode(base58Encode(raw)), raw);
  }
  assert.deepEqual(base58Decode(""), Buffer.alloc(0));
  assert.deepEqual(base58Decode("1".repeat(32)), Buffer.alloc(32));
});

test("operator config accepts distinct public mints and never supplies a default mint", () => {
  const config = loadConfig({ NEONRELAY_SKR_MINT: skr, NEONRELAY_POTATO_MINT: potato });
  assert.equal(config.skrMint, skr);
  assert.equal(config.potatoMint, potato);
  assert.equal(loadConfig({}).skrMint, null);
  assert.equal(loadConfig({}).potatoMint, null);
  assert.equal(loadConfig({ NEONRELAY_POTATO_MINT: "" }).potatoMint, null);
});

test("invalid, zero, whitespace, oversized or duplicate mint config fails at boot", () => {
  for (const value of ["not-a-mint", "1".repeat(32), "1".repeat(31), "0".repeat(32), skr + " ", " " + skr, "z".repeat(1000)]) {
    for (const field of ["NEONRELAY_SKR_MINT", "NEONRELAY_POTATO_MINT"]) {
      assert.throws(() => loadConfig({ [field]: value }), /base58 public key/);
    }
  }
  assert.throws(() => loadConfig({ NEONRELAY_SKR_MINT: skr, NEONRELAY_POTATO_MINT: skr }), /distinct/);
});

test("catalog has all paid tiers and a holder-only freeroll without invented capacity", () => {
  assert.deepEqual(RACE_TIERS.map((x) => x.entryTokens), ["50", "100", "500", "2000", "0"]);
  assert.deepEqual(RACE_TIERS.slice(0, 4).map((x) => x.minPlayers), [10, 20, 50, 100]);
  assert.equal(RACE_TIERS[3]!.maxPlayers, null);
  assert.equal(RACE_TIERS[4]!.legendaryOnly, true);
  assert.equal(RACE_TIERS[4]!.minPlayers, null);
});

test("both currencies remain catalog-only even when mints are configured", () => {
  const data = raceLobby(loadConfig({ NEONRELAY_SKR_MINT: skr, NEONRELAY_POTATO_MINT: potato }));
  assert.equal(data.paymentsEnabled, false);
  assert.equal(data.rankedEntryRequired, true);
  assert.deepEqual(data.categories.map((c) => c.mint), [skr, potato]);
  assert.ok(data.categories.every((c) => c.configured && !c.mintVerified));
  assert.ok(data.categories.flatMap((c) => c.races).every((r) => !r.joinEnabled));
  assert.equal(data.prizeTableBps.reduce((sum, bps) => sum + bps, 0), 10_000);
  Reflect.set(data.categories[0]!.races[0]!, "entryTokens", "999");
  assert.equal(raceLobby(loadConfig({})).categories[0]!.races[0]!.entryTokens, "50");
});

test("pool preview follows 90/10, u64 bounds and per-ticket rounding", () => {
  assert.deepEqual(splitEntryPool(50n, 10), { gross: 500n, rake: 50n, prizePool: 450n });
  assert.deepEqual(splitEntryPool(2000n, 100), { gross: 200000n, rake: 20000n, prizePool: 180000n });
  assert.deepEqual(splitEntryPool(1n, 10), { gross: 10n, rake: 0n, prizePool: 10n });
  assert.deepEqual(splitEntryPool(0n, 10), { gross: 0n, rake: 0n, prizePool: 0n });
  assert.equal(splitEntryPool(50n, 10, 2000).rake, 100n);
  assert.equal(splitEntryPool(50n, 10, 0).rake, 0n);
  for (const rake of [-1, 2001, 1.5, NaN, Infinity]) assert.throws(() => splitEntryPool(50n, 10, rake));
  for (const count of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => splitEntryPool(50n, count));
  assert.throws(() => splitEntryPool(-1n, 10));
  assert.throws(() => splitEntryPool(1n << 64n, 1));
  assert.throws(() => splitEntryPool((1n << 64n) - 1n, 2));
});

test("top ten preview conserves every base unit with deterministic rounding", () => {
  assert.deepEqual(topTenShares(10000n), [2500n, 1800n, 1400n, 1100n, 900n, 700n, 600n, 500n, 300n, 200n]);
  assert.equal(topTenShares(180000n)[0], 45000n); // not 40k
  for (const pool of [0n, 1n, 9n, 99n, 450n, 10001n, (1n << 64n) - 1n]) {
    const shares = topTenShares(pool);
    assert.equal(shares.length, 10);
    assert.equal(shares.reduce((sum, amount) => sum + amount, 0n), pool);
    assert.ok(shares.every((share) => share >= 0n));
    assert.deepEqual(shares, topTenShares(pool));
  }
  assert.throws(() => topTenShares(-1n));
  assert.throws(() => topTenShares(1n << 64n));
});

test("HTTP lobby exposes two categories without requiring payment setup or auth", async () => {
  const { app, base } = await startTestApp();
  try {
    const res = await getJson(base, "/v2/economy/lobby");
    assert.equal(res.status, 200);
    assert.equal(res.json.mode, "catalog-only");
    assert.equal(res.json.paymentsEnabled, false);
    assert.deepEqual(res.json.categories.map((c: { currency: string }) => c.currency), ["SKR", "POTATO"]);
    assert.ok(res.json.categories.every((c: { configured: boolean }) => !c.configured));
    const filtered = await getJson(base, "/v2/economy/lobby?currency=POTATO");
    assert.equal(filtered.status, 200);
    assert.equal(filtered.json.categories.length, 1);
    assert.equal(filtered.json.categories[0].currency, "POTATO");
    assert.equal((await postJson(base, "/v2/economy/join", { currency: "POTATO" })).status, 404);
  } finally { await app.close(); }
});

test("HTTP lobby rejects malformed, ambiguous and unsupported currency values", async () => {
  const { app, base } = await startTestApp();
  try {
    for (const query of ["currency=", "currency=skr", "currency=SOL", "currency=SKR&currency=POTATO"]) {
      const res = await getJson(base, "/v2/economy/lobby?" + query);
      assert.equal(res.status, 400);
      assert.equal(res.json.error.code, "bad-currency");
    }
  } finally { await app.close(); }
});

test("lobby uses existing rate limiter", async () => {
  const { app, base } = await startTestApp();
  try {
    const statuses = [];
    for (let i = 0; i < 11; i++) statuses.push((await getJson(base, "/v2/economy/lobby")).status);
    assert.deepEqual(statuses.slice(0, 10), Array(10).fill(200));
    assert.equal(statuses[10], 429);
  } finally { await app.close(); }
});
