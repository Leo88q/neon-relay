/**
 * Tranche-B metrics tests: activity/DAU, finish rates, claim mix and the
 * pipeline backlog, all computed from seeded ledger + game-event rows.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import { getJson, postJson, startTestApp } from "./helpers.ts";
import {
  canonicalGameEventBytes, type IncomingGameEvent,
} from "../src/game_events.ts";
import { Db, migrate } from "../src/db.ts";
import { collectStuck, computeMetrics } from "../src/metrics.ts";

const OPERATOR = "op-metrics";
const SUPERADMIN = "sup-metrics";

function makeGameServer() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  return {
    publicKeyBase64: raw.toString("base64url"),
    sign: (event: Omit<IncomingGameEvent, "server_signature">): IncomingGameEvent => ({
      ...event,
      server_signature: edSign(null, canonicalGameEventBytes(event), privateKey).toString("base64url"),
    }),
  };
}

test("metrics aggregate activity, finish, claims and pipeline", async () => {
  const server = makeGameServer();
  const { app, base } = await startTestApp({
    serverSigningPublicKey: server.publicKeyBase64,
    operatorToken: OPERATOR,
    superadminToken: SUPERADMIN,
    epochMs: 3_600_000,
  });
  try {
    const now = Date.now();
    const dayA = now - 30 * 3_600_000; // firmly "yesterday" in any UTC offset
    // Day A: p1 plays a 90s session with two matches, p2 starts and idles.
    // Day B (now): p1 plays a 60s session with one finished race.
    const events = [
      server.sign({ session_id: "a1", event_type: "session_start", player_id: "p1", occurred_at: dayA }),
      server.sign({
        session_id: "a1", event_type: "match_end", player_id: "p1", match_id: "ma1",
        mode: "race", result: { finished: true, place: 1 }, occurred_at: dayA + 30_000,
      }),
      server.sign({
        session_id: "a1", event_type: "match_end", player_id: "p1", match_id: "ma2",
        mode: "dm", result: { finished: false }, occurred_at: dayA + 60_000,
      }),
      server.sign({ session_id: "a1", event_type: "session_end", player_id: "p1", occurred_at: dayA + 90_000 }),
      server.sign({ session_id: "a2", event_type: "session_start", player_id: "p2", occurred_at: dayA + 10_000 }),
      server.sign({ session_id: "b1", event_type: "session_start", player_id: "p1", occurred_at: now - 120_000 }),
      server.sign({
        session_id: "b1", event_type: "match_end", player_id: "p1", match_id: "mb1",
        mode: "race", result: { finished: true, place: 3 }, occurred_at: now - 90_000,
      }),
      server.sign({ session_id: "b1", event_type: "session_end", player_id: "p1", occurred_at: now - 60_000 }),
    ];
    const ingested = await postJson(base, "/v1/game/events", { events });
    assert.equal(ingested.json.accepted, 8);

    const dayKey = (ts: number): string => new Date(ts).toISOString().slice(0, 10);
    // Claim mix: one confirmed, one failed, one stuck in submitted.
    app.db.run(
      "INSERT INTO claim_intents (id, wallet_binding_id, epoch_id, amount_micro, leaf_hash, merkle_proof, status, transaction_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      "i1", "b1", 1, 10, "h", "[]", "confirmed", "tx1", now - 1000, now - 1000);
    app.db.run(
      "INSERT INTO claim_intents (id, wallet_binding_id, epoch_id, amount_micro, leaf_hash, merkle_proof, status, transaction_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      "i2", "b2", 1, 10, "h", "[]", "failed", "tx2", now - 1000, now - 1000);
    app.db.run(
      "INSERT INTO claim_intents (id, wallet_binding_id, epoch_id, amount_micro, leaf_hash, merkle_proof, status, transaction_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      "i3", "b3", 1, 10, "h", "[]", "submitted", "tx3", now - 8 * 3_600_000, now - 8 * 3_600_000);
    // Pipeline: one open epoch with pending value, one open proposal, one
    // prize close nobody reconciled.
    const epochId = Math.floor(now / 3_600_000);
    app.db.run(
      "INSERT INTO reward_epochs (id, state, started_at, ended_at) VALUES (?, 'open', ?, ?)",
      epochId, now - 2 * 3_600_000, now + 3_600_000);
    app.db.run(
      "INSERT INTO reward_events (id, idempotency_hash, match_id, player_id, wallet_binding_id, reward_epoch, event_type, amount_micro, occurred_at, ingested_at, server_signature, status, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      "e1", "h1", "m", "p1", "b1", epochId, "match_win", 250, now - 1000, now - 1000, "sig", "accepted", null);
    app.db.run(
      "INSERT INTO admin_proposals (id, type, params, proposed_by_role, proposed_by_hash, created_at, expires_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'open')",
      "p-1", "seal-reward-epoch", JSON.stringify({ epoch_id: epochId }),
      "operator", "00", now - 30 * 60_000, now + 23 * 3_600_000);
    app.db.run(
      "INSERT INTO economy_epochs (epoch, root, total_micro, distribution, created_at) VALUES (?, ?, ?, ?, ?)",
      55, "ab".repeat(32), 10, "[]", now - 1000);

    const anon = await getJson(base, "/v1/admin/metrics");
    assert.equal(anon.status, 403);
    const bad = await getJson(base, "/v1/admin/metrics?days=0", OPERATOR);
    assert.equal(bad.status, 400);
    const res = await getJson(base, "/v1/admin/metrics?days=7", OPERATOR);
    assert.equal(res.status, 200);
    const json = res.json;
    assert.equal(json.window_days, 7);

    const byDay = new Map((json.activity as { day: string }[]).map((d) => [d.day, d]));
    const rowA = byDay.get(dayKey(dayA)) as unknown as { dau: number; sessions: number; avg_session_s: number };
    const rowB = byDay.get(dayKey(now - 60_000)) as unknown as { dau: number; sessions: number; avg_session_s: number };
    assert.equal(rowA.dau, 2);
    assert.equal(rowA.sessions, 2);
    assert.equal(rowA.avg_session_s, 90);
    assert.equal(rowB.dau, 1);
    assert.equal(rowB.sessions, 1);
    assert.equal(rowB.avg_session_s, 60);

    assert.equal(json.finish.total, 3);
    assert.equal(json.finish.finished, 2);
    assert.equal(json.finish.rate, 0.6667);
    const race = (json.finish.by_mode as { mode: string }[]).find((m) => m.mode === "race") as unknown as {
      total: number; finished: number; rate: number;
    };
    assert.deepEqual([race.total, race.finished, race.rate], [2, 2, 1]);
    const dm = (json.finish.by_mode as { mode: string }[]).find((m) => m.mode === "dm") as unknown as {
      total: number; finished: number; rate: number;
    };
    assert.deepEqual([dm.total, dm.finished, dm.rate], [1, 0, 0]);

    assert.equal(json.claims.total, 3);
    assert.equal(json.claims.failed_rate, 0.3333);
    assert.equal(json.claims.stuck_submitted, 1);

    assert.equal(json.pipeline.open_reward_epochs, 1);
    assert.ok((json.pipeline.oldest_open_epoch_age_ms as number) >= 2 * 3_600_000);
    assert.equal(json.pipeline.pending_open_value_micro, 250);
    assert.equal(json.pipeline.open_proposals, 1);
    assert.ok((json.pipeline.oldest_open_proposal_age_ms as number) >= 30 * 60_000);
    assert.deepEqual(json.pipeline.unreconciled_prize_epochs, [55]);
  } finally {
    await app.close();
  }
});

test("metrics on an empty ledger return nulls, not errors", async () => {
  const { app, base } = await startTestApp({ operatorToken: OPERATOR });
  try {
    const res = await getJson(base, "/v1/admin/metrics", OPERATOR);
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.activity, []);
    assert.equal(res.json.finish.total, 0);
    assert.equal(res.json.finish.rate, null);
    assert.equal(res.json.claims.total, 0);
    assert.equal(res.json.claims.failed_rate, null);
    assert.equal(res.json.pipeline.open_reward_epochs, 0);
    assert.equal(res.json.pipeline.oldest_open_epoch_age_ms, null);
  } finally {
    await app.close();
  }
});

test("stuck threshold must be within 1ms..30d", () => {
  const db = new Db(":memory:");
  migrate(db);
  assert.throws(() => collectStuck(db, 0), /threshold must be within 1ms\.\.30d/);
  assert.throws(() => collectStuck(db, 31 * 86_400_000), /threshold must be within 1ms\.\.30d/);
  db.close();
});

test("metrics window must be within 1..90 days", () => {
  const db = new Db(":memory:");
  migrate(db);
  assert.throws(() => computeMetrics(db, 0), /window must be within 1\.\.90 days/);
  assert.throws(() => computeMetrics(db, 91), /window must be within 1\.\.90 days/);
  db.close();
});

test("metrics without an RPC pool report the pool as unconfigured", () => {
  const db = new Db(":memory:");
  migrate(db);
  const metrics = computeMetrics(db, 7, Date.now(), null);
  assert.equal(metrics.pipeline.rpc.configured, false);
  assert.equal(metrics.pipeline.rpc.active, null);
  db.close();
});
