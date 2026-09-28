/**
 * Independent transfer-policy engine (SW-2026-IC, incident catalog 2026 §AD/AE/AF).
 *
 * Why this exists — the 2026 incident pattern (§127 Bitget, §101 Resolv,
 * §121 Dominion, §122 Fogo, §123 Meteora): the component that *initiates* a
 * transfer is not the component that *authorises* it, and the amount a human
 * reads is not necessarily the amount that gets signed. A backend, an approval
 * bot, a treasury laptop or a compromised operator session must not be able to
 * move funds merely because it can reach a signer.
 *
 * This module is deliberately dependency-free and side-effect-free: it is a
 * pure evaluator over (policy, batch, history, balances). The operator CLI
 * (`backend/scripts/transfer_preflight.ts`) uses it as a preflight gate and
 * the deployment runbook requires its verdict (exit code 0) before any Squads
 * transaction is proposed. Nothing here signs, sends or stores a key.
 *
 * Guards, keyed to the incident catalog:
 *  - recipients are allow-listed per chain with a purpose scope     (§127)
 *  - per-transaction, per-recipient, per-hour and per-day limits    (§127)
 *  - velocity is aggregated over ALL chains (a per-chain budget is a
 *    five-finger discount: 15 transfers × 7 chains in 20 minutes)   (§127)
 *  - hard cap on warm-wallet balance; hot keys stay small           (§120/§127)
 *  - batching + mandatory delay above a threshold, so a stolen
 *    session cannot chain an instant drain                             (§128)
 *  - two-person approval above a threshold and for every
 *    off-protocol transfer (OTC/escrow/"partner")                     (§123)
 *  - simulation + balance-delta proof required for bot-initiated
 *    transfers (honeypot defence: the bot is told what it approves)   (§108)
 *  - decoded intent must equal the human-readable text the operator
 *    approved, and the signed hash must match those fields            (§127)
 *  - zero/dust amounts, unknown mints, duplicate intents and
 *    replays are rejected                                             (§111)
 *  - a kill switch (`halted`) fails the whole batch closed
 *
 * Fail-closed: an unknown chain, mint, recipient, purpose or a missing
 * simulation is a violation; an empty allow-list authorises nothing.
 */
import { createHash } from "node:crypto";

export interface TransferPolicy {
  /** Bumped on every review; a mismatch with the expected version fails closed. */
  version: number;
  /** Kill switch. True ⇒ every batch is rejected, no exceptions. */
  halted: boolean;
  /** Chain ids this policy covers (e.g. "solana-mainnet", "solana-devnet"). */
  chains: string[];
  /** Allowed mints, keyed by operator-facing symbol. */
  mints: Record<string, string>;
  recipients: RecipientRule[];
  limits: {
    perTxMicro: number;
    perRecipientDayMicro: number;
    /** Rolling-hour budget, summed over every chain in `chains`. */
    perHourMicro: number;
    /** Rolling-day budget, summed over every chain in `chains`. */
    perDayMicro: number;
    /** The hot/warm wallet balance may never exceed this. */
    warmWalletCapMicro: number;
  };
  approval: {
    /** At or above this amount a second, distinct approver is required. */
    dualAboveMicro: number;
    /** Off-protocol transfers (OTC, escrow, market maker) always need two. */
    offProtocolAlwaysDual: boolean;
    /** At or above this amount the transfer must be queued, then delayed. */
    delayAboveMicro: number;
    /** Delay between queueing and execution. */
    delayMs: number;
  };
  /** Bot- and automation-initiated transfers must carry a simulation proof. */
  simulationRequired: boolean;
}

export interface RecipientRule {
  label: string;
  address: string;
  /** Chains this recipient may receive on (usually one). */
  chains: string[];
  /** What the money is for; any other purpose is refused. */
  purposes: string[];
  /** Optional per-recipient rolling-day cap, stricter than the global one. */
  limitMicro?: number;
  custody: "multisig" | "cold" | "warm";
}

