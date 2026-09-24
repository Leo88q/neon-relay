/**
 * Watchtower OS v3: a small, dependency-free contract catalog for Neon Relay.
 *
 * This file is deliberately a catalog and adapter boundary, not a claim that
 * third-party services are installed or that a free tier is a production SLA.
 * Providers are selected by the deployment operator and can be replaced behind
 * these stable interfaces. Secrets, wallet keys, and provider credentials are
 * never returned by the API.
 */
import { createHash, randomUUID } from "node:crypto";
import type { Config } from "./config.ts";
import type { Db } from "./db.ts";

export const WATCHTOWER_VERSION = "v3";
export const WATCHTOWER_GAME_ID = "neonrelay";
export const WATCHTOWER_TENANT = "neonrelay";
export const WATCHTOWER_NETWORK = "solana";
export const WATCHTOWER_STAGE = "prototype";
export const WATCHTOWER_SOURCE = "neonrelay-backend";
export const WATCHTOWER_PARSER_VERSION = "neonrelay-watchtower-v1";

/** Exactly 33 runtime components. Providers in one row are intentionally
 * deduplicated where they serve the same boundary (for example DAS/Sorada
 * reads and the Shyft/Timescale/Redis indexing path). */
export const WATCHTOWER_COMPONENTS = [
  { id: "identity-phantom-oauth", category: "identity", name: "Phantom OAuth", providers: ["Phantom OAuth"], free_tier: true, contract: "oauth -> wallet public key; no private key" },
  { id: "identity-mwa", category: "identity", name: "Mobile Wallet Adapter", providers: ["MWA", "Solana Mobile Wallet Adapter"], free_tier: true, contract: "deep link / approve / signed message" },
  { id: "identity-firststep-guest", category: "identity", name: "FirstStep guest identity", providers: ["FirstStep"], free_tier: true, contract: "guest -> upgradeable wallet binding" },
  { id: "identity-privy-embedded", category: "identity", name: "Privy embedded wallet", providers: ["Privy"], free_tier: true, contract: "embedded wallet linked to a user-controlled account" },
  { id: "identity-cross-game-pda", category: "identity", name: "Cross-game studio profile PDA", providers: ["studio_profile PDA", "cross-game identity"], free_tier: true, contract: "stable profile key; explicit wallet linking only" },
  { id: "identity-session-keys", category: "identity", name: "Session Keys", providers: ["CgInv", "SessKeys"], free_tier: true, contract: "move / boost / finish only; scoped, expiring, revocable" },
  { id: "assets-bubblegum", category: "assets", name: "Bubblegum v2 compressed assets", providers: ["Bubblegum v2", "Merkle Tree"], free_tier: true, contract: "common skins, tracks and emotes; operator-supplied tree" },
  { id: "assets-core", category: "assets", name: "MPL Core standard assets", providers: ["MPL Core", "Standard NFT"], free_tier: true, contract: "rare skins and founder badge; authority and update rules audited" },
  { id: "assets-das-sorada", category: "assets", name: "DAS fast asset reads", providers: ["DAS", "Sorada"], free_tier: true, contract: "inventory / ownership read adapter; latency is deployment-specific and unverified" },
  { id: "state-xandeum", category: "state", name: "Scalable race state", providers: ["Xandeum"], free_tier: true, contract: "large state adapter; final authority remains the race server" },
  { id: "economy-gamba", category: "economy", name: "Ticket, wager and jackpot", providers: ["Gamba", "GambaUi"], free_tier: true, contract: "useGamba / usePlay / useWager / WagerInput / GameResult / Jackpot" },
  { id: "bots-husks", category: "gameplay", name: "Race AI bots", providers: ["Husks"], free_tier: true, contract: "deterministic bot seed; never eligible for player rewards" },
  { id: "tournaments-ritarena", category: "gameplay", name: "Racing tournaments", providers: ["RitArena"], free_tier: true, contract: "create -> join -> run -> retry -> settle lifecycle" },
  { id: "ecs-arc", category: "gameplay", name: "ARC Entity race model", providers: ["ARC Entity"], free_tier: true, contract: "track entity with Position, Velocity, Owner, Item components" },
  { id: "ecs-bolt", category: "gameplay", name: "Bolt FOCG race systems", providers: ["Bolt FOCG"], free_tier: true, contract: "MovementSystem and RaceSystem; start_race / finish_race" },
  { id: "depin-race", category: "infrastructure", name: "DePIN race workers", providers: ["DePIN"], free_tier: true, contract: "physics, matchmaking and leaderboard workers; stake policy is operator-set" },
  { id: "privacy-arcium", category: "privacy", name: "Confidential payment adapter", providers: ["Arcium", "Arcium Rollups"], free_tier: true, contract: "private wager/payment payload; public settlement receipt" },
  { id: "privacy-pst", category: "privacy", name: "Private verifiable state", providers: ["PST"], free_tier: true, contract: "private proof envelope; verifier and replay protection required" },
  { id: "attributes", category: "assets", name: "On-chain key-value attributes", providers: ["Core Attributes"], free_tier: true, contract: "readable fastest-lap and asset attributes" },
  { id: "preset", category: "infrastructure", name: "Official racing scaffold", providers: ["Preset"], free_tier: true, contract: "versioned deployment template; no credentials in the template" },
  { id: "realtime-actix", category: "infrastructure", name: "High-performance realtime service", providers: ["Rust Actix"], free_tier: true, contract: "authoritative tick, websocket fan-out and backpressure" },
  { id: "access-protocol", category: "monetization", name: "Premium access", providers: ["Access Protocol"], free_tier: true, contract: "stake-to-access tracks/skins; access is not reward eligibility" },
  { id: "idosgames-race", category: "cross-chain", name: "RewardPool bridge", providers: ["idosgames", "RACE"], free_tier: true, contract: "EVM <-> Solana asset link; replay-safe bridge message" },
  { id: "l2-sonic-hypergrid", category: "l2", name: "Dedicated high-frequency grid", providers: ["Sonic Atomic SVM", "HyperGrid"], free_tier: true, contract: "isolated per-game execution for high TPS; Solana fallback" },
  { id: "l2-rush", category: "l2", name: "Declarative ECS runtime", providers: ["Rush ECS"], free_tier: true, contract: "world/entity config compiled to the selected runtime" },
  { id: "l2-repla", category: "l2", name: "Game rollup settlement", providers: ["REPLA"], free_tier: true, contract: "sequencer -> Solana Anchor settlement; no client authority" },
  { id: "l2-magicblock-er", category: "l2", name: "Ephemeral Rollups", providers: ["MagicBlock ER"], free_tier: true, contract: "delegate_account -> execute_in_er -> commit_state" },
  { id: "l2-magic-actions", category: "l2", name: "Automated game actions", providers: ["Magic Actions"], free_tier: true, contract: "settle race, level-up and tournament jobs; idempotent triggers" },
  { id: "indexer-laserstream", category: "indexing", name: "Program event stream", providers: ["LaserStream gRPC"], free_tier: true, contract: "rewards, ARC, Bolt, DePIN, Gamba, Husks and RitArena events" },
  { id: "indexer-shyft-pg-redis", category: "indexing", name: "Callbacks and read model", providers: ["Shyft", "PostgreSQL/TimescaleDB", "Redis"], free_tier: true, contract: "NFT callbacks -> durable time series -> bounded cache" },
  { id: "analytics-helika-gamesight", category: "analytics", name: "Attribution and LiveOps", providers: ["Helika", "GameSight"], free_tier: true, contract: "ad_click -> wallet -> mint funnel with late ID binding" },
  { id: "analytics-game-signals", category: "analytics", name: "Cross-game ML signals", providers: ["Game Signals ML"], free_tier: true, contract: "churn risk and campaign proposal; no automated payout decision" },
  { id: "marketplace-security", category: "marketplace-security", name: "Marketplace and security gates", providers: ["ME", "GameShift", "Tensor", "Security Auditing Skill", "Sentio", "SolGuard", "SLAM", "relayzero", "StealthSDK"], free_tier: true, contract: "listing/payments adapters plus static, simulation and privacy audit gates" },
] as const;

