/**
 * Local-only audit reproductions (2026-09-21 findings, refreshed 2026-09-26).
 *
 * HISTORY: this file used to assert that each documented defect *reproduces*
 * ("passing means the vulnerability exists"). Four of the five reproductions
 * had already been fixed and were silently red, and H-01 was still green —
 * i.e. still exploitable. As of the 2026-09-26 security review every finding
 * below is remediated, so the assertions were inverted: the same attack
 * payloads are replayed and must now be BLOCKED. A red test here means a
 * regression, not a known defect.
 *
 * No production RPC, persistent DB or real keys. Run from repository root:
 *   node --experimental-strip-types --test audit/2026-09-21/poc.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { authenticate, getJson, makeWallet, makeTestServer, postJson, startTestApp } from '../../backend/test/helpers.ts';
import { canonicalEventBytes, idempotencyHash } from '../../backend/src/rewards.ts';
import { verifyProofIndexed, leafHash } from '../../backend/src/merkle.ts';
import { clientIp, RateLimiter } from '../../backend/src/http.ts';

async function seal(base: string, epoch: number) {
  const proposal = await postJson(base, '/v1/admin/proposals',
    { type: 'seal-reward-epoch', params: { epoch_id: epoch } }, 'audit-operator');
  assert.equal(proposal.status, 200);
  const approval = await postJson(base, '/v1/admin/proposals/approve',
    { proposal_id: proposal.json.id }, 'audit-superadmin');
  assert.equal(approval.status, 200);
}
const roles = { operatorToken: 'audit-operator', superadminToken: 'audit-superadmin' };

test('H-01 (FIXED 2026-09-26): unsigned wallet_binding_id can no longer redirect a genuine event', async () => {
  const server = makeTestServer();
  const { app, base } = await startTestApp({ ...roles, serverSigningPublicKey: server.publicKeyBase64 });
  try {
    const victim = await authenticate(base, makeWallet());
    const attackerWallet = makeWallet();
    const attacker = await authenticate(base, attackerWallet);
    const original = server.signEvent({ match_id: 'legitimate-match', player_id: 'victim-stable-id',
      wallet_binding_id: victim.json.wallet_binding_id, event_type: 'map_finish', amount_micro: 100,
      occurred_at: Date.now() });
    const redirected = { ...original, wallet_binding_id: attacker.json.wallet_binding_id };

    // `wallet_binding_id` is not covered by the server signature, so it still
    // hashes to the same idempotency key — that part of the design is unchanged.
    assert.deepEqual(canonicalEventBytes(original), canonicalEventBytes(redirected));
    assert.equal(idempotencyHash(original), idempotencyHash(redirected));

    // CRIT-02: an explicit binding that is not linked to the event player is
    // rejected outright, so the attacker never gets a leaf.
    const result = await postJson(base, '/v1/rewards/events', { events: [redirected] });
    assert.equal(result.json.results[0].status, 'rejected_validation');
    assert.match(result.json.results[0].reason, /not linked to the event player/);

    // The rejection must not poison the idempotency key for the genuine event.
    const retry = await postJson(base, '/v1/rewards/events', { events: [original] });
    assert.equal(retry.json.results[0].status, 'rejected_validation',
      'the victim has not linked a player id either, so no binding may claim it');

    // With the victim properly linked, the reward lands on the victim wallet.
    await postJson(base, '/v1/wallet/link', { player_id: 'victim-stable-id' }, victim.json.session_token);
    const linked = server.signEvent({ match_id: 'legitimate-match-2', player_id: 'victim-stable-id',
      wallet_binding_id: victim.json.wallet_binding_id, event_type: 'map_finish', amount_micro: 100,
      occurred_at: Date.now() });
    const accepted = await postJson(base, '/v1/rewards/events', { events: [linked] });
    assert.equal(accepted.json.results[0].status, 'accepted');
    const epoch = accepted.json.results[0].reward_epoch;
    await seal(base, epoch);

    const victimClaim = await postJson(base, '/v1/rewards/claim-intent', { epoch_id: epoch }, victim.json.session_token);
    assert.equal(victimClaim.status, 200);
    assert.equal(victimClaim.json.amount_micro, 100);
    const attackerClaim = await postJson(base, '/v1/rewards/claim-intent', { epoch_id: epoch }, attacker.json.session_token);
    assert.equal(attackerClaim.status, 404);
    assert.notEqual(victimClaim.json.leaf_hash, leafHash(attackerWallet.rawPublicKey, 100));
    const epochs = await getJson(base, '/v1/rewards/epochs');
    assert.equal(verifyProofIndexed(victimClaim.json.leaf_hash, victimClaim.json.leaf_index,
      victimClaim.json.merkle_proof, epochs.json[0].merkle_root), true);
  } finally { await app.close(); }
});

test('M-01 (FIXED): invalid signature no longer permanently poisons the idempotency key', async () => {
  const server = makeTestServer();
  const { app, base } = await startTestApp({ serverSigningPublicKey: server.publicKeyBase64 });
  try {
    const event = server.signEvent({ match_id: 'poison', player_id: 'p',
      event_type: 'map_finish', amount_micro: 1, occurred_at: Date.now() });
    const poison = await postJson(base, '/v1/rewards/events', {
      events: [{ ...event, server_signature: Buffer.alloc(64).toString('base64url') }] });
    assert.equal(poison.json.results[0].status, 'rejected_signature');
    const genuine = await postJson(base, '/v1/rewards/events', { events: [event] });
    assert.equal(genuine.json.results[0].status, 'accepted');
    assert.ok(genuine.json.results[0].reward_epoch, 'the retry must land in an epoch');
    // And the accepted event is now the duplicate-guarded one.
    const again = await postJson(base, '/v1/rewards/events', { events: [event] });
    assert.equal(again.json.results[0].status, 'duplicate');
  } finally { await app.close(); }
});

test('M-02: fake transaction confirmation — documented dev leniency, blocked in production', async () => {
  const server = makeTestServer();
  // (a) development/test environment: the ledger is bookkeeping only, the
  //     self-reported status is accepted (this is the residual, documented risk).
  const dev = await startTestApp({ ...roles, serverSigningPublicKey: server.publicKeyBase64 });
  try {
    const auth = await authenticate(dev.base, makeWallet());
    await postJson(dev.base, '/v1/wallet/link', { player_id: 'p' }, auth.json.session_token);
    const event = server.signEvent({ match_id: 'fake-confirm', player_id: 'p',
      wallet_binding_id: auth.json.wallet_binding_id, event_type: 'map_finish', amount_micro: 100,
      occurred_at: Date.now() });
    const ingest = await postJson(dev.base, '/v1/rewards/events', { events: [event] });
    assert.equal(ingest.json.results[0].status, 'accepted');
    const epoch = ingest.json.results[0].reward_epoch;
    await seal(dev.base, epoch);
    const intent = await postJson(dev.base, '/v1/rewards/claim-intent', { epoch_id: epoch }, auth.json.session_token);
    const confirmation = await postJson(dev.base, '/v1/rewards/claim-confirmation', {
      intent_id: intent.json.intent_id, transaction_id: 'not-a-solana-signature', status: 'confirmed',
    }, auth.json.session_token);
    assert.equal(confirmation.status, 200);
    const balance = await getJson(dev.base, '/v1/rewards/balance', auth.json.session_token);
    assert.equal(balance.json.claimed_micro, 100);
    assert.equal(balance.json.available_micro, 0);
    // A confirmed intent can never be confirmed twice (no double-spend bookkeeping).
    const replay = await postJson(dev.base, '/v1/rewards/claim-confirmation', {
      intent_id: intent.json.intent_id, transaction_id: 'another-fake-signature', status: 'confirmed',
    }, auth.json.session_token);
    assert.equal(replay.status, 409);
  } finally { await dev.app.close(); }

  // (b) production: the base58 signature shape gate rejects the same payload
  //     before any RPC is attempted. NOTE: the config must actually be built in
  //     production mode — `testConfig()` loads from an empty env, so setting
  //     process.env.NODE_ENV alone does nothing (that is why this case was red).
  const prod = await startTestApp({ ...roles, environment: 'production',
    serverSigningPublicKey: server.publicKeyBase64 });
  try {
    const auth = await authenticate(prod.base, makeWallet());
    await postJson(prod.base, '/v1/wallet/link', { player_id: 'p' }, auth.json.session_token);
    const event = server.signEvent({ match_id: 'fake-confirm-prod', player_id: 'p',
      wallet_binding_id: auth.json.wallet_binding_id, event_type: 'map_finish', amount_micro: 100,
      occurred_at: Date.now() });
    const ingest = await postJson(prod.base, '/v1/rewards/events', { events: [event] });
    await seal(prod.base, ingest.json.results[0].reward_epoch);
    const intent = await postJson(prod.base, '/v1/rewards/claim-intent',
      { epoch_id: ingest.json.results[0].reward_epoch }, auth.json.session_token);
    const confirmation = await postJson(prod.base, '/v1/rewards/claim-confirmation', {
      intent_id: intent.json.intent_id, transaction_id: 'not-a-solana-signature', status: 'confirmed',
    }, auth.json.session_token);
    assert.equal(confirmation.status, 400);
    assert.equal(confirmation.json.error.code, 'bad-transaction-signature');
    const balance = await getJson(prod.base, '/v1/rewards/balance', auth.json.session_token);
    assert.equal(balance.json.claimed_micro, 0);
    assert.equal(balance.json.available_micro, 100);
  } finally { await prod.app.close(); }
});

test('M-03 (FIXED): X-Forwarded-For is ignored unless the socket itself is a trusted proxy', () => {
  const old = process.env.TRUST_PROXY;
  const oldTrusted = process.env.TRUSTED_PROXIES;
  try {
    const req = (xff: string | undefined, remoteAddress: string) =>
      ({ headers: xff === undefined ? {} : { 'x-forwarded-for': xff }, socket: { remoteAddress } }) as any;

    // Default: proxy headers are never trusted.
    delete process.env.TRUST_PROXY;
    delete process.env.TRUSTED_PROXIES;
    assert.equal(clientIp(req('198.51.100.1', '192.0.2.1')), '192.0.2.1');

    process.env.TRUST_PROXY = '1';
    // Without an explicit TRUSTED_PROXIES list the operator accepts the direct
    // peer as a proxy, but a malformed value still falls back to the socket.
    delete process.env.TRUSTED_PROXIES;
    assert.equal(clientIp(req('not-an-ip-address', '192.0.2.1')), '192.0.2.1');
    assert.equal(clientIp(req('198.51.100.1', '192.0.2.1')), '198.51.100.1');

    // With a proxy allowlist, an arbitrary socket cannot forge its address.
    process.env.TRUSTED_PROXIES = '203.0.113.9';
    assert.equal(clientIp(req('198.51.100.1', '192.0.2.1')), '192.0.2.1');
    assert.equal(clientIp(req('198.51.100.1', '203.0.113.9')), '198.51.100.1');

    // The rate limiter therefore buckets the forger by its real socket.
    const limiter = new RateLimiter(1, 0);
    process.env.TRUST_PROXY = '0';
    delete process.env.TRUSTED_PROXIES;
    assert.equal(limiter.allow(clientIp(req('198.51.100.1', '192.0.2.1'))), true);
    assert.equal(limiter.allow(clientIp(req('198.51.100.2', '192.0.2.1'))), false,
      'rotating a forged XFF header must not refill the bucket');
  } finally {
    if (old === undefined) delete process.env.TRUST_PROXY; else process.env.TRUST_PROXY = old;
    if (oldTrusted === undefined) delete process.env.TRUSTED_PROXIES; else process.env.TRUSTED_PROXIES = oldTrusted;
  }
});

test('M-04 (FIXED): C++-shaped events without wallet_binding_id resolve via the linked player id', async () => {
  const server = makeTestServer();
  const { app, base } = await startTestApp({ ...roles, serverSigningPublicKey: server.publicKeyBase64 });
  try {
    const wallet = makeWallet();
    const auth = await authenticate(base, wallet);
    await postJson(base, '/v1/wallet/link', { player_id: 'linked-name' }, auth.json.session_token);
    // Exactly the shape src/game/server/neonrelay_events.cpp writes: no
    // wallet_binding_id, plus unsigned extra fields the backend must ignore.
    const event = { ...server.signEvent({ match_id: 'cpp-event', player_id: 'linked-name',
      event_type: 'map_finish', amount_micro: 100, occurred_at: Date.now() }),
      time_ticks: 1234, public_key: server.publicKeyBase64 };
    const ingest = await postJson(base, '/v1/rewards/events', { events: [event] });
    assert.equal(ingest.json.results[0].status, 'accepted');
    await seal(base, ingest.json.results[0].reward_epoch);
    const epochs = await getJson(base, '/v1/rewards/epochs');
    assert.equal(epochs.json[0].leaf_count, 1);
    assert.equal(epochs.json[0].total_micro, 100);
    const claim = await postJson(base, '/v1/rewards/claim-intent',
      { epoch_id: ingest.json.results[0].reward_epoch }, auth.json.session_token);
    assert.equal(claim.status, 200);
    assert.equal(claim.json.leaf_hash, leafHash(wallet.rawPublicKey, 100));
  } finally { await app.close(); }
});
