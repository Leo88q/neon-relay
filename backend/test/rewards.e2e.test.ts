import test from "node:test";
import assert from "node:assert/strict";
import {
  authenticate, getJson, makeWallet, postJson, startTestApp, makeTestServer,
} from "./helpers.ts";
import { verifyProofIndexed, leafHash } from "../src/merkle.ts";
import type { Config } from "../src/config.ts";
import { Db, migrate } from "../src/db.ts";
import { WalletStore } from "../src/wallets.ts";
import { RewardService, idempotencyHash, type IncomingEvent } from "../src/rewards.ts";
import { testConfig } from "./helpers.ts";

export function rewardConfig(serverKey: string): Partial<Config> {
  return {
    serverSigningPublicKey: serverKey,
    operatorToken: "operator-token",
    superadminToken: "superadmin-token",
    epochMs: 3_600_000,
    capPerMatchMicro: 1_000,
    capDailyMicro: 1_500,
    capWeeklyMicro: 5_000,
  };
}

/**
 * Service-level harness for the wallet-dimension caps.
 *
 * Since CRIT-02 (2026-09-26) a client-supplied `wallet_binding_id` must itself
 * be linked to the event's player, and `wallet_bindings_active_player_unique`
 * (migration 0010) allows at most one active link per player id. The wallet
 * dimension therefore cannot be provoked over HTTP with two live player names
 * any more — it exists for ledger rows that already credit one wallet under a
 * different player id (a revoked link, an operator backfill, or anything
 * ingested before CRIT-02). Those rows are seeded straight into the ledger here
 * so the defence stays under test.
 */
function ledgerService(serverKey: string, overrides: Partial<Config> = {}) {
  const db = new Db(":memory:");
  migrate(db);
  const config = testConfig({ ...rewardConfig(serverKey), ...overrides });
  const wallets = new WalletStore(db);
  return { db, config, wallets, rewards: new RewardService(db, config, wallets) };
}

/**
 * Credit `amount` to a wallet under a player id it is no longer linked to —
 * the ledger shape the wallet-dimension caps exist for (re-link after revoke,
 * operator backfill, or a row written before CRIT-02). Returns the binding id.
 */
function seedAccepted(db: Db, wallets: WalletStore, publicKey: string, linkedPlayerId: string,
  event: Omit<IncomingEvent, "server_signature" | "wallet_binding_id">, now: number): string {
  const binding = wallets.upsertBinding(publicKey, "seeded", now);
  wallets.setPlayerLink(binding.id, linkedPlayerId);
  const full = { ...event, wallet_binding_id: binding.id, server_signature: "seeded" } as IncomingEvent;
  db.run(
    `INSERT INTO reward_events
       (id, idempotency_hash, match_id, player_id, wallet_binding_id, reward_epoch,
        event_type, amount_micro, occurred_at, ingested_at, server_signature, status, reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'accepted', NULL)`,
    crypto.randomUUID(), idempotencyHash(full), event.match_id, event.player_id, binding.id,
    0, event.event_type, event.amount_micro, event.occurred_at, now, "seeded");
  return binding.id;
}

test("ingestion is disabled without a configured server signing key", async () => {
  const { app, base } = await startTestApp({});
  try {
    const res = await postJson(base, "/v1/rewards/events", { events: [{ match_id: "m" }] });
    assert.equal(res.status, 503);
    assert.equal(res.json.error.code, "signing-key-unconfigured");
  } finally {
    await app.close();
  }
});

