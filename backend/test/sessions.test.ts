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

test("absolute 30-day lifetime backstops even huge configured TTLs", () => {
  const db = fresh();
  const wallets = new WalletStore(db);
  const binding = wallets.upsertBinding("cHVibGljLWtleQ", null, 10_000);
  const sessions = new SessionStore(db, 60 * 86_400_000);
  const issued = sessions.issue(binding.id, 10_000);
  // 31 days in: inside the 60-day sliding window, past the absolute cap.
  assert.equal(sessions.validate(issued.token, 10_000 + 31 * 86_400_000).reason, "expired");
  db.close();
});

test("purgeNonces deletes at expiry and pendingNonceCount bounds live challenges (F-16)", () => {
  const db = fresh();
  const wallets = new WalletStore(db);
  const T0 = 1_700_000_000_000;
  // Two nonces issued together: one short-lived, one long-lived.
  wallets.issueNonce(1_000, T0); // expires T0 + 1_000
  wallets.issueNonce(10_000, T0); // expires T0 + 10_000
  assert.equal(wallets.pendingNonceCount(T0), 2);
  // A purge past the first nonce's expiry removes exactly that one; the live
  // nonce survives (no post-expiry retention — F-16 shrinks the table at
  // expiry so challenge spam cannot accumulate history).
  wallets.purgeNonces(T0 + 2_000);
  assert.equal(wallets.pendingNonceCount(T0 + 2_000), 1);
  // And once every nonce has expired the table is empty again.
  wallets.purgeNonces(T0 + 20_000);
  assert.equal(wallets.pendingNonceCount(T0 + 20_000), 0);
  // An expired-but-not-yet-purged nonce still fails as "expired", not
  // "unknown" — verification never accepts it either way.
  const lingering = wallets.issueNonce(1_000, T0 + 50_000);
  wallets.purgeNonces(T0 + 50_000); // nothing expired at this instant
  assert.equal(wallets.consumeNonce(lingering.nonce, T0 + 55_000), "expired");
  db.close();
});
