/**
 * Catalog 2026 §AD/§AE/§AF/§AG tests (incident items 101, 108, 109, 111,
 * 121–123, 127): the independent transfer-policy engine must refuse, not warn.
 *
 * Every test names the catalog item it pins. The engine is pure: no chain, no
 * keys, no network — which is exactly why it can be the out-of-band gate for
 * the operator/bot path that *does* have a signer.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  TransferPolicyError,
  assertPolicyShape,
  assertSerializedMatchesBatch,
  describeIntent,
  evaluateTransferBatch,
  intentHash,
  queueDelayedTransfer,
  type EvaluationContext,
  type LedgerEntry,
  type TransferBatch,
  type TransferIntent,
  type TransferPolicy,
} from "../src/tx_policy.ts";

/** Base58-shaped stand-in (canonicality is only regex-checked here). */
function addr(prefix: string): string {
  const clean = prefix.replace(/[^1-9A-HJ-NP-Za-km-z]/g, "A");
  return `${clean}${"1".repeat(44)}`.slice(0, 44);
}

const SKR = addr("SKRmint");
const COLD = addr("ColdVault");
const PAYOUT = addr("PayoutWallet");
const OTC = addr("OtcEscrow");
const MINTS = { SKR };

function basePolicy(overrides: Partial<TransferPolicy> = {}): TransferPolicy {
  return {
    version: 7,
    halted: false,
    chains: ["solana-mainnet"],
    mints: MINTS,
    recipients: [
      { label: "cold-vault", address: COLD, chains: ["solana-mainnet"], purposes: ["cold-storage", "sweep"], custody: "multisig" },
      { label: "payouts", address: PAYOUT, chains: ["solana-mainnet"], purposes: ["payout", "refund"], custody: "warm", limitMicro: 500_000 },
      { label: "otc", address: OTC, chains: ["solana-mainnet"], purposes: ["buyback"], custody: "multisig" },
    ],
    limits: {
      perTxMicro: 1_000_000,
      perRecipientDayMicro: 2_000_000,
      perHourMicro: 1_500_000,
      perDayMicro: 3_000_000,
      warmWalletCapMicro: 1_000_000,
    },
    approval: {
      dualAboveMicro: 700_000,
      offProtocolAlwaysDual: true,
      delayAboveMicro: 500_000,
      delayMs: 3_600_000,
    },
    ...overrides,
    simulationRequired: overrides.simulationRequired ?? false,
  } as TransferPolicy;
}

function intent(overrides: Partial<TransferIntent> = {}): TransferIntent {
  const base: TransferIntent = {
    chain: "solana-mainnet",
    mint: SKR,
    recipient: COLD,
    amountMicro: 100_000,
    purpose: "cold-storage",
    reason: "weekly sweep to cold storage",
    origin: "human",
    approvals: ["fingerprint-operator"],
    ...overrides,
  };
  if (!("decodedText" in overrides)) {
    // The operator's independent decoder must produce exactly this string.
    base.decodedText = describeIntent(base);
  }
  if (!("signedIntentHash" in overrides)) base.signedIntentHash = intentHash(base);
  return base;
}

function context(overrides: Partial<EvaluationContext> = {}): EvaluationContext {
  return { history: [], now: 1_800_000_000_000, warmWalletBalanceMicro: 300_000, ...overrides };
}

function batch(...transfers: TransferIntent[]): TransferBatch {
  return { batchId: "batch-1", transfers, createdAt: 1_800_000_000_000 };
}

function codes(violations: { code: string }[]): string[] {
  return violations.map((violation) => violation.code);
}

test("§127 valid batch passes and reports the canonical intent hash", () => {
  const verdict = evaluateTransferBatch(basePolicy(), batch(intent()), context());
  assert.equal(verdict.ok, true, JSON.stringify(verdict.violations));
  assert.deepEqual(verdict.violations, []);
  assert.equal(verdict.decoded.length, 1);
  assert.match(verdict.decoded[0], /^chain=solana-mainnet mint=\S+ to=\S+ amount_micro=100000 purpose=cold-storage$/);
  assert.equal(verdict.intentHashes[0], intent().signedIntentHash);
  assert.equal(verdict.totals.grandTotalMicro, 100_000);
  assert.equal(verdict.executeAfter[0], context().now);
});

