/**
 * Security review — 2026-09-26, iteration 5 (Solana game security checklist,
 * items 31–70: identity, off-chain races, DoS and production deploy gates).
 *
 * Regressions pinned here:
 *   F-11 (HIGH)  — /v1/wallet/link accepts only operator-provisioned player
 *                  ids when registration is required (identity squatting →
 *                  reward redirection).
 *   F-12 (MEDIUM)— every /v1/economy/* route is rate-limited (the ticket
 *                  route amplifies each call into an RPC read).
 *   F-13 (MEDIUM)— match-intent validates the epoch window and enforces a
 *                  per-(binding, epoch) inventory cap.
 *   F-14 (MEDIUM)— entry reference/ticket query params are strictly parsed
 *                  (no RangeError 500s from BigInt/u64 writers).
 *   F-15 (MEDIUM)— concurrent admin decisions are serialized: exactly one
 *                  approval executes, the loser gets 409.
 *   F-16 (LOW)   — outstanding wallet-auth challenges are hard-capped.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  authenticate, makeTestServer, makeWallet, postJson, getJson, startTestApp,
} from "./helpers.ts";
import { registerGameAccount } from "../src/game_pairing.ts";

const PROGRAM = "FZcLDdUrs6i1HYFFK2NhqNrbVaP6KTvrqzhyoDGT6CV9";

// ------------------------------------------------------------------ F-11

test("F-11 — wallet link requires operator-provisioned game accounts when enforced", async () => {
  const { app, base } = await startTestApp({
    economyProgramId: PROGRAM,
    playerLinkRequiresRegistration: true,
  });
  try {
    const wallet = makeWallet();
    const auth = await authenticate(base, wallet);
    const token = auth.json.session_token as string;

    // Unprovisioned player id: rejected — nobody may squat an identity.
    const denied = await postJson(base, "/v1/wallet/link", { player_id: "victim-player" }, token);
    assert.equal(denied.status, 403);
    assert.equal(denied.json.error.code, "player-not-registered");

    // Provisioned for a DIFFERENT wallet: still rejected.
    const other = makeWallet();
    registerGameAccount(app.db, "other-player", other.publicKeyBase64);
    const wrongWallet = await postJson(base, "/v1/wallet/link", { player_id: "other-player" }, token);
    assert.equal(wrongWallet.status, 403);
    assert.equal(wrongWallet.json.error.code, "player-not-registered");

    // Provisioned for THIS wallet: accepted.
    registerGameAccount(app.db, "mine-player", wallet.publicKeyBase64);
    const allowed = await postJson(base, "/v1/wallet/link", { player_id: "mine-player" }, token);
    assert.equal(allowed.status, 200);
    assert.equal(allowed.json.player_id, "mine-player");

    // Disabled account (operator revoked it): rejected again.
    app.db.run("UPDATE game_accounts SET enabled = 0 WHERE player_id = ?", "mine-player");
    const auth2 = await authenticate(base, wallet);
    const relink = await postJson(base, "/v1/wallet/link",
      { player_id: "mine-player" }, auth2.json.session_token as string);
    assert.equal(relink.status, 403);
  } finally {
    await app.close();
  }
});

test("F-11 — without the flag the legacy self-declared link still works (dev/test)", async () => {
  const { app, base } = await startTestApp({});
  try {
    const auth = await authenticate(base, makeWallet());
    const res = await postJson(base, "/v1/wallet/link", { player_id: "free-form" },
      auth.json.session_token as string);
    assert.equal(res.status, 200);
  } finally {
    await app.close();
  }
});

// ------------------------------------------------------------------ F-12

test("F-12 — economy read routes are rate-limited after the read burst", async () => {
  const { app, base } = await startTestApp({ economyProgramId: PROGRAM });
  try {
    const auth = await authenticate(base, makeWallet());
    const token = auth.json.session_token as string;
    // The reference route does no RPC work but shares the read bucket that
    // bounds `/v1/economy/ticket`'s RPC amplification (burst 60, 1/s refill).
    let allowed = 0;
    let limited = 0;
    for (let i = 0; i < 64; i++) {
      const res = await getJson(base, "/v1/economy/reference?kind=0&epoch=7", token);
      if (res.status === 200) allowed++;
      else if (res.status === 429) limited++;
      else assert.fail(`unexpected status ${res.status}: ${JSON.stringify(res.json)}`);
    }
    // Burst is 60 with a 1/s refill — a slow CI loop may refill one more
    // token, so accept 60..62 successes and require the rest to be limited.
    assert.ok(allowed >= 60 && allowed <= 62, `burst must be ~60, got ${allowed}`);
    assert.ok(limited >= 2, "requests beyond the burst must be rate-limited");
  } finally {
    await app.close();
  }
});

// ------------------------------------------------------------------ F-13

test("F-13 — match-intent rejects out-of-window epochs and caps the inventory", async () => {
  const { app, base } = await startTestApp({
    economyProgramId: PROGRAM,
    maxMatchIntentsPerEpoch: 2,
  });
  try {
    const auth = await authenticate(base, makeWallet());
    const token = auth.json.session_token as string;
    const current = Math.floor(Date.now() / (7 * 24 * 3_600_000));

    for (const bad of [1, current - 5, current + 9, 1.5, "abc", 2 ** 53]) {
      const res = await postJson(base, "/v1/economy/match-intent", { epoch: bad }, token);
      assert.equal(res.status, 400, `epoch ${JSON.stringify(bad)} must be rejected`);
      assert.equal(res.json.error.code, "bad-epoch");
    }

    // Legacy "no epoch" sugar still resolves to the current epoch.
    const first = await postJson(base, "/v1/economy/match-intent", {}, token);
    assert.equal(first.status, 200);
    assert.equal(first.json.epoch, current);
    const second = await postJson(base, "/v1/economy/match-intent", { epoch: current }, token);
    assert.equal(second.status, 200);

    // Cap: the third row for this (binding, epoch) is refused.
    const third = await postJson(base, "/v1/economy/match-intent", { epoch: current }, token);
    assert.equal(third.status, 429);
    assert.equal(third.json.error.code, "match-intent-cap");
    const rows = app.db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM economy_matches WHERE epoch = ?", current);
    assert.equal(rows?.n, 2, "the cap must bound the stored rows");
  } finally {
    await app.close();
  }
});

// ------------------------------------------------------------------ F-14

test("F-14 — entry reference/ticket params are strict, never a 500", async () => {
  const { app, base } = await startTestApp({ economyProgramId: PROGRAM });
  try {
    const auth = await authenticate(base, makeWallet());
    const token = auth.json.session_token as string;
    for (const query of [
      "kind=1.5", "kind=9", "kind=", "epoch=-1", "epoch=abc", "epoch=1.25",
      "extra=-1", "extra=NaN", `extra=${2 ** 53}`, `epoch=${2 ** 53}`,
    ]) {
      const ref = await getJson(base, `/v1/economy/reference?${query}`, token);
      assert.equal(ref.status, 400, `reference?${query} must be 400, got ${ref.status}`);
      const ticket = await getJson(base, `/v1/economy/ticket?${query}`, token);
      assert.equal(ticket.status, 400, `ticket?${query} must be 400, got ${ticket.status}`);
    }
    // A valid query still derives deterministically.
    const ok = await getJson(base, "/v1/economy/reference?kind=0&epoch=7&extra=0", token);
    assert.equal(ok.status, 200);
    assert.match(ok.json.reference, /^[0-9a-f]{64}$/);
  } finally {
    await app.close();
  }
});

// ------------------------------------------------------------------ F-15

test("F-15 — concurrent proposal approvals execute exactly once", async () => {
  const OPERATOR = "operator-token-0123456789abcdef-0123456789";
  const SUPERADMIN = "superadmin-token-0123456789abcdef-01234";
  const server = makeTestServer();
  const { app, base } = await startTestApp({
    serverSigningPublicKey: server.publicKeyBase64,
    operatorToken: OPERATOR,
    superadminToken: SUPERADMIN,
  });
  try {
    // Create a reward epoch by ingesting one signed event.
    const ingest = await postJson(base, "/v1/rewards/events", {
      events: [server.signEvent({
        match_id: "m-race", player_id: "race-p",
        event_type: "match_win", amount_micro: 100, occurred_at: Date.now(),
      })],
    });
    assert.equal(ingest.json.results[0].status, "accepted");
    const epochs = await getJson(base, "/v1/rewards/epochs");
    const epochId = epochs.json[0].id as number;

    const proposed = await postJson(base, "/v1/admin/proposals",
      { type: "seal-reward-epoch", params: { epoch_id: epochId } }, OPERATOR);
    assert.equal(proposed.status, 200);

    // Fire both approvals at once: the decision lock serializes them, so the
    // second one observes `executed` instead of executing a second seal.
    const [a, b] = await Promise.all([
      postJson(base, "/v1/admin/proposals/approve", { proposal_id: proposed.json.id }, SUPERADMIN),
      postJson(base, "/v1/admin/proposals/approve", { proposal_id: proposed.json.id }, SUPERADMIN),
    ]);
    const statuses = [a.status, b.status].sort((x, y) => x - y);
    assert.deepEqual(statuses, [200, 409],
      `expected exactly one success: ${JSON.stringify([a, b])}`);
    const winner = a.status === 200 ? a : b;
    const loser = a.status === 200 ? b : a;
    assert.equal(winner.json.selfApproved, false);
    assert.equal(loser.json.error.code, "proposal-executed");

    // The epoch really sealed exactly once.
    const epoch = app.db.get<{ state: string }>(
      "SELECT state FROM reward_epochs WHERE id = ?", epochId);
    assert.equal(epoch?.state, "sealed");
  } finally {
    await app.close();
  }
});

// ------------------------------------------------------------------ F-16

test("F-16 — outstanding auth challenges are hard-capped", async () => {
  const { app, base } = await startTestApp({ authNonceCap: 3 });
  try {
    // Issue up to the cap and capture the first challenge for later use.
    const first = await postJson(base, "/v1/auth/challenge", {});
    assert.equal(first.status, 200);
    for (let i = 0; i < 2; i++) {
      const res = await postJson(base, "/v1/auth/challenge", {});
      assert.equal(res.status, 200, `challenge ${i + 1} must succeed`);
    }
    const blocked = await postJson(base, "/v1/auth/challenge", {});
    assert.equal(blocked.status, 429);
    assert.equal(blocked.json.error.code, "challenge-cap");

    // Consuming one outstanding nonce frees capacity for the next issuance.
    const wallet = makeWallet();
    const bytes = Buffer.from(first.json.challenge as string, "base64url");
    const verified = await postJson(base, "/v1/auth/verify-wallet", {
      challenge: bytes.toString("base64url"),
      signature: wallet.sign(bytes).toString("base64url"),
      public_key: wallet.publicKeyBase64,
    });
    assert.equal(verified.status, 200);
    const after = await postJson(base, "/v1/auth/challenge", {});
    assert.equal(after.status, 200, "consuming a nonce must free cap capacity");
  } finally {
    await app.close();
  }
});
