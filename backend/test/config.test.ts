/** Tranche-A config tests: auth-domain fail-fast and new admin defaults. */
import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.ts";

test("dev keeps the documented placeholder domain", () => {
  const config = loadConfig({});
  assert.equal(config.authDomain, "neonrelay.leo88q.example");
  assert.equal(config.operatorToken, null);
  assert.equal(config.superadminToken, null);
  assert.equal(config.adminToken, null);
  assert.equal(config.adminProposalTtlMs, 24 * 60 * 60 * 1000);
  assert.equal(config.backupDir, "var/backups");
});

test("production refuses to boot on a missing or placeholder domain", () => {
  assert.throws(() => loadConfig({ NODE_ENV: "production" }), /NEONRELAY_AUTH_DOMAIN/);
  assert.throws(
    () => loadConfig({ NODE_ENV: "production", NEONRELAY_AUTH_DOMAIN: "neonrelay.leo88q.example" }),
    /placeholder/);
  assert.throws(
    () => loadConfig({
      NODE_ENV: "production",
      NEONRELAY_AUTH_DOMAIN: "relay.neonrelay.example.com",
      NEONRELAY_CLUSTER: "mainnet-beta",
      NEONRELAY_RPC_URL: "https://rpc.example.invalid",
    }),
    /production configuration is incomplete|explicit https URL|distinct RPC infrastructure/);
  const signingKey = Buffer.alloc(32, 7).toString("base64url");
  const ok = loadConfig({
    NODE_ENV: "production",
    NEONRELAY_AUTH_DOMAIN: "relay.neonrelay.example.com",
    NEONRELAY_CLUSTER: "mainnet-beta",
    NEONRELAY_RPC_URL: "https://rpc.example.invalid",
    NEONRELAY_RPC_FALLBACK_URL: "https://fallback.example.invalid",
    NEONRELAY_WATCHTOWER_INGEST_TOKEN: "watchtower-secret-0123456789abcdef",
    NEONRELAY_SERVER_SIGNING_PUBLIC_KEY: signingKey,
    NEONRELAY_GAME_IDENTITY_PUBLIC_KEY: signingKey,
    NEONRELAY_OPERATOR_TOKEN: "operator-token-0123456789abcdef-0123456789",
    NEONRELAY_SUPERADMIN_TOKEN: "superadmin-token-0123456789abcdef-0123",
    NEONRELAY_REWARDS_PROGRAM_ID: "2RaaXKUutemHtSZUsmnEv41ytWMkaXD6rcoziHGLRtmj",
    NEONRELAY_FEATURES_PROGRAM_ID: "4PH1dHVBRbfoydBx3SuRjAS46zRRjHvRxWCNcrFBDqYP",
    NEONRELAY_ECONOMY_PROGRAM_ID: "FZcLDdUrs6i1HYFFK2NhqNrbVaP6KTvrqzhyoDGT6CV9",
    NEONRELAY_ASSETS_PROGRAM_ID: "F5VhZxGGEY61TNNexRwJVomMZtHeAZodqVHPMqoxq3oc",
    NEONRELAY_SKR_MINT: "So11111111111111111111111111111111111111112",
    NEONRELAY_REWARD_MINT: "2RaaXKUutemHtSZUsmnEv41ytWMkaXD6rcoziHGLRtmj",
    NEONRELAY_EXPECTED_GENESIS_HASH: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
    NEONRELAY_DEPLOYMENT_MANIFEST: "/etc/neonrelay/deployment.json",
    NEONRELAY_MONETIZATION_ENABLED: "1",
  });
  assert.equal(ok.authDomain, "relay.neonrelay.example.com");
  assert.equal(ok.environment, "production");
  assert.equal(ok.playerLinkRequiresRegistration, true,
    "production must always require operator-provisioned player links (F-11)");
  // F-19: production boot fails fast when the two-person admin plane or the
  // game identity signer is missing, weak, or malformed.
  const productionEnv = {
    NODE_ENV: "production",
    NEONRELAY_AUTH_DOMAIN: "relay.neonrelay.example.com",
    NEONRELAY_CLUSTER: "mainnet-beta",
    NEONRELAY_RPC_URL: "https://rpc.example.invalid",
    NEONRELAY_RPC_FALLBACK_URL: "https://fallback.example.invalid",
    NEONRELAY_WATCHTOWER_INGEST_TOKEN: "watchtower-secret-0123456789abcdef",
    NEONRELAY_SERVER_SIGNING_PUBLIC_KEY: signingKey,
    NEONRELAY_REWARDS_PROGRAM_ID: "2RaaXKUutemHtSZUsmnEv41ytWMkaXD6rcoziHGLRtmj",
    NEONRELAY_FEATURES_PROGRAM_ID: "4PH1dHVBRbfoydBx3SuRjAS46zRRjHvRxWCNcrFBDqYP",
    NEONRELAY_ECONOMY_PROGRAM_ID: "FZcLDdUrs6i1HYFFK2NhqNrbVaP6KTvrqzhyoDGT6CV9",
    NEONRELAY_ASSETS_PROGRAM_ID: "F5VhZxGGEY61TNNexRwJVomMZtHeAZodqVHPMqoxq3oc",
    NEONRELAY_SKR_MINT: "So11111111111111111111111111111111111111112",
    NEONRELAY_REWARD_MINT: "2RaaXKUutemHtSZUsmnEv41ytWMkaXD6rcoziHGLRtmj",
    NEONRELAY_EXPECTED_GENESIS_HASH: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
    NEONRELAY_DEPLOYMENT_MANIFEST: "/etc/neonrelay/deployment.json",
    NEONRELAY_MONETIZATION_ENABLED: "1",
  };
  assert.throws(() => loadConfig(productionEnv),
    /NEONRELAY_GAME_IDENTITY_PUBLIC_KEY|NEONRELAY_OPERATOR_TOKEN|NEONRELAY_SUPERADMIN_TOKEN/);
  assert.throws(() => loadConfig({
    ...productionEnv,
    NEONRELAY_GAME_IDENTITY_PUBLIC_KEY: signingKey,
    NEONRELAY_OPERATOR_TOKEN: "short",
    NEONRELAY_SUPERADMIN_TOKEN: "another-short-token",
  }), /NEONRELAY_OPERATOR_TOKEN|NEONRELAY_SUPERADMIN_TOKEN/);
  assert.throws(() => loadConfig({
    ...productionEnv,
    NEONRELAY_GAME_IDENTITY_PUBLIC_KEY: "not-a-canonical-key",
    NEONRELAY_OPERATOR_TOKEN: "operator-token-0123456789abcdef-0123456789",
    NEONRELAY_SUPERADMIN_TOKEN: "superadmin-token-0123456789abcdef-0123",
  }), /NEONRELAY_GAME_IDENTITY_PUBLIC_KEY/);
  assert.throws(() => loadConfig({
    ...productionEnv,
    NEONRELAY_GAME_IDENTITY_PUBLIC_KEY: signingKey,
    NEONRELAY_OPERATOR_TOKEN: "same-token-0123456789abcdef-0123456789",
    NEONRELAY_SUPERADMIN_TOKEN: "same-token-0123456789abcdef-0123456789",
  }), /distinct/);
  assert.throws(() => loadConfig({
    NODE_ENV: "production",
    NEONRELAY_AUTH_DOMAIN: "relay.neonrelay.example.com",
    NEONRELAY_RPC_URL: "https://same.example.invalid",
    NEONRELAY_RPC_FALLBACK_URL: "https://same.example.invalid/other-api-key",
  }), /distinct RPC infrastructure/);
  assert.throws(() => loadConfig({
    NEONRELAY_SKR_MINT: "So11111111111111111111111111111111111111112",
    NEONRELAY_REWARD_MINT: "So11111111111111111111111111111111111111112",
  }), /reward and payment mints/);
  assert.throws(() => loadConfig({
    NODE_ENV: "production",
    NEONRELAY_AUTH_DOMAIN: "relay.neonrelay.example.com",
    NEONRELAY_WATCHTOWER_INGEST_TOKEN: "short",
  }), /at least 32 characters/);
});