test("reward lifecycle: sign, ingest, caps, seal, claim, confirm", async () => {
  const server = makeTestServer();
  const { app, base } = await startTestApp(rewardConfig(server.publicKeyBase64));
  try {
    const wallet = makeWallet();
    const auth = await authenticate(base, wallet);
    assert.equal(auth.status, 200);
    const token = auth.json.session_token as string;
    const binding = auth.json.wallet_binding_id as string;
    const linked = await postJson(base, "/v1/wallet/link", { player_id: "p1" }, token);
    assert.equal(linked.status, 200);
    const now = Date.now();

    // ---- ingestion: accepted / duplicate / forged / capped
    const e1 = server.signEvent({
      match_id: "m1", player_id: "p1", wallet_binding_id: binding,
      event_type: "match_win", amount_micro: 600, occurred_at: now,
    });
    const ingested = await postJson(base, "/v1/rewards/events", { events: [e1] });
    assert.equal(ingested.status, 200);
    assert.equal(ingested.json.results[0].status, "accepted");
    assert.equal(ingested.json.accepted, 1);

    const dup = await postJson(base, "/v1/rewards/events", { events: [e1] });
    assert.equal(dup.json.results[0].status, "duplicate");

    const stranger = makeTestServer();
    const forged = stranger.signEvent({
      match_id: "m2", player_id: "p1", wallet_binding_id: binding,
      event_type: "match_win", amount_micro: 10, occurred_at: now,
    });
    const badSig = await postJson(base, "/v1/rewards/events", { events: [forged] });
    assert.equal(badSig.json.results[0].status, "rejected_signature");

    const overMatch = server.signEvent({
      match_id: "m1", player_id: "p1", wallet_binding_id: binding,
      event_type: "match_win", amount_micro: 500, occurred_at: now,
    });
    const cappedMatch = await postJson(base, "/v1/rewards/events", { events: [overMatch] });
    assert.equal(cappedMatch.json.results[0].status, "rejected_caps");
    assert.match(cappedMatch.json.results[0].reason, /per-match cap/);

    const e3 = server.signEvent({
      match_id: "m3", player_id: "p1", wallet_binding_id: binding,
      event_type: "map_finish", amount_micro: 600, occurred_at: now,
    });
    const ok3 = await postJson(base, "/v1/rewards/events", { events: [e3] });
    assert.equal(ok3.json.results[0].status, "accepted");

    const overDaily = server.signEvent({
      match_id: "m4", player_id: "p1", wallet_binding_id: binding,
      event_type: "match_win", amount_micro: 900, occurred_at: now,
    });
    const cappedDaily = await postJson(base, "/v1/rewards/events", { events: [overDaily] });
    assert.equal(cappedDaily.json.results[0].status, "rejected_caps");
    assert.match(cappedDaily.json.results[0].reason, /daily cap/);

    // ---- balance / eligibility before sealing
    const balance = await getJson(base, "/v1/rewards/balance", token);
    assert.equal(balance.status, 200);
    assert.equal(balance.json.pending_micro, 1_200);
    assert.equal(balance.json.available_micro, 0);
    assert.equal(balance.json.claimed_micro, 0);

    const eligibility = await getJson(base, "/v1/rewards/eligibility", token);
    assert.equal(eligibility.json.used.daily_micro, 1_200);
    assert.equal(eligibility.json.remaining.daily_micro, 300);
    assert.equal(eligibility.json.can_earn, true);

    const anonBalance = await getJson(base, "/v1/rewards/balance");
    assert.equal(anonBalance.status, 401);

    // ---- sealing: operator-only, then claim window opens
    const epochsBefore = await getJson(base, "/v1/rewards/epochs");
    const epochId = epochsBefore.json[0].id as number;
    assert.equal(epochsBefore.json[0].state, "open");

    const earlyClaim = await postJson(base, "/v1/rewards/claim-intent",
      { epoch_id: epochId }, token);
    assert.equal(earlyClaim.status, 409);
    assert.equal(earlyClaim.json.error.code, "epoch-not-sealed");

    // Tranche A: sealing runs through the two-person proposal workflow.
    const gone = await postJson(base, "/v1/rewards/epochs/seal",
      { epoch_id: epochId }, "operator-token");
    assert.equal(gone.status, 410);
    assert.equal(gone.json.error.code, "admin-workflow-required");

    const noAdmin = await postJson(base, "/v1/admin/proposals",
      { type: "seal-reward-epoch", params: { epoch_id: epochId } });
    assert.equal(noAdmin.status, 403);
    const wrongAdmin = await postJson(base, "/v1/admin/proposals",
      { type: "seal-reward-epoch", params: { epoch_id: epochId } }, "not-the-operator");
    assert.equal(wrongAdmin.status, 403);

    const proposed = await postJson(base, "/v1/admin/proposals",
      { type: "seal-reward-epoch", params: { epoch_id: epochId } }, "operator-token");
    assert.equal(proposed.status, 200);
    assert.equal(proposed.json.status, "open");
    const proposalId = proposed.json.id as string;

    // Operators cannot approve, even their own proposal (role split enforced).
    const selfApprove = await postJson(base, "/v1/admin/proposals/approve",
      { proposal_id: proposalId }, "operator-token");
    assert.equal(selfApprove.status, 403);

    const approved = await postJson(base, "/v1/admin/proposals/approve",
      { proposal_id: proposalId }, "superadmin-token");
    assert.equal(approved.status, 200);
    assert.equal(approved.json.row.status, "executed");
    assert.equal(approved.json.selfApproved, false);
    const sealed = { status: 200, json: approved.json.result };
    assert.equal(sealed.json.epoch.state, "sealed");
    assert.equal(sealed.json.epoch.total_micro, 1_200);
    assert.equal(sealed.json.epoch.leaf_count, 1);
    assert.match(sealed.json.epoch.merkle_root, /^[0-9a-f]{64}$/);
    assert.equal(sealed.json.audit_root, sealed.json.epoch.merkle_root);

    const reapproved = await postJson(base, "/v1/admin/proposals/approve",
      { proposal_id: proposalId }, "superadmin-token");
    assert.equal(reapproved.status, 409);
    assert.equal(reapproved.json.error.code, "proposal-executed");

    // Sealing an already-sealed epoch fails inside approval (proposal stays
    // open, the failure is audited) instead of double-sealing.
    const dupSeal = await postJson(base, "/v1/admin/proposals",
      { type: "seal-reward-epoch", params: { epoch_id: epochId } }, "operator-token");
    const dupApprove = await postJson(base, "/v1/admin/proposals/approve",
      { proposal_id: dupSeal.json.id }, "superadmin-token");
    assert.equal(dupApprove.status, 409);
    assert.equal(dupApprove.json.error.code, "epoch-already-sealed");

    // ---- balance moves pending -> available
    const balanceSealed = await getJson(base, "/v1/rewards/balance", token);
    assert.equal(balanceSealed.json.available_micro, 1_200);
    assert.equal(balanceSealed.json.pending_micro, 0);

    // ---- claim intent carries a verifiable proof
    const intent = await postJson(base, "/v1/rewards/claim-intent",
      { epoch_id: epochId }, token);
    assert.equal(intent.status, 200);
    assert.equal(intent.json.amount_micro, 1_200);
    const leaf = leafHash(wallet.rawPublicKey, 1_200);
    assert.equal(intent.json.leaf_hash, leaf);
    assert.equal(
      verifyProofIndexed(leaf, intent.json.leaf_index as number, intent.json.merkle_proof as string[],
        sealed.json.epoch.merkle_root as string),
      true);

    const intentAgain = await postJson(base, "/v1/rewards/claim-intent",
      { epoch_id: epochId }, token);
    assert.equal(intentAgain.json.intent_id, intent.json.intent_id);
    assert.equal(intentAgain.json.leaf_index, intent.json.leaf_index);

    // ---- confirmation transitions
    const submitted = await postJson(base, "/v1/rewards/claim-confirmation", {
      intent_id: intent.json.intent_id,
      transaction_id: "tx-1",
      status: "submitted",
    }, token);
    assert.equal(submitted.json.status, "submitted");
    const confirmed = await postJson(base, "/v1/rewards/claim-confirmation", {
      intent_id: intent.json.intent_id,
      transaction_id: "tx-1",
      status: "confirmed",
    }, token);
    assert.equal(confirmed.json.status, "confirmed");
    const confirmedTwice = await postJson(base, "/v1/rewards/claim-confirmation", {
      intent_id: intent.json.intent_id,
      transaction_id: "tx-1",
      status: "confirmed",
    }, token);
    assert.equal(confirmedTwice.status, 409);

    const balanceClaimed = await getJson(base, "/v1/rewards/balance", token);
    assert.equal(balanceClaimed.json.claimed_micro, 1_200);
    assert.equal(balanceClaimed.json.available_micro, 0);

    const intents = await getJson(base, "/v1/rewards/intents", token);
    assert.equal(intents.json.intents.length, 1);
    assert.equal(intents.json.intents[0].status, "confirmed");

    // ---- a wallet with no rewards in the epoch gets a clean 404
    const other = makeWallet();
    const otherAuth = await authenticate(base, other);
    const otherClaim = await postJson(base, "/v1/rewards/claim-intent",
      { epoch_id: epochId }, otherAuth.json.session_token as string);
    assert.equal(otherClaim.status, 404);
    assert.equal(otherClaim.json.error.code, "no-rewards-in-epoch");
  } finally {
    await app.close();
  }
});