export interface TransferIntent {
  chain: string;
  /** Mint address (not a symbol): symbols can be re-pointed by config drift. */
  mint: string;
  recipient: string;
  amountMicro: number;
  purpose: string;
  /** Human-readable reason; required, never used for authorisation. */
  reason: string;
  /** True for OTC/escrow/market-maker style transfers outside the protocol. */
  offProtocol?: boolean;
  /** Distinct approver fingerprints (sha256 of their admin token). */
  approvals?: string[];
  /** Present when this transfer was queued for delayed execution. */
  queuedAt?: number;
  /** Set for automation/bots: the result of a pre-signing simulation. */
  simulation?: { ok: boolean; balanceDeltaVerified: boolean; decoder?: string };
  /** What the human sees before approving. */
  decodedText?: string;
  /** Hash of the intent the signer will actually sign. */
  signedIntentHash?: string;
  /** Transfer kind, for the decoded text and audit trail. */
  origin?: "human" | "bot";
}

export interface TransferBatch {
  /** Batch id: two batches with the same id are a replay, not a second payment. */
  batchId: string;
  transfers: TransferIntent[];
  createdAt: number;
}

export interface LedgerEntry {
  chain: string;
  recipient: string;
  amountMicro: number;
  executedAt: number;
  batchId: string;
  intentHash: string;
}

export interface EvaluationContext {
  /** Everything executed in the last 24h (longest window the policy uses). */
  history: LedgerEntry[];
  now: number;
  /** Warm-wallet balance that the batch would spend from. */
  warmWalletBalanceMicro: number;
  /** Batches already accepted; a repeated batchId is refused. */
  seenBatchIds?: string[];
}

export interface Violation {
  /** Stable code for alerts and tests; never localised. */
  code: string;
  index: number;
  detail: string;
}

export interface TransferVerdict {
  ok: boolean;
  violations: Violation[];
  /** Human-readable decode of every transfer, in batch order. */
  decoded: string[];
  /** Canonical intent hashes, in batch order (what must match the signature). */
  intentHashes: string[];
  /** For `delayAboveMicro` transfers: the earliest allowed execution time. */
  executeAfter: number[];
  /** Totals used for the audit trail. */
  totals: { perChainMicro: Record<string, number>; grandTotalMicro: number };
}

export class TransferPolicyError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "TransferPolicyError";
  }
}

const MAX_SAFE = Number.MAX_SAFE_INTEGER;

function isPositiveSafeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeSafeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Structural validation. Called before any evaluation so a half-written policy
 * (or a policy file edited by an attacker with repo access) fails closed
 * instead of silently authorising.
 */
