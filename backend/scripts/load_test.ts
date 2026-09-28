/**
 * Load generator for the reward backend (zero runtime dependencies, node:http).
 *
 * Boots the real app in-process (same assembly as production `main()`) and
 * drives it with a keep-alive connection pool. Scenarios model the real
 * traffic shapes, including the deliberately throttled ingest path
 * (`routes.ts`: burst 10, ~5 batch-requests/minute per source IP, up to 500
 * events per batch — batching is mandatory by design):
 *
 *   read    — exporter/config/metrics GETs at full speed (capacity probe)
 *   ingest  — phase A: burst of 10 batches × 50 events (limiter burst window)
 *             phase B: paced 1 batch/2s (sustained shaping must shed with 429)
 *   flood   — everything at maximum rate; success = zero 5xx/network errors,
 *             429 shedding is the correct behavior and is reported, not failed
 *   mixed   — full-speed reads + paced ingest (production-like mix)
 *
 * Profiles:  --profile smoke|standard|soak   (5s / 20s / 300s measured phase)
 * Gate:      --assert  exits non-zero on any hard error (5xx or network) or
 *            when the scenario's conservative floor is missed. 429 is never a
 *            hard error: shedding under overload is a feature (SW-2026-AGI 75).
 *
 * Usage:
 *   node --experimental-strip-types scripts/load_test.ts --profile smoke --assert
 *   node --experimental-strip-types scripts/load_test.ts --scenario read
 *   node --experimental-strip-types scripts/load_test.ts --base http://127.0.0.1:8787
 */
import { request as httpRequest, Agent } from "node:http";
import { parseArgs } from "node:util";
import { loadConfig, type Config } from "../src/config.ts";
import { createApp, type App } from "../src/server.ts";

const PROFILES = {
  smoke: { durationMs: 5_000, warmupMs: 1_000, concurrency: 8 },
  standard: { durationMs: 20_000, warmupMs: 2_000, concurrency: 32 },
  soak: { durationMs: 300_000, warmupMs: 5_000, concurrency: 64 },
} as const;

type ProfileName = keyof typeof PROFILES;
type Scenario = "read" | "ingest" | "flood" | "mixed";

const INGEST_TOKEN = "load-test-ingest-token-0123456789abcdef";
const MEMORY_KEY = "load-test-memory-key-0123456789abcdef012345";
const READ_PATHS = ["/watchtower/events?limit=25", "/api/os/config", "/watchtower/metrics/daily"];