/**
 * Keep upgrades safe for installations that already recorded migration 0009
 * before Watchtower was enabled. New databases also get these objects from
 * 0009_beta_operations.sql. CREATE IF NOT EXISTS makes this a no-op there.
 */
export function ensureWatchtowerSchema(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS watchtower_events (
    id TEXT PRIMARY KEY,
    idempotency_hash TEXT NOT NULL UNIQUE,
    event_type TEXT NOT NULL,
    external_id TEXT,
    solana_wallet TEXT,
    wallet_id TEXT,
    session_id TEXT,
    match_id TEXT,
    mode TEXT,
    result_json TEXT,
    metadata_json TEXT,
    occurred_at INTEGER NOT NULL,
    received_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS watchtower_events_time ON watchtower_events (event_type, occurred_at);
  CREATE INDEX IF NOT EXISTS watchtower_events_external ON watchtower_events (external_id, occurred_at);
  CREATE INDEX IF NOT EXISTS watchtower_events_wallet ON watchtower_events (solana_wallet, occurred_at);
  CREATE TABLE IF NOT EXISTS watchtower_identity_links (
    external_id TEXT PRIMARY KEY,
    solana_wallet TEXT,
    wallet_id TEXT,
    first_seen_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL
  ) STRICT;`);
}

export const TELEMETRY_EVENT_TYPES = [
  "match_start", "match_end", "session_start", "session_end", "disconnect",
  "first_finish", "first_claim", "client_crash", "race", "anti_cheat",
  "map", "speedrun", "checkpoint", "anomalies", "reward_velocity",
  "pay_without_play", "play_without_pay", "ticket_claim_conversion",
  "vault_forecast", "reward_pipeline_age", "failed_tx_rate",
] as const;

export type WatchtowerTelemetryType = typeof TELEMETRY_EVENT_TYPES[number];

export interface TelemetryInput {
  event_type: WatchtowerTelemetryType;
  external_id?: string | null;
  solana_wallet?: string | null;
  wallet_id?: string | null;
  session_id?: string | null;
  match_id?: string | null;
  mode?: string | null;
  result?: unknown;
  occurred_at?: number;
  metadata?: unknown;
}

/**
 * Accept the indexer envelope used by LaserStream/Shyft smoke tests as well as
 * the normalized analytics event shape. Indexer fields are retained in bounded
 * metadata, while eventType is mapped into the telemetry vocabulary.
 */
export function normalizeSolanaEvent(input: unknown): TelemetryInput {
  if (!input || typeof input !== "object") throw new Error("event must be an object");
  const value = input as Record<string, unknown>;
  if (typeof value.event_type === "string") return value as unknown as TelemetryInput;
  if (typeof value.eventType !== "string") throw new Error("event_type or eventType is required");
  const eventMap: Record<string, WatchtowerTelemetryType> = {
    RaceStarted: "match_start",
    MatchStarted: "match_start",
    RaceFinished: "match_end",
    MatchFinished: "match_end",
    Disconnected: "disconnect",
    FirstFinish: "first_finish",
    FirstClaim: "first_claim",
    ClientCrash: "client_crash",
  };
  const eventType = eventMap[value.eventType] ?? "race";
  const payload = value.payload && typeof value.payload === "object"
    ? value.payload as Record<string, unknown> : {};
  const metadata = {
    source: "solana-indexer",
    cluster: value.cluster ?? "unknown",
    slot: value.slot ?? null,
    signature: value.signature ?? null,
    program_id: value.programId ?? null,
    payload,
  };
  return {
    event_type: eventType,
    external_id: typeof payload.playerKey === "string" ? payload.playerKey : null,
    solana_wallet: typeof payload.solana_wallet === "string" ? payload.solana_wallet : null,
    session_id: typeof payload.sessionId === "string" ? payload.sessionId : null,
    match_id: typeof payload.matchId === "string" ? payload.matchId : null,
    mode: typeof payload.mode === "string" ? payload.mode : null,
    result: payload.result ?? payload,
    occurred_at: typeof payload.occurredAt === "number" ? payload.occurredAt : undefined,
    metadata,
  };
}

const MAX_TEXT = 256;
const text = (value: unknown, field: string, optional = true): string | null => {
  if (value === undefined || value === null || value === "") {
    if (optional) return null;
    throw new Error(`${field} is required`);
  }
  if (typeof value !== "string" || value.length > MAX_TEXT) throw new Error(`${field} is invalid`);
  return value;
};

const jsonValue = (value: unknown, field: string, max = 4096): string | null => {
  if (value === undefined || value === null) return null;
  let encoded: string;
  try {
    encoded = JSON.stringify(value) ?? "null";
  } catch {
    throw new Error(`${field} is not JSON serializable`);
  }
  if (encoded.length > max) throw new Error(`${field} is too large`);
  return encoded;
};

function normalized(input: TelemetryInput, now: number): {
  eventType: WatchtowerTelemetryType; externalId: string | null; wallet: string | null;
  walletId: string | null; sessionId: string | null; matchId: string | null; mode: string | null;
  result: string | null; metadata: string | null; occurredAt: number;
} {
  if (!(TELEMETRY_EVENT_TYPES as readonly string[]).includes(input.event_type)) {
    throw new Error("event_type is not supported by Watchtower OS v3");
  }
  const occurredAt = input.occurred_at ?? now;
  if (!Number.isSafeInteger(occurredAt) || occurredAt < 0) throw new Error("occurred_at is invalid");
  return {
    eventType: input.event_type,
    externalId: text(input.external_id, "external_id"),
    wallet: text(input.solana_wallet, "solana_wallet"),
    walletId: text(input.wallet_id, "wallet_id"),
    sessionId: text(input.session_id, "session_id"),
    matchId: text(input.match_id, "match_id"),
    mode: text(input.mode, "mode"),
    result: jsonValue(input.result, "result"),
    metadata: jsonValue(input.metadata, "metadata"),
    occurredAt,
  };
}

/** Ingests at-least-once telemetry. The unique digest makes retries harmless. */
export function ingestWatchtowerEvent(db: Db, input: TelemetryInput, now = Date.now()):
  { id: string; idempotency_hash: string; status: "accepted" | "duplicate"; late_bound: boolean } {
  const item = normalized(input, now);
  // An omitted occurred_at is filled for storage, but must not make a retry
  // hash differently a few milliseconds later. Preserve the distinction in
  // the digest while using the receive time as the stored occurrence time.
  const digestItem = { ...item, occurredAt: input.occurred_at ?? null };
  const digest = createHash("sha256").update(JSON.stringify(digestItem)).digest("hex");
  const existing = db.get<{ id: string }>(
    "SELECT id FROM watchtower_events WHERE idempotency_hash = ?", digest);
  if (existing) return { id: existing.id, idempotency_hash: digest, status: "duplicate", late_bound: false };
  const id = randomUUID();
  const lateBound = item.wallet !== null && item.externalId !== null;
  db.run(`INSERT INTO watchtower_events
    (id, idempotency_hash, event_type, external_id, solana_wallet, wallet_id,
     session_id, match_id, mode, result_json, metadata_json, occurred_at, received_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  id, digest, item.eventType, item.externalId, item.wallet, item.walletId,
  item.sessionId, item.matchId, item.mode, item.result, item.metadata, item.occurredAt, now);
  if (item.externalId !== null && item.wallet !== null) {
    db.run(`UPDATE watchtower_events SET solana_wallet = ?, wallet_id = COALESCE(wallet_id, ?)
      WHERE external_id = ? AND solana_wallet IS NULL`, item.wallet, item.walletId, item.externalId);
    db.run(`INSERT INTO watchtower_identity_links (external_id, solana_wallet, wallet_id, first_seen_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(external_id) DO UPDATE SET solana_wallet = excluded.solana_wallet,
        wallet_id = COALESCE(excluded.wallet_id, watchtower_identity_links.wallet_id), last_seen_at = excluded.last_seen_at`,
    item.externalId, item.wallet, item.walletId, now, now);
  } else if (item.externalId !== null) {
    db.run(`INSERT INTO watchtower_identity_links (external_id, solana_wallet, wallet_id, first_seen_at, last_seen_at)
      VALUES (?, NULL, ?, ?, ?)
      ON CONFLICT(external_id) DO UPDATE SET wallet_id = COALESCE(excluded.wallet_id, watchtower_identity_links.wallet_id), last_seen_at = excluded.last_seen_at`,
    item.externalId, item.walletId, now, now);
    const link = db.get<{ solana_wallet: string | null; wallet_id: string | null }>(
      "SELECT solana_wallet, wallet_id FROM watchtower_identity_links WHERE external_id = ?", item.externalId);
    if (link?.solana_wallet !== null && link?.solana_wallet !== undefined) {
      db.run("UPDATE watchtower_events SET solana_wallet = ?, wallet_id = COALESCE(wallet_id, ?) WHERE external_id = ? AND solana_wallet IS NULL",
        link.solana_wallet, link.wallet_id, item.externalId);
    }
  }
  return { id, idempotency_hash: digest, status: "accepted", late_bound: lateBound };
}

export function watchtowerConfig(config: Config): Record<string, unknown> {
  return {
    version: WATCHTOWER_VERSION,
    game_id: WATCHTOWER_GAME_ID,
    tenant: WATCHTOWER_TENANT,
    component_count: WATCHTOWER_COMPONENTS.length,
    component_status: "contract-only; providers and SLAs are unverified",
    components: WATCHTOWER_COMPONENTS,
    program_ids: {
      rewards: config.rewardsProgramId ?? "NEONRELAY_REWARDS_PROGRAM_ID",
      features: config.featuresProgramId ?? "NEONRELAY_FEATURES_PROGRAM_ID",
      economy: config.economyProgramId ?? "NEONRELAY_ECONOMY_PROGRAM_ID",
      assets: config.assetsProgramId ?? "NEONRELAY_ASSETS_PROGRAM_ID",
      identity: process.env.NEONRELAY_IDENTITY_PROGRAM_ID ?? "CgInv",
      session_keys: process.env.NEONRELAY_SESSION_KEYS_PROGRAM_ID ?? "SessKeys",
      treasury: process.env.NEONRELAY_TREASURY_PROGRAM_ID ?? "STrEaSuRy",
    },
    mints: {
      reward: config.rewardMint ?? "NEONRELAY_REWARD_MINT",
      skr: config.skrMint ?? "NEONRELAY_SKR_MINT",
      potato: config.potatoMint ?? "NEONRELAY_POTATO_MINT",
    },
    identity: {
      providers: ["Phantom OAuth", "MWA deep links", "FirstStep guest", "Privy embedded"],
      cross_game_pda: "studio_profile",
      session_key_actions: ["move", "boost", "finish", "race_session"],
      wallet_secrets_client_only: true,
    },
    assets: {
      common: { standard: "external compressed-asset adapter (disabled by default)", status: "unverified" },
      rare: { standard: "external MPL Core adapter (disabled by default)", founder_badge: true, status: "unverified" },
      stats: "Core Attributes adapter (unverified)",
      reads: "DAS adapter (operator-supplied; unverified)",
    },
    race_model: {
      arc_entity: {
        entity: "race_track",
        components: ["Position", "Velocity", "Owner", "Item"],
        source_game: WATCHTOWER_GAME_ID,
        fields: ["is_cnft", "asset_id"],
        systems: ["MovementSystem", "RaceSystem"],
      },
      bolt: {
        systems: ["MovementSystem", "RaceSystem"],
        instructions: ["start_race", "finish_race"],
        race_result: "RaceResult",
        player: "Player",
        lifecycle: ["init", "build", "deploy", "world", "createEntity", "addComponent", "executeSystem"],
      },
      depin: { worker_stake_sol: 10, escrow_sol_per_100_players: 0.1, policy: "operator-set; not transferred by this API" },
    },
    automation: {
      magic_actions: ["harvest", "account_change", "level_up", "grant_reward", "match_end_settle"],
      cron_every_minutes: 5,
      husks: "auto battle jobs",
      ritarena: "auto tournament jobs with retry",
      idempotency_required: true,
    },
    telemetry: {
      event_types: TELEMETRY_EVENT_TYPES,
      identity: "solana_wallet as external_id with late ID binding",
      retention: "operator configured; raw payloads are bounded",
    },
    security: {
      server_authoritative: true,
      reward_eligibility_server_only: true,
      client_crash_is_observable_not_rewardable: true,
      audit_gates: ["Security Auditing Skill", "Sentio", "SolGuard", "SLAM"],
    },
  };
}

export function routeL2(gameId: string, tps: string, ux: string): Record<string, unknown> {
  const highFrequency = tps === "high" || tps === "very_high";
  const gasless = ux === "gasless";
  const execution = highFrequency ? "HyperGrid" : "Solana mainnet";
  return {
    game_id: gameId,
    requested: { tps, ux },
    decision: highFrequency
      ? "dedicated Sonic HyperGrid per game; no shared game contention"
      : "Solana mainnet with the standard RPC pool",
    execution_layer: execution,
    network: "Sonic Atomic SVM",
    isolation: highFrequency ? "dedicated-grid" : "shared-mainnet",
    concurrency: highFrequency ? "thousands of simultaneous action endpoints" : "standard Solana concurrency",
    gasless_path: gasless ? ["MagicBlock ER", "delegate_account", "execute_in_er", "commit_state"] : [],
    privacy_layer: "Arcium",
    private_verification: "PST",
    state_layer: "Xandeum",
    read_layer: "Sorada",
    fallback: "Solana mainnet",
    status: "adapter-contract-unverified",
    enabled: false,
    endpoint_source: "operator-supplied; no provider endpoint is configured by this repository",
    endpoints: null,
    monitoring: ["tps", "p50_latency", "p99_latency", "grid_health", "commit_lag", "fallback_rate"],
  };
}

const SDK_CONTRACTS: Record<string, { provider: string; free_tier: boolean; purpose: string; install: string }> = {
  "godot-solana": { provider: "Godot SolanaClient / WalletAdapter / AnchorProgram", free_tier: true, purpose: "Godot identity, session keys and server-authoritative race actions", install: "copy integrations/godot/neonrelay_client.gd" },
  gamba: { provider: "Gamba", free_tier: true, purpose: "ticket/wager/prize epoch/jackpot adapter", install: "useGamba/usePlay/useWager + GambaUi" },
  preset: { provider: "Preset", free_tier: true, purpose: "official racing scaffold", install: "operator-selected preset; pin the version" },
  ritarena: { provider: "RitArena", free_tier: true, purpose: "tournament lifecycle with retryable events", install: "adapter contract in WATCHTOWER_INTEGRATION.md" },
  xandeum: { provider: "Xandeum", free_tier: true, purpose: "scalable race-state adapter", install: "server-side state projection" },
  pst: { provider: "PST", free_tier: true, purpose: "private verifiable proof envelope", install: "server verifier only" },
  "core-attributes": { provider: "Core Attributes", free_tier: true, purpose: "on-chain readable fastest-lap key/value", install: "DAS read adapter" },
  "access-protocol": { provider: "Access Protocol", free_tier: true, purpose: "premium tracks and skins stake gate", install: "read-only access check" },
  "idosgames-wallet": { provider: "idosgames RewardPool", free_tier: true, purpose: "EVM/Solana wallet and bridge adapter", install: "bridge intent + receipt verifier" },
  "security-auditing-skill": { provider: "Security Auditing Skill", free_tier: true, purpose: "systematic pre-deploy audit checklist", install: "docs/SECURITY_AUDITING_SKILL.md" },
  "sentio-cli": { provider: "Sentio", free_tier: true, purpose: "contract/runtime observability", install: "operator CLI, credentials outside repo" },
  solguard: { provider: "SolGuard", free_tier: true, purpose: "static security checks", install: "CI-only adapter" },
  "solana-slam": { provider: "SLAM / LiteSVM", free_tier: true, purpose: "offline Solana program tests", install: "onchain test harness" },
  arcium: { provider: "Arcium SDK / Rollups", free_tier: true, purpose: "confidential payment and wager payloads", install: "server adapter; public receipt" },
};

export function sdkConfig(name: string, gameId: string): Record<string, unknown> | null {
  const contract = SDK_CONTRACTS[name];
  if (!contract) return null;
  return { game_id: gameId, sdk: name, status: "adapter-contract", ...contract, secrets_client_only: true };
}

export function gameSignalsConfig(gameId: string): Record<string, unknown> {
  return {
    game_id: gameId,
    provider: "Game Signals ML",
    free_tier: true,
    training_reference: "60M+ transactions across 12 games",
    signals: ["churn_14d", "wallet_funnel", "cross_game_retention", "campaign_ltv", "whale_radar"],
    churn: { threshold: 0.7, population_reference: ">85% common-wallet churn analysis" },
    attribution: { primary_external_id: "solana_wallet", late_binding_endpoint: "/api/ingest/solana" },
    model: { baseline: "RandomForest", proposal_endpoint: "/api/campaigns/proposals", human_review_required: true },
    privacy: "wallet identifiers are public keys; do not send seed phrases or OAuth tokens",
  };
}

export function ingestContract(): Record<string, unknown> {
  return {
    game_id: WATCHTOWER_GAME_ID,
    method: ["GET", "POST"],
    endpoint: "/api/ingest/solana",
    required: ["event_type"],
    identity: ["external_id", "solana_wallet", "wallet_id"],
    late_id_binding: true,
    bounded_batch: 500,
    event_types: TELEMETRY_EVENT_TYPES,
    accepted_envelopes: ["normalized analytics event", "LaserStream/Shyft Solana event"],
    example: { event_type: "match_end", external_id: "player-session-1", solana_wallet: "<public-key>", mode: "race", result: { place: 1, fastest_lap_ms: 4210 } },
    solana_example: { cluster: "devnet", slot: 1, signature: "test-neon-1", programId: "NEONRELAY_REWARDS_PROGRAM_ID", eventType: "RaceStarted", payload: { gameId: "neonrelay", playerKey: "test" } },
  };
}