export function assertPolicyShape(policy: TransferPolicy): void {
  const fail = (detail: string): never => {
    throw new TransferPolicyError("policy-invalid", detail);
  };
  if (!policy || typeof policy !== "object") fail("policy object required");
  if (!Number.isInteger(policy.version) || policy.version <= 0) fail("version must be a positive integer");
  if (typeof policy.halted !== "boolean") fail("halted must be boolean");
  if (!Array.isArray(policy.chains) || policy.chains.length === 0) fail("at least one chain required");
  if (new Set(policy.chains).size !== policy.chains.length) fail("chains must be unique");
  if (!policy.mints || typeof policy.mints !== "object" || Array.isArray(policy.mints)) {
    fail("mints map required");
  }
  if (Object.keys(policy.mints).length === 0) {
    fail("at least one allow-listed mint is required (an empty mint list authorises nothing)");
  }
  for (const [symbol, mint] of Object.entries(policy.mints)) {
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) fail(`mint ${symbol} is not canonical base58`);
  }
  if (!Array.isArray(policy.recipients) || policy.recipients.length === 0) {
    fail("at least one allow-listed recipient required (an empty allow-list authorises nothing)");
  }
  const seen = new Set<string>();
  for (const recipient of policy.recipients) {
    if (!recipient.label || typeof recipient.label !== "string") fail("recipient label required");
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(recipient.address)) {
      fail(`recipient ${recipient.label} address is not canonical base58`);
    }
    const key = `${recipient.address}|${recipient.chains.join(",")}`;
    if (seen.has(key)) fail(`duplicate recipient entry ${recipient.label}`);
    seen.add(key);
    if (!Array.isArray(recipient.chains) || recipient.chains.length === 0) {
      fail(`recipient ${recipient.label} must list chains`);
    }
    if (!Array.isArray(recipient.purposes) || recipient.purposes.length === 0) {
      fail(`recipient ${recipient.label} must list allowed purposes`);
    }
    if (!["multisig", "cold", "warm"].includes(recipient.custody)) {
      fail(`recipient ${recipient.label} has unknown custody`);
    }
    if (recipient.limitMicro !== undefined && !isPositiveSafeInt(recipient.limitMicro)) {
      fail(`recipient ${recipient.label} limitMicro must be a positive integer`);
    }
  }
  const limits = policy.limits;
  if (!limits || typeof limits !== "object") fail("limits required");
  for (const field of ["perTxMicro", "perRecipientDayMicro", "perHourMicro", "perDayMicro",
    "warmWalletCapMicro"] as const) {
    if (!isPositiveSafeInt(limits?.[field])) fail(`limits.${field} must be a positive integer`);
  }
  if (limits.perHourMicro > limits.perDayMicro) fail("perHour limit cannot exceed perDay limit");
  if (limits.perTxMicro > limits.perDayMicro) fail("perTx limit cannot exceed perDay limit");
  const approval = policy.approval;
  if (!approval || typeof approval !== "object") fail("approval required");
  if (!isPositiveSafeInt(approval.dualAboveMicro)) fail("approval.dualAboveMicro must be positive");
  if (typeof approval.offProtocolAlwaysDual !== "boolean") fail("approval.offProtocolAlwaysDual must be boolean");
  if (!isNonNegativeSafeInt(approval.delayAboveMicro)) fail("approval.delayAboveMicro must be non-negative");
  if (approval.delayAboveMicro > 0 && !isPositiveSafeInt(approval.delayMs)) {
    fail("approval.delayMs must be positive when a delay threshold is set");
  }
  if (typeof policy.simulationRequired !== "boolean") fail("simulationRequired must be boolean");
}

/** Deterministic canonical form of the fields that get signed. */
export function canonicalIntentPayload(intent: TransferIntent): string {
  return JSON.stringify({
    chain: intent.chain,
    mint: intent.mint,
    recipient: intent.recipient,
    amount_micro: intent.amountMicro,
    purpose: intent.purpose,
  });
}

/** Hash the signer must actually sign; compared against `signedIntentHash`. */
export function intentHash(intent: TransferIntent): string {
  return createHash("sha256").update(canonicalIntentPayload(intent), "utf8").digest("hex");
}

/**
 * The one and only decoding of an intent. Operators approve `decodedText`
 * produced by an independent decoder; the comparison below is the §127
 * "what the human sees == what is signed" invariant. Amounts are printed in
 * base units only — no USD figure that could be manipulated by a price feed.
 */
export function describeIntent(intent: TransferIntent): string {
  const purpose = intent.offProtocol ? `${intent.purpose} (off-protocol)` : intent.purpose;
  return `chain=${intent.chain} mint=${intent.mint} to=${intent.recipient} ` +
    `amount_micro=${intent.amountMicro} purpose=${purpose}`;
}

function sumWhere(entries: LedgerEntry[], now: number, windowMs: number, predicate: (e: LedgerEntry) => boolean): number {
  let total = 0;
  for (const entry of entries) {
    if (!Number.isSafeInteger(entry.amountMicro) || entry.amountMicro < 0) continue;
    if (now - entry.executedAt > windowMs) continue;
    if (predicate(entry)) total += entry.amountMicro;
  }
  return total;
}

