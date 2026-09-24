import { base58Decode, base58Encode } from "./economy.ts";

/**
 * Neon Relay reward backend — configuration.
 *
 * Everything sensitive or environment specific comes from the environment. No
 * signing key, treasury key or mainnet credential is ever read from source or
 * from this file; stage 6 needs none of them (wallet signatures are verified
 * with the *wallet's* public key, which arrives with the request).
 */

export interface Config {
  /** TCP port for the HTTP API. */
  port: number;
  /** SQLite database file (`:memory:` for tests). */
  dbPath: string;
  /**
   * The domain bound into every wallet challenge. Wallets display it to the
   * user; a challenge for another domain must be rejected (phishing guard).
   */
  authDomain: string;
  /** How long a challenge/nonce lives before it is rejected. */
  challengeTtlMs: number;
  /** Session lifetime; slid on every authenticated request. */
  sessionTtlMs: number;
  /** Product version reported by /v1/health. */
  version: string;
  /**
   * Base64url raw Ed25519 public key of the game servers that sign match
   * events. Without it, reward ingestion is disabled (503) — events can never
   * be accepted on trust alone.
   */
  serverSigningPublicKey: string | null;
  /** Separate server identity attestation key; absent disables verified player links. */
  gameIdentityPublicKey: string | null;
  /** Bearer token for operator routes (epoch sealing). Absent = disabled. */
  adminToken: string | null;
  /**
   * Tranche-A role split. When set, `operatorToken` may create admin
   * proposals and read audit data, while `superadminToken` alone may approve
   * (execute) them. `adminToken` is the legacy single token and acts as a
   * superadmin; configure the two role tokens to enforce separation.
   */
  operatorToken: string | null;
  superadminToken: string | null;
  /** How long a proposed admin action waits for approval before expiring. */
  adminProposalTtlMs: number;
  /** Directory for SQLite hot backups created via POST /v1/admin/backup. */
  backupDir: string;
  /** Epoch length; events are assigned to the epoch open at ingestion time. */
  epochMs: number;
  /** Reward caps, in micro units (1e-6 of the reward mint unit). */
  capPerMatchMicro: number;
  capDailyMicro: number;
  capWeeklyMicro: number;
  rpcUrl: string;
  /**
   * Optional second Solana RPC provider. When set, chain reads fail over
   * to it while the primary is failing (cooldown-bounded) and fail back
   * automatically; both must serve the same chain (genesis-pinned).
   */
  rpcFallbackUrl: string | null;
  /** Per-request RPC timeout (AbortSignal). */
  rpcTimeoutMs: number;
  /** How long a failed RPC endpoint is skipped before being retried. */
  rpcCooldownMs: number;
  /**
   * Optional expected chain identity (base58 genesis hash). When set, any
   * RPC endpoint serving another chain is rejected — the last line of
   * defence against a provider pointed at the wrong cluster.
   */
  expectedGenesisHash: string | null;
  economyProgramId: string | null;
  /** Features/assets program ids used by the deployment and custody gate. */
  featuresProgramId: string | null;
  assetsProgramId: string | null;
  /** Rewards program id for on-chain epoch reconciliation (Tranche B). */
  rewardsProgramId: string | null;
  skrMint: string | null;
  /** Reward mint bound into the rewards Config account and claim verifier. */
  rewardMint: string | null;
  potatoMint: string | null;
  /** Generic JSON webhook for alert digests (optional, Tranche B). */
  alertWebhookUrl: string | null;
  /** Telegram alert sink (optional; both must be set to enable). */
  telegramBotToken: string | null;
  telegramChatId: string | null;
  /** Process environment used for fail-closed production gates. */
  environment: "production" | "development" | "test";
  /** Service credential required by production Watchtower ingestion. */
  watchtowerIngestToken: string | null;
  /** Canonical Solana cluster recorded in the deployment manifest. */
  cluster: "devnet" | "testnet" | "mainnet-beta";
  /** Explicit second gate for paid entry; default is disabled. */
  monetizationEnabled: boolean;
  /** Operator-supplied deployment manifest used by the production gate. */
  deploymentManifestPath: string | null;
}

const num = (value: string | undefined, fallback: number): number => {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`invalid numeric environment value: ${value}`);
  }
  return parsed;
};

function mintAddress(value: string | undefined, name: string, noun = "public key"): string | null {
  if (value === undefined || value === "") return null;
  try {
    if (value.length < 32 || value.length > 44) throw new Error();
    const raw = base58Decode(value);
    if (raw.length !== 32 || raw.every((byte) => byte === 0) || base58Encode(raw) !== value) throw new Error();
  } catch {
    throw new Error(`${name} must be a canonical nonzero 32-byte base58 ${noun}`);
  }
  return value;
}

