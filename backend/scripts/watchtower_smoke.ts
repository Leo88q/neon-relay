import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server.ts";
import { loadConfig, type Config } from "../src/config.ts";

function testConfig(overrides: Partial<Config> = {}): Config {
  const dir = mkdtempSync(join(tmpdir(), "neonrelay-watchtower-"));
  return {
    ...loadConfig({}),
    dbPath: join(dir, "neonrelay.db"),
    authDomain: "watchtower-smoke.neonrelay.example",
    challengeTtlMs: 60_000,
    sessionTtlMs: 60_000,
    ...overrides,
  };
}

async function request(base: string, path: string, init?: RequestInit): Promise<any> {
  const response = await fetch(base + path, init);
  const json = await response.json();
  return { status: response.status, json };
}

async function main(): Promise<void> {
  const config = testConfig({
    rewardsProgramId: "2RaaXKUutemHtSZUsmnEv41ytWMkaXD6rcoziHGLRtmj",
    serverSigningPublicKey: "smoke-public-key",
  });
  const dbDir = config.dbPath === ":memory:" ? null : config.dbPath.split("/").slice(0, -1).join("/");
  const app = createApp(config);
  const port = await app.listen(0);
  const base = `http://127.0.0.1:${port}`;
  try {
    console.log(`# Watchtower smoke`);
    console.log(`base=${base}`);

    const accepted = await request(base, "/api/games/neonrelay/ingestion", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        cluster: "devnet",
        slot: 42,
        signature: "watchtower-smoke-1",
        programId: "NEONRELAY_REWARDS_PROGRAM_ID",
        eventType: "RaceStarted",
        payload: { gameId: "neonrelay", playerKey: "smoke-player", mode: "race" },
      }),
    });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.json.accepted, true);
    assert.equal(accepted.json.duplicate, false);
    console.log(`accepted_fresh=${accepted.json.accepted}`);

    const duplicate = await request(base, "/api/games/neonrelay/ingestion", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        cluster: "devnet",
        slot: 42,
        signature: "watchtower-smoke-1",
        programId: "NEONRELAY_REWARDS_PROGRAM_ID",
        eventType: "RaceStarted",
        payload: { gameId: "neonrelay", playerKey: "smoke-player", mode: "race" },
      }),
    });
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.json.accepted, false);
    assert.equal(duplicate.json.duplicate, true);
    console.log(`duplicate_replay=${duplicate.json.duplicate}`);

    const health = await request(base, "/watchtower/health");
    assert.equal(health.status, 200);
    assert.equal(health.json.data.writes, false);
    assert.equal(health.json.network, "solana");
    console.log(`health_writes=${health.json.data.writes}`);

    const configResponse = await request(base, "/watchtower/config");
    assert.equal(configResponse.status, 200);
    assert.equal(configResponse.json.parserVersion, "neonrelay-watchtower-v1");
    console.log(`parser_version=${configResponse.json.parserVersion}`);

    const events = await request(base, "/watchtower/events?limit=10");
    assert.equal(events.status, 200);
    assert.equal(events.json.data.items.length, 1);
    assert.equal(events.json.data.items[0].telemetryType, "match_start");
    console.log(`events_items=${events.json.data.items.length}`);

    const bySignature = await request(base, "/watchtower/events/watchtower-smoke-1");
    assert.equal(bySignature.status, 200);
    assert.equal(bySignature.json.data.signature, "watchtower-smoke-1");
    console.log(`signature_lookup=${bySignature.json.data.signature}`);

    const metrics = await request(base, "/watchtower/metrics/daily?days=7");
    assert.equal(metrics.status, 200);
    assert.equal(metrics.json.network, "solana");
    console.log(`metrics_quality=${metrics.json.dataQuality}`);

    console.log("RESULT: PASS");
  } finally {
    await app.close();
    if (dbDir) rmSync(dbDir, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
