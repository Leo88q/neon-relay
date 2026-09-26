import test from "node:test";
import assert from "node:assert/strict";
import { getJson, postJson, startTestApp } from "./helpers.ts";
import { WATCHTOWER_COMPONENTS, TELEMETRY_EVENT_TYPES } from "../src/watchtower.ts";

async function withApp(fn: (base: string, db: any) => Promise<void>): Promise<void> {
  const { app, base } = await startTestApp();
  try { await fn(base, app.db); } finally { await app.close(); }
}

test("Watchtower config is v3, tenant-scoped, and exactly 33 components", () =>
  withApp(async (base) => {
    const response = await getJson(base, "/api/os/config");
    assert.equal(response.status, 200);
    assert.equal(response.json.version, "v3");
    assert.equal(response.json.game_id, "neonrelay");
    assert.equal(response.json.tenant, "neonrelay");
    assert.equal(response.json.component_count, 33);
    assert.equal(response.json.components.length, WATCHTOWER_COMPONENTS.length);
    assert.equal(response.json.program_ids.rewards, "NEONRELAY_REWARDS_PROGRAM_ID");
    assert.deepEqual(response.json.identity.session_key_actions, ["move", "boost", "finish", "race_session"]);
  }));

test("readyz stays blocked until the production manifest and chain checks pass", async () => {
  const { app, base } = await startTestApp({ environment: "production", monetizationEnabled: true });
  try {
    const response = await getJson(base, "/watchtower/readyz");
    assert.equal(response.status, 503);
    assert.equal(response.json.data.ready, false);
    assert.ok((response.json.data.blockers as string[]).length > 0);
    assert.equal(response.json.data.productionReady, false);
  } finally {
    await app.close();
  }
});

test("canonical /watchtower exporter routes are read-only and metadata-rich", () =>
  withApp(async (base) => {
    const health = await getJson(base, "/watchtower/health");
    assert.equal(health.status, 200);
    assert.equal(health.json.network, "solana");
    assert.equal(health.json.stage, "prototype");
    assert.equal(health.json.data.writes, false);
    assert.equal(health.json.data.health.writes, false);
    const config = await getJson(base, "/watchtower/config");
    assert.equal(config.status, 200);
    assert.equal(config.json.parserVersion, "neonrelay-watchtower-v2");
    assert.ok((config.json.data.routes as { path: string }[]).some((route) => route.path === "/watchtower/events"));
  }));

test("high frequency gasless routing selects HyperGrid plus privacy and fallback", () =>
  withApp(async (base) => {
    const response = await getJson(base, "/api/l2/router?gameId=neonrelay&tps=high&ux=gasless");
    assert.equal(response.status, 200);
    assert.equal(response.json.execution_layer, "HyperGrid");
    assert.equal(response.json.privacy_layer, "Arcium");
    assert.equal(response.json.private_verification, "PST");
    assert.equal(response.json.state_layer, "Xandeum");
    assert.equal(response.json.read_layer, "Sorada");
    assert.equal(response.json.fallback, "Solana mainnet");
    assert.deepEqual(response.json.gasless_path, ["MagicBlock ER", "delegate_account", "execute_in_er", "commit_state"]);
  }));

test("all SDK verification endpoints expose an adapter contract", () =>
  withApp(async (base) => {
    const names = ["godot-solana", "gamba", "preset", "ritarena", "xandeum", "pst",
      "core-attributes", "access-protocol", "idosgames-wallet", "security-auditing-skill",
      "sentio-cli", "solguard", "solana-slam", "arcium"];
    for (const name of names) {
      const response = await getJson(base, `/api/sdk/${name}?gameId=neonrelay`);
      assert.equal(response.status, 200, name);
      assert.equal(response.json.game_id, "neonrelay");
      assert.equal(response.json.status, "adapter-contract");
      assert.equal(response.json.secrets_client_only, true);
    }
  }));

test("configured Watchtower ingestion requires a constant-time bearer credential", async () => {
  const token = "watchtower-test-token-0123456789abcdef";
  const { app, base } = await startTestApp({ watchtowerIngestToken: token });
  try {
    const body = { event_type: "match_start", external_id: "auth-1", mode: "race" };
    const missing = await postJson(base, "/api/ingest/solana", body);
    assert.equal(missing.status, 401);
    assert.equal(missing.json.error.code, "watchtower-auth-required");
    const wrong = await postJson(base, "/api/ingest/solana", body, "wrong-token");
    assert.equal(wrong.status, 401);
    assert.equal(wrong.json.error.code, "watchtower-auth-invalid");
    const accepted = await postJson(base, "/api/ingest/solana", body, token);
    assert.equal(accepted.status, 200);
    assert.equal(accepted.json.accepted, 1);
  } finally {
    await app.close();
  }
});