test("caps block further earnings and eligibility reports can_earn false", async () => {
  const server = makeTestServer();
  const { app, base } = await startTestApp({
    ...rewardConfig(server.publicKeyBase64),
    capDailyMicro: 1_200,
  });
  try {
    const wallet = makeWallet();
    const auth = await authenticate(base, wallet);
    const token = auth.json.session_token as string;
    const binding = auth.json.wallet_binding_id as string;
    await postJson(base, "/v1/wallet/link", { player_id: "p-cap" }, token);
    const now = Date.now();
    const events = [0, 1, 2, 3].map((i) => server.signEvent({
      match_id: `match-${i}`, player_id: "p-cap", wallet_binding_id: binding,
      event_type: "match_win", amount_micro: 400, occurred_at: now,
    }));
    const res = await postJson(base, "/v1/rewards/events", { events });
    const statuses = res.json.results.map((r: { status: string }) => r.status);
    assert.deepEqual(statuses, ["accepted", "accepted", "accepted", "rejected_caps"]);
    const eligibility = await getJson(base, "/v1/rewards/eligibility", token);
    assert.equal(eligibility.json.used.daily_micro, 1_200);
    assert.equal(eligibility.json.remaining.daily_micro, 0);
    assert.equal(eligibility.json.can_earn, false);
    const oneMore = await postJson(base, "/v1/rewards/events", {
      events: [server.signEvent({
        match_id: "match-9", player_id: "p-cap", wallet_binding_id: binding,
        event_type: "match_win", amount_micro: 400, occurred_at: now,
      })],
    });
    assert.equal(oneMore.json.results[0].status, "rejected_caps");
    const eligibilityAfter = await getJson(base, "/v1/rewards/eligibility", token);
    assert.equal(eligibilityAfter.json.can_earn, false);
  } finally {
    await app.close();
  }
});

