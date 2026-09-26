/**
 * SECURITY FINDINGS — characterization and regression tests.
 *
 * The 2026-09-26 security review judged F-01 … F-10 wrong-but-shipped. This
 * file makes every finding executable:
 *
 *   * FIXED (same-day remediations, see the program diffs): F-01, F-01b,
 *     F-02, F-03, F-04, F-05, F-07, F-08, F-09. Their tests are REGRESSION
 *     tests: they assert the fixed behaviour and fail if the fix is quietly
 *     reverted or weakened.
 *   * MANAGED: F-10 — the endianness split itself stays (a coordinated
 *     four-stack migration that must not ship without runnable Android
 *     tests; see the comment in its test), but every program now DECLARES
 *     its u64 seed byte order at the seed constants and the whole inventory
 *     is machine-checked.
 *   * F-06 is a GUARD, not a defect: it pins a seed ordering that is safe
 *     today so it cannot be broken silently.
 *
 * See docs/SECURITY_REVIEW_2026_09_26.md for severity, impact and remediation.
 *
 * These are NOT the security guarantees of the system — those live in
 * `security_checklist.test.ts` (30-item checklist + attack matrix), which
 * asserts what the programs get RIGHT.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  ataAddress, constants as parseConstants, functionBody, getStruct, k, parseAccountsStructs,
  plainWallet, programSource, tokenAccount, useConstants,
} from "./helpers/rust_accounts.ts";
import {
  RULES, acceptAuthorityChangeV2, accountData, adminV2, balance, cancelAuthorityChangeV2,
  payEntryV2, proposeAuthorityChangeV2, refundEntryV2,
  seedPublishedEpoch, sweepExpiredPrizesV2, v2Market,
} from "./helpers/economy_model.ts";
import {
  MAX_ENTRY_FEE as MAX_ENTRY_FEE_TS, MAX_RAKE_STEP_BPS as MAX_RAKE_STEP_BPS_TS,
  MAX_TOURNAMENT_CAPACITY as MAX_TOURNAMENT_CAPACITY_TS,
  REGISTRATION_STAKE_LAMPORTS as REGISTRATION_STAKE_LAMPORTS_TS,
} from "../src/constants.ts";

const MAX_RAKE_BPS = RULES.MAX_RAKE_BPS;

const HERE = dirname(fileURLToPath(import.meta.url));
const ALL_PROGRAMS = ["neonrelay-economy", "neonrelay-rewards", "neonrelay-features",
  "neonrelay-assets"] as const;
const SOURCES: Record<string, string> = Object.fromEntries(
  ALL_PROGRAMS.map((p) => [p, programSource(p)])) as Record<string, string>;
const ECONOMY = SOURCES["neonrelay-economy"] as string;

/** Count `#[account(` attributes attached to one field of an accounts struct. */
function accountAttributeCount(program: string, structName: string, fieldName: string): number {
  const source = SOURCES[program] as string;
  const start = source.indexOf(`pub struct ${structName}<`);
  assert.ok(start >= 0, `${program}::${structName} not found`);
  const brace = source.indexOf("{", start);
  let depth = 0;
  let end = brace;
  for (; end < source.length; end++) {
    if (source[end] === "{") depth++;
    else if (source[end] === "}") { depth--; if (depth === 0) break; }
  }
  const body = source.slice(brace, end);
  const field = body.indexOf(`pub ${fieldName}:`);
  assert.ok(field >= 0, `${structName}.${fieldName} not found`);
  // Walk backwards from the field declaration over its attribute block.
  const before = body.slice(0, field);
  const attrs = [...before.matchAll(/#\[account\(/g)];
  if (attrs.length === 0) return 0;
  // Only the attributes after the previous field declaration belong to this one.
  const prevField = Math.max(before.lastIndexOf("\npub "), before.search(/\n\s+pub /));
  const own = before.slice(prevField < 0 ? 0 : prevField);
  return [...own.matchAll(/#\[account\(/g)].length;
}

// ============================================================ F-01 (MEDIUM)

test("F-01 (FIXED) — rake raises are per-call bounded and observable", () => {
  // Regression for SW-2026-09-26 F-01 (was MEDIUM). set_params/set_params_v2
  // used to move the rake anywhere inside [0, MAX_RAKE_BPS] in a single
  // transaction, silently. Now every increase is bounded by MAX_RAKE_STEP_BPS
  // per call, decreases stay unrestricted, and every accepted change emits
  // ParamsChanged/ParamsChangedV2.
  const consts = parseConstants(ECONOMY);
  assert.equal(consts["MAX_RAKE_STEP_BPS"], "250", "the per-call step cap changed");
  // The same numbers everywhere: Rust, the TS mirror and the test model.
  assert.equal(MAX_RAKE_STEP_BPS_TS, RULES.MAX_RAKE_STEP_BPS, "TS mirror disagrees with the model");
  assert.equal(RULES.MAX_RAKE_STEP_BPS, 250, "the model step cap changed");
  assert.ok(RULES.MAX_RAKE_BPS % RULES.MAX_RAKE_STEP_BPS === 0,
    "the cap is no longer a whole number of steps — re-check the escalation math");

  for (const [handler, event] of [["set_params", "ParamsChanged"], ["set_params_v2", "ParamsChangedV2"]] as const) {
    const body = functionBody(ECONOMY, handler);
    assert.match(body, /rake_bps <= MAX_RAKE_BPS/, `${handler}: the absolute cap was dropped`);
    assert.match(body, /rake_bps\.saturating_sub\(config\.rake_bps\) <= MAX_RAKE_STEP_BPS/,
      `${handler}: the per-call step bound was dropped`);
    assert.match(body, new RegExp(`emit!\\(\\s*${event}`), `${handler}: the change event was dropped`);
  }

  // Executable (set_params_v2): the 0% -> 20% jump is rejected wholesale, but
  // the cap is still reachable in MAX_RAKE_BPS / MAX_RAKE_STEP_BPS = 8 gradual,
  // observable steps — the operator keeps control, the players keep visibility.
  const market = v2Market({ rakeBps: 0 });
  const eventsBefore = market.world.events.length;
  const jump = adminV2(market, { rakeBps: MAX_RAKE_BPS });
  assert.equal(jump.ok, false, "a full-range rake jump was accepted");
  assert.match(JSON.stringify(jump), /RakeStepTooLarge/);
  let config = accountData(market.world, market.keys.config) as { rake_bps: number };
  assert.equal(config.rake_bps, 0, "a rejected change still moved the config");
  assert.equal(market.world.events.length, eventsBefore, "a rejected change emitted an event");

  const step = adminV2(market, { rakeBps: 250 });
  assert.equal(step.ok, true, JSON.stringify(step));
  config = accountData(market.world, market.keys.config) as { rake_bps: number };
  assert.equal(config.rake_bps, 250, "one step was not applied");
  const stepEvent = market.world.events[eventsBefore] as { name: string; fields: Record<string, unknown> } | undefined;
  assert.equal(stepEvent?.name, "ParamsChangedV2", "an accepted raise is not observable");
  assert.equal(stepEvent?.fields["old_rake_bps"], 0);
  assert.equal(stepEvent?.fields["rake_bps"], 250);

  // A bigger jump than the step allows is rejected at any level.
  const tooBig = adminV2(market, { rakeBps: 250 + 251 });
  assert.equal(tooBig.ok, false, "a 2.51% raise slipped through");
  // ... while any decrease is immediate, right down to zero.
  const down = adminV2(market, { rakeBps: 0 });
  assert.equal(down.ok, true, "a rake decrease was blocked");
  config = accountData(market.world, market.keys.config) as { rake_bps: number };
  assert.equal(config.rake_bps, 0);
  // And the gradual path still terminates at the cap.
  const steps = MAX_RAKE_BPS / 250;
  for (let i = 0; i < steps; i++) {
    const res = adminV2(market, { rakeBps: (i + 1) * 250 });
    assert.equal(res.ok, true, `gradual raise step ${i + 1} failed: ${JSON.stringify(res)}`);
  }
  config = accountData(market.world, market.keys.config) as { rake_bps: number };
  assert.equal(config.rake_bps, MAX_RAKE_BPS, "the gradual path no longer reaches the cap");
  // One ParamsChangedV2 per accepted change (raises AND decreases), nothing
  // on rejections: 0->250, 250->0, then the 8 gradual raises.
  const logged = market.world.events.filter((e) => e.name === "ParamsChangedV2").length;
  assert.equal(logged, 2 + steps, "an accepted change went unlogged or a rejection was logged");
});

test("F-01b (FIXED) — v1 entry fees have an absolute ceiling", () => {
  // Regression for SW-2026-09-26 F-01b (was LOW). set_params only required
  // fee > 0, so the authority could set u64::MAX and price out every player
  // (an economic DoS no pause is needed for). Now both fees are bounded by
  // MAX_ENTRY_FEE = the v2 top tier at the largest decimal count.
  const body = functionBody(ECONOMY, "set_params");
  assert.match(body, /fee_match > 0 && fee_tournament > 0/, "the lower bound was dropped");
  assert.match(body, /fee_match <= MAX_ENTRY_FEE && fee_tournament <= MAX_ENTRY_FEE/,
    "the upper bound was dropped");
  assert.match(body, /FeeAboveCeiling/, "the ceiling error was dropped");
  assert.match(body, /emit!\(\s*ParamsChanged/, "the v1 change event was dropped");
  const consts = parseConstants(ECONOMY);
  assert.equal(consts["MAX_ENTRY_FEE"], "2000*1000000000", "the ceiling value changed");
  assert.equal(BigInt(MAX_ENTRY_FEE_TS), RULES.MAX_ENTRY_FEE, "TS mirror disagrees with the model");
  // The ceiling matches the v2 top tier — same economics in both generations.
  assert.equal(RULES.V2_TIERS[RULES.V2_TIERS.length - 1] * 1_000_000_000n, RULES.MAX_ENTRY_FEE);
  // v2 remains immune by construction: its fee table is derived from decimals.
  assert.match(ECONOMY, /pub fn tier_fees_v2\(decimals: u8\)/);
});

// ============================================================ F-02 (LOW/MED)

test("F-02 (FIXED) — the prize sweep is covered by the pause gate", () => {
  // Regression for SW-2026-09-26 F-02 (was LOW/MED). The sweep moves the
  // ENTIRE unclaimed vault remainder into the treasury, but was not
  // pause-gated — so during an incident freeze (or with a compromised
  // authority key) the vault could still be drained while every player-facing
  // path was frozen. Both handlers now fail with Paused before anything else.
  for (const handler of ["sweep_expired_prizes", "sweep_expired_prizes_v2"]) {
    const body = functionBody(ECONOMY, handler);
    assert.match(body, /require!\(!ctx\.accounts\.config\.paused, EconomyError::Paused\)/,
      `${handler} lost its pause gate`);
    assert.match(body, /token::transfer/, `${handler} no longer moves tokens`);
  }
  // The inconsistency itself is gone: EVERY money-moving handler is gated.
  for (const handler of ["pay_entry", "pay_entry_v2", "claim_prize", "claim_prize_v2",
    "publish_prizes", "publish_prizes_v2",
    "sweep_expired_prizes", "sweep_expired_prizes_v2"]) {
    assert.match(functionBody(ECONOMY, handler),
      /require!\(!(ctx\.accounts\.)?config\.paused/,
      `${handler} lost its pause gate`);
  }

  // Executable: a paused, fully expired market can no longer sweep; the vault
  // is untouched, and unpausing restores the sweep.
  const market = v2Market({ paused: true });
  const publishedAt = 1_700_000_000;
  seedPublishedEpoch(market, {
    epoch: 42n, leaves: [{ player: market.keys.player, amount: 500n }],
    vaultBalance: 500n, publishedAt,
  });
  market.world.clock.unixTimestamp = publishedAt + 7 * 24 * 3600;
  const frozen = sweepExpiredPrizesV2(market, { epoch: 42n });
  assert.equal(frozen.ok, false, "the sweep worked while paused");
  assert.match(JSON.stringify(frozen), /Paused/);
  assert.equal(balance(market.world, market.keys.vault), 500n,
    "a rejected sweep still moved vault funds");
  const resume = adminV2(market, { paused: false });
  assert.equal(resume.ok, true, JSON.stringify(resume));
  const swept = sweepExpiredPrizesV2(market, { epoch: 42n });
  assert.equal(swept.ok, true, `unpaused sweep failed: ${JSON.stringify(swept)}`);
  assert.equal(balance(market.world, market.keys.vault), 0n, "the vault was not emptied");
});


// ============================================================ F-03 (LOW)

test("F-03 (FIXED) — the economy authority handover is observable", () => {
  // Regression for SW-2026-09-26 F-03 (was LOW). economy was the only program
  // whose authority handover left no on-chain trace. propose/accept now emit
  // in both generations, with the rotated treasury riding on the accept event
  // — the fact an incident responder needs first.
  for (const program of ALL_PROGRAMS) {
    const source = SOURCES[program] as string;
    assert.match(source, /emit!\(AuthorityChangeProposed/, `${program} lost its propose event`);
    assert.match(source, /emit!\(AuthorityChanged[^V]/, `${program} lost its accept event`);
  }
  for (const [handler, event] of [
    ["propose_authority_change", "AuthorityChangeProposed"],
    ["propose_authority_change_v2", "AuthorityChangeProposedV2"],
    ["accept_authority_change", "AuthorityChanged {"],
    ["accept_authority_change_v2", "AuthorityChangedV2 {"],
  ] as const) {
    assert.match(functionBody(ECONOMY, handler), new RegExp(`emit!\\(\\s*${event.replace("{", "\\{")}`),
      `${handler} does not emit ${event}`);
  }

  // Executable (v2): propose logs the pending key, accept logs old/new
  // authority and the rotated treasury.
  const market = v2Market({});
  const newAuthority = k("f03-new-authority");
  plainWallet(market.world, newAuthority);
  const newTreasury = ataAddress(newAuthority, market.keys.mint);
  tokenAccount(market.world, newTreasury, { mint: market.keys.mint, owner: newAuthority, amount: 0n });
  const eventsBefore = market.world.events.length;
  assert.equal(proposeAuthorityChangeV2(market, { newAuthority, newTreasuryAta: newTreasury }).ok, true);
  market.world.clock.slot = 100 + Number(RULES.MIN_AUTHORITY_DELAY_SLOTS);
  assert.equal(acceptAuthorityChangeV2(market, { newAuthority, newTreasuryAta: newTreasury }).ok, true);
  const proposed = market.world.events[eventsBefore] as { name: string; fields: Record<string, unknown> };
  const accepted = market.world.events[eventsBefore + 1] as { name: string; fields: Record<string, unknown> };
  assert.equal(proposed?.name, "AuthorityChangeProposedV2", "propose emitted nothing");
  assert.equal(proposed?.fields["pending"], newAuthority);
  assert.equal(accepted?.name, "AuthorityChangedV2", "accept emitted nothing");
  assert.equal(accepted?.fields["old"], market.keys.authority);
  assert.equal(accepted?.fields["new"], newAuthority);
  assert.equal(accepted?.fields["treasury_ata"], newTreasury);
});


// ============================================================ F-04 (MEDIUM)

test("F-04 (FIXED) — assets pins the features operator it honors", () => {
  // Regression for SW-2026-09-26 F-04 (was MEDIUM). mint_badge_core used to
  // trust any features-program registry: whoever controlled FEATURES could
  // grant themselves any of the 256 achievement bits and mint badges through
  // ASSETS without the assets authority being involved at all. Now
  //   * AssetsConfig pins `features_authority` (set at bootstrap, rotatable
  //     only by the assets authority, clearable = fail-closed),
  //   * the registry must name that same operator in its `config_authority`,
  //   * mint_badge_* also passes the live features FeaturesConfig PDA, whose
  //     *current* authority must agree with the registry stamp.
  const assets = SOURCES["neonrelay-assets"] as string;
  const features = SOURCES["neonrelay-features"] as string;

  // What the guard verified before AND must keep verifying:
  const guard = functionBody(assets, "require_achievement_registry");
  assert.match(guard, /FEATURES_ACHIEVEMENTS_SEED/, "registry PDA derivation removed");
  assert.match(guard, /registry\.owner, FEATURES_PROGRAM_ID/, "registry owner check removed");
  assert.match(guard, /b"account:AchievementRegistry"/, "discriminator check removed");
  assert.match(guard, /data\[8\.\.40\] == player\.as_ref\(\)/, "player binding removed");
  assert.match(guard, /AchievementNotRecorded/, "bit check removed");

  // The F-04 fix itself:
  assert.match(guard, /config_authority/, "the registry operator-stamp check was removed");
  assert.match(guard, /FeatureAuthorityMismatch/, "the operator-mismatch error was removed");
  assert.match(guard, /FEATURES_CONFIG_SEED/, "the live-config PDA derivation was removed");
  assert.match(guard, /b"account:FeaturesConfig"/, "the live-config discriminator check was removed");
  // The old length check (8 + 32 + 32) would have read the first bitmap word
  // as the stamp; the new one covers the stamp field before it is read.
  assert.match(guard, /8 \+ 32 \+ 64/, "the registry layout check was not widened for the stamp");

  // The pin lives in AssetsConfig and survives rotation observably.
  const config = assets.slice(assets.indexOf("pub struct AssetsConfig"));
  assert.match(config.slice(0, config.indexOf("}")), /pub features_authority: Pubkey/,
    "AssetsConfig lost the features-authority pin");
  assert.match(functionBody(assets, "initialize"), /config\.features_authority = features_authority;/,
    "bootstrap stopped pinning the operator");
  assert.match(functionBody(assets, "initialize"), /FeaturesAuthorityChanged/,
    "the bootstrap pin is not observable");
  assert.match(functionBody(assets, "set_features_authority"), /FeaturesAuthorityChanged/,
    "operator rotation is not observable");
  for (const handler of ["mint_badge_core", "mint_badge_compressed"]) {
    assert.match(functionBody(assets, handler), /Some\(&ctx\.accounts\.features_config\.to_account_info\(\)\)/,
      `${handler} stopped passing the live features config`);
  }

  // features stamps the registry with the vouching operator and honours it.
  const registry = features.slice(features.indexOf("pub struct AchievementRegistry"));
  assert.match(registry.slice(0, registry.indexOf("}")), /pub config_authority: Pubkey/,
    "AchievementRegistry lost its operator stamp");
  assert.match(functionBody(features, "create_registry"), /config_authority = ctx\.accounts\.config\.authority/,
    "create_registry stopped stamping the operator");
  assert.match(functionBody(features, "record_achievement"), /config_authority == ctx\.accounts\.config\.authority/,
    "record_achievement stopped validating the stamp");
  assert.match(functionBody(features, "record_achievement"), /RegistryAuthorityMismatch/,
    "record_achievement lost its mismatch error");
  assert.match(functionBody(features, "restamp_registry"), /config_authority = ctx\.accounts\.config\.authority/,
    "the operator can no longer re-vouch for a registry after rotation");

  // The two programs still bootstrap independently — the pin is what bridges
  // them, so it must stay deliberate and explicit.
  for (const program of ["neonrelay-features", "neonrelay-assets"]) {
    assert.match(functionBody(SOURCES[program] as string, "initialize"), /verify_bootstrap_authority/,
      `${program} lost its bootstrap check`);
  }

  // Executable: the new guard, mirrored 1:1 from the Rust source above,
  // against the original F-04 attack and its post-fix variants. The registry
  // layout is the new one: disc(8) player(32) config_authority(32) bits(32).
  const buf = (name: string) => Buffer.from(name.padEnd(32, "\0"));
  const buildRegistry = (opts: {
    player: string; stamp?: string; bits?: number; legacy?: boolean;
  }) => {
    const b = Buffer.alloc(opts.legacy ? 8 + 32 + 32 + 4 + 1 : 8 + 32 + 32 + 32 + 4 + 1);
    buf(opts.player).copy(b, 8);
    if (!opts.legacy && opts.stamp !== undefined) buf(opts.stamp).copy(b, 8 + 32);
    if (opts.bits !== undefined) {
      b.writeBigUInt64LE(1n << BigInt(opts.bits % 64), 8 + 32 + 32 + 8 * Math.floor(opts.bits / 64));
    }
    return b;
  };
  const buildFeaturesConfig = (authority: string) => {
    const b = Buffer.alloc(8 + 32);
    buf(authority).copy(b, 8);
    return b;
  };
  /** Mirror of require_achievement_registry, same order of checks. */
  const guardMirror = (opts: {
    registry: Buffer; player: string; pinned: string;
    liveConfig: Buffer | null; badgeId: number;
  }): string | null => {
    if (opts.registry.length < 8 + 32 + 64) return "InvalidAchievementRegistry";
    if (!buf(opts.player).equals(opts.registry.subarray(8, 40))) return "InvalidAchievementRegistry";
    const stamp = opts.registry.subarray(8 + 32, 8 + 64);
    if (!buf(opts.pinned).equals(stamp)) return "FeatureAuthorityMismatch";
    if (opts.liveConfig !== null && !stamp.equals(opts.liveConfig.subarray(8, 40))) {
      return "FeatureAuthorityMismatch";
    }
    const word = Math.floor(opts.badgeId / 64);
    const offset = 8 + 32 + 32 + word * 8;
    if (offset + 8 > opts.registry.length) return "InvalidAchievementRegistry";
    const wordValue = opts.registry.readBigUInt64LE(offset);
    if ((wordValue & (1n << BigInt(opts.badgeId % 64))) === 0n) return "AchievementNotRecorded";
    return null;
  };

  const legit = "legit-operator";
  const rogue = "rogue-features-authority";
  // 1. The original attack: a rogue features operator stamps its own registry
  //    and flips bit 7. The assets pin says "legit" — the mint dies.
  const attack = guardMirror({
    registry: buildRegistry({ player: "attacker", stamp: rogue, bits: 7 }),
    player: "attacker", pinned: legit, liveConfig: buildFeaturesConfig(rogue), badgeId: 7,
  });
  assert.equal(attack, "FeatureAuthorityMismatch", "the F-04 attack survives");
  // 2. The honest flow passes: legit stamp, bit recorded, live config agrees.
  assert.equal(guardMirror({
    registry: buildRegistry({ player: "player", stamp: legit, bits: 3 }),
    player: "player", pinned: legit, liveConfig: buildFeaturesConfig(legit), badgeId: 3,
  }), null, "the honest flow is broken");
  // 3. Stale bits: the features authority rotated (live config names the new
  //    operator) but the registry still carries the old stamp. Rejected until
  //    the registry is restamped or the assets pin is deliberately moved.
  assert.equal(guardMirror({
    registry: buildRegistry({ player: "player", stamp: legit, bits: 3 }),
    player: "player", pinned: legit, liveConfig: buildFeaturesConfig("new-operator"), badgeId: 3,
  }), "FeatureAuthorityMismatch", "stale bits mint after a features rotation");
  // 4. Old-layout (pre-upgrade) registries are rejected on length, not
  //    misread: 8+32+32+4+1 = 77 < 104 bytes required by the new layout.
  assert.equal(guardMirror({
    registry: buildRegistry({ player: "player", legacy: true }),
    player: "player", pinned: legit, liveConfig: buildFeaturesConfig(legit), badgeId: 0,
  }), "InvalidAchievementRegistry", "a legacy-layout registry is misread instead of rejected");
});

// ============================================================ F-05 (LOW)

test("F-05 (FIXED) — collection carries one merged #[account(...)] attribute", () => {
  // Regression for SW-2026-09-26 F-05 (was LOW). MintBadgeCore.collection
  // (and the same pattern in MintBadgeCompressed) carried TWO #[account(...)]
  // attributes; Anchor's merge behaviour for repeated attributes is
  // version-dependent. Now a single attribute holds the seeds, the bump AND
  // the authority constraint, and the handler keeps its own authority check
  // as defence in depth.
  const source = SOURCES["neonrelay-assets"] as string;
  const structs = parseAccountsStructs(source);
  for (const name of ["MintBadgeCore", "MintBadgeCompressed"]) {
    assert.equal(accountAttributeCount("neonrelay-assets", name, "collection"), 1,
      `${name}.collection no longer carries exactly one #[account] attribute`);
    const field = getStruct(structs, name).fields.find((f) => f.name === "collection");
    assert.ok(field?.seeds?.includes("collection.name.as_bytes()"),
      `${name}: the collection seeds changed — re-check the self-referential derivation`);
    assert.ok((field?.constraints ?? []).some((c) => c.includes("collection.authority == config.authority")),
      `${name}: the merged attribute lost the authority constraint`);
  }
  assert.match(functionBody(source, "mint_badge_core"),
    /collection\.authority == ctx\.accounts\.config\.authority/,
    "the handler-level authority check was removed — it is the defence in depth");
  useConstants(source);
});


// ============================================================ F-06 (LOW)

test("F-06 — a variable-length seed is only safe because a fixed-length seed follows it", () => {
  // FIX (guard, not a defect today): keep every variable-length seed followed by
  // a fixed-length one, or length-prefix it. This test fails if the ordering is
  // ever changed, which would create a real PDA aliasing collision.
  const source = SOURCES["neonrelay-assets"] as string;
  const structs = parseAccountsStructs(source);
  const field = getStruct(structs, "CreateCollection").fields.find((f) => f.name === "collection");
  const seeds = (field?.seeds ?? "").replace(/^\[|\]$/g, "").split(",").map((s) => s.trim());
  assert.deepEqual(seeds, ["COLLECTION_SEED", "name.as_bytes()", "authority.key().as_ref()"],
    "the create_collection seed list changed — re-derive the aliasing argument in F-06");
  // `name` is bounded, and the trailing seed is a 32-byte pubkey, so equal
  // concatenations imply equal name lengths. Both halves are required:
  assert.match(source, /pub const MAX_COLLECTION_NAME: usize = 32;/);
  assert.match(functionBody(source, "create_collection"),
    /name\.len\(\) <= MAX_COLLECTION_NAME/, "the name bound was removed");
  // No other program puts a variable-length seed last.
  for (const program of ALL_PROGRAMS) {
    for (const struct of parseAccountsStructs(SOURCES[program] as string)) {
      for (const f of struct.fields) {
        if (!f.seeds) continue;
        const parts = f.seeds.replace(/^\[|\]$/g, "").split(",").map((s) => s.trim());
        const last = parts[parts.length - 1] ?? "";
        // A variable-length seed is a String/&str turned into bytes. Fixed-size
        // seeds (`to_be_bytes`, `key().as_ref()`, `[u8; 32]` args) are safe in
        // any position. NB: match the *expression*, never a bare substring —
        // `tournament_id` contains "name".
        const variableLength = /\b(?:name|uri|symbol|title|description|text)\.as_bytes\(\)$/.test(last);
        assert.ok(!variableLength,
          `${program}::${struct.name}.${f.name} ends with a variable-length seed: ${last}`);
      }
    }
  }
});

// ============================================================ F-07 (LOW)

test("F-07 (FIXED) — registration locks a refundable stake, not a balance check", () => {
  // Regression for SW-2026-09-26 F-07 (was LOW). register used to accept any
  // wallet that merely HELD 0.01 SOL — one wallet could fill every slot of a
  // 65 535-capacity tournament "for free" while holding that balance once.
  // Now every registration LOCKS 0.01 SOL inside the registration PDA: a
  // fully refundable capital lock, never a fee — the operator has no
  // instruction that can take it.
  const source = SOURCES["neonrelay-features"] as string;
  const consts = parseConstants(source);
  assert.equal(consts["REGISTRATION_STAKE_LAMPORTS"], "10000000", "the stake value changed");
  assert.equal(REGISTRATION_STAKE_LAMPORTS_TS, 10_000_000, "the TS mirror drifted");
  // The capital bound of the attack: filling MAX_TOURNAMENT_CAPACITY slots
  // now binds 655.35 SOL of the attacker's lamports concurrently.
  assert.equal(MAX_TOURNAMENT_CAPACITY_TS * REGISTRATION_STAKE_LAMPORTS_TS, 655_350_000_000);

  // register: affordability pre-check + the actual lock (player -> PDA).
  const register = functionBody(source, "register");
  assert.match(register, /player\.lamports\(\) >= REGISTRATION_STAKE_LAMPORTS/);
  assert.match(register, /system_program::transfer\(/, "register no longer moves funds");
  assert.match(register, /from: ctx\.accounts\.player\.to_account_info\(\)/);
  assert.match(register, /to: ctx\.accounts\.registration\.to_account_info\(\)/);
  assert.doesNotMatch(source, /MIN_SYBIL/, "the bare balance check is back");
  assert.match(source, /pub const MAX_TOURNAMENT_CAPACITY: u32 = 65_535;/);
  assert.match(register, /tournament\.registered < tournament\.capacity/);

  // The lock is returned by BOTH exits — and only by them.
  const helper = functionBody(source, "return_registration_stake");
  assert.match(helper, /new_with_signer/, "the PDA (not the operator wallet) must sign the return");
  assert.match(helper, /to: player\.clone\(\)/, "the stake must go home to the player");
  assert.match(helper, /minimum_balance\(8 \+ Registration::INIT_SPACE\)/,
    "the tombstone must stay rent-exempt after the stake leaves");
  assert.match(helper, /RegistrationStakeMissing/,
    "an account without a stake must be rejected, not drained below rent");

  const cancel = functionBody(source, "cancel_registration");
  assert.match(cancel, /return_registration_stake\(/, "cancel no longer returns the stake");
  assert.match(cancel, /registration\.active = false/);
  assert.match(cancel, /saturating_sub\(1\)/, "cancel no longer frees the slot");
  assert.match(cancel, /RegistrationStakeReturned/, "the stake return is not observable");

  const reclaim = functionBody(source, "reclaim_stake");
  assert.match(reclaim, /now >= ctx\.accounts\.tournament\.ends_at/,
    "reclaim is not gated on the tournament ending");
  assert.match(reclaim, /TournamentNotEnded/);
  assert.match(reclaim, /return_registration_stake\(/);
  assert.match(reclaim, /RegistrationStakeReturned/);
  // `active` doubles as the stake-locked flag: both exits require it, so the
  // stake is returned exactly once per registration.
  for (const handler of ["cancel_registration", "reclaim_stake"]) {
    assert.match(functionBody(source, handler), /require!\(ctx\.accounts\.registration\.active/,
      `${handler} no longer requires the registration to be active`);
  }
});


// ============================================================ F-09 (INFO)

test("F-09 (FIXED) — the rewards seed mirror points at the real file", () => {
  // Regression for SW-2026-09-26 F-09 (was INFO). The rewards doc comment
  // pointed readers at onchain/src/pda.ts, which does not exist. The real
  // mirror is onchain/src/constants.ts (SEEDS), asserted equal by
  // onchain/test/program.test.ts.
  const source = SOURCES["neonrelay-rewards"] as string;
  assert.doesNotMatch(source, /onchain\/src\/pda\.ts/, "the stale pda.ts pointer is back");
  assert.match(source, /Mirrored by `onchain\/src\/constants\.ts`/, "the mirror pointer lost its target");
  assert.equal(existsSync(resolve(HERE, "..", "src", "pda.ts")), false,
    "onchain/src/pda.ts appeared — update this test and the doc comment");
  assert.ok(existsSync(resolve(HERE, "..", "src", "constants.ts")), "the real mirror vanished");
  assert.match(source, /onchain\/test\/program\.test\.ts/);
  assert.ok(existsSync(resolve(HERE, "program.test.ts")));
});


// ============================================================ F-10 (INFO)

test("F-10 (MANAGED) — u64 PDA seeds use opposite endianness in different programs", () => {
  // The endianness split stays (see the deferral note above): economy is
  // little-endian, rewards/features/assets are big-endian, and every
  // implementation agrees with its mirrors. What changed since the finding:
  // each program now DECLARES its byte order at the seed constants, and this
  // test machine-checks the whole inventory — a new seed site with the
  // opposite order, or a dropped declaration, goes red immediately.
  const rewards = SOURCES["neonrelay-rewards"] as string;
  const economy = ECONOMY;
  assert.match(rewards, /EPOCH_SEED, &epoch_id\.to_be_bytes\(\)/);
  assert.match(economy, /PRIZES_SEED, epoch\.to_le_bytes\(\)\.as_ref\(\)/);
  assert.match(economy, /PRIZES_V2_SEED, config\.mint\.as_ref\(\), epoch\.to_le_bytes\(\)\.as_ref\(\)/);
  // Each program is internally consistent — that is why this is INFO, not a bug.
  assert.equal((rewards.match(/epoch_id\.to_be_bytes\(\)/g) ?? []).length >= 2, true);
  assert.doesNotMatch(rewards, /epoch_id\.to_le_bytes\(\)/);
  assert.doesNotMatch(economy, /epoch\.to_be_bytes\(\)/);

  // SW-2026-09-26: the declared-convention inventory. Only `seeds = [...]`
  // lines count — leaf-hash encodings are golden-vector-pinned separately.
  const seedLines = (source: string): string[] =>
    source.split("\n").filter((line) => line.includes("seeds = [") || line.includes("seeds=["));
  const conventions = [
    { program: "neonrelay-economy", order: "little-endian", own: /to_le_bytes\(\)/, opposite: /to_be_bytes\(\)/ },
    { program: "neonrelay-rewards", order: "big-endian", own: /to_be_bytes\(\)/, opposite: /to_le_bytes\(\)/ },
    { program: "neonrelay-features", order: "big-endian", own: /to_be_bytes\(\)/, opposite: /to_le_bytes\(\)/ },
    { program: "neonrelay-assets", order: "big-endian", own: /to_be_bytes\(\)/, opposite: /to_le_bytes\(\)/ },
  ] as const;
  for (const conv of conventions) {
    const source = SOURCES[conv.program] as string;
    const lines = seedLines(source);
    assert.ok(lines.length > 0, `${conv.program}: no seed lines found`);
    for (const line of lines) {
      if (/to_(be|le)_bytes\(\)/.test(line)) {
        assert.match(line, conv.own,
          `${conv.program}: a seed site uses the OPPOSITE byte order — re-check F-10: ${line.trim()}`);
        assert.doesNotMatch(line, conv.opposite);
      }
    }
    assert.match(source, new RegExp(conv.order),
      `${conv.program}: the seed constants no longer declare "${conv.order}"`);
  }
});


// =============================================== mitigations that must hold

test("F-XX — the mitigations the findings rely on are still in place", () => {
  // If any of these flip, the findings above change severity immediately.
  for (const program of ALL_PROGRAMS) {
    const source = SOURCES[program] as string;
    assert.match(functionBody(source, "initialize"), /verify_bootstrap_authority/,
      `${program} lost bootstrap-authority verification`);
    assert.match(source, /MIN_AUTHORITY_DELAY_SLOTS: u64 = 432_000/);
  }
  // Assets cannot reach an unpinned third-party CPI in the default build.
  const assets = SOURCES["neonrelay-assets"] as string;
  assert.match(assets, /compile_error!\("assets core CPI is not production-pinned/);
  assert.match(assets, /compile_error!\("assets Bubblegum CPI is not production-pinned/);
  for (const handler of ["create_tree", "mint_badge_compressed"]) {
    const body = functionBody(assets, handler);
    const firstStatement = body.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
    assert.match(firstStatement, /#\[cfg\(not\(feature = "bubblegum"\)\)\]/,
      `${handler} no longer fails closed as its first statement`);
    assert.match(body, /AssetPathNotConfigured/);
  }
  // The rake cap is the same number in every place that enforces it.
  assert.equal(MAX_RAKE_BPS, 2000);
  for (const program of ["neonrelay-economy"]) {
    const consts = useConstants(SOURCES[program] as string);
    void consts;
    assert.match(SOURCES[program] as string, /pub const MAX_RAKE_BPS: u16 = 2000;/);
  }
  // SW-2026-09-26 F-01: the per-call step cap must stay in lockstep too.
  assert.match(ECONOMY, /pub const MAX_RAKE_STEP_BPS: u16 = 250;/);
  assert.match(ECONOMY, /pub const MAX_ENTRY_FEE: u64 = 2_000 \* 1_000_000_000;/);
  // SW-2026-09-26 F-02: the sweep stays pause-gated like every other
  // money-moving instruction.
  for (const handler of ["sweep_expired_prizes", "sweep_expired_prizes_v2"]) {
    assert.match(functionBody(ECONOMY, handler),
      /require!\(!ctx\.accounts\.config\.paused, EconomyError::Paused\)/,
      `${handler} lost its pause gate`);
  }
  // SW-2026-09-26 F-03: the economy authority handover stays observable.
  assert.match(ECONOMY, /emit!\(AuthorityChangeProposed/, "economy lost its propose event");
  assert.match(ECONOMY, /emit!\(AuthorityChanged/, "economy lost its accept event");
  // SW-2026-09-26 F-04: rotating the trusted features operator stays
  // observable, and the assets program keeps its own operator pin.
  assert.match(SOURCES["neonrelay-assets"] as string, /pub struct FeaturesAuthorityChanged/);
  assert.match(SOURCES["neonrelay-assets"] as string, /pub fn set_features_authority/);
  // A stranger still cannot touch any of the admin planes.
  const market = v2Market({});
  const stranger = k("findings-stranger");
  const raised = adminV2(market, { authority: stranger, signers: [stranger], rakeBps: 2000 });
  assert.equal(raised.ok, false, "a stranger raised the rake");
  const config = accountData(market.world, market.keys.config) as { rake_bps: number };
  assert.notEqual(config.rake_bps, MAX_RAKE_BPS);
});

// ============================================================ F-20 (MEDIUM)

test("F-20 (FIXED) — the v1 bootstrap enforces the same fee ceiling as set_params", () => {
  // Regression for SW-2026-09-26 F-20 (was MEDIUM). F-01b capped fees in
  // set_params, but the one-time initialize() accepted any u64 > 0 — a
  // mistyped initial fee could start above the ceiling every later call is
  // refused at. The bootstrap now shares the ceiling.
  const init = functionBody(ECONOMY, "initialize");
  assert.match(init, /fee_match <= MAX_ENTRY_FEE && fee_tournament <= MAX_ENTRY_FEE/);
  assert.match(init, /EconomyError::FeeAboveCeiling/);
  // The ceiling constant itself is unchanged and still bounds the v2 tiers.
  assert.match(ECONOMY, /pub const MAX_ENTRY_FEE: u64 = 2_000 \* 1_000_000_000;/);
  // set_params keeps enforcing it too (F-01b must not regress).
  assert.match(functionBody(ECONOMY, "set_params"), /EconomyError::FeeAboveCeiling/);
});

// ============================================================ F-21 (MEDIUM)

test("F-21 (FIXED) — v2 refunds can never eat published-epoch reservations", () => {
  // Regression for SW-2026-09-26 F-21 (was MEDIUM). refund_entry_v2 pulls
  // the prize portion out of the VAULT, which also collateralises every
  // published epoch through config.reserved. Without the guard an operator
  // refund could leave a published Merkle root unpayable (claims fail until
  // the vault is topped up) — a stranded-winner state, not a theft.
  const prize = 45_000_000n; // tier 0 = 50 units @ 6 decimals, 10% rake

  // Blocked case: the vault balance after the prize payout would fall below
  // the aggregate reservation of a published epoch.
  const blocked = v2Market({ playerBalance: 10n ** 9n });
  const blockedRef = k("f21-blocked");
  assert.equal(payEntryV2(blocked, { reference: blockedRef, tier: 0 }).ok, true);
  assert.equal(balance(blocked.world, blocked.keys.vault), prize);
  seedPublishedEpoch(blocked, {
    epoch: 77n, leaves: [{ player: blocked.keys.player, amount: prize }], vaultBalance: prize,
  });
  const refused = refundEntryV2(blocked, { reference: blockedRef });
  assert.equal(refused.ok, false, JSON.stringify(refused));
  assert.match(JSON.stringify(refused), /VaultUnderfunded/);
  assert.equal(balance(blocked.world, blocked.keys.vault), prize,
    "a rejected refund still moved vault funds");
  assert.equal(accountData(blocked.world, blocked.keys.config).reserved, prize,
    "a rejected refund still consumed a reservation");

  // Healthy case: reservations that leave room for the prize portion pass,
  // and the invariant (balance >= reserved) still holds afterwards.
  const healthy = v2Market({ playerBalance: 10n ** 9n });
  const healthyRef = k("f21-healthy");
  assert.equal(payEntryV2(healthy, { reference: healthyRef, tier: 0 }).ok, true);
  // Top the vault up (operator funding) so balance = 2 * prize, then reserve
  // one prize worth for a published epoch.
  seedPublishedEpoch(healthy, {
    epoch: 78n, leaves: [{ player: healthy.keys.player, amount: prize }],
    vaultBalance: prize * 2n,
  });
  const accepted = refundEntryV2(healthy, { reference: healthyRef });
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  assert.equal(balance(healthy.world, healthy.keys.vault), prize);
  assert.equal(accountData(healthy.world, healthy.keys.config).reserved, prize);
  assert.ok(balance(healthy.world, healthy.keys.vault) >=
    accountData(healthy.world, healthy.keys.config).reserved,
    "the refund broke the vault >= reserved invariant");
});

// ============================================================ F-22 (LOW)

test("F-22 (FIXED) — a mistaken v2 authority proposal can be cancelled", () => {
  // Regression for SW-2026-09-26 F-22 (was LOW). propose_authority_change_v2
  // creates the pending PDA with `init`; without an abort path a proposal to
  // an uncontrolled key made the handover permanently un-re-proposeable —
  // an operational lock-out of authority rotation.
  assert.match(ECONOMY, /pub fn cancel_authority_change_v2/);
  const cancel = functionBody(ECONOMY, "cancel_authority_change_v2");
  assert.match(cancel, /emit!\(AuthorityChangeCancelledV2/);
  // Cancellation must never move authority on its own — only accept does.
  assert.doesNotMatch(cancel, /config\.authority =/);

  const structs = parseAccountsStructs(ECONOMY);
  const st = getStruct(structs, "CancelAuthorityV2");
  const auth = st.fields.find((f) => f.name === "authority");
  assert.equal(auth?.signer, true, "cancel must be signed");
  const config = st.fields.find((f) => f.name === "config");
  assert.deepEqual(config?.hasOne ?? [], ["authority"],
    "cancel must be gated on the stored current authority");
  const pending = st.fields.find((f) => f.name === "pending_authority");
  assert.equal(pending?.close, "authority", "the pending PDA must close back to the canceller");

  // Executable: propose to an uncontrolled key, cancel, re-propose cleanly.
  const market = v2Market({});
  const stray = k("f22-stray-target");
  plainWallet(market.world, stray);
  const treasury = ataAddress(stray, market.keys.mint);
  tokenAccount(market.world, treasury, { mint: market.keys.mint, owner: stray, amount: 0n });
  assert.equal(proposeAuthorityChangeV2(market, {
    newAuthority: stray, newTreasuryAta: treasury }).ok, true);
  // The pending target cannot cancel on the current authority's behalf…
  const hijack = cancelAuthorityChangeV2(market, {
    authority: stray, signers: [stray] });
  assert.equal(hijack.ok, false, "the pending target cancelled the handover");
  // …but the current authority can, and the pending PDA is gone afterwards.
  const eventsBefore = market.world.events.length;
  const cancelled = cancelAuthorityChangeV2(market, {});
  assert.equal(cancelled.ok, true, JSON.stringify(cancelled));
  const event = market.world.events[eventsBefore] as { name: string; fields: Record<string, unknown> };
  assert.equal(event?.name, "AuthorityChangeCancelledV2");
  assert.equal(event?.fields["pending"], stray);
  // A second cancel has nothing to close.
  assert.equal(cancelAuthorityChangeV2(market, {}).ok, false);
  // And the operator can propose again — the rotation path is unblocked.
  assert.equal(proposeAuthorityChangeV2(market, {
    newAuthority: stray, newTreasuryAta: treasury }).ok, true);
});
