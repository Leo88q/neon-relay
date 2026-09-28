/**
 * Catalog item 113: the incident kit's safe-harbor memo must be usable under
 * pressure and verifiable by a third party. These tests pin both directions —
 * building an offer that stays inside policy, and refusing to act on a
 * look-alike offer that does not.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
	DEFAULT_SAFE_HARBOR_POLICY,
	SafeHarborError,
	buildSafeHarborMemo,
	verifySafeHarborMemo,
	type SafeHarborPolicy,
	type SafeHarborTerms,
} from "../scripts/safe_harbor_memo.ts";

const NOW = Date.parse("2026-09-28T00:00:00Z");
const DAY = 86_400_000;

const ADDRESS = "FZcLDdUrs6i1HYFFK2NhqNrbVaP6KTvrqzhyoDGT6CV9";
const MINT = "SKR1111111111111111111111111111111111111111";

function policy(overrides: Partial<SafeHarborPolicy> = {}): SafeHarborPolicy {
	return { ...DEFAULT_SAFE_HARBOR_POLICY, ...overrides };
}

function terms(overrides: Partial<SafeHarborTerms> = {}): SafeHarborTerms {
	return {
		incidentId: "INC-2026-09-28-drain",
		chain: "solana-mainnet",
		asset: MINT,
		returnAddress: ADDRESS,
		returnBps: 8_500,
		deadlineMs: NOW + 5 * DAY,
		...overrides,
	};
}

test("item 113: an offer inside policy renders one deterministic, parseable line", () => {
	const offer = buildSafeHarborMemo(terms(), policy(), NOW);
	assert.ok(offer.bytes <= 566);
	assert.equal(offer.bytes, Buffer.byteLength(offer.memo, "utf8"));
	assert.match(offer.memo, /^NEONRELAY SAFE HARBOR v1 /);
	assert.match(offer.memo, /return_bps=8500/);
	assert.match(offer.memo, /bounty_bps=2000/);
	assert.match(offer.memo, /return_to=FZcLDdUrs6i1HYFFK2NhqNrbVaP6KTvrqzhyoDGT6CV9/);
	// Deterministic: the same terms never produce two different messages.
	assert.equal(buildSafeHarborMemo(terms(), policy(), NOW).memo, offer.memo);
	assert.equal(offer.terms.bountyBps, 2_000);

	const verification = verifySafeHarborMemo(offer.memo, policy(), NOW, { expectedReturnAddress: ADDRESS });
	assert.equal(verification.ok, true, verification.violations.join(","));
	assert.equal(verification.terms?.returnBps, 8_500);
});

test("item 113: terms outside the pre-agreed policy are refused, not negotiated live", () => {
	assert.throws(() => buildSafeHarborMemo(terms({ returnBps: 4_000 }), policy(), NOW),
		(error: SafeHarborError) => error.code === "return-share-out-of-policy");
	assert.throws(() => buildSafeHarborMemo(terms({ chain: "solana-devnet" }), policy(), NOW),
		(error: SafeHarborError) => error.code === "chain-not-allowed");
	assert.throws(() => buildSafeHarborMemo(terms({ returnAddress: "0OIl-not-base58" }), policy(), NOW),
		(error: SafeHarborError) => error.code === "invalid-return-address");
	assert.throws(() => buildSafeHarborMemo(terms({ incidentId: "has spaces and /" }), policy(), NOW),
		(error: SafeHarborError) => error.code === "invalid-incident-id");
	// A 24-hour ultimatum is not an offer people can act on.
	assert.throws(() => buildSafeHarborMemo(terms({ deadlineMs: NOW + 3_600_000 }), policy(), NOW),
		(error: SafeHarborError) => error.code === "deadline-too-soon");
});

test("item 113: policy shape bugs fail closed before anything is broadcast", () => {
	const policyInvalid = (error: SafeHarborError) => error.code === "policy-invalid";
	assert.throws(() => buildSafeHarborMemo(terms(), policy({ minReturnBps: 9_000, maxReturnBps: 8_000 }), NOW), policyInvalid);
	assert.throws(() => buildSafeHarborMemo(terms(), policy({ bountyBps: 9_000 }), NOW), policyInvalid);
	assert.throws(() => buildSafeHarborMemo(terms(), policy({ contact: "no-channel" }), NOW), policyInvalid);
	assert.throws(() => buildSafeHarborMemo(terms(), policy({ minDeadlineMs: 60_000 }), NOW), policyInvalid);
	assert.throws(() => buildSafeHarborMemo(terms(), policy({ maxMemoBytes: 1_000 }), NOW), policyInvalid);
});

test("item 113: an over-long memo is refused instead of being truncated", () => {
	const loud = policy({ contact: `${"a".repeat(400)}@example.com` });
	assert.throws(() => buildSafeHarborMemo(terms(), loud, NOW),
		(error: SafeHarborError) => error.code === "memo-too-long");
});

test("item 113: forged or widened offers are detected by verification", () => {
	const good = buildSafeHarborMemo(terms(), policy(), NOW).memo;
	const widened = good.replace("return_bps=8500", "return_bps=1000");
	const widenedVerdict = verifySafeHarborMemo(widened, policy(), NOW);
	assert.equal(widenedVerdict.ok, false);
	assert.ok(widenedVerdict.violations.includes("return-share-out-of-policy"), widenedVerdict.violations.join(","));

	const wrongBounty = good.replace("bounty_bps=2000", "bounty_bps=9000");
	assert.ok(verifySafeHarborMemo(wrongBounty, policy(), NOW).violations.includes("bounty-not-policy"));

	const lookAlike = good.replace("project=neon-relay", "project=neon-relay-claim");
	assert.deepEqual(verifySafeHarborMemo(lookAlike, policy(), NOW).violations, ["wrong-project"]);

	const otherAddress = "2RaaXKUutemHtSZUsmnEv41ytWMkaXD6rcoziHGLRtmj";
	const addressMismatch = verifySafeHarborMemo(good, policy(), NOW, { expectedReturnAddress: otherAddress });
	assert.equal(addressMismatch.ok, false);
	assert.ok(addressMismatch.violations.includes("return-address-mismatch"));

	assert.deepEqual(verifySafeHarborMemo("send 1 BTC to me", policy(), NOW).violations,
		["memo-not-a-safe-harbor-offer"]);
});

test("item 113: an expired offer is visibly expired on re-verification", () => {
	const offer = buildSafeHarborMemo(terms({ deadlineMs: NOW + 4 * DAY }), policy(), NOW);
	const later = NOW + 5 * DAY;
	const verdict = verifySafeHarborMemo(offer.memo, policy(), later);
	assert.equal(verdict.ok, false);
	assert.ok(verdict.violations.includes("deadline-too-soon"), verdict.violations.join(","));
});