test("reward ingestion fails closed when the signing key is malformed", async () => {
  const { app, base } = await startTestApp(rewardConfig("!!!not-a-key!!!"));
  try {
    const res = await postJson(base, "/v1/rewards/events", { events: [{ match_id: "m" }] });
    assert.equal(res.status, 500);
    assert.equal(res.json.error.code, "signing-key-invalid");
  } finally {
    await app.close();
  }
});

test("reward ingestion rejects events with a non-integer timestamp", async () => {
  const server = makeTestServer();
  const { app, base } = await startTestApp(rewardConfig(server.publicKeyBase64));
  try {
    const event = server.signEvent({
      match_id: "m1", player_id: "p1", wallet_binding_id: "b1",
      event_type: "match_win", amount_micro: 100, occurred_at: "soon" as unknown as number,
    });
    const res = await postJson(base, "/v1/rewards/events", { events: [event] });
    assert.equal(res.json.results[0].status, "rejected_validation");
    assert.match(res.json.results[0].reason, /occurred_at/);
  } finally {
    await app.close();
  }
});

test("reward ingestion rejects events without a server signature", async () => {
  const server = makeTestServer();
  const { app, base } = await startTestApp(rewardConfig(server.publicKeyBase64));
  try {
    const res = await postJson(base, "/v1/rewards/events", {
      events: [{
        match_id: "m1", player_id: "p1", wallet_binding_id: "b1",
        event_type: "match_win", amount_micro: 100, occurred_at: Date.now(),
      }],
    });
    assert.equal(res.json.results[0].status, "rejected_validation");
    assert.match(res.json.results[0].reason, /server_signature/);
  } finally {
    await app.close();
  }
});

