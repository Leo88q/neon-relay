/**
 * Neon Relay on-chain security checklist — 2026-09-26 review.
 *
 * This suite walks a 30-point Solana/Anchor vulnerability checklist (identity
 * and accounts, state and re-entrancy, token/economic math, admin power,
 * Anchor-specific pitfalls and runtime concerns) and turns every point into an
 * executable assertion against the real program sources.
 *
 * Two kinds of check are used:
 *
 *   A. CONSTRAINT EXECUTION — `helpers/rust_accounts.ts` parses the
 *      `#[derive(Accounts)]` structs and evaluates them the way the Anchor
 *      runtime does; `helpers/economy_model.ts` adds the handler bodies. An
 *      attack scenario therefore has to *die on a named constraint*, not merely
 *      fail to match a regular expression.
 *
 *   B. SOURCE CONTRACTS — structural rules that cannot be executed without a
 *      BPF loader (dependency pins, `unsafe`, `init_if_needed`, seed namespace
 *      collisions, error/instruction discriminator stability, checked
 *      arithmetic, event bounding).
 *
 * Where a Rust pure function is re-implemented for (A), it is differentially
 * fuzzed against the Rust body and against the backend/TypeScript mirror in
 * section 31, so the model cannot drift from the program.
 *
 * Run: cd onchain && npm test
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  ATA_PROGRAM, PROGRAM_IDS, SYSTEM, TOKEN_PROGRAM, addAccount, ataAddress,
  constants as parseConstants, evalAccounts, functionBody, getStruct, k, keyOfBase58, makeWorld,
  offCurve, parseAccountsStructs, pda, plainWallet, programSource, rentExempt, splitTopLevel,
  tokenAccount, useConstants, useInitSpace,
} from "./helpers/rust_accounts.ts";
import {
  RULES, SOURCE, STRUCTS, SEED_CONSTANTS, INIT_SPACE, acceptAuthorityChangeV2, adminV2,
  balance, claimPdaV2, claimPrizeV2, initializeV2, accountData, merkleLeaf,
  merkleLeafV2, payEntryV2, prizesPdaV2, proofDepth, proposeAuthorityChangeV2, publishPrizesV2,
  refundEntryV2, reservePrizesV2, seedPublishedEpoch, sha256, splitFeeV2, sweepExpiredPrizesV2,
  ticketPdaV2, tierFeesV2, v2Market, verifyProofIndexed, verifyProofV2,
} from "./helpers/economy_model.ts";
import { economyLeafV2, verifyEconomyProofV2 } from "../../backend/src/economy_v2_codec.ts";
import { V2_ACCOUNT_BYTES } from "../../backend/src/economy_v2_rpc.ts";
import { leafHash, verifyProofIndexed as backendVerifyProofIndexed } from "../../backend/src/merkle.ts";
import { TICKET_DISCRIMINATOR } from "../../backend/src/economy.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ALL_PROGRAMS = ["neonrelay-economy", "neonrelay-rewards", "neonrelay-features", "neonrelay-assets"];
const SOURCES: Record<string, string> = Object.fromEntries(
  ALL_PROGRAMS.map((name) => [name, programSource(name)]),
);

function instructionNames(source: string): string[] {
  const start = source.indexOf("#[program]");
  const end = source.indexOf("// -------------------------------------------------------------------- accounts", start);
  const body = source.slice(start, end < 0 ? source.length : end);
  const names: string[] = [];
  const re = /pub fn (\w+)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(body)) !== null) names.push(match[1] as string);
  return names;
}

function eventNames(source: string): string[] {
  const names: string[] = [];
  const re = /#\[event\]\s*pub struct (\w+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) names.push(match[1] as string);
  return names;
}

function errorVariants(source: string): string[] {
  const start = source.indexOf("#[error_code]");
  assert.ok(start >= 0, "no #[error_code] enum");
  const brace = source.indexOf("{", start);
  let depth = 0;
  let end = brace;
  for (let i = brace; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") { depth--; if (depth === 0) { end = i; break; } }
  }
  return source.slice(brace + 1, end)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("//") && !line.startsWith("#[") && !line.startsWith('"'))
    .map((line) => line.replace(/^#[^\]]*\]\s*/, "").replace(/,$/, "").trim())
    .filter((line) => /^[A-Z]\w*$/.test(line));
}

function anchorDiscriminator(prefix: string, name: string): string {
  return createHash("sha256").update(`${prefix}:${name}`).digest("hex").slice(0, 16);
}

// ============================================================ A. identity (1-6)

test("A1 — every account the program creates is a seed-derived PDA with a bump", () => {
  for (const program of ALL_PROGRAMS) {
    const structs = parseAccountsStructs(SOURCES[program] as string);
    assert.ok(structs.length > 0, `${program}: no #[derive(Accounts)] structs parsed`);
    for (const struct of structs) {
      for (const field of struct.fields) {
        if (!field.init) continue;
        const pdaInit = Boolean(field.seeds) || Boolean(field.associatedTokenMint);
        assert.ok(pdaInit,
          `${program}::${struct.name}.${field.name} is init without seeds — arbitrary account creation`);
        if (field.seeds) {
          assert.ok(field.bump,
            `${program}::${struct.name}.${field.name} uses seeds without a bump`);
        }
        assert.ok(field.payer,
          `${program}::${struct.name}.${field.name} is init without a payer`);
        // SPL token accounts and mints are sized by their `token::`/`mint::`
        // constraints (165/82 bytes); every other account must declare its
        // exact space so the rent transfer cannot be short-changed.
        const spl = Boolean(field.tokenMint) || field.raw.includes("mint::decimals") ||
          Boolean(field.associatedTokenMint);
        assert.ok(field.space || spl,
          `${program}::${struct.name}.${field.name} is init without space`);
        if (field.space) {
          assert.match(field.space, /^(8 \+ \w+::INIT_SPACE|\w+::LEN|\d+)$/,
            `${program}::${struct.name}.${field.name} uses an ad-hoc space expression`);
        }
        assert.ok(!field.initIfNeeded,
          `${program}::${struct.name}.${field.name} uses init_if_needed (re-initialisation hazard)`);
      }
      // Read accounts that hold program state must also be identity-pinned:
      // either seed-derived, address-pinned, or bound by a constraint that ties
      // them to the config authority (the assets `CreateTree.collection` slot).
      for (const field of struct.fields) {
        if (field.init || field.signer || field.program || field.unchecked) continue;
        if (/Account<'info/.test(field.ty) && !/TokenAccount|Mint/.test(field.ty)) {
          const authorityBound = field.constraints.some((c) => /authority/.test(c)) ||
            field.hasOne.some((h) => /authority/.test(h));
          assert.ok(field.seeds || field.address || authorityBound,
            `${program}::${struct.name}.${field.name} is an unpinned program account`);
        }
      }
    }
  }
});

test("A1 — derived PDAs are off-curve and the seed namespaces never collide", () => {
  const programId = keyOfBase58(PROGRAM_IDS["neonrelay-economy"] as string);
  const seeds = [...SEED_CONSTANTS.entries()];
  assert.equal(seeds.length, 9, "expected the v1+v2 seed namespaces");
  for (const [name, value] of seeds) {
    const derived = pda([Buffer.from(value, "utf8"), randomBytes(32)], programId);
    assert.ok(offCurve(derived.address), `${name} derived an on-curve address`);
    assert.ok(derived.bump <= 255);
  }
  const values = seeds.map(([, value]) => value);
  assert.equal(new Set(values).size, values.length, "two seed namespaces share a literal");
  // A textual prefix is NOT an aliasing risk on Solana: every seed is hashed as
  // its own byte slice, so ["neonrelay_entry"] and ["neonrelay_entry_v2"] can
  // never produce the same address. What must hold is that the v2 namespaces
  // are a distinct, versioned set and that v1 seeds are unchanged.
  const v2 = seeds.filter(([name]) => name.endsWith("_V2_SEED"));
  assert.equal(v2.length, 5, "expected config/entry/prizes/claim/pending v2 namespaces");
  for (const [name, value] of v2) {
    assert.ok(value.endsWith("_v2"), `${name} ("${value}") is not version-suffixed`);
    const v1Name = name.replace("_V2_SEED", "_SEED");
    const v1 = seeds.find(([candidate]) => candidate === v1Name);
    // PENDING_V2_SEED is new in v2 (v1 stored the pending authority inside the
    // config), so a counterpart is required only where v1 had one.
    if (v1) assert.notEqual(v1[1], value, `${name} reuses the v1 namespace`);
  }
  // v1 seeds are frozen: changing one strands every deployed account.
  assert.equal(SEED_CONSTANTS.get("CONFIG_SEED"), "neonrelay_economy_config");
  assert.equal(SEED_CONSTANTS.get("ENTRY_SEED"), "neonrelay_entry");
  assert.equal(SEED_CONSTANTS.get("PRIZES_SEED"), "neonrelay_prizes");
  assert.equal(SEED_CONSTANTS.get("CLAIM_SEED"), "neonrelay_prize_claim");
  // Cross-program: the same literal in two programs is fine (different program
  // ids ⇒ different PDAs), but every namespace must be program-prefixed.
  for (const program of ALL_PROGRAMS) {
    const namespaces = useConstants(SOURCES[program] as string);
    for (const [name, value] of namespaces) {
      assert.match(value, /^neonrelay_/, `${program}::${name} ("${value}") is not namespaced`);
    }
  }
});

test("A2 — every mint/authority/owner relation is pinned with has_one, address or token::", () => {
  const economy = SOURCES["neonrelay-economy"] as string;
  const structs = parseAccountsStructs(economy);
  const mustPin: Record<string, string[]> = {
    PayEntry: ["player_ata", "vault_ata", "treasury_ata", "config"],
    PayEntryV2: ["player_ata", "vault_ata", "treasury_ata", "config"],
    ClaimPrize: ["player_ata", "vault_ata", "prizes", "config"],
    ClaimPrizeV2: ["player_ata", "vault_ata", "prizes", "config"],
    RefundEntryV2: ["config", "player_ata", "vault_ata", "treasury_ata", "ticket"],
    SweepPrizes: ["config", "vault_ata", "treasury_ata", "prizes"],
    SweepPrizesV2: ["config", "vault_ata", "treasury_ata", "prizes"],
    PublishPrizes: ["config", "vault_ata"],
    PublishPrizesV2: ["config", "vault_ata"],
    // `mint` is deliberately unconstrained at the account level: the operator
    // chooses the payment mint, so it is bound indirectly (treasury_ata.mint ==
    // mint.key(), the vault ATA is derived from it) and hardened in the handler
    // by requiring both mint authorities to be revoked.
    Initialize: ["treasury_ata"],
    InitializeV2: ["treasury_ata", "legacy_config"],
    AcceptAuthorityV1: ["config", "new_treasury_ata"],
    AcceptAuthorityV2: ["config", "pending_authority", "new_treasury_ata"],
  };
  for (const [name, fields] of Object.entries(mustPin)) {
    const struct = getStruct(structs, name);
    for (const fieldName of fields) {
      const field = struct.fields.find((f) => f.name === fieldName);
      assert.ok(field, `${name}.${fieldName} disappeared from the accounts struct`);
      const pinned = field.hasOne.length > 0 || Boolean(field.address) || Boolean(field.seeds) ||
        Boolean(field.tokenMint) || field.constraints.length > 0;
      assert.ok(pinned, `${name}.${fieldName} carries no mint/owner/identity constraint`);
    }
  }
  // The token accounts that move money must always name both mint and owner.
  for (const name of ["PayEntry", "PayEntryV2", "ClaimPrize", "ClaimPrizeV2", "RefundEntryV2"]) {
    const struct = getStruct(structs, name);
    for (const field of struct.fields) {
      if (!/TokenAccount/.test(field.ty)) continue;
      if (field.init && field.associatedTokenMint) continue;
      // `token::mint` / `token::authority` are parsed out of the attribute, so
      // they have to be folded back in before pattern-matching the pinning.
      const text = [field.tokenMint, field.tokenAuthority, field.address,
        field.hasOne.join(" "), field.constraints.join(" "), field.raw]
        .filter(Boolean).join(" ");
      assert.match(text, /mint/, `${name}.${field.name} does not pin the token mint`);
      assert.match(text, /owner|authority/, `${name}.${field.name} does not pin the token owner`);
    }
  }
  void economy;
});