interface Sample { ms: number; status: number; kind: "ok" | "shaped" | "hard-error" }
interface Tally {
  samples: Sample[];
  acceptedEvents: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      profile: { type: "string", default: "smoke" },
      scenario: { type: "string", default: "mixed" },
      duration: { type: "string" },
      concurrency: { type: "string" },
      base: { type: "string" },
      db: { type: "string", default: ":memory:" },
      assert: { type: "boolean", default: false },
    },
  });

  const profileName = values.profile as ProfileName;
  const profile = PROFILES[profileName];
  if (!profile) throw new Error(`unknown profile ${values.profile}`);
  const scenario = values.scenario as Scenario;
  if (!["read", "ingest", "flood", "mixed"].includes(scenario)) {
    throw new Error(`unknown scenario ${values.scenario}`);
  }
  const durationMs = values.duration ? Number(values.duration) * 1000 : profile.durationMs;
  const concurrency = values.concurrency ? Number(values.concurrency) : profile.concurrency;

  let app: App | null = null;
  let base = values.base ?? "";
  if (!base) {
    const config: Config = {
      ...loadConfig({}),
      dbPath: values.db,
      authDomain: "load.neonrelay.test",
      watchtowerIngestToken: INGEST_TOKEN,
      watchtowerMemoryKey: MEMORY_KEY,
    };
    app = createApp(config);
    base = `http://127.0.0.1:${await app.listen(0)}`;
  }
  const target = new URL(base);
  const agent = new Agent({ keepAlive: true, maxSockets: concurrency });
  const tally: Tally = { samples: [], acceptedEvents: 0 };
  let seq = 0;       // ingest event ids
  let reqIdx = 0;    // per-request counter for mix decisions (reads included)

  function send(kind: "read" | "ingest", batchEvents = 50): Promise<Sample> {
    reqIdx += 1;
    let method = "GET";
    let path = READ_PATHS[seq % READ_PATHS.length]!;
    let body: string | undefined;
    const headers: Record<string, string> = {};
    if (kind === "ingest") {
      method = "POST";
      path = "/api/ingest/solana";
      const events = Array.from({ length: batchEvents }, () => {
        seq += 1;
        return {
          event_type: "match_end",
          external_id: `load-${process.pid}-${seq}`,
          match_id: `m-${seq}`,
          occurred_at: 1_770_000_000_000 + seq,
          metadata: { seq, note: "load-test event" },
        };
      });
      body = JSON.stringify({ events });
      headers["content-type"] = "application/json";
      headers["authorization"] = `Bearer ${INGEST_TOKEN}`;
    }
    return new Promise((resolve) => {
      const started = performance.now();
      const req = httpRequest({
        agent,
        host: target.hostname,
        port: target.port,
        method,
        path,
        headers,
      }, (res) => {
        let accepted = 0;
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          if (kind === "ingest" && res.statusCode === 200) {
            try {
              const json = JSON.parse(Buffer.concat(chunks).toString("utf8"));
              accepted = typeof json.accepted === "number" ? json.accepted : 0;
            } catch { /* counted as 0 */ }
          }
          const status = res.statusCode ?? 0;
          const sample: Sample = {
            ms: performance.now() - started,
            status,
            kind: status < 400 ? "ok" : status === 429 ? "shaped" : "hard-error",
          };
          if (accepted > 0) tally.acceptedEvents += accepted;
          resolve(sample);
        });
      });
      req.on("error", () => resolve({
        ms: performance.now() - started, status: 0, kind: "hard-error",
      }));
      if (body) req.write(body);
      req.end();
    });
  }

  async function record(p: Promise<Sample>): Promise<void> {
    const sample = await p;
    tally.samples.push(sample);
  }

  /** Full-speed workers for `durationMs`. */
  async function phaseMaxRate(ms: number, kind: "read" | "ingest" | "both", recordSamples = true): Promise<void> {
    const stopAt = Date.now() + ms;
    await Promise.all(Array.from({ length: concurrency }, async () => {
      while (Date.now() < stopAt) {
        const pick = kind === "read" ? "read" : kind === "ingest" ? "ingest" : (reqIdx % 4 === 0 ? "ingest" : "read");
        const p = send(pick);
        if (recordSamples) await record(p); else await p;
      }
    }));
  }

  /** Paced ingest: `ratePerSec` batches of `batchEvents`, one worker (serial). */
  async function phasePacedIngest(ms: number, ratePerSec: number, batchEvents: number, recordSamples = true): Promise<void> {
    const stopAt = Date.now() + ms;
    const interval = 1000 / ratePerSec;
    while (Date.now() < stopAt) {
      const slot = performance.now();
      const p = send("ingest", batchEvents);
      if (recordSamples) await record(p); else await p;
      const spent = performance.now() - slot;
      if (spent < interval) await new Promise((r) => setTimeout(r, interval - spent));
    }
  }

  /** True burst: `count` batches in flight at once (the limiter burst window). */
  async function phaseBurstIngest(count: number, batchEvents: number): Promise<void> {
    await Promise.all(Array.from({ length: count }, () => record(send("ingest", batchEvents))));
  }

  // Warmup (never recorded): reads only, so the ingest limiter burst window is
  // intact for the measured ingest phases.
  await phaseMaxRate(profile.warmupMs, "read", false);

  const wallStart = performance.now();
  if (scenario === "read") {
    await phaseMaxRate(durationMs, "read");
  } else if (scenario === "flood") {
    await phaseMaxRate(durationMs, "both");
  } else if (scenario === "ingest") {
    await phaseBurstIngest(10, 50);                  // phase A: exactly the burst window (10 × 50 events)
    await phasePacedIngest(durationMs, 0.5, 50);     // phase B: sustained — limiter must shed the rest
  } else {
    await Promise.all([
      phaseMaxRate(durationMs, "read"),
      phasePacedIngest(durationMs, 1, 50),          // steady ingest while reads saturate
    ]);
  }
  const wallSec = (performance.now() - wallStart) / 1000;

  agent.destroy();
  if (app) await app.close();

  const samples = tally.samples;
  const ok = samples.filter((s) => s.kind === "ok");
  const shaped = samples.filter((s) => s.kind === "shaped");
  const hard = samples.filter((s) => s.kind === "hard-error");
  const lat = ok.map((s) => s.ms).sort((a, b) => a - b);
  const okRps = ok.length / wallSec;

  const fmt = (n: number) => n.toFixed(1);
  console.log(`load_test: profile=${profileName} scenario=${scenario} concurrency=${concurrency} duration=${fmt(wallSec)}s target=${base}`);
  console.log(`  requests : ${samples.length} total — ${ok.length} ok (${fmt(okRps)} req/s), ${shaped.length} shaped (429), ${hard.length} hard errors`);
  console.log(`  latency  : p50=${fmt(percentile(lat, 50))}ms p95=${fmt(percentile(lat, 95))}ms p99=${fmt(percentile(lat, 99))}ms max=${fmt(lat[lat.length - 1] ?? 0)}ms`);
  console.log(`  ingest   : ${tally.acceptedEvents} events accepted (${fmt(tally.acceptedEvents / wallSec)} events/s)`);
  if (shaped.length > 0) {
    console.log(`  shedding : ${fmt((shaped.length / samples.length) * 100)}% of requests answered 429 (limiter held — by design, not a failure)`);
  }

  if (values.assert) {
    const problems: string[] = [];
    if (hard.length > 0) problems.push(`${hard.length} hard errors (5xx/network)`);
    if (samples.length === 0) problems.push("no requests completed");
    // Conservative floors for shared CI runners (measured locally by far above).
    if (scenario === "read" && okRps < 200) problems.push(`read throughput ${fmt(okRps)} req/s below smoke floor 200`);
    if (scenario === "ingest" && tally.acceptedEvents < 400) {
      problems.push(`ingest burst accepted ${tally.acceptedEvents} events, expected ≥400 (limiter burst window)`);
    }
    if (scenario === "mixed" && okRps < 100) problems.push(`mixed throughput ${fmt(okRps)} req/s below smoke floor 100`);
    if (scenario === "flood" && shaped.length === 0) {
      problems.push("flood produced no 429 shedding — the ingest limiter is gone");
    }
    if (problems.length > 0) {
      console.error(`load_test: FAIL — ${problems.join("; ")}`);
      process.exit(1);
    }
    console.log(`load_test: PASS (0 hard errors, scenario floors met)`);
  }
}

await main();
