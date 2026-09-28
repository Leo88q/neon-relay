/**
 * Client-side policy conformance (catalog 2026 §AD/AF: items 104, 108, 114,
 * 119). Kotlin cannot be compiled in this sandbox (BL-02) and the Android
 * suite only runs in the Android CI job, so this test pins the *source-level*
 * properties that make the mobile path safe. It fails if a future edit
 * reintroduces any of the drainer primitives:
 *
 *  - the program allowlist must be enforced by the builders themselves, not by
 *    a caller that can forget (item 114);
 *  - no Approve / SetAuthority / Assign / CloseAccount / Burn instruction may
 *    exist in the wallet sources — the game only ever pays for entry and
 *    claims prizes (items 104/114, "no unlimited delegates");
 *  - no durable-nonce (System Program) instruction may be built (items 104/108);
 *  - no official program id may be hardcoded in main sources: the allowlist is
 *    operator configuration, and a repository that ships ids is a repo that
 *    ships someone's clone (item 114);
 *  - the client sends one transaction at a time and never batches extra
 *    instructions into the message (blast-radius reduction, item 108);
 *  - no third-party analytics/ads/Crashlytics SDK appears in the Gradle
 *    dependency catalog (item 104's supply-chain half for mobile).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const walletDir = join(repoRoot, "android", "app", "src", "main", "java", "com", "leo88q", "neonrelay", "wallet");
const testDir = join(repoRoot, "android", "app", "src", "test", "java", "com", "leo88q", "neonrelay", "wallet");

function read(path: string): string {
	return readFileSync(path, "utf8");
}

const walletSources = readdirSync(walletDir)
	.filter((name) => name.endsWith(".kt"))
	.map((name) => ({ name, text: read(join(walletDir, name)) }));

test("item 114: transaction builders enforce the program allowlist before compiling", () => {
	// Ordering inside each build entry point is the property that matters:
	// the allowlist check must run before anything is compiled for signature.
	const sliceFrom = (text: string, marker: string): string => {
		const start = text.indexOf(marker);
		assert.ok(start >= 0, `missing ${marker}`);
		const rest = text.slice(start + marker.length);
		const nextFun = rest.indexOf("\n    fun ");
		return nextFun >= 0 ? rest.slice(0, nextFun) : rest;
	};
	const economy = read(join(walletDir, "EconomyTxBuilder.kt"));
	for (const entry of ["fun buildPayEntryMessage(", "fun buildClaimPrizeMessage("]) {
		const body = sliceFrom(economy, entry);
		const requireAt = body.indexOf("ProgramPolicy.requireEconomyAllowed(programId)");
		const compileAt = body.indexOf("compileMessage(");
		assert.ok(requireAt >= 0, `${entry} must call ProgramPolicy.requireEconomyAllowed(programId)`);
		assert.ok(compileAt >= 0, `${entry} must compile a message`);
		assert.ok(requireAt < compileAt, `${entry}: the allowlist check must run before compilation`);
	}
	const rewardsBody = sliceFrom(read(join(walletDir, "RewardsTxBuilder.kt")), "fun buildClaimMessage(");
	const requireAt = rewardsBody.indexOf("ProgramPolicy.requireRewardsAllowed(programId)");
	const compileAt = rewardsBody.indexOf("compileMessage(");
	assert.ok(requireAt >= 0, "buildClaimMessage must call ProgramPolicy.requireRewardsAllowed(programId)");
	assert.ok(compileAt >= 0, "buildClaimMessage must compile a message");
	assert.ok(requireAt < compileAt, "the allowlist check must run before compilation");
});

test("item 104/114: no drainer instruction primitives exist in the client", () => {
	const forbidden = [
		"SetAuthority", "setAuthority", "ApproveChecked", "approveChecked",
		"CreateAccount", "createAccount", "Assign", "assign(",
		"CloseAccount", "closeAccount", "Burn", "burn(",
		"AdvanceNonceAccount", "advanceNonceAccount", "durableNonce", "durable_nonce",
	];
	// Comments are documentation, not instructions: strip them before the scan
	// so the code that *refuses* a primitive can say its name.
	const stripComments = (text: string): string =>
		text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
	for (const { name, text } of walletSources) {
		const code = stripComments(text);
		for (const needle of forbidden) {
			assert.equal(code.includes(needle), false,
				`${name} contains '${needle}': the game wallet path must never build it (items 104/114)`);
		}
	}
	// The only instruction payloads the client may construct are these two.
	const economy = read(join(walletDir, "EconomyTxBuilder.kt"));
	assert.match(economy, /fun payEntryData\(/);
	assert.match(economy, /fun claimPrizeData\(/);
});

test("item 104/108: System Program instructions stay forbidden in the compiler", () => {
	const economy = read(join(walletDir, "EconomyTxBuilder.kt"));
	assert.match(economy, /require\(!programId\.contentEquals\(SYSTEM_PROGRAM_ID\)\)/,
		"compileMessage must keep refusing System Program instructions");
	assert.match(economy, /durable-nonce/, "the refusal must stay documented as the durable-nonce defence");
});

test("item 114: no official program id is hardcoded in main sources", () => {
	for (const { name, text } of walletSources) {
		const base58Literals = [...text.matchAll(/"([1-9A-HJ-NP-Za-km-z]{32,44})"/g)].map((m) => m[1]!);
		for (const literal of base58Literals) {
			// Token/ATA/System ids are protocol constants and are allowed; a
			// game program id would be operator configuration and must not be.
			assert.ok([
				"TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
				"ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
				"11111111111111111111111111111111",
			].includes(literal), `${name} hardcodes program id ${literal}`);
		}
	}
	// ProgramPolicy must start empty and only ever be filled by the operator.
	const policy = read(join(walletDir, "ProgramPolicy.kt"));
	assert.match(policy, /private var economyAllowlist: Set<String> = emptySet\(\)/);
	assert.match(policy, /private var rewardsAllowlist: Set<String> = emptySet\(\)/);
	assert.match(policy, /fun configure\(/);
	assert.match(policy, /fun reset\(/);
});

test("item 108: the client signs exactly the message it built, one transaction per action", () => {
	const manager = read(join(walletDir, "WalletManager.kt"));
	const sendLines = manager.split("\n").filter((line) => line.includes("signAndSendTransactions("));
	assert.ok(sendLines.length >= 2, "expected both send paths (economy entry and claim)");
	for (const line of sendLines) {
		assert.match(line, /arrayOf\(EconomyTxBuilder\.unsignedTransaction\(message\)\)/,
			"every send must be a single locally built message (no wallet-supplied payload)");
	}
});

test("item 104: the mobile dependency catalog contains no analytics/ads SDK", () => {
	const catalog = read(join(repoRoot, "android", "gradle", "libs.versions.toml"));
	const forbidden = ["firebase", "crashlytics", "amplitude", "segment", "appsflyer", "adjust",
		"facebook", "sentry", "onesignal", "admob", "ads"];
	for (const needle of forbidden) {
		assert.equal(catalog.toLowerCase().includes(needle), false,
			`dependency catalog mentions '${needle}': third-party SDKs are not allowed next to a wallet (item 104)`);
	}
	assert.match(catalog, /mobilewalletadapter-clientlib/);
});

test("item 114: the Kotlin suites configure the allowlist, so enforcement is testable", () => {
	for (const name of ["EconomyTxBuilderTest.kt", "RewardsTxBuilderTest.kt"]) {
		const text = read(join(testDir, name));
		assert.match(text, /@Before fun allowlistOfficialPrograms\(\)/,
			`${name} must configure the allowlist for every test (JUnit order is unspecified)`);
		assert.match(text, /ProgramPolicy\.reset\(\)/, `${name} must test the fail-closed state`);
	}
});