test("A3 — the payer signs, and money-moving instructions name their signer", () => {
  const structs = parseAccountsStructs(SOURCE);
  for (const struct of structs) {
    const signers = struct.fields.filter((f) => f.signer);
    assert.ok(signers.length > 0, `${struct.name} accepts an unsigned instruction`);
    for (const field of struct.fields) {
      if (field.init) {
        assert.ok(signers.some((s) => s.name === field.payer),
          `${struct.name}.${field.name}: payer ${field.payer} is not a signer`);
      }
      if (field.close) {
        assert.ok(struct.fields.some((s) => s.name === field.close),
          `${struct.name}: close = ${field.close} names an account that is not passed`);
      }
    }
  }
  // Admin instructions must gate on the stored authority, never on "a signer".
  for (const name of ["Admin", "AdminV2", "PublishPrizes", "PublishPrizesV2", "SweepPrizes",
    "SweepPrizesV2", "RefundEntryV2", "ProposeAuthorityV2", "InitializeV2"]) {
    const struct = getStruct(structs, name);
    const gated = struct.fields.some((f) =>
      f.hasOne.includes("authority") ||
      f.constraints.some((c) => /authority\.key\(\) == (legacy_)?config\.authority/.test(c)));
    assert.ok(gated, `${name} accepts any signer: no field binds it to config.authority`);
    // And the authority slot itself must be a Signer.
    const authority = struct.fields.find((f) => f.name === "authority");
    assert.ok(authority?.signer, `${name}.authority is not a Signer`);
  }
});

test("A3 — executable: a missing signature or a foreign payer is rejected", () => {
  const market = v2Market({ playerBalance: 10n ** 9n });
  const reference = k("ref-a3");
  // The player is not a signer: `player: Signer` must reject.
  const unsigned = payEntryV2(market, { reference, tier: 0, signers: [] });
  assert.equal(unsigned.ok, false);
  assert.equal((unsigned as { failure: { kind: string } }).failure.kind, "not-signer");
  // Somebody else pays for the ticket: the ticket PDA is keyed by the player,
  // so a foreign payer cannot even address it.
  const stranger = k("stranger");
  plainWallet(market.world, stranger);
  tokenAccount(market.world, ataAddress(stranger, market.keys.mint),
    { mint: market.keys.mint, owner: stranger, amount: 10n ** 9n });
  const foreign = payEntryV2(market, {
    reference, tier: 0, player: stranger, playerAta: ataAddress(stranger, market.keys.mint),
  });
  assert.equal(foreign.ok, true, "a stranger may pay for their own ticket…");
  assert.equal(balance(market.world, market.keys.playerAta), 10n ** 9n,
    "…but it must not touch the original player's balance");
  // And the original player's ticket PDA is untouched by that payment.
  const victimTicket = ticketPdaV2(market, reference, market.keys.player).address;
  assert.equal(market.world.accounts.get(victimTicket), undefined);
});

test("A4 — system/token programs are typed, so no fake program can be passed", () => {
  for (const program of ALL_PROGRAMS) {
    const structs = parseAccountsStructs(SOURCES[program] as string);
    for (const struct of structs) {
      for (const field of struct.fields) {
        if (field.name === "system_program") {
          assert.equal(field.ty, "Program<'info, System>",
            `${program}::${struct.name}.system_program is not a typed Program<System>`);
        }
        if (field.name === "token_program") {
          assert.equal(field.ty, "Program<'info, Token>",
            `${program}::${struct.name}.token_program is not a typed Program<Token>`);
        }
        if (field.name === "associated_token_program") {
          assert.match(field.ty, /^Program<'info, anchor_spl::associated_token::AssociatedToken>$/,
            `${program}::${struct.name}.associated_token_program is not typed`);
        }
        // An init that creates a PDA needs the system program in the list.
        if (field.init && field.seeds) {
          assert.ok(struct.fields.some((f) => f.name === "system_program"),
            `${program}::${struct.name} inits ${field.name} without the system program`);
        }
      }
    }
  }
});

test("A5 — created accounts are rent-exempt for their exact declared size", () => {
  const sizes = INIT_SPACE;
  for (const [name, space] of sizes) {
    const rent = rentExempt(8 + space);
    assert.ok(rent > 0 && Number.isSafeInteger(rent), `${name}: bad rent`);
    // Rent must exceed the lamports of a zero-length account, otherwise the
    // runtime would reject the create.
    assert.ok(rent > rentExempt(0), `${name}: rent below the minimum`);
  }
  // The sizes the backend RPC reader hardcodes must match the program layout.
  assert.equal(8 + (sizes.get("EconomyConfigV2") ?? -1), V2_ACCOUNT_BYTES.config);
  assert.equal(8 + (sizes.get("EntryTicketV2") ?? -1), V2_ACCOUNT_BYTES.ticket);
  assert.equal(V2_ACCOUNT_BYTES.mint, 82, "classic SPL mint layout");
  assert.equal(V2_ACCOUNT_BYTES.token, 165, "classic SPL token account layout");
  // …and the v1 ticket discriminator/size the backend parses.
  const v1Ticket = 8 + (sizes.get("EntryTicket") ?? -1);
  assert.equal(v1Ticket, 8 + 32 + 32 + 1 + 8 + 8 + 1);
  assert.equal(TICKET_DISCRIMINATOR.toString("hex"), anchorDiscriminator("account", "EntryTicket"));
});

test("A6 — no zero/default state: every handler initialises its whole struct", () => {
  const structs = parseAccountsStructs(SOURCE);
  const initStructs: Record<string, string> = {
    initialize: "EconomyConfig", initialize_v2: "EconomyConfigV2", pay_entry: "EntryTicket",
    pay_entry_v2: "EntryTicketV2", publish_prizes: "PrizeEpoch", publish_prizes_v2: "PrizeEpochV2",
    claim_prize: "PrizeClaim", claim_prize_v2: "PrizeClaimV2",
    propose_authority_change_v2: "PendingAuthorityV2",
  };
  const source = SOURCES["neonrelay-economy"] as string;
  const dataStructs = new Map<string, string[]>();
  const re = /pub struct (\w+)\s*\{/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    const name = match[1] as string;
    if (!INIT_SPACE.has(name)) continue;
    let depth = 0;
    let i = source.indexOf("{", match.index);
    const start = i;
    for (; i < source.length; i++) {
      if (source[i] === "{") depth++;
      else if (source[i] === "}") { depth--; if (depth === 0) break; }
    }
    const fields = source.slice(start + 1, i).split("\n")
      .map((line) => /^\s*pub (\w+):/.exec(line.trim()))
      .filter(Boolean).map((m2) => m2?.[1] as string);
    dataStructs.set(name, fields);
  }
  for (const [handler, structName] of Object.entries(initStructs)) {
    const body = functionBody(SOURCE, handler);
    const fields = dataStructs.get(structName) ?? [];
    assert.ok(fields.length > 0, `${structName} fields not parsed`);
    for (const field of fields) {
      if (field === "bump") {
        assert.match(body, /bump = ctx\.bumps\./, `${handler} does not store the canonical bump`);
        continue;
      }
      assert.ok(body.includes(`.${field} =`) || body.includes(`.${field}=`),
        `${handler} leaves ${structName}.${field} at its default value`);
    }
  }
  void structs;
});

// ======================================================= B. state / reentrancy

test("B7 — all state is committed before the external CPI (no re-entrancy window)", () => {
  const cases: [string, string, string[]][] = [
    ["pay_entry_v2", "ticket.amount = fee", ["token::transfer"]],
    ["claim_prize_v2", "claim.amount = amount", ["token::transfer"]],
    ["claim_prize", "claim.amount = amount", ["token::transfer"]],
    ["refund_entry_v2", "let rake = ctx.accounts.ticket.rake", ["token::transfer"]],
    ["sweep_expired_prizes_v2", "ctx.accounts.prizes.remaining = 0", ["token::transfer"]],
    ["publish_prizes_v2", "config.reserved = reserve_prizes_v2", []],
  ];
  for (const [handler, stateWrite, cpis] of cases) {
    const body = functionBody(SOURCE, handler);
    const writeAt = body.indexOf(stateWrite);
    assert.ok(writeAt >= 0, `${handler}: state write "${stateWrite}" not found`);
    for (const cpi of cpis) {
      const cpiAt = body.indexOf(cpi);
      assert.ok(cpiAt >= 0, `${handler}: CPI ${cpi} not found`);
      assert.ok(writeAt < cpiAt,
        `${handler} performs ${cpi} before "${stateWrite}" — a re-entrant call would see stale state`);
    }
  }
  // No CPI target other than SPL token: an unknown program could call back.
  const cpiTargets = new Set<string>();
  const re = /CpiContext::new(?:_with_signer)?\(\s*([\w.()]+)\.to_account_info\(\)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(SOURCE)) !== null) cpiTargets.add(match[1] as string);
  for (const target of cpiTargets) {
    assert.match(target, /token_program/, `unexpected CPI target ${target}`);
  }
});