function serverSigningKey(value: string | undefined): string | null {
  if (value === undefined || value === "") return null;
  try {
    const raw = Buffer.from(value, "base64url");
    if (raw.length !== 32 || raw.toString("base64url") !== value) throw new Error();
  } catch {
    throw new Error("NEONRELAY_SERVER_SIGNING_PUBLIC_KEY must be canonical base64url Ed25519 raw public key");
  }
  return value;
}

function productionRpcUrl(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} must be an explicit https URL in production`);
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" || parsed.hostname === "") throw new Error();
  } catch {
    throw new Error(`${name} must be an explicit https URL in production`);
  }
  return value;
}

function rpcEndpointIdentity(value: string): string {
  const parsed = new URL(value);
  // A different API-key path on the same host is not independent
  // infrastructure; production failover must cross an origin boundary.
  return `${parsed.protocol}//${parsed.host}`;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const skrMint = mintAddress(env.NEONRELAY_SKR_MINT, "NEONRELAY_SKR_MINT");
  const rewardMint = mintAddress(env.NEONRELAY_REWARD_MINT, "NEONRELAY_REWARD_MINT", "reward mint");
  const potatoMint = mintAddress(env.NEONRELAY_POTATO_MINT, "NEONRELAY_POTATO_MINT");
  if (skrMint !== null && skrMint === potatoMint) throw new Error("SKR and POTATO must use distinct mints");
  if (rewardMint !== null && ((skrMint !== null && rewardMint === skrMint) ||
      (potatoMint !== null && rewardMint === potatoMint))) {
    throw new Error("reward and payment mints must use distinct mints");
  }
  // Tranche-A fail-fast: the .example placeholder domain must never authenticate
  // real wallets. Production refuses to boot without an explicit domain.
  const production = env.NODE_ENV === "production";
  const environment = production ? "production" : env.NODE_ENV === "test" ? "test" : "development";
  const authDomain = env.NEONRELAY_AUTH_DOMAIN;
  if (authDomain === undefined || authDomain === "") {
    if (production) {
      throw new Error("NEONRELAY_AUTH_DOMAIN must be set in production (refusing the .example placeholder)");
    }
  } else if (production && authDomain.endsWith(".example")) {
    throw new Error("NEONRELAY_AUTH_DOMAIN must not use the .example placeholder in production");
  }
  const economyProgramId = mintAddress(env.NEONRELAY_ECONOMY_PROGRAM_ID, "NEONRELAY_ECONOMY_PROGRAM_ID", "program id");
  const featuresProgramId = mintAddress(env.NEONRELAY_FEATURES_PROGRAM_ID, "NEONRELAY_FEATURES_PROGRAM_ID", "program id");
  const assetsProgramId = mintAddress(env.NEONRELAY_ASSETS_PROGRAM_ID, "NEONRELAY_ASSETS_PROGRAM_ID", "program id");
  const rewardsProgramId = mintAddress(env.NEONRELAY_REWARDS_PROGRAM_ID, "NEONRELAY_REWARDS_PROGRAM_ID", "program id");
  const expectedGenesisHash = mintAddress(env.NEONRELAY_EXPECTED_GENESIS_HASH, "NEONRELAY_EXPECTED_GENESIS_HASH", "genesis hash");
  const watchtowerIngestToken = env.NEONRELAY_WATCHTOWER_INGEST_TOKEN ?? null;
  if (production && watchtowerIngestToken !== null && watchtowerIngestToken.length < 32) {
    throw new Error("NEONRELAY_WATCHTOWER_INGEST_TOKEN must be at least 32 characters in production");
  }
  const deploymentManifestPath = env.NEONRELAY_DEPLOYMENT_MANIFEST ?? null;
  if (production) {
    const primaryRpc = productionRpcUrl(env.NEONRELAY_RPC_URL, "NEONRELAY_RPC_URL");
    const fallbackRpc = productionRpcUrl(env.NEONRELAY_RPC_FALLBACK_URL, "NEONRELAY_RPC_FALLBACK_URL");
    if (rpcEndpointIdentity(primaryRpc) === rpcEndpointIdentity(fallbackRpc)) {
      throw new Error("NEONRELAY_RPC_FALLBACK_URL must identify distinct RPC infrastructure in production");
    }
  }
  if (production && !env.NEONRELAY_CLUSTER) {
    throw new Error("NEONRELAY_CLUSTER must be explicit in production");
  }
  const clusterValue = env.NEONRELAY_CLUSTER ?? "devnet";
  if (clusterValue !== "devnet" && clusterValue !== "testnet" && clusterValue !== "mainnet-beta") {
    throw new Error("NEONRELAY_CLUSTER must be devnet, testnet, or mainnet-beta");
  }
  const cluster = clusterValue as "devnet" | "testnet" | "mainnet-beta";
  const monetizationEnabled = env.NEONRELAY_MONETIZATION_ENABLED === "1";
  if (production) {
    const missing: string[] = [];
    if (!watchtowerIngestToken) missing.push("NEONRELAY_WATCHTOWER_INGEST_TOKEN");
    if (!serverSigningKey(env.NEONRELAY_SERVER_SIGNING_PUBLIC_KEY)) missing.push("NEONRELAY_SERVER_SIGNING_PUBLIC_KEY");
    if (!economyProgramId) missing.push("NEONRELAY_ECONOMY_PROGRAM_ID");
    if (!featuresProgramId) missing.push("NEONRELAY_FEATURES_PROGRAM_ID");
    if (!assetsProgramId) missing.push("NEONRELAY_ASSETS_PROGRAM_ID");
    if (!rewardsProgramId) missing.push("NEONRELAY_REWARDS_PROGRAM_ID");
    if (!skrMint) missing.push("NEONRELAY_SKR_MINT");
    if (!rewardMint) missing.push("NEONRELAY_REWARD_MINT");
    if (!expectedGenesisHash) missing.push("NEONRELAY_EXPECTED_GENESIS_HASH");
    if (!deploymentManifestPath) missing.push("NEONRELAY_DEPLOYMENT_MANIFEST");
    if (!monetizationEnabled) missing.push("NEONRELAY_MONETIZATION_ENABLED=1");
    if (missing.length > 0) throw new Error(`production configuration is incomplete: ${missing.join(", ")}`);
  }
  return {
    port: num(env.PORT, 8787),
    dbPath: env.NEONRELAY_DB ?? "var/neonrelay.db",
    authDomain: authDomain ?? "neonrelay.leo88q.example",
    challengeTtlMs: num(env.NEONRELAY_CHALLENGE_TTL_MS, 120_000),
    sessionTtlMs: num(env.NEONRELAY_SESSION_TTL_MS, 12 * 60 * 60 * 1000),
    version: env.npm_package_version ?? "0.1.0",
    serverSigningPublicKey: serverSigningKey(env.NEONRELAY_SERVER_SIGNING_PUBLIC_KEY),
    gameIdentityPublicKey: env.NEONRELAY_GAME_IDENTITY_PUBLIC_KEY ?? null,
    adminToken: env.NEONRELAY_ADMIN_TOKEN ?? null,
    operatorToken: env.NEONRELAY_OPERATOR_TOKEN ?? null,
    superadminToken: env.NEONRELAY_SUPERADMIN_TOKEN ?? null,
    adminProposalTtlMs: num(env.NEONRELAY_ADMIN_PROPOSAL_TTL_MS, 24 * 60 * 60 * 1000),
    backupDir: env.NEONRELAY_BACKUP_DIR ?? "var/backups",
    epochMs: num(env.NEONRELAY_EPOCH_MS, 7 * 24 * 60 * 60 * 1000),
    capPerMatchMicro: num(env.NEONRELAY_CAP_PER_MATCH_MICRO, 50_000_000),
    capDailyMicro: num(env.NEONRELAY_CAP_DAILY_MICRO, 250_000_000),
    capWeeklyMicro: num(env.NEONRELAY_CAP_WEEKLY_MICRO, 1_000_000_000),
    // --- economy (stage 15): SKR pay-to-play, docs/PLAY_ECONOMY.md
    rpcUrl: env.NEONRELAY_RPC_URL ?? "https://api.devnet.solana.com",
    rpcFallbackUrl: env.NEONRELAY_RPC_FALLBACK_URL ?? null,
    rpcTimeoutMs: num(env.NEONRELAY_RPC_TIMEOUT_MS, 10_000),
    rpcCooldownMs: num(env.NEONRELAY_RPC_COOLDOWN_MS, 30_000),
    expectedGenesisHash,
    economyProgramId,
    featuresProgramId,
    assetsProgramId,
    rewardsProgramId,
    // Operator-set SKR mint (Solana Mobile Seeker token). Never hardcoded;
    // devnet runs use a labelled test mint (BL-16).
    skrMint,
    rewardMint,
    potatoMint,
    alertWebhookUrl: env.NEONRELAY_ALERT_WEBHOOK_URL ?? null,
    telegramBotToken: env.NEONRELAY_TELEGRAM_BOT_TOKEN ?? null,
    telegramChatId: env.NEONRELAY_TELEGRAM_CHAT_ID ?? null,
    environment,
    watchtowerIngestToken,
    cluster,
    monetizationEnabled,
    deploymentManifestPath,
  };
}
