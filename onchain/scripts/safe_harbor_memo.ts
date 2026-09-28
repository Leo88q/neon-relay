#!/usr/bin/env node
/**
 * Safe-harbor / on-chain negotiation kit (catalog item 113).
 *
 * Aquifer (31 Aug 2026, ~$2.5M) showed both halves of the problem: the team
 * *did* broadcast an on-chain offer — 20% of a return of at least 80% within
 * three days — but (a) the terms had to be composed under pressure, and
 * (b) with no pre-agreed template there is no way to tell a genuine offer from
 * a look-alike one when it arrives. This module is the pre-agreed template:
 *
 *  - terms are validated against a policy (minimum return, bounty cap, minimum
 *    notice, allowed chains) *before* anything is broadcast;
 *  - the memo is a single deterministic line, parseable by `parseSafeHarborMemo`
 *    and verifiable against the policy by a third party (exchange, analyst,
 *    counterparty) who does not trust the sender;
 *  - the byte length is checked against the SPL Memo limit, because a truncated
 *    offer is a broken offer;
 *  - nothing here signs, funds or sends: the operator broadcasts with their own
 *    tooling and records the signature in the incident log.
 *
 * The memo carries no legal promise of amnesty and no USD figure: only the
 * mechanical terms (asset, address, shares, deadline) the chain can enforce.
 */

export interface SafeHarborPolicy {
	projectId: string;
	contact: string;
	/** Chains where the offer is valid (must match how the incident is tracked). */
	chains: string[];
	/** A return offer below this share of the moved assets is not authorised. */
	minReturnBps: number;
	/** Above this share the team would be returning more than it recovers. */
	maxReturnBps: number;
	/** Bounty paid to the counterparty out of the returned amount. */
	bountyBps: number;
	/** Minimum notice: a deadline closer than this is not a real option. */
	minDeadlineMs: number;
	/** SPL Memo program accepts at most 566 bytes. */
	maxMemoBytes: number;
}

export interface SafeHarborTerms {
	incidentId: string;
	chain: string;
	/** Mint/asset being returned. */
	asset: string;
	/** Address the counterparty should return assets to. */
	returnAddress: string;
	returnBps: number;
	deadlineMs: number;
}

export class SafeHarborError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.code = code;
		this.name = "SafeHarborError";
	}
}

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const INCIDENT_ID = /^[A-Za-z0-9._-]{1,64}$/;
const MEMO_PREFIX = "NEONRELAY SAFE HARBOR v1";

export function assertSafeHarborPolicy(policy: SafeHarborPolicy): void {
	const fail = (message: string): never => { throw new SafeHarborError("policy-invalid", message); };
	if (!policy || typeof policy !== "object") fail("policy required");
	if (typeof policy.projectId !== "string" || policy.projectId.length === 0) fail("projectId required");
	if (typeof policy.contact !== "string" || !policy.contact.includes("@")) {
		fail("contact must be a channel a counterparty can actually reach");
	}
	if (!Array.isArray(policy.chains) || policy.chains.length === 0) fail("at least one chain required");
	for (const field of ["minReturnBps", "maxReturnBps", "bountyBps"] as const) {
		if (!Number.isInteger(policy[field]) || policy[field] < 0 || policy[field] > 10_000) {
			fail(`${field} must be an integer within 0..10000`);
		}
	}
	if (policy.minReturnBps > policy.maxReturnBps) fail("minReturnBps cannot exceed maxReturnBps");
	if (policy.bountyBps > policy.minReturnBps) {
		// The bounty comes out of what is actually returned; paying more than the
		// minimum acceptable return is a giveaway, not an incentive.
		fail("bountyBps cannot exceed minReturnBps");
	}
	if (!Number.isInteger(policy.minDeadlineMs) || policy.minDeadlineMs < 24 * 3_600_000) {
		fail("minDeadlineMs must be at least 24h: an offer that expires in minutes is not an offer");
	}
	if (!Number.isInteger(policy.maxMemoBytes) || policy.maxMemoBytes <= 0 || policy.maxMemoBytes > 566) {
		fail("maxMemoBytes must be within 1..566 (SPL Memo limit)");
	}
}