test("reward ingestion rejects wrong-typed fields without crashing", async () => {
  const server = makeTestServer();
  const { app, base } = await startTestApp(rewardConfig(server.publicKeyBase64));
  try {
    // Signed over a valid match_id, then corrupted: validation runs before the
    // signature check, so this must be rejected_validation, not a crash.
    const event = {
      ...server.signEvent({
        match_id: "m1", player_id: "p1", wallet_binding_id: "b1",
        event_type: "match_win", amount_micro: 100, occurred_at: Date.now(),
      }),
      match_id: null,
    };
    const res = await postJson(base, "/v1/rewards/events", { events: [event] });
    assert.equal(res.json.results[0].status, "rejected_validation");
    assert.match(res.json.results[0].reason, /match_id invalid/);
  } finally {
    await app.close();
  }
});

test("reward ingestion rejects a single event above the per-match cap", async () => {
  const server = makeTestServer();
  const { app, base } = await startTestApp(rewardConfig(server.publicKeyBase64));
  try {
    const wallet = makeWallet();
    const auth = await authenticate(base, wallet);
    const binding = auth.json.wallet_binding_id as string;
    await postJson(base, "/v1/wallet/link", { player_id: "p1" }, auth.json.session_token as string);
    const res = await postJson(base, "/v1/rewards/events", {
      events: [server.signEvent({
        match_id: "m1", player_id: "p1", wallet_binding_id: binding,
        event_type: "match_win", amount_micro: 1_001, occurred_at: Date.now(),
      })],
    });
    assert.equal(res.json.results[0].status, "rejected_caps");
    assert.match(res.json.results[0].reason, /amount exceeds per-match cap/);
  } finally {
    await app.close();
  }
});

test("per-match cap is also enforced across the wallet dimension", () => {
  const server = makeTestServer();
  const { db, wallets, rewards } = ledgerService(server.publicKeyBase64);
  try {
    const wallet = makeWallet();
    const now = Date.now();
    // The wallet already collected 600 in this match under its previous player
    // id; the new event keeps the player dimension (600 <= 1_000) honest but
    // pushes the wallet dimension to 1_200.
    const binding = seedAccepted(db, wallets, wallet.publicKeyBase64, "pB", {
      match_id: "m9", player_id: "old-link", event_type: "match_win",
      amount_micro: 600, occurred_at: now,
    }, now);
    const event = server.signEvent({
      match_id: "m9", player_id: "pB", wallet_binding_id: binding,
      event_type: "match_win", amount_micro: 600, occurred_at: now,
    });
    const [result] = rewards.ingestEvents([event], now);
    assert.equal(result.status, "rejected_caps");
    assert.match(result.reason as string, /per-match cap exceeded \(wallet\)/);
  } finally {
    db.close();
  }
});