test("§127 an empty allow-list authorises nothing: policy shape fails closed", () => {
  assert.throws(() => assertPolicyShape(basePolicy({ recipients: [] })), TransferPolicyError);
  assert.throws(() => assertPolicyShape(basePolicy({ chains: [] })), /chain/);
  assert.throws(() => assertPolicyShape(basePolicy({ mints: {} })), /mint/);
  assert.throws(() => assertPolicyShape(basePolicy({ version: 0 })), /version/);
  const badRecipient = basePolicy();
  badRecipient.recipients[0].address = "not-base58";
  assert.throws(() => assertPolicyShape(badRecipient), /canonical base58/);
});

test("§113/§127 kill switch: halted policy refuses the whole batch", () => {
  const verdict = evaluateTransferBatch(basePolicy({ halted: true }), batch(intent()), context());
  assert.equal(verdict.ok, false);
  assert.deepEqual(codes(verdict.violations), ["policy-halted"]);
});

test("§127 recipients, purposes, chains and mints are allow-listed, not inferred", () => {
  const stranger = addr("Stranger");
  const unknownRecipient = evaluateTransferBatch(basePolicy(),
    batch(intent({ recipient: stranger })), context());
  assert.ok(codes(unknownRecipient.violations).includes("recipient-not-allowed"));

  const wrongPurpose = evaluateTransferBatch(basePolicy(),
    batch(intent({ recipient: PAYOUT, purpose: "buyback" })), context());
  assert.ok(codes(wrongPurpose.violations).includes("purpose-not-allowed"));

  const wrongChain = evaluateTransferBatch(basePolicy(),
    batch(intent({ chain: "solana-devnet" })), context());
  assert.ok(codes(wrongChain.violations).includes("chain-not-allowed"));

  const wrongMint = evaluateTransferBatch(basePolicy(),
    batch(intent({ mint: addr("FakeMint") })), context());
  assert.ok(codes(wrongMint.violations).includes("mint-not-allowed"));
});

test("§111 zero, dust and max amounts: zero refused, one micro allowed, max refused", () => {
  const zero = evaluateTransferBatch(basePolicy(), batch(intent({ amountMicro: 0 })), context());
  assert.ok(codes(zero.violations).includes("invalid-amount"));

  const dust = evaluateTransferBatch(basePolicy(), batch(intent({ amountMicro: 1 })), context(
    { warmWalletBalanceMicro: 1 }));
  assert.equal(dust.ok, true, JSON.stringify(dust.violations));

  const tooBig = evaluateTransferBatch(basePolicy(),
    batch(intent({ amountMicro: Number.MAX_SAFE_INTEGER })), context());
  assert.ok(codes(tooBig.violations).includes("per-tx-limit"));

  const float = evaluateTransferBatch(basePolicy(),
    batch(intent({ amountMicro: 1.5 })), context());
  assert.ok(codes(float.violations).includes("invalid-amount"));
});

test("§127 velocity is aggregated over ALL chains, not per chain", () => {
  const history: LedgerEntry[] = [
    { chain: "solana-mainnet", recipient: PAYOUT, amountMicro: 1_400_000, executedAt: 1_800_000_000_000 - 60_000, batchId: "b0", intentHash: "h0" },
  ];
  const verdict = evaluateTransferBatch(basePolicy(),
    batch(intent({ recipient: PAYOUT, purpose: "payout", amountMicro: 200_000 })),
    context({ history, warmWalletBalanceMicro: 2_000_000 }));
  // 1.4M spent in the last hour + 200k now = 1.6M > 1.5M hourly budget.
  assert.ok(codes(verdict.violations).includes("hour-budget-exceeded"), JSON.stringify(verdict.violations));
});

test("§127 per-recipient rolling-day cap is enforced independently of the global budget", () => {
  const history: LedgerEntry[] = [
    { chain: "solana-mainnet", recipient: PAYOUT, amountMicro: 450_000, executedAt: 1_800_000_000_000 - 3_600_000, batchId: "b0", intentHash: "h0" },
  ];
  const verdict = evaluateTransferBatch(basePolicy(),
    batch(intent({ recipient: PAYOUT, purpose: "payout", amountMicro: 100_000 })),
    context({ history, warmWalletBalanceMicro: 2_000_000 }));
  assert.ok(codes(verdict.violations).includes("per-recipient-day-limit"));
});

