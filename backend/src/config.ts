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
  economyProgramId: string | null;
  skrMint: string | null;
  potatoMint: string | null;
}

const num = (value: string | undefined, fallback: number): number => {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`invalid numeric environment value: ${value}`);
  }
  return parsed;
};

function mintAddress(value: string | undefined, name: string): string | null {
  if (value === undefined || value === "") return null;
  try {
    if (value.length < 32 || value.length > 44) throw new Error();
    const raw = base58Decode(value);
    if (raw.length !== 32 || raw.every((byte) => byte === 0) || base58Encode(raw) !== value) throw new Error();
  } catch {
    throw new Error(`${name} must be a canonical nonzero 32-byte base58 public key`);
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const skrMint = mintAddress(env.NEONRELAY_SKR_MINT, "NEONRELAY_SKR_MINT");
  const potatoMint = mintAddress(env.NEONRELAY_POTATO_MINT, "NEONRELAY_POTATO_MINT");
  if (skrMint !== null && skrMint === potatoMint) throw new Error("SKR and POTATO must use distinct mints");
  // Tranche-A fail-fast: the .example placeholder domain must never authenticate
  // real wallets. Production refuses to boot without an explicit domain.
  const production = env.NODE_ENV === "production";
  const authDomain = env.NEONRELAY_AUTH_DOMAIN;
  if (authDomain === undefined || authDomain === "") {
    if (production) {
      throw new Error("NEONRELAY_AUTH_DOMAIN must be set in production (refusing the .example placeholder)");
    }
  } else if (production && authDomain.endsWith(".example")) {
    throw new Error("NEONRELAY_AUTH_DOMAIN must not use the .example placeholder in production");
  }
  return {
    port: num(env.PORT, 8787),
    dbPath: env.NEONRELAY_DB ?? "var/neonrelay.db",
    authDomain: authDomain ?? "neonrelay.leo88q.example",
    challengeTtlMs: num(env.NEONRELAY_CHALLENGE_TTL_MS, 120_000),
    sessionTtlMs: num(env.NEONRELAY_SESSION_TTL_MS, 12 * 60 * 60 * 1000),
    version: env.npm_package_version ?? "0.1.0",
    serverSigningPublicKey: env.NEONRELAY_SERVER_SIGNING_PUBLIC_KEY ?? null,
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
    economyProgramId: env.NEONRELAY_ECONOMY_PROGRAM_ID ?? null,
    // Operator-set SKR mint (Solana Mobile Seeker token). Never hardcoded;
    // devnet runs use a labelled test mint (BL-16).
    skrMint,
    potatoMint,
  };
}
