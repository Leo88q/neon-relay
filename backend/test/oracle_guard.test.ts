/**
 * Catalog 2026 §AA/§AH tests (incident items 95, 96, 102, 111, 117, 118):
 * a price that cannot be trusted must produce `no-price`, never a number the
 * protocol acts on, and recognised value must be capped by market depth.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  OracleGuardError,
  assertOraclePolicyShape,
  assertVerifierRedundancy,
  countIndependentSources,
  guardPrice,
  markValueMicro,
  verifyConfigChangeAttestation,
  type OraclePolicy,
  type PriceSample,
} from "../src/oracle_guard.ts";

const NOW = 1_800_000_000_000;

function policy(overrides: Partial<OraclePolicy> = {}): OraclePolicy {
  return {
    maxAgeMs: 60_000,
    maxFutureSkewMs: 2_000,
    minSources: 3,
    maxDeviationBps: 300,
    minWindowVolumeMicro: 100_000_000,
    minTrades: 20,
    depthCapBps: 1_000, // recognise at most 10% of window volume
    ...overrides,
  };
}

function sample(overrides: Partial<PriceSample> = {}): PriceSample {
  return {
    source: "provider-a",
    priceMicro: 1_000_000,
    timestampMs: NOW - 1_000,
    volumeMicro: 60_000_000,
    trades: 30,
    ...overrides,
  };
}

test("§96/§118 a healthy three-source window yields a median price", () => {
  const decision = guardPrice([
    sample({ source: "provider-a", priceMicro: 1_000_000 }),
    sample({ source: "provider-b", priceMicro: 1_010_000, volumeMicro: 50_000_000 }),
    sample({ source: "self-node", priceMicro: 990_000, volumeMicro: 50_000_000 }),
  ], policy(), NOW);
  assert.equal(decision.status, "ok");
  if (decision.status !== "ok") return;
  assert.equal(decision.priceMicro, 1_000_000);
  assert.deepEqual(decision.sources.sort(), ["provider-a", "provider-b", "self-node"]);
  assert.ok(decision.volumeMicro >= 100_000_000);
  assert.ok(decision.trades >= 20);
});

test("§96 prices from the future are rejected, not averaged (Ostium pattern)", () => {
  const decision = guardPrice([
    sample({ source: "provider-a" }),
    sample({ source: "provider-b" }),
    sample({ source: "attacker", timestampMs: NOW + 3_600_000, priceMicro: 5_000_000 }),
  ], policy(), NOW);
  assert.equal(decision.status, "no-price");
  if (decision.status !== "no-price") return;
  assert.ok(decision.reasons.some((reason) => reason.includes("future-timestamp")), decision.reasons.join());
  assert.ok(decision.reasons.some((reason) => reason.includes("insufficient-independent-sources")));
});

test("§96 stale samples and malformed prices never become a fallback", () => {
  const decision = guardPrice([
    sample({ source: "provider-a", timestampMs: NOW - 10 * 60_000 }),
    sample({ source: "provider-b", timestampMs: NOW - 10 * 60_000 }),
    sample({ source: "provider-c", priceMicro: 0 }),
  ], policy(), NOW);
  assert.equal(decision.status, "no-price");
  if (decision.status !== "no-price") return;
  assert.ok(decision.reasons.filter((reason) => reason.endsWith(":stale")).length === 2);
  assert.ok(decision.reasons.includes("provider-c:invalid-price"));
});

test("§102 a single verifier is not redundancy: minSources is enforced in code", () => {
  const decision = guardPrice([sample({ source: "only-node" })], policy(), NOW);
  assert.equal(decision.status, "no-price");
  if (decision.status !== "no-price") return;
  assert.ok(decision.reasons.some((reason) => reason.startsWith("insufficient-independent-sources")));

  assert.throws(() => assertOraclePolicyShape(policy({ minSources: 1 })), /at least 2/);
});

test("§96 affiliated sources do not count as independent", () => {
  const pol = policy({ minSources: 3, affiliationGroups: [["provider-a", "provider-a-reseller"]] });
  const decision = guardPrice([
    sample({ source: "provider-a" }),
    sample({ source: "provider-a-reseller" }),
    sample({ source: "self-node" }),
  ], pol, NOW);
  assert.equal(decision.status, "no-price");
  assert.equal(countIndependentSources(["provider-a", "provider-a-reseller", "self-node"], pol), 2);
  // With a two-source requirement the same set is acceptable.
  const relaxed = guardPrice([
    sample({ source: "provider-a" }),
    sample({ source: "provider-a-reseller" }),
    sample({ source: "self-node" }),
  ], policy({ minSources: 2, affiliationGroups: [["provider-a", "provider-a-reseller"]] }), NOW);
  assert.equal(relaxed.status, "ok");
});

test("§96 a divergent source stops the decision instead of being averaged away", () => {
  const decision = guardPrice([
    sample({ source: "provider-a" }),
    sample({ source: "provider-b" }),
    sample({ source: "attacker", priceMicro: 5_000_000 }),
  ], policy(), NOW);
  assert.equal(decision.status, "no-price");
  if (decision.status !== "no-price") return;
  assert.ok(decision.reasons.some((reason) => reason.includes("divergence")), decision.reasons.join());
});

test("§118 thin liquidity and quiet windows produce no price (YieldBlox pattern)", () => {
  const thinVolume = guardPrice([
    sample({ volumeMicro: 10_000, trades: 30 }),
    sample({ source: "provider-b", volumeMicro: 10_000, trades: 30 }),
    sample({ source: "self-node", volumeMicro: 10_000, trades: 30 }),
  ], policy(), NOW);
  assert.equal(thinVolume.status, "no-price");
  if (thinVolume.status === "no-price") {
    assert.ok(thinVolume.reasons.some((reason) => reason.startsWith("thin-liquidity")), thinVolume.reasons.join());
  }

  const quietWindow = guardPrice([
    sample({ volumeMicro: 60_000_000, trades: 1 }),
    sample({ source: "provider-b", volumeMicro: 60_000_000, trades: 0 }),
    sample({ source: "self-node", volumeMicro: 60_000_000, trades: 1 }),
  ], policy(), NOW);
  assert.equal(quietWindow.status, "no-price");
  if (quietWindow.status === "no-price") {
    assert.ok(quietWindow.reasons.some((reason) => reason.startsWith("too-few-trades")), quietWindow.reasons.join());
  }
});

test("§95 recognised value is capped by real depth, not by the spot price", () => {
  const decision = guardPrice([
    sample({ volumeMicro: 60_000_000, trades: 30 }),
    sample({ source: "provider-b", volumeMicro: 50_000_000, trades: 30 }),
    sample({ source: "self-node", volumeMicro: 50_000_000, trades: 30 }),
  ], policy(), NOW);
  assert.equal(decision.status, "ok");
  if (decision.status !== "ok") return;
  // Window volume 160M, depthCap 10% = 16M is the most value that may be recognised.
  const notional = markValueMicro(1_000_000_000, decision, policy());
  assert.equal(notional.capped, true);
  assert.equal(notional.valueMicro, 16_000_000);

  const small = markValueMicro(1_000_000, decision, policy());
  assert.equal(small.capped, false);
  assert.equal(small.valueMicro, 1_000_000);
});

test("§95/§111 a no-price decision values nothing; zero amounts are refused", () => {
  const noPrice = guardPrice([], policy(), NOW);
  assert.equal(noPrice.status, "no-price");
  assert.deepEqual(markValueMicro(1_000_000, noPrice, policy()), {
    valueMicro: 0, capped: true, reason: "no-price",
  });
  assert.throws(() => markValueMicro(0, noPrice, policy()), OracleGuardError);
  const ok = guardPrice([
    sample({ volumeMicro: 60_000_000, trades: 30 }),
    sample({ source: "provider-b", volumeMicro: 50_000_000, trades: 30 }),
    sample({ source: "self-node", volumeMicro: 50_000_000, trades: 30 }),
  ], policy(), NOW);
  assert.throws(() => markValueMicro(-5, ok, policy()), /positive integer/);
});

test("§102 silent 2-of-2 → 1-of-1 downgrades are rejected in code", () => {
  assertVerifierRedundancy({ threshold: 2, total: 3, independentOperators: 2 },
    { threshold: 2, total: 3, independentOperators: 2 });
  assert.throws(() => assertVerifierRedundancy({ threshold: 1, total: 1, independentOperators: 1 },
    { threshold: 2, total: 3, independentOperators: 2 }), /threshold 1 is below/);
  assert.throws(() => assertVerifierRedundancy({ threshold: 2, total: 3, independentOperators: 1 },
    { threshold: 2, total: 3, independentOperators: 2 }), /independent operators/);
  assert.throws(() => assertVerifierRedundancy({ threshold: 4, total: 3, independentOperators: 3 },
    { threshold: 2, total: 3, independentOperators: 2 }), /cannot exceed/);
});

test("§117 price/fee config changes require a fresh fork simulation with fuzzing", () => {
  assert.deepEqual(verifyConfigChangeAttestation({
    simulated: false, forkSlot: 0, currentSlot: 100, maxForkAgeSlots: 1_000, minFuzzCases: 10,
  }), { ok: false, code: "config-requires-simulation", detail: "no fork simulation attached to the change" });

  const stale = verifyConfigChangeAttestation({
    simulated: true, forkSlot: 1, currentSlot: 10_000, maxForkAgeSlots: 1_000,
    fuzzCases: 50, minFuzzCases: 10,
  });
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.equal(stale.code, "fork-too-old");

  const underfuzzed = verifyConfigChangeAttestation({
    simulated: true, forkSlot: 9_500, currentSlot: 10_000, maxForkAgeSlots: 1_000,
    fuzzCases: 3, minFuzzCases: 10,
  });
  assert.equal(underfuzzed.ok, false);
  if (!underfuzzed.ok) assert.equal(underfuzzed.code, "fuzz-coverage-insufficient");

  const broken = verifyConfigChangeAttestation({
    simulated: true, forkSlot: 9_500, currentSlot: 10_000, maxForkAgeSlots: 1_000,
    fuzzCases: 100, minFuzzCases: 10, invariantViolations: ["vault-drained"],
  });
  assert.equal(broken.ok, false);
  if (!broken.ok) assert.equal(broken.code, "invariant-violations");

  assert.deepEqual(verifyConfigChangeAttestation({
    simulated: true, forkSlot: 9_500, currentSlot: 10_000, maxForkAgeSlots: 1_000,
    fuzzCases: 100, minFuzzCases: 10,
  }), { ok: true });
});
