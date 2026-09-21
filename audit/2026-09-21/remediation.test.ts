/**
 * Verification of Audit Remediations (2026-09-21).
 * Confirms that all patched vulnerabilities are strictly blocked and fixed.
 * Run from repository root:
 * node --experimental-strip-types --test audit/2026-09-21/remediation.test.ts
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

test('FIX CRIT-01 / H-01: Attacker cannot hijack victim reward with their own wallet_binding_id', async () => {
  const server = makeTestServer();
  const { app, base } = await startTestApp({ ...roles, serverSigningPublicKey: server.publicKeyBase64 });
  try {
    const victim = await authenticate(base, makeWallet());
    await postJson(base, '/v1/wallet/link', { player_id: 'victim-stable-id' }, victim.json.session_token);

    const attackerWallet = makeWallet();
    const attacker = await authenticate(base, attackerWallet);

    const original = server.signEvent({
      match_id: 'legitimate-match',
      player_id: 'victim-stable-id',
      wallet_binding_id: victim.json.wallet_binding_id,
      event_type: 'map_finish',
      amount_micro: 100,
      occurred_at: Date.now(),
    });

    // Attacker tries to replace victim's binding with their own
    const tampered = { ...original, wallet_binding_id: attacker.json.wallet_binding_id };

    const result = await postJson(base, '/v1/rewards/events', { events: [tampered] });
    assert.equal(result.json.results[0].status, 'rejected_validation');
    assert.match(result.json.results[0].reason, /wallet binding does not/);

    // Genuine event succeeds
    const genuine = await postJson(base, '/v1/rewards/events', { events: [original] });
    assert.equal(genuine.json.results[0].status, 'accepted');

    const epoch = genuine.json.results[0].reward_epoch;
    await seal(base, epoch);

    // Victim receives Merkle proof
    const victimClaim = await postJson(base, '/v1/rewards/claim-intent', { epoch_id: epoch }, victim.json.session_token);
    assert.equal(victimClaim.status, 200);
    assert.equal(victimClaim.json.amount_micro, 100);

    // Attacker gets 404 (no leaves)
    const attackerClaim = await postJson(base, '/v1/rewards/claim-intent', { epoch_id: epoch }, attacker.json.session_token);
    assert.equal(attackerClaim.status, 404);
  } finally {
    await app.close();
  }
});

test('FIX HIGH-01 / M-01: Invalid signature retry is no longer poisoned', async () => {
  const server = makeTestServer();
  const { app, base } = await startTestApp({ serverSigningPublicKey: server.publicKeyBase64 });
  try {
    const event = server.signEvent({
      match_id: 'poison-test',
      player_id: 'p1',
      event_type: 'map_finish',
      amount_micro: 50,
      occurred_at: Date.now(),
    });

    // Send corrupted signature
    const corrupt = await postJson(base, '/v1/rewards/events', {
      events: [{ ...event, server_signature: Buffer.alloc(64).toString('base64url') }],
    });
    assert.equal(corrupt.json.results[0].status, 'rejected_signature');

    // Resend genuine event - now cleanly accepted!
    const genuine = await postJson(base, '/v1/rewards/events', { events: [event] });
    assert.equal(genuine.json.results[0].status, 'accepted');
  } finally {
    await app.close();
  }
});

test('FIX MED-01: Fake transaction confirmation is rejected in production without valid signature', async () => {
  const oldEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  const server = makeTestServer();
  const { app, base } = await startTestApp({ ...roles, serverSigningPublicKey: server.publicKeyBase64 });
  try {
    const auth = await authenticate(base, makeWallet());
    const event = server.signEvent({
      match_id: 'fake-tx',
      player_id: 'p2',
      wallet_binding_id: auth.json.wallet_binding_id,
      event_type: 'map_finish',
      amount_micro: 100,
      occurred_at: Date.now(),
    });
    const ingest = await postJson(base, '/v1/rewards/events', { events: [event] });
    const epoch = ingest.json.results[0].reward_epoch;
    await seal(base, epoch);

    const intent = await postJson(base, '/v1/rewards/claim-intent', { epoch_id: epoch }, auth.json.session_token);

    // Arbitrary fake transaction string must be rejected
    const confirmation = await postJson(base, '/v1/rewards/claim-confirmation', {
      intent_id: intent.json.intent_id,
      transaction_id: 'not-a-solana-signature',
      status: 'confirmed',
    }, auth.json.session_token);
    assert.equal(confirmation.status, 400);
    assert.equal(confirmation.json.error.code, 'bad-transaction-signature');
  } finally {
    process.env.NODE_ENV = oldEnv;
    await app.close();
  }
});

test('FIX MED-02: TRUST_PROXY=1 validates IP format and ignores forged headers', () => {
  const old = process.env.TRUST_PROXY;
  const oldTrusted = process.env.TRUSTED_PROXIES;
  try {
    process.env.TRUST_PROXY = '1';
    const req = (xff: string, socket = '192.0.2.1') => ({
      headers: { 'x-forwarded-for': xff },
      socket: { remoteAddress: socket },
    }) as any;

    // Valid IP is parsed
    assert.equal(clientIp(req('198.51.100.1')), '198.51.100.1');

    // Malformed non-IP is rejected and safely falls back to socket IP
    assert.equal(clientIp(req('not-an-ip-address')), '192.0.2.1');

    // Untrusted proxy socket IP ignores X-Forwarded-For when TRUSTED_PROXIES is configured
    process.env.TRUSTED_PROXIES = '10.0.0.1,10.0.0.2';
    assert.equal(clientIp(req('198.51.100.1', '192.0.2.1')), '192.0.2.1');
    assert.equal(clientIp(req('198.51.100.1', '10.0.0.1')), '198.51.100.1');
  } finally {
    if (old === undefined) delete process.env.TRUST_PROXY;
    else process.env.TRUST_PROXY = old;
    if (oldTrusted === undefined) delete process.env.TRUSTED_PROXIES;
    else process.env.TRUSTED_PROXIES = oldTrusted;
  }
});

test('FIX HIGH-02 / M-04: Authentic C++ events (omitting wallet_binding_id) resolve via player_id', async () => {
  const server = makeTestServer();
  const { app, base } = await startTestApp({ ...roles, serverSigningPublicKey: server.publicKeyBase64 });
  try {
    const auth = await authenticate(base, makeWallet());
    await postJson(base, '/v1/wallet/link', { player_id: 'cpp-player' }, auth.json.session_token);

    // Event generated without wallet_binding_id, exactly as C++ server does
    const event = server.signEvent({
      match_id: 'cpp-match',
      player_id: 'cpp-player',
      event_type: 'map_finish',
      amount_micro: 250,
      occurred_at: Date.now(),
    });
    assert.equal((event as any).wallet_binding_id, undefined);

    const ingest = await postJson(base, '/v1/rewards/events', { events: [event] });
    assert.equal(ingest.json.results[0].status, 'accepted');

    const epochId = ingest.json.results[0].reward_epoch;
    await seal(base, epochId);

    const epochs = await getJson(base, '/v1/rewards/epochs');
    assert.equal(epochs.json[0].leaf_count, 1);
    assert.equal(epochs.json[0].total_micro, 250);

    const claim = await postJson(base, '/v1/rewards/claim-intent', {
      epoch_id: epochId,
    }, auth.json.session_token);
    assert.equal(claim.status, 200);
    assert.equal(claim.json.amount_micro, 250);
  } finally {
    await app.close();
  }
});