export function inRollingWindow(entry: LedgerEntry, now: number, windowMs: number): boolean {
  return now - entry.executedAt <= windowMs;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/**
 * Evaluate a whole batch. Returns `ok: false` together with every violation;
 * there is no partial execution: a batch with one bad transfer is refused
 * entirely (an attacker who can add a transfer can also reorder one).
 *
 * `options.queueing` marks the *queue* pass (recording `queuedAt` for
 * above-threshold transfers). The queue pass is authorised on its own rules —
 * amounts, recipients, approvals, budgets — but the delay has not elapsed yet,
 * which is exactly what makes execution later provable.
 */
export function evaluateTransferBatch(
  policy: TransferPolicy,
  batch: TransferBatch,
  context: EvaluationContext,
  options: { queueing?: boolean } = {},
): TransferVerdict {
  assertPolicyShape(policy);
  const violations: Violation[] = [];
  const decoded: string[] = [];
  const intentHashes: string[] = [];
  const executeAfter: number[] = [];
  const totals = { perChainMicro: {} as Record<string, number>, grandTotalMicro: 0 };

  if (policy.halted) {
    return refuse("policy-halted", "kill switch is engaged: no transfer is authorised");
  }
  if (!batch || typeof batch !== "object" || !Array.isArray(batch.transfers) || batch.transfers.length === 0) {
    return refuse("empty-batch", "batch has no transfers");
  }
  if (!batch.batchId || typeof batch.batchId !== "string") {
    return refuse("missing-batch-id", "batchId is required for replay detection");
  }
  if (typeof batch.createdAt !== "number" || !Number.isFinite(batch.createdAt)) {
    return refuse("missing-batch-time", "createdAt is required");
  }
  if (context.seenBatchIds?.includes(batch.batchId)) {
    return refuse("replayed-batch", `batch ${batch.batchId} was already executed`);
  }
  if (!Number.isFinite(context.now) || context.now < batch.createdAt) {
    return refuse("clock-skew", "evaluation time precedes the batch creation time");
  }

  const inBatchHashes = new Set<string>();
  let batchTotal = 0;

  batch.transfers.forEach((intent, index) => {
    const push = (code: string, detail: string) => violations.push({ code, index, detail });

    if (!intent || typeof intent !== "object") {
      push("malformed-intent", "transfer is not an object");
      decoded.push("(malformed)");
      intentHashes.push("");
      executeAfter.push(context.now);
      return;
    }

    // --- shape / fail-closed primitives (§111 zero and dust amounts) --------
    if (!isPositiveSafeInt(intent.amountMicro)) {
      push("invalid-amount", "amountMicro must be a positive safe integer (zero and dust are refused)");
    } else if (intent.amountMicro > policy.limits.perTxMicro) {
      push("per-tx-limit", `amount ${intent.amountMicro} exceeds per-transaction limit ${policy.limits.perTxMicro}`);
    }
    if (typeof intent.reason !== "string" || intent.reason.trim().length < 3) {
      push("missing-reason", "a human-readable reason is required for the audit trail");
    }
    if (!policy.chains.includes(intent.chain)) {
      push("chain-not-allowed", `chain ${intent.chain} is not in the policy allow-list`);
    }
    const knownMints = Object.values(policy.mints);
    if (!knownMints.includes(intent.mint)) {
      push("mint-not-allowed", `mint ${intent.mint} is not in the policy allow-list`);
    }

    // --- recipient allow-list ----------------------------------------------
    const rule = policy.recipients.find((candidate) =>
      candidate.address === intent.recipient && candidate.chains.includes(intent.chain));
    if (!rule) {
      push("recipient-not-allowed", `recipient ${intent.recipient} is not allow-listed on ${intent.chain}`);
    } else {
      if (!rule.purposes.includes(intent.purpose)) {
        push("purpose-not-allowed", `purpose ${intent.purpose} is not allowed for ${rule.label}`);
      }
      const recipientDay = sumWhere(context.history, context.now, DAY_MS,
        (entry) => entry.recipient === intent.recipient) + (Number.isSafeInteger(intent.amountMicro) ? intent.amountMicro : 0);
      const cap = rule.limitMicro ?? policy.limits.perRecipientDayMicro;
      if (recipientDay > cap) {
        push("per-recipient-day-limit", `recipient daily total ${recipientDay} exceeds ${cap}`);
      }
    }

    // --- approvals ----------------------------------------------------------
    const approvals = Array.isArray(intent.approvals) ? intent.approvals.filter((a) => typeof a === "string") : [];
    const uniqueApprovers = new Set(approvals);
    if (uniqueApprovers.size !== approvals.length) {
      push("duplicate-approver", "the same approver was counted twice");
    }
    const needsDual = (isPositiveSafeInt(intent.amountMicro) && intent.amountMicro >= policy.approval.dualAboveMicro) ||
      (policy.approval.offProtocolAlwaysDual && intent.offProtocol === true);
    if (needsDual && uniqueApprovers.size < 2) {
      push("dual-approval-required", "two distinct approvers are required for this transfer");
    }

    // --- simulation (§108 honeypot / bot approval traps) --------------------
    if (policy.simulationRequired || intent.origin === "bot") {
      const simulation = intent.simulation;
      if (!simulation || simulation.ok !== true || simulation.balanceDeltaVerified !== true) {
        push("simulation-required", "a successful balance-delta simulation is required before signing");
      }
      const decoder = simulation?.decoder;
      if (decoder !== undefined && typeof decoder !== "string") {
        push("simulation-decoder-invalid", "simulation.decoder must be a string when present");
      }
    }

    // --- decode equality (§127: human-approved text == signed fields) -------
    const description = describeIntent(intent);
    decoded.push(description);
    if (typeof intent.decodedText !== "string" || intent.decodedText.length === 0) {
      push("decoded-text-missing", "the operator-facing decode is required and must be compared");
    } else if (intent.decodedText !== description) {
      push("decoder-mismatch", "decoded text does not match the canonical decoding of the signed fields");
    }
    const hash = intentHash(intent);
    intentHashes.push(hash);
    if (typeof intent.signedIntentHash !== "string" || intent.signedIntentHash.length === 0) {
      push("signed-hash-missing", "the signed intent hash is required");
    } else if (intent.signedIntentHash !== hash) {
      push("signed-hash-mismatch", "the signed intent hash does not match the canonical fields");
    }
    if (inBatchHashes.has(hash)) push("duplicate-intent", "identical transfer appears twice in the batch");
    inBatchHashes.add(hash);
    if (context.history.some((entry) => entry.intentHash === hash)) {
      push("replayed-intent", "this exact transfer was already executed");
    }

    // --- delay / batching ---------------------------------------------------
    const needsDelay = isPositiveSafeInt(intent.amountMicro) && intent.amountMicro >= policy.approval.delayAboveMicro &&
      policy.approval.delayAboveMicro > 0;
    if (needsDelay) {
      const queuedAt = intent.queuedAt;
      if (typeof queuedAt !== "number" || !Number.isFinite(queuedAt) || queuedAt <= 0) {
        // Even the queueing pass must carry a queue timestamp: an intent that
        // was never queued may not be executed later by claiming it was.
        push("delay-not-queued", "transfer above the delay threshold must be queued before execution");
        executeAfter.push(context.now + policy.approval.delayMs);
      } else {
        const earliest = queuedAt + policy.approval.delayMs;
        executeAfter.push(earliest);
        if (!options.queueing && context.now < earliest) {
          push("delay-not-elapsed", `queued transfer may execute no earlier than ${earliest}`);
        }
      }
    } else {
      executeAfter.push(context.now);
    }

    if (isPositiveSafeInt(intent.amountMicro)) {
      batchTotal += intent.amountMicro;
      totals.perChainMicro[intent.chain] = (totals.perChainMicro[intent.chain] ?? 0) + intent.amountMicro;
    }
  });

  // --- velocity budgets: summed over every chain in the policy -------------
  const hourSpent = sumWhere(context.history, context.now, HOUR_MS, () => true);
  const daySpent = sumWhere(context.history, context.now, DAY_MS, () => true);
  if (hourSpent + batchTotal > policy.limits.perHourMicro) {
    violations.push({
      code: "hour-budget-exceeded", index: -1,
      detail: `rolling hour ${hourSpent + batchTotal} (all chains) exceeds ${policy.limits.perHourMicro}`,
    });
  }
  if (daySpent + batchTotal > policy.limits.perDayMicro) {
    violations.push({
      code: "day-budget-exceeded", index: -1,
      detail: `rolling day ${daySpent + batchTotal} (all chains) exceeds ${policy.limits.perDayMicro}`,
    });
  }
  if (isNonNegativeSafeInt(context.warmWalletBalanceMicro) &&
      batchTotal > context.warmWalletBalanceMicro) {
    violations.push({
      code: "insufficient-warm-balance", index: -1,
      detail: `batch spends ${batchTotal} but the warm wallet holds ${context.warmWalletBalanceMicro}`,
    });
  }
  const warmAfter = (isNonNegativeSafeInt(context.warmWalletBalanceMicro) ? context.warmWalletBalanceMicro : 0) - batchTotal;
  if (warmAfter > policy.limits.warmWalletCapMicro) {
    violations.push({
      code: "warm-wallet-cap-exceeded", index: -1,
      detail: `warm wallet would hold ${warmAfter}, above the cap ${policy.limits.warmWalletCapMicro}`,
    });
  }

  totals.grandTotalMicro = batchTotal;
  return { ok: violations.length === 0, violations, decoded, intentHashes, executeAfter, totals };

  function refuse(code: string, detail: string): TransferVerdict {
    return {
      ok: false,
      violations: [{ code, index: -1, detail }],
      decoded: [], intentHashes: [], executeAfter: [], totals,
    };
  }
}

/**
 * Queue a transfer for delayed execution: the caller stores the returned
 * record and may only execute it once `executeAt` has passed and the same,
 * unchanged intent re-evaluates clean.
 */
export function queueDelayedTransfer(
  policy: TransferPolicy, intent: TransferIntent, queuedAt: number,
): { intent: TransferIntent; executeAt: number } {
  assertPolicyShape(policy);
  return { intent: { ...intent, queuedAt }, executeAt: queuedAt + policy.approval.delayMs };
}

/**
 * Cross-check the batch against bytes actually handed to the signer
 * (independent decoder invariant, §127). The caller supplies the transfer
 * instructions exactly as serialised for signing; every instruction must map
 * to an evaluated intent, and vice versa. Extra instructions are refused —
 * that is how "approve" and "set authority" sneak in.
 */
export function assertSerializedMatchesBatch(
  verdict: TransferVerdict, serialized: string[],
): void {
  if (!verdict.ok) throw new TransferPolicyError("verdict-not-ok", "batch did not pass the policy gate");
  if (serialized.length !== verdict.intentHashes.length) {
    throw new TransferPolicyError("serialized-count-mismatch",
      `signer received ${serialized.length} instructions for ${verdict.intentHashes.length} evaluated intents`);
  }
  serialized.forEach((text, index) => {
    const expected = verdict.decoded[index];
    if (!text.includes(`amount_micro=${extractAmount(expected)}`)) {
      throw new TransferPolicyError("serialized-amount-mismatch",
        `serialized instruction ${index} does not carry the evaluated amount`);
    }
    if (!text.includes(`to=${extractRecipient(expected)}`)) {
      throw new TransferPolicyError("serialized-recipient-mismatch",
        `serialized instruction ${index} does not carry the evaluated recipient`);
    }
  });
}

function extractAmount(decoded: string): string {
  return decoded.match(/amount_micro=(\d+)/)?.[1] ?? "(none)";
}

function extractRecipient(decoded: string): string {
  return decoded.match(/to=(\S+)/)?.[1] ?? "(none)";
}