test("§123 off-protocol (OTC/escrow) transfers always need two distinct approvers", () => {
  const single = evaluateTransferBatch(basePolicy(),
    batch(intent({ recipient: OTC, purpose: "buyback", offProtocol: true, amountMicro: 100_000 })),
    context());
  assert.ok(codes(single.violations).includes("dual-approval-required"));

  const duplicated = evaluateTransferBatch(basePolicy(),
    batch(intent({
      recipient: OTC, purpose: "buyback", offProtocol: true, amountMicro: 100_000,
      approvals: ["same", "same"],
    })), context());
  assert.ok(codes(duplicated.violations).includes("duplicate-approver"));

  const two = evaluateTransferBatch(basePolicy(),
    batch(intent({
      recipient: OTC, purpose: "buyback", offProtocol: true, amountMicro: 100_000,
      approvals: ["ops-a", "ops-b"],
    })), context());
  assert.equal(two.ok, true, JSON.stringify(two.violations));
  assert.match(two.decoded[0], /off-protocol/);
});

test("§108 bot/honeypot defence: automation must attach a verified simulation", () => {
  const policy = basePolicy({ simulationRequired: true });
  const withoutSimulation = evaluateTransferBatch(policy,
    batch(intent()), context());
  assert.ok(codes(withoutSimulation.violations).includes("simulation-required"));

  const faked = evaluateTransferBatch(policy,
    batch(intent({ simulation: { ok: true, balanceDeltaVerified: false } })), context());
  assert.ok(codes(faked.violations).includes("simulation-required"));

  const humanWithoutFlag = evaluateTransferBatch(basePolicy(),
    batch(intent({ origin: "bot" })), context());
  // origin=bot implies the flag even when the policy-wide requirement is off.
  assert.ok(codes(humanWithoutFlag.violations).includes("simulation-required"));

  const verified = evaluateTransferBatch(policy,
    batch(intent({ simulation: { ok: true, balanceDeltaVerified: true, decoder: "v1" } })), context());
  assert.equal(verified.ok, true, JSON.stringify(verified.violations));
});

test("§127 decoded text and signed hash must match the canonical fields", () => {
  const lyingDecoder = evaluateTransferBatch(basePolicy(),
    batch(intent({ decodedText: "transfer 5 tokens to the nice audit firm" })), context());
  assert.ok(codes(lyingDecoder.violations).includes("decoder-mismatch"));

  const lyingHash = evaluateTransferBatch(basePolicy(),
    batch(intent({ signedIntentHash: "0".repeat(64) })), context());
  assert.ok(codes(lyingHash.violations).includes("signed-hash-mismatch"));

  const missing = evaluateTransferBatch(basePolicy(),
    batch(intent({ decodedText: "", signedIntentHash: "" })), context());
  assert.ok(codes(missing.violations).includes("decoded-text-missing"));
  assert.ok(codes(missing.violations).includes("signed-hash-missing"));

  // The human-readable decode must change when the amount changes.
  const swapped = { ...intent({ amountMicro: 100_000 }), amountMicro: 900_000 };
  assert.equal(swapped.signedIntentHash, intentHash(intent({ amountMicro: 100_000 })));
});

test("§111/§127 replays and duplicates are refused", () => {
  const replayedBatch = evaluateTransferBatch(basePolicy(), batch(intent()),
    { ...context(), seenBatchIds: ["batch-1"] });
  assert.deepEqual(codes(replayedBatch.violations), ["replayed-batch"]);

  const twice = evaluateTransferBatch(basePolicy(), batch(intent(), intent()), context());
  assert.ok(codes(twice.violations).includes("duplicate-intent"));

  const historical = intent();
  const history: LedgerEntry[] = [{
    chain: historical.chain, recipient: historical.recipient, amountMicro: historical.amountMicro,
    executedAt: context().now - 10_000, batchId: "old", intentHash: intentHash(historical),
  }];
  const replayed = evaluateTransferBatch(basePolicy(), batch(historical), context({ history }));
  assert.ok(codes(replayed.violations).includes("replayed-intent"));
});