test("rpc failover settings default to a single provider", () => {
  const config = loadConfig({});
  assert.equal(config.rpcUrl, "https://api.devnet.solana.com");
  assert.equal(config.rpcFallbackUrl, null);
  assert.equal(config.rpcTimeoutMs, 10_000);
  assert.equal(config.rpcCooldownMs, 30_000);
  assert.equal(config.expectedGenesisHash, null);
});

test("rpc failover settings load from the environment and validate", () => {
  const config = loadConfig({
    NEONRELAY_RPC_URL: "https://primary.example",
    NEONRELAY_RPC_FALLBACK_URL: "https://fallback.example",
    NEONRELAY_RPC_TIMEOUT_MS: "5000",
    NEONRELAY_RPC_COOLDOWN_MS: "15000",
    NEONRELAY_EXPECTED_GENESIS_HASH: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  });
  assert.equal(config.rpcUrl, "https://primary.example");
  assert.equal(config.rpcFallbackUrl, "https://fallback.example");
  assert.equal(config.rpcTimeoutMs, 5000);
  assert.equal(config.rpcCooldownMs, 15_000);
  assert.equal(config.expectedGenesisHash, "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG");
  assert.throws(() => loadConfig({ NEONRELAY_EXPECTED_GENESIS_HASH: "not-a-hash" }), /genesis hash/);
  assert.throws(() => loadConfig({ NEONRELAY_RPC_TIMEOUT_MS: "0" }), /invalid numeric/);
  assert.throws(() => loadConfig({ NEONRELAY_RPC_COOLDOWN_MS: "soon" }), /invalid numeric/);
});

test("role tokens and backup settings load from the environment", () => {
  const config = loadConfig({
    NEONRELAY_OPERATOR_TOKEN: "op",
    NEONRELAY_SUPERADMIN_TOKEN: "sup",
    NEONRELAY_ADMIN_TOKEN: "legacy",
    NEONRELAY_BACKUP_DIR: "/tmp/nr-backups",
    NEONRELAY_ADMIN_PROPOSAL_TTL_MS: "60000",
  });
  assert.equal(config.operatorToken, "op");
  assert.equal(config.superadminToken, "sup");
  assert.equal(config.adminToken, "legacy");
  assert.equal(config.backupDir, "/tmp/nr-backups");
  assert.equal(config.adminProposalTtlMs, 60_000);
});
