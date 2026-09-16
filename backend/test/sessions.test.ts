import test from "node:test";
import assert from "node:assert/strict";
import { Db, migrate } from "../src/db.ts";
import { SessionStore } from "../src/sessions.ts";
import { WalletStore } from "../src/wallets.ts";

function fresh() {
  const db = new Db(":memory:");
  migrate(db);
  return db;
}

test("nonce is single use and expires", () => {
  const db = fresh();
  const wallets = new WalletStore(db);
  const nonce = wallets.issueNonce(1000, 10_000);
  assert.equal(wallets.consumeNonce(nonce.nonce, 10_500), null);
  assert.equal(wallets.consumeNonce(nonce.nonce, 10_600), "replayed");
  const late = wallets.issueNonce(1000, 10_000);
  assert.equal(wallets.consumeNonce(late.nonce, 11_001), "expired");
  assert.equal(wallets.consumeNonce("nope", 10_000), "unknown");
  db.close();
});

test("binding upsert revives revoked bindings and keeps identity", () => {
  const db = fresh();
  const wallets = new WalletStore(db);
  const first = wallets.upsertBinding("KEY", "label one", 1);
  const again = wallets.upsertBinding("KEY", "label two", 2);
  assert.equal(again.id, first.id);
  assert.equal(again.label, "label two");
  wallets.revokeBinding(first.id, 3);
  const revived = wallets.upsertBinding("KEY", null, 4);
  assert.equal(revived.revoked_at, null);
  db.close();
});

test("session validate slides expiry and rejects revoked/expired", () => {
  const db = fresh();
  const wallets = new WalletStore(db);
  const sessions = new SessionStore(db, 1000);
  const binding = wallets.upsertBinding("KEY", null, 1);
  const issued = sessions.issue(binding.id, 10_000);
  const ok = sessions.validate(issued.token, 10_500);
  assert.equal(ok.reason, null);
  assert.equal(ok.session?.expires_at, 11_500);
  assert.equal(sessions.validate(null, 10_500).reason, "missing");
  assert.equal(sessions.validate("wrong", 10_500).reason, "missing");
  assert.equal(sessions.validate(issued.token, 12_001).reason, "expired");
  const fresh2 = sessions.issue(binding.id, 10_000);
  sessions.revoke(fresh2.row.id, 10_100);
  assert.equal(sessions.validate(fresh2.token, 10_200).reason, "revoked");
  sessions.revokeForBinding(binding.id, 10_300);
  db.close();
});
