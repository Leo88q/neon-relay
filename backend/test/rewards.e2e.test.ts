import test from "node:test";
import assert from "node:assert/strict";
import {
  authenticate, getJson, makeWallet, postJson, startTestApp, makeTestServer,
} from "./helpers.ts";
import { verifyProofIndexed, leafHash } from "../src/merkle.ts";
import type { Config } from "../src/config.ts";

function rewardConfig(serverKey: string): Partial<Config> {
  return {
    serverSigningPublicKey: serverKey,
    adminToken: "operator-token",
    epochMs: 3_600_000,
    capPerMatchMicro: 1_000,
    capDailyMicro: 1_500,
    capWeeklyMicro: 5_000,
  };
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

    const noAdmin = await postJson(base, "/v1/rewards/epochs/seal", { epoch_id: epochId });
    assert.equal(noAdmin.status, 403);
    const wrongAdmin = await postJson(base, "/v1/rewards/epochs/seal",
      { epoch_id: epochId }, "not-the-operator");
    assert.equal(wrongAdmin.status, 403);

    const sealed = await postJson(base, "/v1/rewards/epochs/seal",
      { epoch_id: epochId }, "operator-token");
    assert.equal(sealed.status, 200);
    assert.equal(sealed.json.epoch.state, "sealed");
    assert.equal(sealed.json.epoch.total_micro, 1_200);
    assert.equal(sealed.json.epoch.leaf_count, 1);
    assert.match(sealed.json.epoch.merkle_root, /^[0-9a-f]{64}$/);
    assert.equal(sealed.json.audit_root, sealed.json.epoch.merkle_root);

    const resealed = await postJson(base, "/v1/rewards/epochs/seal",
      { epoch_id: epochId }, "operator-token");
    assert.equal(resealed.status, 409);

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
      verifyProofIndexed(leaf, 0, intent.json.merkle_proof as string[],
        sealed.json.epoch.merkle_root as string),
      true);

    const intentAgain = await postJson(base, "/v1/rewards/claim-intent",
      { epoch_id: epochId }, token);
    assert.equal(intentAgain.json.intent_id, intent.json.intent_id);

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