function assertTerms(terms: SafeHarborTerms, policy: SafeHarborPolicy, now: number): void {
	if (typeof terms.incidentId !== "string" || !INCIDENT_ID.test(terms.incidentId)) {
		throw new SafeHarborError("invalid-incident-id", "incidentId must match [A-Za-z0-9._-]{1,64}");
	}
	if (!policy.chains.includes(terms.chain)) {
		throw new SafeHarborError("chain-not-allowed", `chain ${terms.chain} is not covered by this policy`);
	}
	if (!BASE58.test(terms.asset)) {
		throw new SafeHarborError("invalid-asset", "asset must be a canonical base58 mint address");
	}
	if (!BASE58.test(terms.returnAddress)) {
		throw new SafeHarborError("invalid-return-address", "returnAddress must be a canonical base58 address");
	}
	if (!Number.isInteger(terms.returnBps) || terms.returnBps < policy.minReturnBps || terms.returnBps > policy.maxReturnBps) {
		throw new SafeHarborError("return-share-out-of-policy",
			`returnBps ${terms.returnBps} is outside the authorised ${policy.minReturnBps}..${policy.maxReturnBps}`);
	}
	if (!Number.isInteger(terms.deadlineMs)) {
		throw new SafeHarborError("invalid-deadline", "deadlineMs must be an integer epoch-millisecond timestamp");
	}
	if (terms.deadlineMs < now + policy.minDeadlineMs) {
		throw new SafeHarborError("deadline-too-soon",
			`deadline must be at least ${policy.minDeadlineMs} ms in the future`);
	}
	if (terms.deadlineMs - now > 30 * 24 * 3_600_000) {
		throw new SafeHarborError("deadline-too-far", "an offer more than 30 days out is not credible; shorten it");
	}
}

function render(terms: SafeHarborTerms, policy: SafeHarborPolicy): string {
	return [
		MEMO_PREFIX,
		`project=${policy.projectId}`,
		`incident=${terms.incidentId}`,
		`chain=${terms.chain}`,
		`asset=${terms.asset}`,
		`return_to=${terms.returnAddress}`,
		`return_bps=${terms.returnBps}`,
		`bounty_bps=${policy.bountyBps}`,
		`deadline=${new Date(terms.deadlineMs).toISOString()}`,
		`contact=${policy.contact}`,
	].join(" ");
}

export interface SafeHarborOffer {
	memo: string;
	bytes: number;
	terms: SafeHarborTerms & { bountyBps: number; projectId: string; contact: string };
}

/** Build the offer memo. Throws (never truncates) when a rule is violated. */
export function buildSafeHarborMemo(
	terms: SafeHarborTerms, policy: SafeHarborPolicy, now: number = Date.now(),
): SafeHarborOffer {
	assertSafeHarborPolicy(policy);
	assertTerms(terms, policy, now);
	const memo = render(terms, policy);
	const bytes = Buffer.byteLength(memo, "utf8");
	if (bytes > policy.maxMemoBytes) {
		throw new SafeHarborError("memo-too-long",
			`memo is ${bytes} bytes, limit is ${policy.maxMemoBytes}: shorten the contact or incident id, never the terms`);
	}
	return {
		memo,
		bytes,
		terms: {
			...terms,
			bountyBps: policy.bountyBps,
			projectId: policy.projectId,
			contact: policy.contact,
		},
	};
}

export interface SafeHarborVerification {
	ok: boolean;
	violations: string[];
	terms?: SafeHarborOffer["terms"];
}

/**
 * Verify an offer before acting on it — whether it was written by this project
 * or received from a counterparty. `expectedReturnAddress` lets the recipient
 * bind the offer to the address they control.
 */
