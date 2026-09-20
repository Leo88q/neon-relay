/**
 * Tranche-B game event log tests: signed ingestion, idempotency, validation,
 * admin listing with filters and retention purges.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import {
  authenticate, getJson, makeWallet, postJson, startTestApp,
} from "./helpers.ts";
import {
  canonicalGameEventBytes, type IncomingGameEvent,
} from "../src/game_events.ts";

const OPERATOR = "op-game";
const SUPERADMIN = "sup-game";

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

async function startGameApp() {
  const server = makeGameServer();
  const { app, base } = await startTestApp({
    serverSigningPublicKey: server.publicKeyBase64,
    operatorToken: OPERATOR,
    superadminToken: SUPERADMIN,
  });
  return { app, base, server };
}

test("ingestion is disabled without a signing key", async () => {
  const { app, base } = await startTestApp({ operatorToken: OPERATOR });
  try {
    const res = await postJson(base, "/v1/game/events", { events: [{ event_type: "x" }] });
    assert.equal(res.status, 503);
    assert.equal(res.json.error.code, "signing-key-unconfigured");
  } finally {
    await app.close();
  }
});

test("session lifecycle ingests once and replays collapse", async () => {
  const { app, base, server } = await startGameApp();
  try {
    const now = Date.now();
    const events = [
      server.sign({ session_id: "s1", event_type: "session_start", player_id: "p1", occurred_at: now }),
      server.sign({
        session_id: "s1", event_type: "match_end", player_id: "p1",
        match_id: "m1", mode: "race", result: { finished: true, place: 2 }, occurred_at: now + 1000,
      }),
      server.sign({ session_id: "s1", event_type: "session_end", player_id: "p1", occurred_at: now + 2000 }),
    ];
    const first = await postJson(base, "/v1/game/events", { events });
    assert.equal(first.status, 200);
    assert.equal(first.json.accepted, 3);
    const replay = await postJson(base, "/v1/game/events", { events });
    assert.deepEqual(replay.json.results.map((r: { status: string }) => r.status),
      ["duplicate", "duplicate", "duplicate"]);

    const stranger = makeGameServer();
    const forged = await postJson(base, "/v1/game/events", {
      events: [stranger.sign({ session_id: "s2", event_type: "session_start", occurred_at: now })],
    });
    assert.equal(forged.json.results[0].status, "rejected_signature");

    const badBatch = await postJson(base, "/v1/game/events", { events: [] });
    assert.equal(badBatch.status, 400);
  } finally {
    await app.close();
  }
});

test("validation rejects malformed events without ingesting", async () => {
  const { app, base, server } = await startGameApp();
  try {
    const now = Date.now();
    const cases: [Omit<IncomingGameEvent, "server_signature">, string][] = [
      [{ session_id: "s", event_type: "client_crash", occurred_at: now }, "rejected_validation"],
      [{ session_id: "s", event_type: "match_end", occurred_at: now }, "rejected_validation"], // no match_id
      [{ session_id: "s", event_type: "session_start", occurred_at: -5 }, "rejected_validation"],
      [{
        session_id: "s", event_type: "match_end", match_id: "m",
        result: { blob: "x".repeat(3000) }, occurred_at: now,
      }, "rejected_validation"],
    ];
    for (const [event, expected] of cases) {
      const res = await postJson(base, "/v1/game/events", { events: [server.sign(event)] });
      assert.equal(res.json.results[0].status, expected, JSON.stringify(event));
    }
  } finally {
    await app.close();
  }
});

test("admin listing filters and paginates", async () => {
  const { app, base, server } = await startGameApp();
  try {
    const now = Date.now();
    await postJson(base, "/v1/game/events", {
      events: [
        server.sign({ session_id: "s1", event_type: "session_start", player_id: "p1", occurred_at: now - 2000 }),
        server.sign({ session_id: "s2", event_type: "session_start", player_id: "p2", occurred_at: now - 1000 }),
        server.sign({ session_id: "s2", event_type: "disconnect", player_id: "p2", occurred_at: now }),
      ],
    });
    const anon = await getJson(base, "/v1/admin/game-events");
    assert.equal(anon.status, 403);
    const all = await getJson(base, "/v1/admin/game-events", OPERATOR);
    assert.equal(all.json.pagination.total, 3);
    const starts = await getJson(base, "/v1/admin/game-events?event_type=session_start", OPERATOR);
    assert.equal(starts.json.pagination.total, 2);
    const p2 = await getJson(base, "/v1/admin/game-events?player_id=p2&limit=1&offset=1", OPERATOR);
    assert.equal(p2.json.events.length, 1);
    assert.equal(p2.json.pagination.total, 2);
    const since = await getJson(base, `/v1/admin/game-events?since=${now - 500}`, OPERATOR);
    assert.equal(since.json.pagination.total, 1);
    const badType = await getJson(base, "/v1/admin/game-events?event_type=nope", OPERATOR);
    assert.equal(badType.status, 400);
    assert.equal(badType.json.error.code, "bad-event-type");
  } finally {
    await app.close();
  }
});

test("retention purge deletes only old events and audits", async () => {
  const { app, base, server } = await startGameApp();
  try {
    const now = Date.now();
    await postJson(base, "/v1/game/events", {
      events: [
        server.sign({ session_id: "old", event_type: "session_start", player_id: "p-old", occurred_at: now - 40 * 86_400_000 }),
        server.sign({ session_id: "new", event_type: "session_start", player_id: "p-new", occurred_at: now }),
      ],
    });
    const denied = await postJson(base, "/v1/admin/game-events/purge", { older_than_days: 30 }, OPERATOR);
    assert.equal(denied.status, 403);
    const bad = await postJson(base, "/v1/admin/game-events/purge", { older_than_days: 0 }, SUPERADMIN);
    assert.equal(bad.status, 400);
    const purged = await postJson(base, "/v1/admin/game-events/purge", { older_than_days: 30 }, SUPERADMIN);
    assert.equal(purged.json.purged, 1);
    const remaining = await getJson(base, "/v1/admin/game-events", OPERATOR);
    assert.equal(remaining.json.pagination.total, 1);
    assert.equal(remaining.json.events[0].player_id, "p-new");
    const both = await postJson(base, "/v1/admin/game-events/purge",
      { older_than_days: 30, player_id: "p-new" }, SUPERADMIN);
    assert.equal(both.status, 400);
    const byPlayer = await postJson(base, "/v1/admin/game-events/purge",
      { player_id: "p-new" }, SUPERADMIN);
    assert.equal(byPlayer.json.purged, 1);
    const gone = await getJson(base, "/v1/admin/game-events", OPERATOR);
    assert.equal(gone.json.pagination.total, 0);
    const audit = await getJson(base, "/v1/admin/audit", OPERATOR);
    assert.ok((audit.json.entries as { action: string }[]).some((e) => e.action === "game-events-purged"));
    void authenticate;
    void makeWallet;
  } finally {
    await app.close();
  }
});