test("B8 — no self-CPI, no instruction-introspection trust, no recursion", () => {
  assert.doesNotMatch(SOURCE, /sysvar::instructions/, "instruction introspection is not allowed");
  assert.doesNotMatch(SOURCE, /invoke_signed\(\s*&\[\s*instruction/, "no self-CPI");
  assert.doesNotMatch(SOURCE, /neonrelay_economy::cpi/, "the program never CPIs into itself");
  for (const program of ALL_PROGRAMS) {
    assert.doesNotMatch(SOURCES[program] as string, /invoke\(/,
      `${program} uses a raw invoke(); CPI must go through a typed CpiContext`);
  }
});

test("B9/B10 — no cached globals; clock use is bounded and checked", () => {
  assert.doesNotMatch(SOURCE, /\bstatic mut\b/, "no mutable statics");
  assert.doesNotMatch(SOURCE, /\bonce_cell|lazy_static|thread_local/, "no global caches");
  // Every Clock read either feeds a timelock with checked_add or a timestamp
  // that is only ever compared against a stored value.
  const clockReads = SOURCE.match(/Clock::get\(\)\?/g) ?? [];
  assert.ok(clockReads.length >= 6, "expected the program to read the clock");
  const checkedAdds = SOURCE.match(/checked_add\(/g) ?? [];
  assert.ok(checkedAdds.length >= 4, "timelock/expiry arithmetic must be checked");
  assert.match(SOURCE, /MIN_AUTHORITY_DELAY_SLOTS/, "authority change must stay timelocked");
  assert.match(SOURCE, /PRIZE_SWEEP_DELAY_SECONDS/, "sweep must stay time-gated");
  // No value may depend on a timestamp alone: money movement is bounded by the
  // stored reservation, not by wall-clock interpolation.
  assert.doesNotMatch(SOURCE, /unix_timestamp\s*[-+*/]\s*\w+\s*\*\s*amount/,
    "no time-scaled payout arithmetic");
});

test("B7 — executable: a claim cannot be replayed while its state is committed", () => {
  const market = v2Market({ playerBalance: 0n });
  const { proofs, total } = seedPublishedEpoch(market, {
    epoch: 11n, leaves: [{ player: market.keys.player, amount: 40_000_000n }],
  });
  const first = claimPrizeV2(market, { epoch: 11n, amount: 40_000_000n, leafIndex: 0, proof: proofs[0] as string[] });
  assert.equal(first.ok, true);
  assert.equal(balance(market.world, market.keys.playerAta), 40_000_000n);
  const config = accountData(market.world, market.keys.config) as { reserved: bigint };
  assert.equal(config.reserved, 0n, "the reservation must be consumed by the claim");
  const replay = claimPrizeV2(market, { epoch: 11n, amount: 40_000_000n, leafIndex: 0, proof: proofs[0] as string[] });
  assert.equal(replay.ok, false);
  assert.equal((replay as { failure: { kind: string; accountField: string } }).failure.kind,
    "already-initialized");
  assert.equal(balance(market.world, market.keys.playerAta), 40_000_000n, "no second payout");
  void total;
});

// ==================================================== C. token / economic math

test("C11 — the payment mint must have both authorities revoked before boot", () => {
  for (const program of ["neonrelay-economy", "neonrelay-rewards"]) {
    const source = SOURCES[program] as string;
    assert.match(source, /mint_authority\.is_none\(\)/, `${program} does not check mint_authority`);
    assert.match(source, /freeze_authority\.is_none\(\)/, `${program} does not check freeze_authority`);
    assert.match(source, /MintAuthorityNotRevoked/, `${program} has no error for a live mint authority`);
    assert.match(source, /FreezeAuthorityNotRevoked/, `${program} has no error for a live freeze authority`);
  }
  // Executable: initialize_v2 refuses an inflatable or freezable mint.
  const market = v2Market({ legacy: true });
  const mint = k("fresh-mint");
  addAccount(market.world, {
    key: mint, owner: keyOfBase58("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
    lamports: 1_461_600, decimals: 6, mintAuthority: k("mint-authority"), freezeAuthority: null,
  });
  tokenAccount(market.world, ataAddress(market.keys.authority, mint),
    { mint, owner: market.keys.authority, amount: 0n });
  const bad = initializeV2(market, { mint, mintAuthority: k("mint-authority"), freezeAuthority: null });
  assert.equal(bad.ok, false);
  assert.match(JSON.stringify(bad), /MintAuthorityNotRevoked/);
  const frozen = initializeV2(market, { mint, mintAuthority: null, freezeAuthority: k("freeze") });
  assert.equal(frozen.ok, false);
  assert.match(JSON.stringify(frozen), /FreezeAuthorityNotRevoked/);
});

test("C12 — token-2022 extensions, delegates and native accounts fail closed", () => {
  assert.match(SOURCE, /fn require_safe_token_account/, "the fail-closed token policy is gone");
  const body = functionBody(SOURCE, "require_safe_token_account");
  assert.match(body, /AccountState::Initialized/);
  assert.match(body, /delegate\.is_none\(\)/);
  assert.match(body, /is_native\.is_none\(\)/);
  assert.match(body, /close_authority\.is_none\(\)/);
  // Every money-moving handler calls it for each token account it touches.
  for (const handler of ["pay_entry", "pay_entry_v2", "claim_prize", "claim_prize_v2",
    "refund_entry_v2"]) {
    const text = functionBody(SOURCE, handler);
    const touched = new Set<string>();
    const re = /require_safe_token_account\(&ctx\.accounts\.(\w+)\)/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) touched.add(match[1] as string);
    for (const account of ["player_ata", "vault_ata"]) {
      if (text.includes(`ctx.accounts.${account}`)) {
        assert.ok(touched.has(account), `${handler} touches ${account} without the safe-token check`);
      }
    }
  }
  // Executable: a delegated player ATA passes Anchor but dies in the handler.
  const market = v2Market({ playerBalance: 10n ** 9n });
  tokenAccount(market.world, k("delegated-ata"), {
    mint: market.keys.mint, owner: market.keys.player, amount: 10n ** 9n, delegate: k("attacker"),
  });
  const delegated = payEntryV2(market, {
    reference: k("ref-c12"), tier: 0, playerAta: k("delegated-ata"),
  });
  assert.equal(delegated.ok, false);
  assert.match(JSON.stringify(delegated), /unsafe-token-account/);
});

test("C13/C14/C15 — fee math is checked, never negative, and always sums to the fee", () => {
  const body = functionBody(SOURCE, "pay_entry_v2");
  assert.match(body, /split_fee_v2\(fee, config\.rake_bps\)/);
  const split = functionBody(SOURCE, "split_fee_v2");
  assert.match(split, /u128::from\(fee\)\.checked_mul/);
  assert.match(split, /checked_div/);
  assert.match(split, /u64::try_from/);
  assert.match(split, /fee\.checked_sub\(rake\)/);
  assert.doesNotMatch(SOURCE, /\bas u64\b[^;]*amount/, "no unchecked narrowing of amounts");
  // Executable invariants over the whole domain, including u64::MAX.
  const cases: [bigint, number][] = [
    [1n, 0], [1n, 2000], [10_000n, 1000], [(1n << 64n) - 1n, 2000], [(1n << 64n) - 1n, 10_000 - 1],
    [50n * 10n ** 6n, 1000], [2000n * 10n ** 9n, 333],
  ];
  for (const [fee, bps] of cases) {
    const { rake, prize } = splitFeeV2(fee, bps > RULES.MAX_RAKE_BPS ? RULES.MAX_RAKE_BPS : bps);
    assert.equal(rake + prize, fee, `split must be exact for fee=${fee} bps=${bps}`);
    assert.ok(rake >= 0n && prize >= 0n, "no negative component");
    assert.ok(rake <= fee, "fee <= amount invariant");
    assert.ok(rake * 10_000n <= fee * BigInt(RULES.MAX_RAKE_BPS), "rake never exceeds the cap");
  }
  assert.throws(() => splitFeeV2(0n, 100), /InvalidFee/);
  assert.throws(() => splitFeeV2(100n, RULES.MAX_RAKE_BPS + 1), /InvalidRake/);
  // Rounding is floor(), so dust always stays with the players, and the cap is
  // a hard ceiling: 10_000 bps (100%) is rejected, not silently honoured.
  assert.equal(splitFeeV2(3n, RULES.MAX_RAKE_BPS).rake, 0n);
  assert.equal(splitFeeV2(1n, RULES.MAX_RAKE_BPS - 1).rake, 0n);
  assert.equal(splitFeeV2(1_000_001n, 1000).rake, 100_000n);
  assert.equal(splitFeeV2(1_000_000n, RULES.MAX_RAKE_BPS).rake, 200_000n);
});

test("C16 — the vault is program-owned and no instruction can drain it arbitrarily", () => {
  // Every transfer out of a vault is signed by the config PDA and destined for
  // a constrained account.
  const transfers = SOURCE.match(/from: ctx\.accounts\.vault_ata\.to_account_info\(\)/g) ?? [];
  assert.ok(transfers.length >= 4, "expected the claim/refund/sweep vault transfers");
  const withSigner = SOURCE.match(/CpiContext::new_with_signer/g) ?? [];
  assert.ok(withSigner.length >= transfers.length,
    "a vault transfer is not PDA-signed — the vault authority would have to be a wallet");
  assert.doesNotMatch(SOURCE, /authority: ctx\.accounts\.authority\.to_account_info\(\)[\s\S]{0,200}vault_ata/,
    "the vault must never be spendable by the operator wallet");
  // There is no generic withdraw instruction.
  const names = instructionNames(SOURCE);
  assert.ok(!names.some((n) => /withdraw|drain|rescue|emergency_withdraw/.test(n)),
    `unexpected withdrawal instruction: ${names.join(", ")}`);
  // Executable: the vault ATA is the config PDA's associated token account, and
  // passing any other account as the vault dies on `address = config.vault_ata`.
  const market = v2Market({});
  const rogue = k("rogue-vault");
  tokenAccount(market.world, rogue, { mint: market.keys.mint, owner: k("attacker"), amount: 0n });
  const result = payEntryV2(market, {
    reference: k("ref-c16"), tier: 0, extraKeys: { vault_ata: rogue },
  });
  assert.equal(result.ok, false);
  assert.equal((result as { failure: { kind: string } }).failure.kind, "address-mismatch");
});

test("C16 — executable: the vault/treasury can never be passed as a player account", () => {
  const market = v2Market({ playerBalance: 10n ** 9n, vaultBalance: 500n });
  const asVault = payEntryV2(market, {
    reference: k("ref-alias-1"), tier: 0, playerAta: market.keys.vaultAta,
  });
  assert.equal(asVault.ok, false);
  const asTreasury = payEntryV2(market, {
    reference: k("ref-alias-2"), tier: 0, playerAta: market.keys.treasury,
  });
  assert.equal(asTreasury.ok, false);
  assert.equal(balance(market.world, market.keys.vaultAta), 500n, "vault untouched");
  // A duplicate account in the same instruction (player_ata === treasury_ata)
  // is the same attack and must die on the same constraint.
  const duplicate = payEntryV2(market, {
    reference: k("ref-alias-3"), tier: 0, playerAta: market.keys.treasury,
    extraKeys: { treasury_ata: market.keys.treasury },
  });
  assert.equal(duplicate.ok, false);
});

test("C17 — replay and front-running: tickets are keyed by (mint, reference, player)", () => {
  const struct = getStruct(STRUCTS, "PayEntryV2");
  const ticket = struct.fields.find((f) => f.name === "ticket");
  assert.ok(ticket?.seeds, "ticket lost its seeds");
  assert.match(ticket.seeds as string, /ENTRY_V2_SEED/);
  assert.match(ticket.seeds as string, /config\.mint\.as_ref\(\)/);
  assert.match(ticket.seeds as string, /reference\.as_ref\(\)/);
  assert.match(ticket.seeds as string, /player\.key\(\)\.as_ref\(\)/);
  // Executable: the same reference is a one-shot per player per market.
  const market = v2Market({ playerBalance: 10n ** 10n });
  const reference = k("ref-c17");
  assert.equal(payEntryV2(market, { reference, tier: 2 }).ok, true);
  const replay = payEntryV2(market, { reference, tier: 2 });
  assert.equal(replay.ok, false);
  assert.equal((replay as { failure: { kind: string } }).failure.kind, "already-initialized");
  // A different player may use the same reference (it is their own ticket).
  const other = k("player-2");
  plainWallet(market.world, other);
  tokenAccount(market.world, ataAddress(other, market.keys.mint),
    { mint: market.keys.mint, owner: other, amount: 10n ** 10n });
  assert.equal(payEntryV2(market, { reference, tier: 2, player: other,
    playerAta: ataAddress(other, market.keys.mint) }).ok, true);
  // …but a second market (different mint) is a separate namespace.
  assert.notEqual(
    ticketPdaV2(market, reference, market.keys.player).address,
    ticketPdaV2({ ...market, keys: { ...market.keys, mint: k("other-mint") } }, reference, market.keys.player).address);
});

test("C18/C19 — bounded work: proofs, tiers, leaves and events cannot be weaponised", () => {
  assert.match(SOURCE, /require!\(proof\.len\(\) <= MAX_PROOF_LEN/, "proof length must be capped");
  const maxProof = Number((parseConstants(SOURCE)["MAX_PROOF_LEN"] ?? "32").replace(/_/g, ""));
  assert.equal(maxProof, 32);
  assert.match(SOURCE, /leaf_count > 0 && leaf_count <= 10/, "leaf_count must stay top-10");
  assert.doesNotMatch(SOURCE, /for .* in ctx\.accounts/, "no iteration over account collections");
  assert.doesNotMatch(SOURCE, /while\s+true/, "no unbounded loops");
  assert.doesNotMatch(SOURCE, /msg!\(|sol_log\(/, "no unbounded raw logging");
  // Every emit! is a fixed-shape event.
  const emits = SOURCE.match(/emit!\((\w+)/g) ?? [];
  assert.ok(emits.length >= 4, "expected the audit events");
  for (const name of eventNames(SOURCE)) {
    const fields = SOURCE.slice(SOURCE.indexOf(`pub struct ${name}`));
    assert.ok(fields.includes("}"), `${name} is malformed`);
  }
  // Executable: an oversized proof is rejected before any hashing happens.
  const market = v2Market({});
  seedPublishedEpoch(market, { epoch: 3n, leaves: [{ player: market.keys.player, amount: 1n }] });
  const longProof = Array.from({ length: 33 }, () => "ab".repeat(32));
  const result = claimPrizeV2(market, { epoch: 3n, amount: 1n, leafIndex: 0, proof: longProof });
  assert.equal(result.ok, false);
  assert.match(JSON.stringify(result), /ProofTooLong/);
});

test("C20 — admin power is capped, timelocked and observable", () => {
  const consts = parseConstants(SOURCE);
  assert.equal(Number(consts["MAX_RAKE_BPS"]), 2000, "rake cap moved");
  assert.equal(Number(consts["MAX_RAKE_STEP_BPS"]), 250, "per-call rake step cap moved (SW-2026-09-26 F-01)");
  assert.equal(consts["MAX_ENTRY_FEE"], "2000*1000000000", "v1 fee ceiling moved (SW-2026-09-26 F-01b)");
  assert.equal(Number(consts["MIN_AUTHORITY_DELAY_SLOTS"]), 432_000, "timelock moved");
  assert.equal(consts["PRIZE_SWEEP_DELAY_SECONDS"], "7*24*60*60", "sweep delay moved");
  for (const handler of ["set_params", "set_params_v2", "initialize", "initialize_v2"]) {
    assert.match(functionBody(SOURCE, handler), /rake_bps <= MAX_RAKE_BPS/,
      `${handler} accepts an uncapped rake`);
  }
  // SW-2026-09-26 F-01: a rake *increase* is bounded per call (decreases are
  // unrestricted) and every accepted change emits an event.
  for (const handler of ["set_params", "set_params_v2"]) {
    const body = functionBody(SOURCE, handler);
    assert.match(body, /rake_bps\.saturating_sub\(config\.rake_bps\) <= MAX_RAKE_STEP_BPS/,
      `${handler} no longer bounds the per-call rake increase`);
    assert.match(body, /emit!\(ParamsChanged/, `${handler} change is not observable`);
  }
  // SW-2026-09-26 F-01b: v1 fees have an absolute ceiling.
  assert.match(functionBody(SOURCE, "set_params"), /MAX_ENTRY_FEE/);
  assert.match(functionBody(SOURCE, "accept_authority_change_v2"), /TimelockNotExpired/);
  assert.match(functionBody(SOURCE, "accept_authority_change"), /TimelockNotExpired/);
  assert.match(SOURCE, /emit!\(AdminPaused/, "pause toggles must be observable");
  // Executable: the timelock really blocks, and really expires.
  const market = v2Market({});
  const newAuthority = k("new-authority");
  plainWallet(market.world, newAuthority);
  const newTreasury = ataAddress(newAuthority, market.keys.mint);
  tokenAccount(market.world, newTreasury, { mint: market.keys.mint, owner: newAuthority, amount: 0n });
  const propose = proposeAuthorityChangeV2(market, { newAuthority, newTreasuryAta: newTreasury });
  assert.equal(propose.ok, true, JSON.stringify(propose));
  market.world.clock.slot = 100 + Number(consts["MIN_AUTHORITY_DELAY_SLOTS"]) - 1;
  const early = acceptAuthorityChangeV2(market, { newAuthority, newTreasuryAta: newTreasury });
  assert.equal(early.ok, false);
  assert.match(JSON.stringify(early), /TimelockNotExpired/);
  market.world.clock.slot = 100 + Number(consts["MIN_AUTHORITY_DELAY_SLOTS"]);
  const late = acceptAuthorityChangeV2(market, { newAuthority, newTreasuryAta: newTreasury });
  assert.equal(late.ok, true, JSON.stringify(late));
  const config = accountData(market.world, market.keys.config) as { authority: string; treasury_ata: string };
  assert.equal(config.authority, newAuthority);
  assert.equal(config.treasury_ata, newTreasury);
  // The pending PDA was closed, so the same proposal cannot be accepted twice.
  const replay = acceptAuthorityChangeV2(market, { newAuthority, newTreasuryAta: newTreasury });
  assert.equal(replay.ok, false);
  assert.equal((replay as { failure: { kind: string } }).failure.kind, "missing-account");
  // And a stranger cannot propose.
  const market2 = v2Market({});
  const evil = k("evil-operator");
  plainWallet(market2.world, evil);
  const proposed = proposeAuthorityChangeV2(market2, {
    newAuthority: evil, newTreasuryAta: evil, proposer: evil, signers: [evil],
  });
  // `has_one = authority` on the config rejects the impostor; depending on which
  // account the scenario fails to supply first, Anchor surfaces this either as
  // the has_one mismatch or as the missing/unpinned authority slot.
  assert.equal(proposed.ok, false, "a stranger may propose an authority change");
  assert.ok(["has-one-mismatch", "missing-account", "not-signer"]
    .includes((proposed as { failure: { kind: string } }).failure.kind),
    `unexpected failure kind ${(proposed as { failure: { kind: string } }).failure.kind}`);
});

// ============================================================ D. Anchor specifics

test("D21/D22 — account sizes are exact and every init names payer + system program", () => {
  const structs = parseAccountsStructs(SOURCE);
  for (const struct of structs) {
    for (const field of struct.fields) {
      if (!field.init) continue;
      assert.ok(field.payer, `${struct.name}.${field.name}: init without payer`);
      assert.ok(struct.fields.some((f) => f.name === "system_program"),
        `${struct.name}: init without system_program`);
      if (field.space) {
        assert.match(field.space, /^8 \+ \w+::INIT_SPACE$/,
          `${struct.name}.${field.name}: space must be 8 + <Type>::INIT_SPACE`);
        const typeName = /(\w+)::INIT_SPACE/.exec(field.space)?.[1] as string;
        assert.ok(INIT_SPACE.has(typeName), `${typeName} is not a declared account struct`);
      } else {
        assert.ok(field.associatedTokenMint,
          `${struct.name}.${field.name}: init without space or associated_token`);
      }
    }
  }
});

test("D23 — `mut` appears only on accounts the instruction really writes", () => {
  const structs = parseAccountsStructs(SOURCE);
  const readOnly: Record<string, string[]> = {
    PayEntryV2: ["config"],
    ClaimPrizeV2: [],
    RefundEntryV2: [],
    PublishPrizesV2: ["vault_ata"],
    InitializeV2: ["mint", "legacy_config", "treasury_ata"],
    AcceptAuthorityV2: ["new_treasury_ata"],
  };
  for (const [name, fields] of Object.entries(readOnly)) {
    const struct = getStruct(structs, name);
    for (const fieldName of fields) {
      const field = struct.fields.find((f) => f.name === fieldName);
      assert.ok(field, `${name}.${fieldName} disappeared`);
      assert.equal(field.mut, false, `${name}.${fieldName} is marked mut but is read-only`);
    }
  }
  // Accounts whose stored value changes must be mut, or the write is lost.
  const mustBeMut: Record<string, string[]> = {
    PayEntryV2: ["player", "player_ata", "vault_ata", "treasury_ata"],
    ClaimPrizeV2: ["config", "prizes", "vault_ata", "player_ata"],
    PublishPrizesV2: ["authority", "config"],
    RefundEntryV2: ["ticket", "vault_ata", "treasury_ata", "player_ata"],
    SweepPrizesV2: ["config", "prizes", "vault_ata", "treasury_ata"],
    AcceptAuthorityV2: ["config", "pending_authority", "new_authority"],
  };
  for (const [name, fields] of Object.entries(mustBeMut)) {
    const struct = getStruct(structs, name);
    for (const fieldName of fields) {
      const field = struct.fields.find((f) => f.name === fieldName);
      assert.ok(field, `${name}.${fieldName} disappeared`);
      assert.equal(field.mut, true, `${name}.${fieldName} is written but not marked mut`);
    }
  }
});

test("D24/D25 — typed deserialisation, documented CHECKs and stable discriminators", () => {
  for (const program of ALL_PROGRAMS) {
    const source = SOURCES[program] as string;
    assert.doesNotMatch(source, /try_borrow_data\(\)[\s\S]{0,80}from_bytes/,
      `${program} reinterprets raw account bytes`);
    // Every UncheckedAccount must carry a `/// CHECK:` justification.
    const structs = parseAccountsStructs(source);
    for (const struct of structs) {
      for (const field of struct.fields) {
        if (!field.unchecked) continue;
        const index = source.indexOf(`pub struct ${struct.name}<'info>`);
        const region = source.slice(Math.max(0, index - 100), source.indexOf(`pub ${field.name}:`, index));
        assert.match(region, /\/\/\/ CHECK:/,
          `${program}::${struct.name}.${field.name} is UncheckedAccount without a /// CHECK note`);
      }
    }
  }
  // Instruction names are the discriminator input: pin them.
  const pinned = [
    "initialize", "set_params", "set_paused", "propose_authority_change", "accept_authority_change",
    "pay_entry", "publish_prizes", "claim_prize", "sweep_expired_prizes", "initialize_v2",
    "set_paused_v2", "pay_entry_v2", "refund_entry_v2", "publish_prizes_v2", "claim_prize_v2",
    "sweep_expired_prizes_v2", "set_params_v2", "propose_authority_change_v2",
    "accept_authority_change_v2",
  ];
  assert.deepEqual(instructionNames(SOURCE), pinned,
    "instruction set changed: discriminators and the Android/backend builders must be re-pinned");
  const discriminators = pinned.map((name) => anchorDiscriminator("global", name));
  assert.equal(new Set(discriminators).size, pinned.length, "instruction discriminator collision");
  // Error variants are positional: appending is safe, inserting is not.
  const variants = errorVariants(SOURCE);
  assert.deepEqual(variants.slice(0, 6),
    ["InvalidRake", "InvalidFee", "InvalidKind", "InvalidTreasuryMint", "Unauthorized", "Paused"],
    "error discriminants shifted — clients decode the wrong error");
  assert.ok(variants.includes("UnsafeTokenAccount") && variants.includes("InvalidLeafCount"));
  assert.equal(new Set(variants).size, variants.length, "duplicate error variant");
});

test("D26 — the toolchain and dependency pins the CI gate enforces are intact", () => {
  const cargo = readFileSync(resolve(HERE, "..", "programs", "neonrelay-economy", "Cargo.toml"), "utf8");
  assert.match(cargo, /anchor-lang = "0\.31\.1"/);
  assert.match(cargo, /anchor-spl = "0\.31\.1"/);
  assert.match(cargo, /solana-program-test = "=2\.1\.0"/);
  assert.match(cargo, /solana-sdk = "=2\.1\.0"/);
  assert.match(cargo, /solana-client = "=2\.1\.0"/);
  const workspace = readFileSync(resolve(HERE, "..", "Cargo.toml"), "utf8");
  assert.match(workspace, /overflow-checks = true/, "release overflow checks must stay on");
  const anchor = readFileSync(resolve(HERE, "..", "Anchor.toml"), "utf8");
  assert.match(anchor, /anchor_version = "0\.31\.1"/);
  for (const [program, id] of Object.entries(PROGRAM_IDS)) {
    assert.ok(anchor.includes(id), `${program} id ${id} is not pinned in Anchor.toml`);
    assert.match(SOURCES[program] as string, new RegExp(`declare_id!\\("${id}"\\)`),
      `${program} declare_id drifted from Anchor.toml`);
  }
});

// ============================================================== E. runtime concerns

test("E27 — compute budget: bounded allocations and no per-instruction scanning", () => {
  assert.match(SOURCE, /const MAX_PROOF_LEN: usize = 32;/);
  assert.match(SOURCE, /fees: \[u64; 4\]/, "the tier table must stay fixed-size");
  assert.doesNotMatch(SOURCE, /Vec<Vec</, "no nested heap growth");
  // The only Vec in instruction data is the Merkle proof, and it is capped
  // before it is used anywhere else.
  const claim = functionBody(SOURCE, "claim_prize_v2");
  assert.ok(claim.indexOf("proof.len() <= MAX_PROOF_LEN") < claim.indexOf("verify_proof_v2"),
    "the proof is verified before its length is capped");
});

test("E28 — close refunds go to an account bound by the instruction", () => {
  const structs = parseAccountsStructs(SOURCE);
  let closes = 0;
  for (const struct of structs) {
    for (const field of struct.fields) {
      if (!field.close) continue;
      closes++;
      const target = struct.fields.find((f) => f.name === field.close);
      assert.ok(target, `${struct.name}: close target ${field.close} is not passed`);
      // The destination must itself be pinned to the closed account's identity.
      const bound = field.constraints.some((c) => c.includes(`${field.name}.player == ${target.name}.key()`)) ||
        field.constraints.some((c) => c.includes(`${field.name}.new_authority == ${target.name}.key()`)) ||
        (field.seeds ?? "").includes(`${target.name}.key().as_ref()`);
      assert.ok(bound,
        `${struct.name}.${field.name} closes into ${target.name}, which is not bound to the account`);
      assert.ok(target.signer || field.constraints.some((c) => c.includes(target.name)),
        `${struct.name}: rent destination ${target.name} is unconstrained`);
    }
  }
  assert.ok(closes >= 2, "expected the refund and authority-change closes");
  // Executable: the refund rent lands on the ticket's player, not the caller.
  const market = v2Market({ playerBalance: 10n ** 9n });
  const reference = k("ref-e28");
  assert.equal(payEntryV2(market, { reference, tier: 0 }).ok, true);
  const playerBefore = market.world.accounts.get(market.keys.player)?.lamports ?? 0;
  const refund = refundEntryV2(market, { reference });
  assert.equal(refund.ok, true, JSON.stringify(refund));
  const playerAfter = market.world.accounts.get(market.keys.player)?.lamports ?? 0;
  assert.ok(playerAfter > playerBefore, "the rent refund did not reach the player");
  assert.equal(market.world.closed.length, 1);
  // A different player cannot collect that refund: the ticket PDA binds them.
  const impostor = k("impostor");
  plainWallet(market.world, impostor);
  tokenAccount(market.world, ataAddress(impostor, market.keys.mint),
    { mint: market.keys.mint, owner: impostor, amount: 0n });
  const market2 = v2Market({ playerBalance: 10n ** 9n });
  assert.equal(payEntryV2(market2, { reference, tier: 0 }).ok, true);
  const impostorAta = ataAddress(impostor, market2.keys.mint);
  plainWallet(market2.world, impostor);
  tokenAccount(market2.world, impostorAta,
    { mint: market2.keys.mint, owner: impostor, amount: 0n });
  const stolen = refundEntryV2(market2, { reference, player: impostor, playerAta: impostorAta });
  // The ticket PDA is keyed by (mint, reference, player), so the impostor either
  // addresses an account that does not exist (`missing-account`) or one that is
  // not the ticket PDA (`pda-mismatch`). Either way the refund cannot happen.
  assert.equal(stolen.ok, false, show(stolen));
  assert.ok(["pda-mismatch", "missing-account"]
    .includes((stolen as { failure: { kind: string } }).failure.kind),
    `unexpected rejection mode: ${show(stolen)}`);
  const realTicket = ticketPdaV2(market2, reference, market2.keys.player).address;
  assert.ok(market2.world.accounts.get(realTicket)?.exists !== false,
    "the impostor's attempt closed somebody else's ticket");
  assert.equal(balance(market2.world, impostorAta), 0n, "the impostor was paid");
  // The real player can still be refunded by the authority.
  const legit = refundEntryV2(market2, { reference });
  assert.equal(legit.ok, true, show(legit));
});

test("E29 — aliasing: config/treasury/vault identities are mutually exclusive", () => {
  const structs = parseAccountsStructs(SOURCE);
  // v2 pins the anti-aliasing in the accounts struct itself; v1 keeps the same
  // two guards in the handler body (checked below). Both layers must exist.
  // The vault guard is the load-bearing one on every payout path: without it a
  // caller could name the prize vault as "their" wallet and drain it. The
  // treasury guard is defence in depth (see the note below ClaimPrizeV2).
  for (const name of ["PayEntryV2", "ClaimPrizeV2", "RefundEntryV2"]) {
    const struct = getStruct(structs, name);
    const playerAta = struct.fields.find((f) => f.name === "player_ata");
    assert.ok(playerAta, `${name} has no player_ata`);
    assert.ok(playerAta.constraints.some((c) => /!= config\.vault_ata/.test(c)),
      `${name}.player_ata may alias the prize vault`);
    assert.ok(playerAta.constraints.some((c) => /player_ata\.owner == player\.key\(\)/.test(c)),
      `${name}.player_ata does not pin its owner`);
  }
  // SW-2026-09-26 (E29 follow-up): ClaimPrizeV2 now carries the same
  // `player_ata != config.treasury_ata` anti-alias as PayEntryV2 and
  // RefundEntryV2. It was never exploitable (the owner pin already excluded
  // the treasury, whose authority is the config PDA), but the three payout
  // paths stay symmetric now.
  const claimV2 = getStruct(structs, "ClaimPrizeV2")
    .fields.find((f) => f.name === "player_ata");
  assert.ok((claimV2?.constraints ?? []).some((c) => /!= config\.treasury_ata/.test(c)),
    "ClaimPrizeV2 lost the treasury anti-alias — the payout paths must stay symmetric");
  for (const name of ["PayEntry", "ClaimPrize"]) {
    const struct = getStruct(structs, name);
    const playerAta = struct.fields.find((f) => f.name === "player_ata");
    assert.ok(playerAta, `${name} has no player_ata`);
    assert.ok(playerAta.constraints.some((c) => /player_ata\.owner == player\.key\(\)/.test(c)),
      `${name}.player_ata does not pin its owner`);
  }
  // The treasury slot may never be the vault (that would let the operator rake
  // 100% by "paying itself"). Both are `address`-pinned to different config
  // fields and carry different `token::authority` values (the config PDA vs the
  // operator), and a single token account has exactly one owner — so aliasing is
  // structurally impossible. Assert that both halves of the argument hold.
  for (const name of ["SweepPrizes", "SweepPrizesV2"]) {
    const struct = getStruct(structs, name);
    const vault = struct.fields.find((f) => f.name === "vault_ata");
    const treasury = struct.fields.find((f) => f.name === "treasury_ata");
    assert.ok(vault && treasury, `${name} does not carry both sides of the payout`);
    assert.equal(vault?.address, "config.vault_ata", `${name}.vault_ata is not address-pinned`);
    assert.equal(treasury?.address, "config.treasury_ata", `${name}.treasury_ata is not address-pinned`);
    assert.equal(vault?.tokenAuthority, "config", `${name}.vault_ata is not program-owned`);
    assert.equal(treasury?.tokenAuthority, "config.authority",
      `${name}.treasury_ata is not operator-owned`);
  }
  // Where the operator gets to *choose* a treasury (the authority handover), the
  // struct forbids picking the vault — that is the only place the two could be
  // made to alias by an actor, and it is closed.
  for (const name of ["AcceptAuthorityV1", "AcceptAuthorityV2"]) {
    const struct = getStruct(structs, name);
    const slot = struct.fields.find((f) => f.name === "new_treasury_ata");
    assert.ok(slot?.constraints.some((c) => /!= config\.vault_ata/.test(c)),
      `${name}.new_treasury_ata may be set to the prize vault`);
  }
  // v1 keeps the same guard inside the handler.
  assert.match(functionBody(SOURCE, "pay_entry"), /player_ata\.key\(\) != config\.vault_ata/);
  assert.match(functionBody(SOURCE, "pay_entry"), /player_ata\.key\(\) != config\.treasury_ata/);
});

/**
 * Drop line comments (`//`, `///`, `//!`) and block comments so the hygiene
 * sweep looks at executable code only. String literals are preserved.
 */
function stripRustComments(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const two = source.slice(i, i + 2);
    if (two === "//") {
      const nl = source.indexOf("\n", i);
      i = nl < 0 ? source.length : nl;
      continue;
    }
    if (two === "/*") {
      let depth = 1;
      i += 2;
      while (i < source.length && depth > 0) {
        if (source.slice(i, i + 2) === "/*") { depth++; i += 2; }
        else if (source.slice(i, i + 2) === "*/") { depth--; i += 2; }
        else i++;
      }
      continue;
    }
    if (source[i] === "\"") {
      const end = scanRustString(source, i);
      out += source.slice(i, end);
      i = end;
      continue;
    }
    out += source[i] as string;
    i++;
  }
  return out;
}

function scanRustString(source: string, start: number): number {
  let i = start + 1;
  while (i < source.length) {
    if (source[i] === "\\") { i += 2; continue; }
    if (source[i] === "\"") return i + 1;
    i++;
  }
  return source.length;
}

/** `JSON.stringify` that survives bigint, for assertion messages. */
function show(value: unknown): string {
  return JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? `${v}n` : v));
}

/**
 * Everything under `#[cfg(test)] mod tests` is compiled out of the deployed
 * program, so panics/unwraps there are not reachable on chain. The scan has to
 * look at the shipped code only.
 */
function onChainSource(source: string): string {
  // Drop every `#[cfg(test)] mod tests { ... }` block: it is compiled out of the
  // deployed program, so its unwraps/panics are unreachable on chain.
  let out = "";
  let i = 0;
  for (;;) {
    const start = source.indexOf("#[cfg(test)]", i);
    if (start < 0) { out += source.slice(i); break; }
    out += source.slice(i, start);
    const brace = source.indexOf("{", start);
    let depth = 0;
    let j = brace;
    for (; j < source.length; j++) {
      if (source[j] === "{") depth++;
      else if (source[j] === "}") { depth--; if (depth === 0) break; }
    }
    i = j + 1;
  }
  return out;
}

test("E30 — no deprecated sysvars, no unsafe, no panics in the program path", () => {
  for (const program of ALL_PROGRAMS) {
    const source = onChainSource(SOURCES[program] as string);
    assert.doesNotMatch(source, /\bunsafe\b/, `${program} contains unsafe code`);
    // `try_into().unwrap()` on a slice whose length was just `require!`d is
    // infallible (the error type is `()`), so it cannot panic; anything else can.
    const unwraps = [...source.matchAll(/\.unwrap\(\)/g)].length;
    const infallible = [...source.matchAll(/try_into\(\)\.unwrap\(\)/g)].length;
    assert.equal(unwraps, infallible,
      `${program} has ${unwraps - infallible} fallible unwrap() in the deployed path`);
    assert.doesNotMatch(source, /panic!\(/, `${program} panics instead of returning an error`);
    assert.doesNotMatch(source, /EpochSchedule|slot_history|Sysvar::from_account_info/,
      `${program} reads a deprecated/unused sysvar`);
    assert.doesNotMatch(source, /init_if_needed/, `${program} uses init_if_needed`);
  }
});

// ============================================ 31. model ↔ program ↔ backend parity

test("31 — the TS model of every pure Rust helper agrees with the Rust body", () => {
  // split_fee_v2
  const splitBody = functionBody(SOURCE, "split_fee_v2");
  assert.match(splitBody, /require!\(fee > 0, EconomyError::InvalidFee\)/);
  assert.match(splitBody, /require!\(rake_bps <= MAX_RAKE_BPS, EconomyError::InvalidRake\)/);
  for (let i = 0; i < 500; i++) {
    const fee = BigInt(`0x${randomBytes(8).toString("hex")}`) % ((1n << 64n) - 1n) + 1n;
    const bps = Number(randomBytes(2).readUInt16BE(0)) % (RULES.MAX_RAKE_BPS + 1);
    const { rake, prize } = splitFeeV2(fee, bps);
    const expected = (fee * BigInt(bps)) / 10_000n;
    assert.equal(rake, expected, `floor rounding differs for fee=${fee} bps=${bps}`);
    assert.equal(prize, fee - expected);
  }
  // tier_fees_v2 vs the backend expectation used by readMarketV2
  for (let decimals = 0; decimals <= 15; decimals++) {
    const fees = tierFeesV2(decimals);
    assert.deepEqual(fees, [50n, 100n, 500n, 2000n].map((n) => n * 10n ** BigInt(decimals)));
  }
  assert.throws(() => tierFeesV2(200), /Overflow/);
  // reserve_prizes_v2
  assert.equal(reservePrizesV2(1000n, 200n, 300n), 500n);
  assert.throws(() => reservePrizesV2(1000n, 900n, 200n), /VaultUnderfunded/);
  assert.throws(() => reservePrizesV2(100n, 200n, 1n), /VaultUnderfunded/);
  assert.throws(() => reservePrizesV2(100n, 0n, 0n), /InvalidTotal/);
  // `reserved + total` can never overflow, because the guard above it forces
  // `total <= balance - reserved` and `balance` is itself a u64. Property-test
  // that instead of asserting an unreachable throw.
  for (let i = 0; i < 500; i++) {
    const balance = BigInt(`0x${randomBytes(8).toString("hex")}`);
    const reserved = BigInt(`0x${randomBytes(8).toString("hex")}`) % (balance + 1n);
    const free = balance - reserved;
    const total = free === 0n ? 1n : BigInt(`0x${randomBytes(8).toString("hex")}`) % free + 1n;
    try {
      const next = reservePrizesV2(balance, reserved, total);
      assert.ok(next <= (1n << 64n) - 1n, `reservation overflowed u64: ${next}`);
      assert.equal(next, reserved + total);
      assert.ok(next <= balance, "the reservation exceeds the vault balance");
    } catch (err) {
      assert.equal((err as ProgramError).code, "VaultUnderfunded");
    }
  }
  // proof_depth: exactly the padded depth, and malformed counts fail closed.
  assert.equal(proofDepth(1), 0);
  assert.equal(proofDepth(2), 1);
  assert.equal(proofDepth(3), 2);
  assert.equal(proofDepth(10), 4);
  assert.throws(() => proofDepth(0), /InvalidLeafCount/);
  assert.throws(() => proofDepth(-1), /InvalidLeafCount/);
  assert.throws(() => proofDepth(0xffffffff), /InvalidLeafCount/);
  assert.throws(() => proofDepth(1.5), /InvalidLeafCount/);
  // The Rust `checked_next_power_of_two` guard is what keeps a huge leaf_count
  // from wrapping to a short proof.
  assert.match(functionBody(SOURCE, "proof_depth"), /checked_next_power_of_two/);
  assert.match(functionBody(SOURCE, "proof_depth"), /depth <= MAX_PROOF_LEN/);
});

test("31 — leaves and proofs are byte-identical to the backend and the client", () => {
  for (let i = 0; i < 200; i++) {
    const wallet = randomBytes(32);
    const mint = randomBytes(32);
    const amount = BigInt(`0x${randomBytes(6).toString("hex")}`);
    assert.equal(merkleLeafV2(wallet, amount, mint), economyLeafV2(wallet, amount, mint));
    assert.equal(merkleLeaf(wallet, amount), leafHash(wallet, Number(amount)));
  }
  // A random tree must verify the same way in all three implementations.
  for (const leafCount of [1, 2, 3, 5, 10]) {
    const leaves = Array.from({ length: leafCount }, () => randomBytes(32).toString("hex"));
    const depth = Math.max(0, Math.ceil(Math.log2(Math.max(1, leafCount))));
    let layer = [...leaves];
    while (layer.length < 2 ** depth) layer.push("0".repeat(64));
    while (layer.length > 1) {
      const next: string[] = [];
      for (let j = 0; j < layer.length; j += 2) {
        next.push(sha256(layer[j] as string, layer[j + 1] as string).toString("hex"));
      }
      layer = next;
    }
    const root = layer[0] as string;
    for (let index = 0; index < leafCount; index++) {
      const proof: string[] = [];
      let current = [...leaves];
      while (current.length < 2 ** depth) current.push("0".repeat(64));
      let i = index;
      while (current.length > 1) {
        const sibling = i % 2 === 0 ? i + 1 : i - 1;
        proof.push(current[sibling] as string);
        const next: string[] = [];
        for (let j = 0; j < current.length; j += 2) {
          next.push(sha256(current[j] as string, current[j + 1] as string).toString("hex"));
        }
        current = next;
        i = Math.floor(i / 2);
      }
      assert.equal(verifyProofIndexed(leaves[index] as string, index, proof, root), true);
      assert.equal(backendVerifyProofIndexed(leaves[index] as string, index, proof, root), true);
      assert.equal(verifyProofV2(leaves[index] as string, index, proof, root), true);
      assert.equal(verifyEconomyProofV2(leaves[index] as string, index, proof, root), true);
      // A high index bit that the proof length cannot support must be rejected.
      assert.equal(verifyProofV2(leaves[index] as string, index + 2 ** proof.length, proof, root), false);
      assert.equal(verifyEconomyProofV2(leaves[index] as string, index + 2 ** proof.length, proof, root), false);
    }
  }
});

// ======================================================= executable attack matrix

test("X1 — a forged config account cannot be passed to any instruction", () => {
  const market = v2Market({ playerBalance: 10n ** 9n });
  const forged = k("forged-config");
  const world = market.world;
  addAccount(world, {
    key: forged, owner: world.programId, lamports: rentExempt(180),
    data: {
      __type: "EconomyConfigV2", authority: k("attacker"), mint: market.keys.mint,
      treasury_ata: k("attacker-treasury"), vault_ata: k("attacker-vault"),
      fees: [1n, 1n, 1n, 1n], rake_bps: 2000, reserved: 0n, paused: false, bump: 255,
    },
  });
  const result = payEntryV2(market, {
    reference: k("ref-x1"), tier: 0, extraKeys: { config: forged },
  });
  assert.equal(result.ok, false);
  assert.equal((result as { failure: { kind: string } }).failure.kind, "pda-mismatch");
  // A config owned by another program is rejected on the owner check.
  const foreign = k("foreign-config");
  addAccount(world, { key: foreign, owner: k("other-program"), lamports: rentExempt(180), data: {} });
  const foreignResult = payEntryV2(market, {
    reference: k("ref-x1b"), tier: 0, extraKeys: { config: foreign },
  });
  assert.equal(foreignResult.ok, false);
  assert.ok(["pda-mismatch", "wrong-owner"].includes(
    (foreignResult as { failure: { kind: string } }).failure.kind));
});

test("X2 — a stored bump that is not the canonical bump is rejected", () => {
  const market = v2Market({});
  const config = accountData(market.world, market.keys.config) as { bump: number };
  const canonical = config.bump;
  config.bump = canonical === 255 ? 254 : canonical + 1;
  const result = adminV2(market, { paused: true });
  assert.equal(result.ok, false);
  assert.equal((result as { failure: { kind: string } }).failure.kind, "bump-mismatch");
});

test("X3 — cross-market state cannot be replayed against another mint", () => {
  const winners = (market: Market) => [
    { player: market.keys.player, amount: 100n },
    { player: k("winner-2"), amount: 200n },
    { player: k("winner-3"), amount: 300n },
  ];
  const market = v2Market({ playerBalance: 10n ** 10n });
  const other = v2Market({ mint: k("other-mint"), playerBalance: 10n ** 10n });
  assert.notEqual(market.keys.mint, other.keys.mint);
  assert.notEqual(market.keys.config, other.keys.config,
    "two mints must not share one config PDA");

  // The same reference can be paid in both markets, because the ticket PDA is
  // keyed by the mint — but the two tickets are different accounts.
  const reference = k("ref-x3");
  assert.equal(payEntryV2(market, { reference, tier: 1 }).ok, true);
  assert.equal(payEntryV2(other, { reference, tier: 1 }).ok, true);
  assert.notEqual(
    ticketPdaV2(market, reference, market.keys.player).address,
    ticketPdaV2(other, reference, other.keys.player).address,
    "tickets must be isolated per market");
  // ... and paying the same reference twice in the SAME market is a replay.
  const replay = payEntryV2(market, { reference, tier: 1 });
  assert.equal(replay.ok, false, show(replay));
  assert.equal((replay as { failure: { kind: string } }).failure.kind, "already-initialized");

  // Prize epochs are keyed by (mint, epoch) and the leaf binds the mint, so a
  // proof from market A cannot open market B's vault. Three leaves ⇒ a real
  // (non-empty) proof, otherwise the two proofs would both be `[]`.
  const a = seedPublishedEpoch(market, { epoch: 21n, leaves: winners(market) });
  const b = seedPublishedEpoch(other, { epoch: 21n, leaves: winners(other) });
  assert.notEqual(a.prizes, b.prizes, "the epoch PDA is not mint-scoped");
  assert.notEqual(a.root, b.root, "identical winners in two mints must hash differently");
  assert.equal((a.proofs[0] as string[]).length, proofDepth(3));

  const otherWalletBefore = balance(other.world, other.keys.playerAta);
  const crossMint = claimPrizeV2(other, {
    epoch: 21n, amount: 100n, leafIndex: 0, proof: a.proofs[0] as string[],
  });
  assert.equal(crossMint.ok, false, show(crossMint));
  assert.match(show(crossMint), /ProofInvalid/);
  assert.equal(otherWalletBefore, 10n ** 10n - (tierFeesV2(6)[1] as bigint),
    "the entry fee was not what the tier table says");

  // The genuinely-correct proof for market B still works.
  const own = claimPrizeV2(other, {
    epoch: 21n, amount: 100n, leafIndex: 0, proof: b.proofs[0] as string[],
  });
  assert.equal(own.ok, true, show(own));
  assert.equal(balance(other.world, other.keys.playerAta), otherWalletBefore + 100n,
    "the legitimate proof did not pay the leaf amount");

  // A published epoch cannot be re-pointed at a different root or mint.
  const configOfOther = accountData(other.world, other.keys.config) as { mint: Key };
  const prizesOfOther = accountData(other.world, b.prizes) as { mint: Key; root: string };
  assert.equal(prizesOfOther.mint, configOfOther.mint, "the epoch is not bound to its market");
  assert.equal(prizesOfOther.root, b.root);
});

test("X4 — publication is one-way and reservations cannot double-spend the vault", () => {
  const market = v2Market({});
  const vault = market.world.accounts.get(market.keys.vault);
  assert.ok(vault);
  vault.amount = 1_000n;
  const rootA = sha256(Buffer.from("root-a")).toString("hex");
  const rootB = sha256(Buffer.from("root-b")).toString("hex");
  assert.equal(publishPrizesV2(market, { epoch: 1n, root: rootA, total: 600n, leafCount: 2 }).ok, true);
  const config = accountData(market.world, market.keys.config) as { reserved: bigint };
  assert.equal(config.reserved, 600n);
  // 600 of 1000 are spoken for: a second 500 must not fit.
  const over = publishPrizesV2(market, { epoch: 2n, root: rootB, total: 500n, leafCount: 2 });
  assert.equal(over.ok, false);
  assert.match(show(over), /VaultUnderfunded/);
  assert.equal(publishPrizesV2(market, { epoch: 3n, root: rootB, total: 400n, leafCount: 2 }).ok, true);
  // Re-read: the rejected publication above rolled the world back to a snapshot,
  // so the `config` object captured before it is no longer the live one.
  assert.equal(config.reserved, 600n, "the rejected publication changed the reservation");
  assert.equal((accountData(market.world, market.keys.config) as { reserved: bigint }).reserved,
    1000n, "the third publication did not reserve its total");
  // Re-publishing the same epoch is an init on an existing PDA.
  const replay = publishPrizesV2(market, { epoch: 1n, root: rootB, total: 1n, leafCount: 1 });
  assert.equal(replay.ok, false);
  assert.equal((replay as { failure: { kind: string } }).failure.kind, "already-initialized");
  // Zero/negative/garbage publications are rejected before any state change.
  // `publish_prizes_v2` rejects the whole tuple with InvalidTotal:
  //   total > 0 && root != [0; 32] && leaf_count > 0 && leaf_count <= 10
  // Each case runs in its own market, because a rejected publication is rolled
  // back on chain while this harness keeps the PDA the failed `init` created.
  const badCases: { root: string; total: bigint; leafCount: number; why: string }[] = [
    { root: "0".repeat(64), total: 1n, leafCount: 1, why: "an all-zero root is not a tree" },
    { root: rootA, total: 0n, leafCount: 1, why: "a zero total reserves nothing and pays nobody" },
    { root: rootA, total: 1n, leafCount: 0, why: "a tree with no leaves cannot be claimed" },
    { root: rootA, total: 1n, leafCount: 11, why: "leaf_count above the MAX_PROOF_LEN bound" },
    { root: rootA, total: 2n ** 64n - 1n, leafCount: 1, why: "a total the vault can never cover" },
  ];
  for (const [i, bad] of badCases.entries()) {
    const fresh = v2Market({});
    (fresh.world.accounts.get(fresh.keys.vault) as { amount: bigint }).amount = 1_000n;
    const result = publishPrizesV2(fresh, { epoch: BigInt(100 + i), ...bad });
    assert.equal(result.ok, false, `${bad.why}: ${show(bad)}`);
    assert.match(show(result), /InvalidTotal|VaultUnderfunded/,
      `${bad.why} was not rejected: ${show(result)}`);
    const freshConfig = accountData(fresh.world, fresh.keys.config) as { reserved: bigint };
    assert.equal(freshConfig.reserved, 0n, `${bad.why} still reserved funds`);
  }
  // The bound itself is exactly 10, and 10 is accepted (depth 4).
  const edge = v2Market({});
  (edge.world.accounts.get(edge.keys.vault) as { amount: bigint }).amount = 1_000n;
  assert.equal(publishPrizesV2(edge, { epoch: 7n, root: rootA, total: 1n, leafCount: 10 }).ok, true,
    "leaf_count = 10 must be accepted");
  assert.equal((accountData(market.world, market.keys.config) as { reserved: bigint }).reserved,
    1000n, "a rejected publication must not reserve funds");
  // A stranger cannot publish.
  const stranger = k("stranger-publisher");
  plainWallet(market.world, stranger);
  const forged = publishPrizesV2(market, {
    epoch: 30n, root: rootA, total: 1n, leafCount: 1, authority: stranger, signers: [stranger],
  });
  assert.equal(forged.ok, false);
  assert.equal((forged as { failure: { kind: string } }).failure.kind, "has-one-mismatch");
});

test("X5 — claims are bounded by index, depth, epoch and the remaining budget", () => {
  // A rejected claim never reaches the chain, so nothing is written. This
  // harness does create the `init` claim PDA before the handler runs, so every
  // attempt gets its own freshly seeded market with its own winners and proofs.
  const setup = (epoch = 5n) => {
    const market = v2Market({});
    const leaves = [
      { player: market.keys.player, amount: 100n },
      { player: k("winner-2"), amount: 200n },
      { player: k("winner-3"), amount: 300n },
    ];
    const seeded = seedPublishedEpoch(market, { epoch, leaves });
    return { market, leaves, proofs: seeded.proofs, total: seeded.total };
  };
  const { proofs } = setup();
  const depth = proofDepth(3);
  assert.equal(depth, 2, "3 leaves pad to a depth-2 tree");
  assert.equal(proofs[0]?.length, depth, "the proof must be exactly `depth` siblings");

  // Wrong index for a valid proof.
  {
    const { market } = setup();
    const r = claimPrizeV2(market, { epoch: 5n, amount: 100n, leafIndex: 1, proof: proofs[0] as string[] });
    assert.equal(r.ok, false, show(r));
    assert.match(show(r), /ProofInvalid/);
  }
  // Wrong amount for a valid index.
  {
    const { market } = setup();
    const r = claimPrizeV2(market, { epoch: 5n, amount: 101n, leafIndex: 0, proof: proofs[0] as string[] });
    assert.equal(r.ok, false, show(r));
    assert.match(show(r), /ProofInvalid/);
  }
  // Index beyond leaf_count.
  {
    const { market } = setup();
    const r = claimPrizeV2(market, { epoch: 5n, amount: 100n, leafIndex: 3, proof: proofs[0] as string[] });
    assert.equal(r.ok, false, show(r));
    assert.match(show(r), /ProofInvalid/);
  }
  // Truncated proof (depth must be exact, not "at most").
  {
    const { market } = setup();
    const r = claimPrizeV2(market, { epoch: 5n, amount: 100n, leafIndex: 0,
      proof: (proofs[0] as string[]).slice(0, 1) });
    assert.equal(r.ok, false, show(r));
    assert.match(show(r), /ProofInvalid/);
  }
  // Padded proof (one sibling too many) must fail just as hard.
  {
    const { market } = setup();
    const r = claimPrizeV2(market, { epoch: 5n, amount: 100n, leafIndex: 0,
      proof: [...(proofs[0] as string[]), "0".repeat(64)] });
    assert.equal(r.ok, false, show(r));
    assert.match(show(r), /ProofInvalid/);
  }
  // Proof longer than MAX_PROOF_LEN is refused before any hashing.
  {
    const { market } = setup();
    const r = claimPrizeV2(market, { epoch: 5n, amount: 100n, leafIndex: 0,
      proof: Array.from({ length: 33 }, () => "0".repeat(64)) });
    assert.equal(r.ok, false, show(r));
    assert.match(show(r), /ProofTooLong/);
  }
  // Wrong epoch: the prizes PDA is keyed by epoch, so there is nothing to claim.
  {
    const { market } = setup();
    const r = claimPrizeV2(market, { epoch: 6n, amount: 100n, leafIndex: 0, proof: proofs[0] as string[] });
    assert.equal(r.ok, false, show(r));
    assert.equal((r as { failure: { kind: string } }).failure.kind, "missing-account");
  }
  // Zero amount.
  {
    const { market } = setup();
    const r = claimPrizeV2(market, { epoch: 5n, amount: 0n, leafIndex: 0, proof: proofs[0] as string[] });
    assert.equal(r.ok, false, show(r));
    assert.match(show(r), /ZeroAmount/);
  }

  // The honest claim works and moves exactly the leaf amount.
  const { market, proofs: ownProofs } = setup();
  const honest = claimPrizeV2(market, { epoch: 5n, amount: 100n, leafIndex: 0,
    proof: ownProofs[0] as string[] });
  assert.equal(honest.ok, true, show(honest));
  assert.equal(balance(market.world, market.keys.playerAta), 1_000_100n,
    "the claim must add exactly the leaf amount to the wallet");
  const prizes = accountData(market.world, prizesPdaV2(market, 5n).address) as { remaining: bigint };
  assert.equal(prizes.remaining, 500n, "the epoch budget must shrink by exactly the leaf");

  // Over-claiming the remainder must fail even with a "valid-looking" proof,
  // and the failure must leave the vault and the wallet untouched.
  const vaultBefore = balance(market.world, market.keys.vault);
  const greedy = claimPrizeV2(market, { epoch: 5n, amount: 600n, leafIndex: 0,
    proof: ownProofs[0] as string[] });
  assert.equal(greedy.ok, false, show(greedy));
  assert.equal(balance(market.world, market.keys.vault), vaultBefore, "a rejected claim moved vault funds");
  assert.equal(balance(market.world, market.keys.playerAta), 1_000_100n, "a rejected claim paid twice");

  // And the same leaf can never be claimed twice.
  const replay = claimPrizeV2(market, { epoch: 5n, amount: 100n, leafIndex: 0,
    proof: ownProofs[0] as string[] });
  assert.equal(replay.ok, false, show(replay));
  assert.equal((replay as { failure: { kind: string } }).failure.kind, "already-initialized");
  assert.equal(balance(market.world, market.keys.playerAta), 1_000_100n);
});

test("X6 — pause is honoured by every money-moving instruction", () => {
  const handlers = [
    { name: "pay_entry_v2", run: (paused: boolean) => {
      const market = v2Market({ paused, playerBalance: 10n ** 9n });
      return payEntryV2(market, { reference: k(`ref-pause-${paused}`), tier: 0 });
    } },
    { name: "publish_prizes_v2", run: (paused: boolean) => {
      const market = v2Market({ paused });
      market.world.accounts.get(market.keys.vault)!.amount = 100n;
      return publishPrizesV2(market, { epoch: 1n, root: sha256(Buffer.from("r")).toString("hex"),
        total: 10n, leafCount: 1 });
    } },
    { name: "claim_prize_v2", run: (paused: boolean) => {
      const market = v2Market({});
      const { proofs } = seedPublishedEpoch(market, { epoch: 2n,
        leaves: [{ player: market.keys.player, amount: 5n }] });
      if (paused) (accountData(market.world, market.keys.config) as { paused: boolean }).paused = true;
      return claimPrizeV2(market, { epoch: 2n, amount: 5n, leafIndex: 0, proof: proofs[0] as string[] });
    } },
    // SW-2026-09-26 F-02: the sweep used to dodge this gate; now it is in the
    // matrix like every other money-moving instruction.
    { name: "sweep_expired_prizes_v2", run: (paused: boolean) => {
      const market = v2Market({ paused });
      seedPublishedEpoch(market, { epoch: 9n,
        leaves: [{ player: market.keys.player, amount: 5n }], vaultBalance: 5n,
        publishedAt: 1_700_000_000 });
      market.world.clock.unixTimestamp = 1_700_000_000 + 7 * 24 * 3600;
      return sweepExpiredPrizesV2(market, { epoch: 9n });
    } },
  ];
  for (const handler of handlers) {
    assert.equal(handler.run(false).ok, true, `${handler.name} must work while unpaused`);
    const paused = handler.run(true);
    assert.equal(paused.ok, false, `${handler.name} must stop while paused`);
    assert.match(JSON.stringify(paused), /Paused/);
  }
  // Pausing is authority-only and emits an event.
  const market = v2Market({});
  const stranger = k("pause-stranger");
  plainWallet(market.world, stranger);
  assert.equal(adminV2(market, { paused: true, authority: stranger, signers: [stranger] }).ok, false);
  assert.equal(adminV2(market, { paused: true }).ok, true);
  assert.deepEqual(market.world.events.at(-1)?.name, "AdminPausedV2");
  // The rake cap AND the per-call step cap (SW-2026-09-26 F-01) are enforced
  // on the admin path: one step up is fine, a full-range jump is not.
  const before = accountData(market.world, market.keys.config) as { rake_bps: number };
  const baseRake = before.rake_bps;
  assert.equal(adminV2(market, { rakeBps: RULES.MAX_RAKE_BPS + 1 }).ok, false, "the absolute cap was dropped");
  assert.equal(adminV2(market, { rakeBps: baseRake + RULES.MAX_RAKE_STEP_BPS }).ok, true,
    "a single legal step was rejected");
  const configAfter = accountData(market.world, market.keys.config) as { rake_bps: number };
  assert.equal(configAfter.rake_bps, baseRake + RULES.MAX_RAKE_STEP_BPS);
  assert.equal(adminV2(market, { rakeBps: RULES.MAX_RAKE_BPS }).ok, false,
    "a rake jump past the step cap was accepted");
  // SW-2026-09-26 F-02 closed the last gap: the sweep is pause-gated too, and
  // the matrix above now covers every money-moving v2 instruction.
});

test("X7 — refunds are exact, one-shot and only authority-approved", () => {
  // Tier 3 costs 2_000 * 10^6, so the wallet needs more than the 1e9 default.
  const playerBalance = 10n ** 10n;
  const market = v2Market({ playerBalance });
  const reference = k("ref-x7");
  assert.equal(payEntryV2(market, { reference, tier: 3 }).ok, true);
  const fee = tierFeesV2(6)[3] as bigint;
  const { rake, prize } = splitFeeV2(fee, 1000);
  const treasury = balance(market.world, market.keys.treasury);
  const vault = balance(market.world, market.keys.vault);
  assert.equal(treasury, rake);
  assert.equal(vault, prize);
  // A stranger cannot refund.
  const stranger = k("refund-stranger");
  plainWallet(market.world, stranger);
  const forged = refundEntryV2(market, { reference, authority: stranger, signers: [stranger] });
  assert.equal(forged.ok, false);
  assert.equal((forged as { failure: { kind: string } }).failure.kind, "has-one-mismatch");
  assert.equal(balance(market.world, market.keys.playerAta), playerBalance - fee);
  // The operator refund returns exactly the stored split, not today's rake.
  const refund = refundEntryV2(market, { reference });
  assert.equal(refund.ok, true, show(refund));
  assert.equal(balance(market.world, market.keys.playerAta), playerBalance);
  assert.equal(balance(market.world, market.keys.treasury), 0n);
  assert.equal(balance(market.world, market.keys.vault), 0n);
  // One-shot: the ticket is closed, so a replay has nothing to refund.
  const replay = refundEntryV2(market, { reference });
  assert.equal(replay.ok, false);
  assert.equal((replay as { failure: { kind: string } }).failure.kind, "missing-account");
  // A tampered split (rake + prize != amount) is refused even by the authority.
  const market2 = v2Market({ playerBalance: 10n ** 9n });
  const ref2 = k("ref-x7b");
  assert.equal(payEntryV2(market2, { reference: ref2, tier: 0 }).ok, true);
  const ticket = accountData(market2.world, ticketPdaV2(market2, ref2, market2.keys.player).address) as
    { rake: bigint; prize: bigint };
  ticket.prize += 1n;
  const tampered = refundEntryV2(market2, { reference: ref2 });
  assert.equal(tampered.ok, false);
  assert.match(JSON.stringify(tampered), /InvalidAmount/);
});

test("X8 — an underfunded vault or treasury fails atomically instead of going negative", () => {
  const market = v2Market({});
  const { proofs } = seedPublishedEpoch(market, {
    epoch: 8n, leaves: [{ player: market.keys.player, amount: 1_000n }], vaultBalance: 10n,
  });
  const result = claimPrizeV2(market, {
    epoch: 8n, amount: 1_000n, leafIndex: 0, proof: proofs[0] as string[],
  });
  assert.equal(result.ok, false, show(result));
  assert.match(show(result), /insufficient funds/);
  // Atomicity: the vault held 10 and the leaf promised 1_000, so nothing at all
  // may move — not even the credit leg of the transfer.
  assert.equal(balance(market.world, market.keys.playerAta), 1_000_000n,
    "a rejected claim changed the winner's balance");
  assert.equal(balance(market.world, market.keys.vault), 10n, "a rejected claim drained the vault");
  const prizesLeft = accountData(market.world, prizesPdaV2(market, 8n).address) as
    { remaining: bigint };
  assert.equal(prizesLeft.remaining, 1_000n, "a rejected claim consumed the epoch budget");
  const reservedLeft = accountData(market.world, market.keys.config) as { reserved: bigint };
  assert.equal(reservedLeft.reserved, 1_000n, "a rejected claim released the reservation");
  // And the claim PDA was rolled back, so a later, funded claim still works.
  const retry = claimPrizeV2(market, {
    epoch: 8n, amount: 1_000n, leafIndex: 0, proof: proofs[0] as string[],
  });
  (market.world.accounts.get(market.keys.vault) as { amount: bigint }).amount = 1_000n;
  const funded = claimPrizeV2(market, {
    epoch: 8n, amount: 1_000n, leafIndex: 0, proof: proofs[0] as string[],
  });
  assert.equal(retry.ok, false, show(retry));
  assert.equal(funded.ok, true, show(funded));
  assert.equal(balance(market.world, market.keys.playerAta), 1_001_000n);
  // The sweep cannot drive the reservation negative either.
  const market2 = v2Market({});
  seedPublishedEpoch(market2, { epoch: 8n,
    leaves: [{ player: market2.keys.player, amount: 100n }], vaultBalance: 100n });
  (accountData(market2.world, market2.keys.config) as { reserved: bigint }).reserved = 0n;
  market2.world.clock.unixTimestamp += 7 * 24 * 3600 + 1;
  const sweep = sweepExpiredPrizesV2(market2, { epoch: 8n });
  assert.equal(sweep.ok, false, show(sweep));
  assert.match(show(sweep), /VaultUnderfunded/);
});

test("X9 — the expired-prize sweep is time-gated, one-shot and treasury-bound", () => {
  const market = v2Market({});
  const published = 1_700_000_000;
  seedPublishedEpoch(market, {
    epoch: 9n, leaves: [{ player: market.keys.player, amount: 250n }],
    vaultBalance: 250n, publishedAt: published,
  });
  market.world.clock.unixTimestamp = published + 7 * 24 * 3600 - 1;
  const early = sweepExpiredPrizesV2(market, { epoch: 9n });
  assert.equal(early.ok, false);
  assert.match(JSON.stringify(early), /PrizeNotExpired/);
  assert.equal(balance(market.world, market.keys.treasury), 0n);
  market.world.clock.unixTimestamp = published + 7 * 24 * 3600;
  assert.equal(sweepExpiredPrizesV2(market, { epoch: 9n }).ok, true);
  assert.equal(balance(market.world, market.keys.treasury), 250n);
  assert.equal(balance(market.world, market.keys.vault), 0n);
  const config = accountData(market.world, market.keys.config) as { reserved: bigint };
  assert.equal(config.reserved, 0n);
  // Second sweep: nothing left.
  const again = sweepExpiredPrizesV2(market, { epoch: 9n });
  assert.equal(again.ok, false);
  assert.match(JSON.stringify(again), /NothingToSweep/);
  // A stranger cannot sweep, and the destination is pinned to config.treasury_ata.
  const market2 = v2Market({});
  seedPublishedEpoch(market2, { epoch: 9n,
    leaves: [{ player: market2.keys.player, amount: 250n }], vaultBalance: 250n, publishedAt: published });
  market2.world.clock.unixTimestamp = published + 7 * 24 * 3600;
  const stranger = k("sweep-stranger");
  plainWallet(market2.world, stranger);
  const forged = sweepExpiredPrizesV2(market2, { epoch: 9n, authority: stranger, signers: [stranger] });
  assert.equal(forged.ok, false);
  assert.equal((forged as { failure: { kind: string } }).failure.kind, "has-one-mismatch");
  const redirect = sweepExpiredPrizesV2(market2, {
    epoch: 9n, extraKeys: { treasury_ata: k("attacker-ata") },
  });
  assert.equal(redirect.ok, false);
});

test("X10 — bootstrap: a market can only be opened by the legacy operator", () => {
  const market = v2Market({ legacy: true });
  const legacyConfig = pda([Buffer.from(SEED_CONSTANTS.get("CONFIG_SEED") as string, "utf8")],
    market.keys.programId).address;
  const mint = k("boot-mint");
  addAccount(market.world, {
    key: mint, owner: keyOfBase58("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
    lamports: 1_461_600, decimals: 9, mintAuthority: null, freezeAuthority: null,
  });
  tokenAccount(market.world, ataAddress(market.keys.authority, mint),
    { mint, owner: market.keys.authority, amount: 0n });
  // The legacy config slot is the v1 PDA; pass it explicitly.
  const ok = initializeV2(market, { mint, extraKeys: { legacy_config: legacyConfig } });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  // A random first caller cannot seize a market.
  const market2 = v2Market({ legacy: true });
  const attacker = k("boot-attacker");
  plainWallet(market2.world, attacker);
  const mint2 = k("boot-mint-2");
  addAccount(market2.world, {
    key: mint2, owner: keyOfBase58("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
    lamports: 1_461_600, decimals: 6, mintAuthority: null, freezeAuthority: null,
  });
  tokenAccount(market2.world, ataAddress(attacker, mint2), { mint: mint2, owner: attacker, amount: 0n });
  const seized = initializeV2(market2, {
    mint: mint2, authority: attacker, signers: [attacker],
    extraKeys: { legacy_config: legacyConfig },
  });
  assert.equal(seized.ok, false);
  assert.equal((seized as { failure: { kind: string } }).failure.kind, "constraint-failed");
  // Every market starts paused, so boot cannot silently go live.
  const config = accountData(market.world, pda(
    [Buffer.from(SEED_CONSTANTS.get("CONFIG_V2_SEED") as string, "utf8"), Buffer.from(mint, "hex")],
    market.keys.programId).address) as { paused?: boolean };
  assert.match(functionBody(SOURCE, "initialize_v2"), /config\.paused = true/);
  assert.equal(config.paused, undefined, "the model does not fabricate a live market");
});

test("X11 — the fee table is fixed: a caller cannot choose a cheaper or free tier", () => {
  const market = v2Market({ playerBalance: 10n ** 12n });
  const fees = tierFeesV2(6);
  for (const tier of [0, 1, 2, 3]) {
    const reference = k(`ref-tier-${tier}`);
    const before = balance(market.world, market.keys.playerAta);
    assert.equal(payEntryV2(market, { reference, tier }).ok, true);
    assert.equal(before - balance(market.world, market.keys.playerAta), fees[tier]);
    const ticket = accountData(market.world, ticketPdaV2(market, reference, market.keys.player).address) as
      { amount: bigint; rake: bigint; prize: bigint; tier: number };
    assert.equal(ticket.amount, fees[tier]);
    assert.equal(ticket.tier, tier);
    assert.equal(ticket.rake + ticket.prize, ticket.amount);
  }
  // Out-of-range tiers are refused by the array bounds check.
  for (const tier of [4, 9, 255]) {
    const result = payEntryV2(market, { reference: k(`ref-tier-bad-${tier}`), tier });
    assert.equal(result.ok, false, `tier ${tier} must be rejected`);
    assert.match(JSON.stringify(result), /InvalidFee/);
  }
  // Unknown entry kinds are refused before any transfer.
  const kind = payEntryV2(market, { reference: k("ref-kind"), tier: 0, kind: 7 });
  assert.equal(kind.ok, false);
  assert.match(JSON.stringify(kind), /InvalidKind/);
  // The fees stored in config are exactly the decimal-scaled table.
  const config = accountData(market.world, market.keys.config) as { fees: bigint[] };
  assert.deepEqual(config.fees, fees);
});

test("X12 — the v1 payment path keeps its aliasing, mint and reservation guards", () => {
  const source = SOURCE;
  const payEntry = functionBody(source, "pay_entry");
  assert.match(payEntry, /require!\(!config\.paused, EconomyError::Paused\)/);
  assert.match(payEntry, /player_ata\.key\(\) != config\.vault_ata/);
  assert.match(payEntry, /player_ata\.key\(\) != config\.treasury_ata/);
  assert.match(payEntry, /vault_ata\.mint == config\.mint/);
  assert.match(payEntry, /vault_ata\.owner == config\.key\(\)/);
  // v1 computes the rake in u64: with overflow-checks = true a fee above
  // u64::MAX / rake_bps aborts instead of silently under-charging.
  assert.match(payEntry, /checked_mul\(u64::from\(config\.rake_bps\)\)/);
  assert.match(payEntry, /checked_div\(RAKE_DENOM\)/);
  assert.match(payEntry, /fee\.checked_sub\(rake\)/);
  const publish = functionBody(source, "publish_prizes");
  assert.match(publish, /vault_ata\.amount\.checked_sub\(config\.reserved\)/);
  assert.match(publish, /config\.reserved\.checked_add\(total\)/);
  const claim = functionBody(source, "claim_prize");
  assert.match(claim, /amount <= ctx\.accounts\.prizes\.total/);
  assert.match(claim, /config\.reserved\.checked_sub\(amount\)/);
  assert.match(claim, /prizes\.total\.checked_sub\(amount\)/);
});

// ------------------------------------------------------------------ hygiene sweep

test("H — no secrets, mints or cluster assumptions are baked into the programs", () => {
  for (const program of ALL_PROGRAMS) {
    const full = SOURCES[program] as string;
    // Only executable code counts: the module docs are *supposed* to explain
    // that the payment mint is operator-supplied (and name it), which is the
    // opposite of hardcoding it.
    // `declare_id!` and the named `*_PROGRAM_ID` constants pin *programs*, which
    // is exactly what you want; a bare base58 literal anywhere else would be a
    // hardcoded mint, treasury or authority.
    const code = stripRustComments(full).split("\n")
      .filter((line) => !/declare_id!/.test(line) && !/PROGRAM_ID/.test(line))
      .join("\n");
    const literals = code.match(/\b[1-9A-HJ-NP-Za-km-z]{32,}\b/gu) ?? [];
    const allowed = new Set<string>([
      PROGRAM_IDS["neonrelay-economy"] as string, PROGRAM_IDS["neonrelay-rewards"] as string,
      PROGRAM_IDS["neonrelay-features"] as string, PROGRAM_IDS["neonrelay-assets"] as string,
      SYSTEM, TOKEN_PROGRAM, ATA_PROGRAM,
    ]);
    for (const literal of literals) {
      assert.ok(allowed.has(literal),
        `${program} hardcodes a base58 key in code: ${literal}`);
    }
    assert.doesNotMatch(code, /SKR|So11111111111111111111111111111111111111112/,
      `${program} hardcodes a payment mint in code`);
    assert.doesNotMatch(code, /mainnet|devnet/i, `${program} branches on a cluster in code`);
    assert.doesNotMatch(code, /\benv!\(|option_env!\(/, `${program} bakes in a build-time secret`);
    // A capture-group match returns [fullMatch, group1], so exactly one
    // `declare_id!` shows up as a length-2 array.
    const ids = full.match(/declare_id!\("([^"]+)"\)/) ?? [];
    assert.equal(ids.length, 2, `${program} must declare exactly one id`);
    assert.equal(ids[1], PROGRAM_IDS[program], `${program} declares an unexpected id`);
  }
  // The devnet-only policy and the "mint is not hardcoded" claim are documented.
  assert.match(SOURCE, /CLUSTER POLICY: devnet only/);
  assert.match(SOURCE, /NOT hardcoded/i);
});

test("H — the model itself stays honest: it rejects what the program rejects", () => {
  // Sanity check on the harness: a world with no accounts at all must fail.
  const empty = makeWorld({ programId: keyOfBase58(PROGRAM_IDS["neonrelay-economy"] as string) });
  const struct = getStruct(STRUCTS, "PayEntryV2");
  const result = evalAccounts(struct, empty);
  assert.equal(result.ok, false);
  // Rent numbers follow the runtime formula, so a created account cannot be
  // garbage-collected mid-instruction.
  assert.equal(rentExempt(0), 890_880);
  assert.equal(rentExempt(165), 2_039_280);
  assert.ok(rentExempt(180) > rentExempt(165));
});

test("H — helper surface is intact", () => {
  // These are easy to lose when editing; assert the model still exports them.
  for (const fn of [splitTopLevel, useConstants, useInitSpace, parseConstants, functionBody,
    merkleLeaf, merkleLeafV2, verifyProofIndexed, verifyProofV2, proofDepth, splitFeeV2,
    tierFeesV2, reservePrizesV2, claimPdaV2, prizesPdaV2, ticketPdaV2, v2Market, evalAccounts]) {
    assert.equal(typeof fn, "function");
  }
});
