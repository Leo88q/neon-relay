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
  const ok = loadConfig({ NODE_ENV: "production", NEONRELAY_AUTH_DOMAIN: "relay.neonrelay.example.com" });
  assert.equal(ok.authDomain, "relay.neonrelay.example.com");
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
