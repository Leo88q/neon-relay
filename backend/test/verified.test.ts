/**
 * GET /v1/rewards/verified — read-only verified-results route
 * (docs/UI_POTATO_ARENA_REDESIGN_RU.md §7.7) and the features registry decoder.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  authenticate, getJson, makeWallet, postJson, startTestApp, makeTestServer,
} from "./helpers.ts";
import { base58Decode, base58Encode, findProgramAddress } from "../src/economy.ts";
import {
  readAchievementRegistry, FeaturesReadError, FEATURES_ACHIEVEMENTS_SEED,
} from "../src/features_read.ts";
import type { Config } from "../src/config.ts";

const TEST_PROGRAM_ID = "4PH1dHVBRbfoydBx3SuRjAS46zRRjHvRxWCNcrFBDqYP";

function rewardConfig(serverKey: string): Partial<Config> {
  return {
    serverSigningPublicKey: serverKey,
    operatorToken: "operator-token",
    superadminToken: "superadmin-token",
    epochMs: 3_600_000,
    capPerMatchMicro: 1_000,
    capDailyMicro: 1_500,
    capWeeklyMicro: 5_000,
  };
}

// ---------------------------------------------------------------- registry decode

function makeRegistryBytes(player: Buffer, ids: number[], bump: number,
  countOverride?: number): Buffer {
  const b = Buffer.alloc(81);
  createHash("sha256").update("account:AchievementRegistry", "utf8")
    .digest().subarray(0, 8).copy(b, 0);
  player.copy(b, 8);
  const words = [0n, 0n, 0n, 0n];
  for (const id of ids) words[Math.floor(id / 64)]! |= 1n << BigInt(id % 64);
  words.forEach((w, i) => b.writeBigUInt64LE(w, 40 + i * 8));
  b.writeUInt32LE(countOverride ?? ids.length, 72);
  b[80] = bump;
  return b;
}

function registryFixture(playerPub: Buffer) {
  const program = base58Decode(TEST_PROGRAM_ID);
  const pda = findProgramAddress([FEATURES_ACHIEVEMENTS_SEED, playerPub], program);
  return { address: base58Encode(pda.address), bump: pda.bump };
}

test("readAchievementRegistry decodes ids, count and bump from the PDA", async () => {
  const player = Buffer.alloc(32, 7);
  const { address, bump } = registryFixture(player);
  const bytes = makeRegistryBytes(player, [0, 64, 255], bump);
  let sawMethod: string | null = null;
  let sawAddress: string | null = null;
  const rpc = async (method: string, params: unknown[]) => {
    sawMethod = method;
    sawAddress = String(params[0]);
    return { value: { owner: TEST_PROGRAM_ID, executable: false,
      data: [bytes.toString("base64"), "base64"] } };
  };
  const view = await readAchievementRegistry(rpc, TEST_PROGRAM_ID, player.toString("base64url"));
  assert.equal(sawMethod, "getAccountInfo");
  assert.equal(sawAddress, address);
  assert.ok(view);
  assert.equal(view.address, address);
  assert.equal(view.bump, bump);
  assert.equal(view.count, 3);
  assert.deepEqual(view.ids, [0, 64, 255]);
});

test("readAchievementRegistry returns null when the registry does not exist", async () => {
  const player = Buffer.alloc(32, 3);
  const { address } = registryFixture(player);
  const rpc = async (method: string, params: unknown[]) => {
    assert.equal(String(params[0]), address);
    return { value: null };
  };
  const view = await readAchievementRegistry(rpc, TEST_PROGRAM_ID, player.toString("base64url"));
  assert.equal(view, null);
});

test("readAchievementRegistry rejects a count that disagrees with the bitmap", async () => {
  const player = Buffer.alloc(32, 5);
  const { bump } = registryFixture(player);
  const bytes = makeRegistryBytes(player, [1, 65], bump, 1);
  const rpc = async () => ({ value: { owner: TEST_PROGRAM_ID, executable: false,
    data: [bytes.toString("base64"), "base64"] } });
  await assert.rejects(
    readAchievementRegistry(rpc, TEST_PROGRAM_ID, player.toString("base64url")),
    (err: Error) => err instanceof FeaturesReadError && err.code === "registry-count-mismatch",
  );
});

test("readAchievementRegistry rejects a wrong owner and a foreign player", async () => {
  const player = Buffer.alloc(32, 9);
  const { bump } = registryFixture(player);
  const rpc = async () => ({ value: { owner: "SomeOtherProgram1111111111111111111111111111111",
    executable: false, data: [makeRegistryBytes(player, [0], bump).toString("base64"), "base64"] } });
  await assert.rejects(
    readAchievementRegistry(rpc, TEST_PROGRAM_ID, player.toString("base64url")),
    (err: Error) => err instanceof FeaturesReadError && err.code === "registry-account-invalid",
  );
  const foreign = Buffer.alloc(32, 11);
  const rpc2 = async () => ({ value: { owner: TEST_PROGRAM_ID, executable: false,
    data: [makeRegistryBytes(foreign, [0], bump).toString("base64"), "base64"] } });
  await assert.rejects(
    readAchievementRegistry(rpc2, TEST_PROGRAM_ID, player.toString("base64url")),
    (err: Error) => err instanceof FeaturesReadError && err.code === "registry-player-mismatch",
  );
});

test("readAchievementRegistry validates the wallet public key shape", async () => {
  await assert.rejects(
    readAchievementRegistry(async () => ({}), TEST_PROGRAM_ID, "short"),
    (err: Error) => err instanceof FeaturesReadError && err.code === "wallet-public-key-invalid",
  );
});

// ---------------------------------------------------------------- the route

test("GET /v1/rewards/verified requires a session", async () => {
  const { app, base } = await startTestApp(rewardConfig(makeTestServer().publicKeyBase64));
  try {
    const res = await getJson(base, "/v1/rewards/verified");
    assert.equal(res.status, 401);
  } finally {
    await app.close();
  }
});

test("verified route: accepted events aggregate per type, rejects stay out, no cross-player leak", async () => {
  const server = makeTestServer();
  const { app, base } = await startTestApp(rewardConfig(server.publicKeyBase64));
  try {
    const wallet = makeWallet();
    const auth = await authenticate(base, wallet);
    assert.equal(auth.status, 200);
    const token = auth.json.session_token as string;
    const binding = auth.json.wallet_binding_id as string;
    const linked = await postJson(base, "/v1/wallet/link", { player_id: "p1" }, token);
    assert.equal(linked.status, 200);
    const now = Date.now();

    const e1 = server.signEvent({
      match_id: "m1", player_id: "p1", wallet_binding_id: binding,
      event_type: "map_finish", amount_micro: 600, occurred_at: now,
    });
    const e2 = server.signEvent({
      match_id: "m2", player_id: "p1", wallet_binding_id: binding,
      event_type: "map_finish", amount_micro: 400, occurred_at: now + 1,
    });
    const e3 = server.signEvent({
      match_id: "m3", player_id: "p1", wallet_binding_id: binding,
      event_type: "match_win", amount_micro: 250, occurred_at: now + 2,
    });
    const ingested = await postJson(base, "/v1/rewards/events", { events: [e1, e2, e3] });
    assert.equal(ingested.status, 200);
    assert.equal(ingested.json.accepted, 3);

    // Forged signature: must be rejected and must not appear in the verified view.
    const stranger = makeTestServer();
    const forged = stranger.signEvent({
      match_id: "m9", player_id: "p1", wallet_binding_id: binding,
      event_type: "map_finish", amount_micro: 10, occurred_at: now + 3,
    });
    const bad = await postJson(base, "/v1/rewards/events", { events: [forged] });
    assert.equal(bad.json.results[0].status, "rejected_signature");

    const res = await getJson(base, "/v1/rewards/verified", token);
    assert.equal(res.status, 200);
    assert.equal(res.json.source, "server-verified");
    assert.equal(res.json.player_id, "p1");
    assert.equal(res.json.wallet_binding_id, binding);
    assert.equal(res.json.achievements, null);
    assert.equal(res.json.achievements_status, "disabled"); // no program id in test config
    assert.deepEqual(res.json.events, [
      { event_type: "map_finish", count: 2, count_today: 2, total_micro: 1000, last_at: now + 1 },
      { event_type: "match_win", count: 1, count_today: 1, total_micro: 250, last_at: now + 2 },
    ]);
    assert.equal(res.json.recent.length, 3);
    assert.deepEqual(res.json.recent.map((r: any) => r.event_type),
      ["match_win", "map_finish", "map_finish"]);

    // A second player ingests for themselves: invisible to p1, visible to p2.
    const wallet2 = makeWallet();
    const auth2 = await authenticate(base, wallet2);
    const token2 = auth2.json.session_token as string;
    const binding2 = auth2.json.wallet_binding_id as string;
    await postJson(base, "/v1/wallet/link", { player_id: "p2" }, token2);
    const p2e = server.signEvent({
      match_id: "m4", player_id: "p2", wallet_binding_id: binding2,
      event_type: "map_finish", amount_micro: 100, occurred_at: now + 4,
    });
    const p2ing = await postJson(base, "/v1/rewards/events", { events: [p2e] });
    assert.equal(p2ing.json.results[0].status, "accepted");

    const p1again = await getJson(base, "/v1/rewards/verified", token);
    assert.equal(p1again.json.events.length, 2);
    assert.equal(p1again.json.recent.length, 3);

    const p2res = await getJson(base, "/v1/rewards/verified", token2);
    assert.equal(p2res.json.player_id, "p2");
    assert.deepEqual(p2res.json.events, [
      { event_type: "map_finish", count: 1, count_today: 1, total_micro: 100, last_at: now + 4 },
    ]);
  } finally {
    await app.close();
  }
});
