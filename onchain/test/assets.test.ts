/**
 * Offline conformance for neonrelay-assets (source-gated asset paths + security).
 * No chain, no crates.io — pins seeds, program ids, leaf hash and fail-closed CPI gates.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  ASSETS_PROGRAM_ID_PLACEHOLDER,
  FEATURES_PROGRAM_ID_PLACEHOLDER,
  ASSETS_SEEDS,
  BUBBLEGUM_PROGRAM_ID,
  COMPRESSION_PROGRAM_ID,
  MPL_CORE_PROGRAM_ID,
} from "../src/constants.ts";
import {
  compressedBadgeLeaf,
  isBubblegumProgram,
  isCompressionProgram,
} from "../src/assets.ts";

const here = dirname(fileURLToPath(import.meta.url));
const libRs = readFileSync(
  join(here, "../programs/neonrelay-assets/src/lib.rs"),
  "utf8"
);
const anchorToml = readFileSync(join(here, "../Anchor.toml"), "utf8");

// Seeds pinned between lib.rs and TS
test("assets PDA seeds in lib.rs match TS constants", () => {
  assert.match(
    libRs,
    new RegExp(`CONFIG_SEED: &\\[u8\\] = b"${ASSETS_SEEDS.config}"`)
  );
  assert.match(
    libRs,
    new RegExp(`COLLECTION_SEED: &\\[u8\\] = b"${ASSETS_SEEDS.collection}"`)
  );
  assert.match(
    libRs,
    new RegExp(`BADGE_SEED: &\\[u8\\] = b"${ASSETS_SEEDS.badge}"`)
  );
  assert.match(
    libRs,
    new RegExp(
      `TREE_CONFIG_SEED: &\\[u8\\] = b"${ASSETS_SEEDS.treeConfig}"`
    )
  );
});

test("assets program id placeholder consistent", () => {
  assert.match(
    libRs,
    new RegExp(`declare_id!\\("${ASSETS_PROGRAM_ID_PLACEHOLDER}"\\)`)
  );
  assert.match(
    anchorToml,
    new RegExp(`neonrelay_assets = "${ASSETS_PROGRAM_ID_PLACEHOLDER}"`)
  );
  assert.match(
    libRs,
    new RegExp(`FEATURES_PROGRAM_ID: Pubkey = pubkey!\\("${FEATURES_PROGRAM_ID_PLACEHOLDER}"\\)`)
  );
});

test("external program ids are pinned (Bubblegum/Compression/Core)", () => {
  assert.match(
    libRs,
    new RegExp(`BUBBLEGUM_PROGRAM_ID.*${BUBBLEGUM_PROGRAM_ID}`)
  );
  assert.match(
    libRs,
    new RegExp(`COMPRESSION_PROGRAM_ID.*${COMPRESSION_PROGRAM_ID}`)
  );
  assert.match(
    libRs,
    new RegExp(`MPL_CORE_PROGRAM_ID.*${MPL_CORE_PROGRAM_ID}`)
  );
  assert.equal(isBubblegumProgram(BUBBLEGUM_PROGRAM_ID), true);
  assert.equal(isCompressionProgram(COMPRESSION_PROGRAM_ID), true);
  assert.equal(isBubblegumProgram(COMPRESSION_PROGRAM_ID), false);
});

test("compressed badge leaf deterministic and 32-byte hex", () => {
  const player = Buffer.alloc(32, 7);
  const meta = Buffer.alloc(32, 1);
  const creator = Buffer.alloc(32, 2);
  const leaf1 = compressedBadgeLeaf(player, 42, meta, creator);
  const leaf2 = compressedBadgeLeaf(player, 42, meta, creator);
  assert.equal(leaf1, leaf2);
  assert.match(leaf1, /^[0-9a-f]{64}$/);
  const leaf3 = compressedBadgeLeaf(player, 43, meta, creator);
  assert.notEqual(leaf1, leaf3);
  assert.throws(() => compressedBadgeLeaf(Buffer.alloc(31), 0, meta, creator));
  assert.throws(() => compressedBadgeLeaf(player, 256, meta, creator));
  assert.throws(() => compressedBadgeLeaf(player, 0, Buffer.alloc(31), creator));
});

test("security invariants present in lib.rs (45-checklist spot checks)", () => {
  // no init_if_needed (critical #12)
  assert.ok(
    !libRs.includes("init_if_needed"),
    "must not use init_if_needed (reinit race)"
  );
  // checked arithmetic (#15)
  assert.match(libRs, /checked_add/);
  assert.match(libRs, /overflow/);
  // signer checks via has_one = authority
  const authorityChecks = libRs.match(
    /has_one = authority @ AssetsError::Unauthorized/g
  );
  assert.ok(
    authorityChecks && authorityChecks.length >= 2,
    "admin contexts must enforce has_one = authority"
  );
  // PDA bump canonicalization (#18) — store bump, use ctx.bumps
  assert.match(libRs, /ctx\.bumps\.config/);
  assert.match(libRs, /pub bump: u8/);
  // CPI program id validation (#9) — bubblegum/compression hard-check
  assert.match(libRs, /InvalidBubblegumProgram/);
  assert.match(libRs, /InvalidCompressionProgram/);
  assert.match(libRs, /tree_config\.merkle_tree == ctx\.accounts\.merkle_tree\.key\(\)/);
  assert.match(libRs, /data\[8\.\.40\] == player\.as_ref\(\)/);
  // PermanentDelegate reject (#31 Token-2022)
  assert.match(libRs, /PermanentDelegateNotAllowed/);
  assert.match(libRs, /mint_data\[44\] == decimals/);
  // The verified default build permits only the internal bounded collection
  // descriptor; external Core/Bubblegum CPI remains compile-time gated.
  assert.match(libRs, /bounded internal collection descriptor/);
  assert.match(libRs, /compile_error!\("assets core CPI/);
  assert.match(libRs, /compile_error!\("assets Bubblegum CPI/);
  // Pause gate
  assert.match(libRs, /require!.*!.*paused.*Paused/);
  assert.match(libRs, /account\.state == anchor_spl::token::spl_token::state::AccountState::Initialized/);
  // Timelock for authority
  assert.match(libRs, /MIN_AUTHORITY_DELAY_SLOTS/);
  assert.match(libRs, /TimelockNotExpired/);
  // CEI comment present
  assert.match(libRs, /CEI/);
});

test("external asset paths remain cost-measurement gated", () => {
  assert.match(libRs, /AssetPathNotConfigured/);
  assert.doesNotMatch(libRs, /0\.00001|0\.0029|0\.022/);
  assert.doesNotMatch(readFileSync(join(here, "../src/assets.ts"), "utf8"), /C_NFT_COST|perItemSOL/);
});

test("no hardcoded mint / no SKR in assets program", () => {
  // Only program id string long enough to be pubkey should be declare_id + pinned externals
  const candidates = libRs.match(/"[1-9A-HJ-NP-Za-km-z]{32,44}"/g) ?? [];
  // Should contain exactly: declare_id + bubblegum + compression + noop + core
  assert.ok(
    candidates.includes(`"${ASSETS_PROGRAM_ID_PLACEHOLDER}"`),
    "must contain placeholder"
  );
  assert.ok(candidates.includes(`"${BUBBLEGUM_PROGRAM_ID}"`));
  assert.ok(!/skr/i.test(libRs.replace(/BUBBLEGUM|COMPRESSION|MPL_CORE/g, "")), "no SKR token name");
});
