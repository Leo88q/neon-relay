/**
 * Catalog 2026 §AC tests (incident items 102, 103): money-path chain reads go
 * through a provider quorum that requires independence, agreement and the
 * finalized commitment — divergence and unavailability are hard errors.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  MIN_VERIFIER_CONFIG,
  QuorumError,
  assertProviderIndependence,
  quorumRead,
  redactEndpoint,
  stripVolatileSlots,
  verifierDowngradeViolation,
  type QuorumProvider,
} from "../src/rpc_quorum.ts";

const ACCOUNT_DATA = "AAAAAQIDBAU=";

function provider(
  id: string, endpoint: string, value: unknown,
  options: { fail?: string } = {},
): QuorumProvider {
  return {
    id,
    endpoint,
    call: async () => {
      if (options.fail) throw new Error(options.fail);
      return value;
    },
  };
}

function accountResponse(data: string, slot: number): unknown {
  return { context: { slot }, value: { owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", data: [data, "base64"], executable: false, lamports: 2_039_280 } };
}

function request(overrides: Partial<Parameters<typeof quorumRead>[1]> = {}) {
  return {
    method: "getAccountInfo",
    paramsFor: (commitment: string) => ["VaUlT111111111111111111111111111111111111111", { commitment, encoding: "base64" }],
    commitment: "finalized" as const,
    minAgreement: 2,
    ...overrides,
  };
}

test("§103 two independent providers agreeing on finalized data is a quorum", async () => {
  const calls: string[] = [];
  const providers: QuorumProvider[] = [
    { id: "primary", endpoint: "https://rpc-a.example", call: async (method, params) => {
      calls.push(`${method}:${JSON.stringify(params)}`);
      return accountResponse(ACCOUNT_DATA, 100);
    } },
    { id: "fallback", endpoint: "https://rpc-b.example", call: async () => accountResponse(ACCOUNT_DATA, 101) },
    { id: "self-node", endpoint: "https://node.internal.example", selfHosted: true, call: async () => accountResponse(ACCOUNT_DATA, 99) },
  ];
  const result = await quorumRead(providers, request({ minAgreement: 3 }));
  assert.equal(result.commitment, "finalized");
  assert.deepEqual(result.agreeing, ["primary", "fallback", "self-node"]);
  assert.deepEqual(result.failed, []);
  assert.match(result.digest, /^[0-9a-f]{64}$/);
  // The commitment the caller asked for is the one actually sent on the wire.
  assert.ok(calls[0].includes('"commitment":"finalized"'), calls[0]);
  // Slot differences do not break agreement; the data does.
  assert.deepEqual(stripVolatileSlots(accountResponse(ACCOUNT_DATA, 100)),
    stripVolatileSlots(accountResponse(ACCOUNT_DATA, 101)));
});

test("§103 a provider with tampered data is outvoted, not trusted", async () => {
  const providers = [
    provider("primary", "https://rpc-a.example", accountResponse(ACCOUNT_DATA, 100)),
    provider("fallback", "https://rpc-b.example", accountResponse(ACCOUNT_DATA, 100)),
    provider("poisoned", "https://rpc-c.example", accountResponse("TAMPERED", 100)),
  ];
  const result = await quorumRead(providers, request({ minAgreement: 2 }));
  assert.deepEqual(result.agreeing, ["primary", "fallback"]);
  assert.equal(JSON.stringify(result.value).includes("TAMPERED"), false);

  // If the tampered pair is the majority but below minAgreement, refuse.
  await assert.rejects(
    quorumRead([
      provider("poisoned-1", "https://rpc-x.example", accountResponse("TAMPERED", 1)),
      provider("poisoned-2", "https://rpc-y.example", accountResponse("TAMPERED", 1)),
      provider("honest", "https://rpc-z.example", accountResponse(ACCOUNT_DATA, 1)),
    ], request({ minAgreement: 3 })),
    (error: QuorumError) => error.code === "quorum-divergence");
});

test("§103 divergence is a stop condition with the disagreeing groups named", async () => {
  const providers = [
    provider("honest", "https://rpc-a.example", accountResponse(ACCOUNT_DATA, 1)),
    provider("liar", "https://rpc-b.example", accountResponse("FABRICATED", 1)),
  ];
  await assert.rejects(quorumRead(providers, request()), (error: QuorumError) => {
    assert.equal(error.code, "quorum-divergence");
    assert.ok(Array.isArray(error.detail.observed));
    assert.ok(JSON.stringify(error.detail).includes("liar"));
    return true;
  });
});

test("§102/§103 providers on one host are one verifier wearing two hats", async () => {
  const providers = [
    provider("key-1", "https://rpc.same-provider.example/?api-key=1", accountResponse(ACCOUNT_DATA, 1)),
    provider("key-2", "https://rpc.same-provider.example/?api-key=2", accountResponse(ACCOUNT_DATA, 1)),
  ];
  await assert.rejects(quorumRead(providers, request()), (error: QuorumError) => {
    assert.equal(error.code, "providers-not-independent");
    return true;
  });
  assert.throws(() => assertProviderIndependence(providers, 2), /share an endpoint host/);
  assert.throws(() => assertProviderIndependence([
    provider("a", "https://a.example", 1),
    provider("b", "https://b.example", 1),
  ], 1), /at least 2/);
  assert.equal(redactEndpoint("https://rpc.example/secret-path?api-key=abc"), "https://rpc.example");
});

test("§103 unavailability is reported as unavailability, never as a value", async () => {
  const providers = [
    provider("primary", "https://rpc-a.example", accountResponse(ACCOUNT_DATA, 1), { fail: "ECONNRESET" }),
    provider("fallback", "https://rpc-b.example", accountResponse(ACCOUNT_DATA, 1)),
  ];
  await assert.rejects(quorumRead(providers, request()), (error: QuorumError) => {
    assert.equal(error.code, "quorum-unavailable");
    assert.deepEqual(error.detail.failed, [{ id: "primary", error: "ECONNRESET" }]);
    return true;
  });
});

test("§103 money-path reads must be finalized, not tip-following", async () => {
  await assert.rejects(quorumRead([
    provider("a", "https://a.example", accountResponse(ACCOUNT_DATA, 1)),
    provider("b", "https://b.example", accountResponse(ACCOUNT_DATA, 1)),
  ], request({ commitment: "confirmed" })), (error: QuorumError) => error.code === "commitment-not-finalized");
});

test("§102 verifier configuration cannot be silently downgraded", () => {
  assert.deepEqual(MIN_VERIFIER_CONFIG, { threshold: 2, total: 3, independentOperators: 2 });
  assert.equal(verifierDowngradeViolation(
    { threshold: 3, total: 5, independentOperators: 3 },
    { threshold: 3, total: 5, independentOperators: 3 }), null);
  // KelpDAO: 2-of-2 quietly becomes 1-of-1.
  assert.equal(verifierDowngradeViolation(
    { threshold: 2, total: 2, independentOperators: 2 },
    { threshold: 1, total: 1, independentOperators: 1 }), "threshold-below-code-minimum");
  assert.equal(verifierDowngradeViolation(
    { threshold: 3, total: 5, independentOperators: 3 },
    { threshold: 2, total: 5, independentOperators: 3 }), "security-downgrade-requires-timelock-and-alert");
  assert.equal(verifierDowngradeViolation(
    { threshold: 3, total: 5, independentOperators: 3 },
    { threshold: 3, total: 5, independentOperators: 1 }), "operators-not-independent");
});
