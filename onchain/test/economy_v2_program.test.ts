/** Source/ABI contract checks, NOT execution of Rust or Solana accounts. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { V2_SEEDS } from "../../backend/src/economy_v2_codec.ts";

const source = readFileSync(new URL("../programs/neonrelay-economy/src/lib.rs", import.meta.url), "utf8");
function instruction(name: string): string {
  const start = source.indexOf(`pub fn ${name}(`);
  assert.ok(start >= 0, name);
  const end = source.indexOf("\n\tpub fn ", start + 1);
  return source.slice(start, end < 0 ? source.indexOf("// -------------------------------------------------------------------- accounts", start) : end);
}
function accounts(name: string): string {
  const start = source.indexOf(`pub struct ${name}<'info>`);
  assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf("\n}", start) + 2);
}

test("v2 Rust seed namespaces match backend without changing v1", () => {
  for (const [name, seed] of Object.entries(V2_SEEDS)) {
    const rustName = name === "entry" ? "ENTRY" : name.toUpperCase();
    assert.ok(source.includes(`const ${rustName}_V2_SEED: &[u8] = b"${seed}";`));
  }
  assert.ok(source.includes('const CONFIG_SEED: &[u8] = b"neonrelay_economy_config";'));
  assert.ok(source.includes('hashv(&[wallet, &amount.to_be_bytes()]).to_bytes()'));
  assert.ok(source.includes('hashv(&[wallet, &amount.to_be_bytes(), mint]).to_bytes()'));
});

test("v2 initialization is operator-gated and token accounts are mint/owner constrained", () => {
  assert.match(accounts("InitializeV2"), /authority\.key\(\) == legacy_config\.authority/);
  assert.match(accounts("InitializeV2"), /seeds = \[CONFIG_SEED\]/);
  assert.match(accounts("InitializeV2"), /associated_token::authority = config/);
  assert.match(accounts("InitializeV2"), /treasury_ata\.owner == authority\.key\(\)/);
  for (const name of ["PayEntryV2", "ClaimPrizeV2"]) {
    assert.match(accounts(name), /player_ata\.mint == config\.mint/);
    assert.match(accounts(name), /player_ata\.owner == player\.key\(\)/);
    assert.match(accounts(name), /vault_ata\.mint == config\.mint/);
    assert.match(accounts(name), /vault_ata\.owner == config\.key\(\)/);
    assert.match(accounts(name), /address = config\.vault_ata/);
  }
});

test("v2 pause, one-way publication and per-mint anti-replay guards remain present", () => {
  for (const name of ["pay_entry_v2", "publish_prizes_v2", "claim_prize_v2"]) {
    assert.match(instruction(name), /require!\(!config\.paused, EconomyError::Paused\)/);
  }
  assert.doesNotMatch(source, /init_if_needed/);
  assert.match(accounts("PayEntryV2"), /init, payer = player/);
  assert.match(accounts("PayEntryV2"), /ENTRY_V2_SEED, config\.mint\.as_ref\(\), reference\.as_ref\(\), player\.key\(\)\.as_ref\(\)/);
  assert.match(accounts("PublishPrizesV2"), /init, payer = authority/);
  assert.match(accounts("PublishPrizesV2"), /has_one = authority/);
  assert.match(accounts("ClaimPrizeV2"), /init, payer = player/);
  assert.match(accounts("ClaimPrizeV2"), /CLAIM_V2_SEED, config\.mint\.as_ref\(\), epoch\.to_le_bytes\(\)\.as_ref\(\), player\.key\(\)\.as_ref\(\)/);
});

test("v2 reserves aggregate funds and constrains claim index, depth and remaining total", () => {
  assert.match(instruction("publish_prizes_v2"), /reserve_prizes_v2\(ctx\.accounts\.vault_ata\.amount, config\.reserved, total\)/);
  const claim = instruction("claim_prize_v2");
  assert.match(claim, /leaf_index < prizes\.leaf_count/);
  assert.match(claim, /proof\.len\(\) == depth/);
  assert.match(claim, /prizes\.remaining\.checked_sub\(amount\)/);
  assert.match(claim, /config\.reserved\.checked_sub\(amount\)/);
  assert.match(claim, /CONFIG_V2_SEED, config\.mint\.as_ref\(\)/);
  assert.match(instruction("pay_entry_v2"), /config\.fees\.get\(usize::from\(tier\)\)/);
});