export function verifySafeHarborMemo(
	memo: string, policy: SafeHarborPolicy, now: number = Date.now(),
	options: { expectedReturnAddress?: string } = {},
): SafeHarborVerification {
	assertSafeHarborPolicy(policy);
	const violations: string[] = [];
	if (typeof memo !== "string" || !memo.startsWith(`${MEMO_PREFIX} `)) {
		return { ok: false, violations: ["memo-not-a-safe-harbor-offer"] };
	}
	const fields = new Map<string, string>();
	for (const token of memo.slice(MEMO_PREFIX.length + 1).split(" ")) {
		const eq = token.indexOf("=");
		if (eq < 0) continue;
		fields.set(token.slice(0, eq), token.slice(eq + 1));
	}
	const projectId = fields.get("project");
	if (projectId !== policy.projectId) violations.push("wrong-project");
	for (const required of ["incident", "chain", "asset", "return_to", "return_bps", "bounty_bps", "deadline", "contact"]) {
		if (!fields.has(required)) violations.push(`missing-${required}`);
	}
	if (violations.length > 0) return { ok: false, violations };

	const returnBps = Number(fields.get("return_bps"));
	const bountyBps = Number(fields.get("bounty_bps"));
	const deadlineMs = Date.parse(fields.get("deadline") ?? "");
	const terms: SafeHarborOffer["terms"] = {
		incidentId: fields.get("incident")!,
		chain: fields.get("chain")!,
		asset: fields.get("asset")!,
		returnAddress: fields.get("return_to")!,
		returnBps,
		deadlineMs,
		bountyBps,
		projectId,
		contact: fields.get("contact")!,
	};
	try {
		// Re-run the same policy rules: a forged memo cannot widen its own terms.
		assertTerms(terms, policy, now);
	} catch (error) {
		violations.push((error as SafeHarborError).code);
	}
	if (bountyBps !== policy.bountyBps) violations.push("bounty-not-policy");
	if (fields.get("contact") !== policy.contact) violations.push("contact-not-policy");
	if (options.expectedReturnAddress && terms.returnAddress !== options.expectedReturnAddress) {
		violations.push("return-address-mismatch");
	}
	return violations.length === 0 ? { ok: true, violations, terms } : { ok: false, violations, terms };
}

export const DEFAULT_SAFE_HARBOR_POLICY: SafeHarborPolicy = Object.freeze({
	projectId: "neon-relay",
	contact: "security@neonrelay.example",
	chains: ["solana-mainnet"],
	minReturnBps: 8_000,
	maxReturnBps: 9_500,
	bountyBps: 2_000,
	minDeadlineMs: 72 * 3_600_000,
	maxMemoBytes: 566,
});

// ------------------------------------------------------------------ CLI
//
// node --experimental-strip-types onchain/scripts/safe_harbor_memo.ts \
//   --incident INC-2026-09-28 --return-address <addr> --deadline 2026-10-05T00:00:00Z
// node --experimental-strip-types onchain/scripts/safe_harbor_memo.ts --verify "<memo>"
//
// The operator copies the printed memo into a transaction and records the
// signature in the incident log. Exit code 1 means: do not broadcast this.

function argValue(argv: string[], name: string): string | null {
	const index = argv.indexOf(name);
	return index >= 0 ? argv[index + 1] ?? null : null;
}

async function main(argv: string[]): Promise<number> {
	const policy = DEFAULT_SAFE_HARBOR_POLICY;
	const verifyIndex = argv.indexOf("--verify");
	if (verifyIndex >= 0) {
		const memo = argv[verifyIndex + 1] ?? "";
		const verdict = verifySafeHarborMemo(memo, policy);
		if (verdict.ok) {
			console.log(`safe-harbor memo verified: ${verdict.terms?.incidentId} return_bps=${verdict.terms?.returnBps}`);
			return 0;
		}
		console.error(`safe-harbor memo refused: ${verdict.violations.join(", ")}`);
		return 1;
	}
	const incident = argValue(argv, "--incident");
	const returnAddress = argValue(argv, "--return-address");
	const deadline = argValue(argv, "--deadline");
	const asset = argValue(argv, "--asset") ?? MINT_PLACEHOLDER;
	if (!incident || !returnAddress || !deadline) {
		console.error("usage: --incident <id> --return-address <addr> --deadline <ISO> [--asset <mint>] [--return-bps <n>]");
		return 1;
	}
	const deadlineMs = Date.parse(deadline);
	try {
		const offer = buildSafeHarborMemo({
			incidentId: incident,
			chain: argValue(argv, "--chain") ?? policy.chains[0]!,
			asset,
			returnAddress,
			returnBps: Number(argValue(argv, "--return-bps") ?? policy.minReturnBps),
			deadlineMs,
		}, policy);
		console.log(offer.memo);
		console.error(`(${offer.bytes} bytes of ${policy.maxMemoBytes}; bounty ${policy.bountyBps / 100}%)`);
		return 0;
	} catch (error) {
		console.error(`refused: ${(error as SafeHarborError).code}: ${(error as Error).message}`);
		return 1;
	}
}

/** The asset is operator-supplied at incident time; this placeholder fails the base58 check on purpose. */
const MINT_PLACEHOLDER = "UNSET_ASSET_MINT_AT_INCIDENT_TIME";

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "")) {
	main(process.argv).then((code) => process.exit(code));
}
