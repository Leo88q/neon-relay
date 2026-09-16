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
}

const num = (value: string | undefined, fallback: number): number => {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`invalid numeric environment value: ${value}`);
  }
  return parsed;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: num(env.PORT, 8787),
    dbPath: env.NEONRELAY_DB ?? "var/neonrelay.db",
    authDomain: env.NEONRELAY_AUTH_DOMAIN ?? "neonrelay.leo88q.example",
    challengeTtlMs: num(env.NEONRELAY_CHALLENGE_TTL_MS, 120_000),
    sessionTtlMs: num(env.NEONRELAY_SESSION_TTL_MS, 12 * 60 * 60 * 1000),
    version: env.npm_package_version ?? "0.1.0",
  };
}