test("telemetry is idempotent and late-binds earlier external events", () =>
  withApp(async (base, db) => {
    const first = await postJson(base, "/api/ingest/solana", {
      event_type: "match_start", external_id: "click-42", mode: "race",
      result: { map: "chrome" },
    });
    assert.equal(first.status, 200);
    assert.equal(first.json.accepted, 1);
    const second = await postJson(base, "/api/ingest/solana", {
      event_type: "match_end", external_id: "click-42", solana_wallet: "wallet-public-key",
      match_id: "match-1", mode: "race", result: { place: 1 },
    });
    assert.equal(second.status, 200);
    assert.equal(second.json.accepted, 1);
    const rows = db.all(
      "SELECT event_type, solana_wallet FROM watchtower_events WHERE external_id = ? ORDER BY event_type", "click-42") as { event_type: string; solana_wallet: string | null }[];
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!.solana_wallet, "wallet-public-key");
    assert.equal(rows[1]!.solana_wallet, "wallet-public-key");
    const retry = await postJson(base, "/api/ingest/solana", {
      event_type: "match_end", external_id: "click-42", solana_wallet: "wallet-public-key",
      match_id: "match-1", mode: "race", result: { place: 1 },
    });
    assert.equal(retry.status, 200);
    assert.equal(retry.json.accepted, 0);
    assert.equal(retry.json.results[0].status, "duplicate");
  }));

test("Solana indexer envelopes map into session telemetry", () =>
  withApp(async (base, db) => {
    const response = await postJson(base, "/api/ingest/solana", {
      cluster: "devnet", slot: 1, signature: "test-neon-1",
      programId: "NEONRELAY_REWARDS_PROGRAM_ID", eventType: "RaceStarted",
      payload: { gameId: "neonrelay", playerKey: "test" },
    });
    assert.equal(response.status, 200);
    assert.equal(response.json.accepted, 1);
    assert.equal(response.json.results[0].status, "accepted");
    const row = db.get(
      "SELECT event_type, metadata_json FROM watchtower_events WHERE id = ?", response.json.results[0].id) as { event_type: string; metadata_json: string } | undefined;
    assert.equal(row?.event_type, "match_start");
    assert.match(row?.metadata_json ?? "", /test-neon-1/);
    const canonical = await getJson(base, "/watchtower/events/test-neon-1");
    assert.equal(canonical.status, 200);
    assert.equal(canonical.json.data.signature, "test-neon-1");
    assert.equal(canonical.json.data.telemetryType, "match_start");
  }));

test("hub ingestion alias reports accepted then duplicate for a replayed single event", () =>
  withApp(async (base) => {
    const first = await postJson(base, "/api/games/neonrelay/ingestion", {
      cluster: "devnet", slot: 7, signature: "hub-ingest-1",
      programId: "NEONRELAY_REWARDS_PROGRAM_ID", eventType: "RaceStarted",
      payload: { gameId: "neonrelay", playerKey: "hub-player" },
    });
    assert.equal(first.status, 200);
    assert.equal(first.json.accepted, true);
    assert.equal(first.json.duplicate, false);
    const second = await postJson(base, "/api/games/neonrelay/ingestion", {
      cluster: "devnet", slot: 7, signature: "hub-ingest-1",
      programId: "NEONRELAY_REWARDS_PROGRAM_ID", eventType: "RaceStarted",
      payload: { gameId: "neonrelay", playerKey: "hub-player" },
    });
    assert.equal(second.status, 200);
    assert.equal(second.json.accepted, false);
    assert.equal(second.json.duplicate, true);
    const contract = await getJson(base, "/api/games/neonrelay/ingestion");
    assert.equal(contract.status, 200);
    assert.equal(contract.json.endpoint, "/api/ingest/solana");
  }));

test("telemetry rejects unknown event types and reports the full contract", () =>
  withApp(async (base) => {
    const contract = await getJson(base, "/api/ingest/solana");
    assert.equal(contract.status, 200);
    assert.deepEqual(contract.json.event_types, TELEMETRY_EVENT_TYPES);
    const invalid = await postJson(base, "/api/ingest/solana", { event_type: "mint_money" });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.json.error.code, "bad-telemetry");
  }));