test("daily cap is also enforced across the wallet dimension", () => {
  const server = makeTestServer();
  const { db, wallets, rewards } = ledgerService(server.publicKeyBase64);
  try {
    const wallet = makeWallet();
    const now = Date.now();
    const binding = seedAccepted(db, wallets, wallet.publicKeyBase64, "pB", {
      match_id: "m1", player_id: "old-link", event_type: "match_win",
      amount_micro: 900, occurred_at: now,
    }, now);
    const event = server.signEvent({
      match_id: "m2", player_id: "pB", wallet_binding_id: binding,
      event_type: "match_win", amount_micro: 900, occurred_at: now,
    });
    const [result] = rewards.ingestEvents([event], now);
    assert.equal(result.status, "rejected_caps");
    assert.match(result.reason as string, /daily cap exceeded \(wallet\)/);
  } finally {
    db.close();
  }
});

test("weekly player cap blocks earnings above the weekly budget", async () => {
  const server = makeTestServer();
  const { app, base } = await startTestApp({
    ...rewardConfig(server.publicKeyBase64),
    capDailyMicro: 100_000, // daily stays out of the way; weekly binds first
    capWeeklyMicro: 1_500,
  });
  try {
    const wallet = makeWallet();
    const auth = await authenticate(base, wallet);
    const binding = auth.json.wallet_binding_id as string;
    // CRIT-02: an explicit wallet_binding_id must belong to the event player.
    await postJson(base, "/v1/wallet/link", { player_id: "p1" }, auth.json.session_token as string);
    const now = Date.now();
    const events = ["m1", "m2"].map((match) => server.signEvent({
      match_id: match, player_id: "p1", wallet_binding_id: binding,
      event_type: "match_win", amount_micro: 900, occurred_at: now,
    }));
    const res = await postJson(base, "/v1/rewards/events", { events });
    assert.equal(res.json.results[0].status, "accepted");
    assert.equal(res.json.results[1].status, "rejected_caps");
    assert.match(res.json.results[1].reason, /weekly cap/);
  } finally {
    await app.close();
  }
});

test("weekly cap is also enforced across the wallet dimension", () => {
  const server = makeTestServer();
  const { db, wallets, rewards } = ledgerService(server.publicKeyBase64, {
    capDailyMicro: 100_000, // daily stays out of the way; weekly binds first
    capWeeklyMicro: 1_500,
  });
  try {
    const wallet = makeWallet();
    const now = Date.now();
    const binding = seedAccepted(db, wallets, wallet.publicKeyBase64, "pB", {
      match_id: "m1", player_id: "old-link", event_type: "match_win",
      amount_micro: 900, occurred_at: now,
    }, now);
    const event = server.signEvent({
      match_id: "m2", player_id: "pB", wallet_binding_id: binding,
      event_type: "match_win", amount_micro: 900, occurred_at: now,
    });
    const [result] = rewards.ingestEvents([event], now);
    assert.equal(result.status, "rejected_caps");
    assert.match(result.reason as string, /weekly cap exceeded \(wallet\)/);
  } finally {
    db.close();
  }
});

test("reward ingestion into a sealed epoch is rejected", async () => {
  const server = makeTestServer();
  const { app, base } = await startTestApp(rewardConfig(server.publicKeyBase64));
  try {
    const wallet = makeWallet();
    const auth = await authenticate(base, wallet);
    const token = auth.json.session_token as string;
    const binding = auth.json.wallet_binding_id as string;
    await postJson(base, "/v1/wallet/link", { player_id: "p1" }, token);
    const now = Date.now();
    await postJson(base, "/v1/rewards/events", {
      events: [server.signEvent({
        match_id: "m1", player_id: "p1", wallet_binding_id: binding,
        event_type: "match_win", amount_micro: 600, occurred_at: now,
      })],
    });
    const epochs = await getJson(base, "/v1/rewards/epochs");
    const epochId = epochs.json[0].id as number;
    const proposed = await postJson(base, "/v1/admin/proposals",
      { type: "seal-reward-epoch", params: { epoch_id: epochId } }, "operator-token");
    await postJson(base, "/v1/admin/proposals/approve",
      { proposal_id: proposed.json.id }, "superadmin-token");
    const late = await postJson(base, "/v1/rewards/events", {
      events: [server.signEvent({
        match_id: "m2", player_id: "p1", wallet_binding_id: binding,
        event_type: "match_win", amount_micro: 100, occurred_at: now,
      })],
    });
    assert.equal(late.json.results[0].status, "rejected_epoch_sealed");
    const balance = await getJson(base, "/v1/rewards/balance", token);
    assert.equal(balance.json.available_micro, 600);
  } finally {
    await app.close();
  }
});