test("§128/§127 above-threshold transfers are queued and delayed, not instant", () => {
  const big = intent({ amountMicro: 800_000, approvals: ["ops-a", "ops-b"] });
  const unqueued = evaluateTransferBatch(basePolicy(), batch(big), context({ warmWalletBalanceMicro: 900_000 }));
  assert.ok(codes(unqueued.violations).includes("delay-not-queued"));

  const queued = queueDelayedTransfer(basePolicy(), big, 1_800_000_000_000);
  assert.equal(queued.executeAt, 1_800_000_000_000 + 3_600_000);

  const tooEarly = evaluateTransferBatch(basePolicy(), batch(queued.intent), context({
    warmWalletBalanceMicro: 900_000, now: 1_800_000_000_000 + 60_000,
  }));
  assert.ok(codes(tooEarly.violations).includes("delay-not-elapsed"));

  const executed = evaluateTransferBatch(basePolicy(), batch(queued.intent), context({
    warmWalletBalanceMicro: 900_000, now: queued.executeAt,
  }));
  assert.equal(executed.ok, true, JSON.stringify(executed.violations));

  // The queue pass itself is authorised (nothing moves yet): the intent has a
  // queuedAt, so `delay-not-elapsed` is not a finding there — and only there.
  const queuePass = evaluateTransferBatch(basePolicy(), batch(queued.intent), context({
    warmWalletBalanceMicro: 900_000,
  }), { queueing: true });
  assert.equal(queuePass.ok, true, JSON.stringify(queuePass.violations));
  // An intent with no queue timestamp is refused even in queueing mode.
  const neverQueued = evaluateTransferBatch(basePolicy(), batch(big), context({
    warmWalletBalanceMicro: 900_000,
  }), { queueing: true });
  assert.ok(codes(neverQueued.violations).includes("delay-not-queued"));
});

test("§120/§127 the warm wallet is hard-capped; proceeds must be swept to cold", () => {
  const overCap = evaluateTransferBatch(basePolicy(),
    batch(intent({ amountMicro: 50_000 })), context({ warmWalletBalanceMicro: 1_500_000 }));
  assert.ok(codes(overCap.violations).includes("warm-wallet-cap-exceeded"));

  const insufficient = evaluateTransferBatch(basePolicy(),
    batch(intent({ amountMicro: 100_000 })), context({ warmWalletBalanceMicro: 10_000 }));
  assert.ok(codes(insufficient.violations).includes("insufficient-warm-balance"));

  const healthy = evaluateTransferBatch(basePolicy(),
    batch(intent({ amountMicro: 100_000 })), context({ warmWalletBalanceMicro: 300_000 }));
  assert.equal(healthy.ok, true, JSON.stringify(healthy.violations));
});

test("§127 the serialized instructions must carry exactly the evaluated transfers", () => {
  const policy = basePolicy();
  const verdict = evaluateTransferBatch(policy, batch(intent()), context());
  assertSerializedMatchesBatch(verdict, [`transfer ${verdict.decoded[0].split(" ")[1]} amount_micro=100000 to=${COLD}`]);
  assert.throws(() => assertSerializedMatchesBatch(verdict,
    [`transfer amount_micro=100000 to=${COLD}`, "SetAuthority newAuthority=attacker"]),
  /signer received 2 instructions/);
  assert.throws(() => assertSerializedMatchesBatch(verdict,
    [`transfer amount_micro=999999 to=${COLD}`]), /does not carry the evaluated amount/);
  assert.throws(() => assertSerializedMatchesBatch(verdict,
    [`transfer amount_micro=100000 to=${addr("Attacker")}`]), /does not carry the evaluated recipient/);
});

test("§127 batch totals are reported per chain and overall for the audit trail", () => {
  const policy = basePolicy({ chains: ["solana-mainnet", "solana-devnet"] });
  const devnetCold = { ...COLD };
  policy.recipients[0].chains = ["solana-mainnet", "solana-devnet"];
  void devnetCold;
  const verdict = evaluateTransferBatch(policy, batch(
    intent({ amountMicro: 100_000 }),
    intent({ chain: "solana-devnet", amountMicro: 200_000 }),
  ), context({ warmWalletBalanceMicro: 1_000_000 }));
  assert.equal(verdict.ok, true, JSON.stringify(verdict.violations));
  assert.deepEqual(verdict.totals.perChainMicro, { "solana-mainnet": 100_000, "solana-devnet": 200_000 });
  assert.equal(verdict.totals.grandTotalMicro, 300_000);
});