test("reward ingestion rejects an empty events array", async () => {
  const { app, base } = await startTestApp({});
  try {
    const res = await postJson(base, "/v1/rewards/events", { events: [] });
    assert.equal(res.status, 400);
  } finally {
    await app.close();
  }
});

test("claim intent rejects a non-integer epoch", async () => {
  const server = makeTestServer();
  const { app, base } = await startTestApp(rewardConfig(server.publicKeyBase64));
  try {
    const auth = await authenticate(base, makeWallet());
    const res = await postJson(base, "/v1/rewards/claim-intent",
      { epoch_id: "x" }, auth.json.session_token as string);
    assert.equal(res.status, 400);
  } finally {
    await app.close();
  }
});

test("claim confirmation rejects an unknown status", async () => {
  const server = makeTestServer();
  const { app, base } = await startTestApp(rewardConfig(server.publicKeyBase64));
  try {
    const auth = await authenticate(base, makeWallet());
    const res = await postJson(base, "/v1/rewards/claim-confirmation",
      { intent_id: "i", transaction_id: "t", status: "weird" },
      auth.json.session_token as string);
    assert.equal(res.status, 400);
  } finally {
    await app.close();
  }
});

test("claim intents list paginates", async () => {
  const server = makeTestServer();
  const { app, base } = await startTestApp(rewardConfig(server.publicKeyBase64));
  try {
    const wallet = makeWallet();
    const auth = await authenticate(base, wallet);
    const token = auth.json.session_token as string;
    const binding = auth.json.wallet_binding_id as string;
    await postJson(base, "/v1/wallet/link", { player_id: "p1" }, token);
    await postJson(base, "/v1/rewards/events", {
      events: [server.signEvent({
        match_id: "m1", player_id: "p1", wallet_binding_id: binding,
        event_type: "match_win", amount_micro: 600, occurred_at: Date.now(),
      })],
    });
    const epochId = (await getJson(base, "/v1/rewards/epochs")).json[0].id as number;
    const proposed = await postJson(base, "/v1/admin/proposals",
      { type: "seal-reward-epoch", params: { epoch_id: epochId } }, "operator-token");
    await postJson(base, "/v1/admin/proposals/approve",
      { proposal_id: proposed.json.id }, "superadmin-token");
    await postJson(base, "/v1/rewards/claim-intent", { epoch_id: epochId }, token);
    const page = await getJson(base, "/v1/rewards/intents?limit=1&offset=0", token);
    assert.equal(page.json.intents.length, 1);
    assert.deepEqual(page.json.pagination, { limit: 1, offset: 0, total: 1 });
    const empty = await getJson(base, "/v1/rewards/intents?limit=1&offset=5", token);
    assert.deepEqual(empty.json.intents, []);
    assert.equal(empty.json.pagination.total, 1);
  } finally {
    await app.close();
  }
});

test("a revoked wallet binding fails closed on session use", async () => {
  const server = makeTestServer();
  const { app, base } = await startTestApp(rewardConfig(server.publicKeyBase64));
  try {
    const auth = await authenticate(base, makeWallet());
    const token = auth.json.session_token as string;
    const bindingId = auth.json.wallet_binding_id as string;
    app.db.run("UPDATE wallet_bindings SET revoked_at = ? WHERE id = ?", Date.now(), bindingId);
    const res = await getJson(base, "/v1/rewards/balance", token);
    assert.equal(res.status, 401);
    assert.equal(res.json.error.code, "binding-revoked");
  } finally {
    await app.close();
  }
});
