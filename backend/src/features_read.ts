/**
 * Read-only reader for the neonrelay-features achievement registry (stage 11).
 *
 * The only place in the backend that decodes the registry PDA. Strictly
 * read-only and fail-closed: any layout drift throws FeaturesReadError instead
 * of guessing. It exists for GET /v1/rewards/verified — the single
 * server-confirmed source for the client's "verified results" showcase
 * (docs/UI_POTATO_ARENA_REDESIGN_RU.md §7.7). Achievement metadata (name/art)
 * stays off-chain, so this view carries ids only.
 */
import { createHash } from "node:crypto";
import { base58Decode, base58Encode, findProgramAddress } from "./economy.ts";

/** Mirrors ACHIEVEMENTS_SEED in onchain/programs/neonrelay-features/src/lib.rs. */
export const FEATURES_ACHIEVEMENTS_SEED = Buffer.from("neonrelay_achievements", "utf8");

/**
 * Account size, byte-identical to `AchievementRegistry::LEN` in
 * onchain/programs/neonrelay-features/src/lib.rs:
 * 8 (discriminator) + 32 (player) + 32 (config_authority, SW-2026-09-26 F-04)
 * + 4*8 (bits [u64; 4]) + 4 (count u32) + 1 (bump u8) = 109.
 * verified.test.ts pins this constant against the Rust source, so a layout
 * change on either side fails the suite instead of silently degrading the
 * achievements showcase.
 */
export const ACHIEVEMENT_REGISTRY_LEN = 109;
export const ACHIEVEMENT_BITS = 256;

/** Field offsets, absolute positions inside the account data. */
export const ACHIEVEMENT_REGISTRY_OFFSETS = {
  player: 8,
  configAuthority: 40,
  bits: 72,
  count: 104,
  bump: 108,
} as const;

export interface AchievementRegistryView {
  address: string;
  bump: number;
  count: number;
  /** Set achievement ids, ascending. */
  ids: number[];
  /**
   * Features `config.authority` the registry was last vouched for
   * (SW-2026-09-26 F-04), base58. `neonrelay-assets` refuses to mint badges
   * against registries stamped by a different operator, so surfacing the
   * stamp lets the showcase report which operator the on-chain bits came from.
   */
  configAuthority: string;
}

export class FeaturesReadError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

type RpcCaller = (method: string, params: unknown[]) => Promise<unknown>;

function popcount(word: bigint): number {
  let n = 0;
  let w = word;
  while (w > 0n) {
    n += Number(w & 1n);
    w >>= 1n;
  }
  return n;
}

/**
 * Decode the player's AchievementRegistry. Returns null when the account does
 * not exist (the normal state before the first recorded achievement);
 * throws FeaturesReadError on anything malformed (fail-closed, like the
 * production gate in routes.ts).
 */
export async function readAchievementRegistry(
  rpc: RpcCaller,
  programIdBase58: string,
  walletPublicKeyBase64Url: string,
): Promise<AchievementRegistryView | null> {
  const player = Buffer.from(walletPublicKeyBase64Url, "base64url");
  if (player.length !== 32 || player.toString("base64url") !== walletPublicKeyBase64Url) {
    throw new FeaturesReadError("wallet-public-key-invalid",
      "wallet public key must be exactly 32 base64url bytes");
  }
  let program: Buffer;
  try {
    program = base58Decode(programIdBase58);
  } catch {
    throw new FeaturesReadError("program-id-invalid", "features program id is not base58");
  }
  if (program.length !== 32 || base58Encode(program) !== programIdBase58) {
    throw new FeaturesReadError("program-id-invalid", "features program id is not canonical base58");
  }
  const pda = findProgramAddress([FEATURES_ACHIEVEMENTS_SEED, player], program);
  const address = base58Encode(pda.address);

  const reply = await rpc("getAccountInfo",
    [address, { encoding: "base64", commitment: "finalized" }]) as
    { value?: { owner?: unknown; executable?: unknown; data?: unknown } | null };
  const account = reply?.value;
  if (account === null || account === undefined) return null; // registry not created yet
  if (account.owner !== programIdBase58 || account.executable !== false
      || !Array.isArray(account.data) || account.data[1] !== "base64"
      || typeof account.data[0] !== "string") {
    throw new FeaturesReadError("registry-account-invalid", "registry account shape mismatch");
  }
  const encoded = account.data[0];
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded) {
    throw new FeaturesReadError("registry-data-noncanonical", "noncanonical base64 payload");
  }
  if (bytes.length !== ACHIEVEMENT_REGISTRY_LEN) {
    throw new FeaturesReadError("registry-layout-invalid",
      `registry must be ${ACHIEVEMENT_REGISTRY_LEN} bytes, got ${bytes.length}`);
  }
  const discriminator = createHash("sha256").update("account:AchievementRegistry", "utf8")
    .digest().subarray(0, 8);
  if (!bytes.subarray(0, 8).equals(discriminator)) {
    throw new FeaturesReadError("registry-discriminator-invalid", "registry discriminator mismatch");
  }
  if (!bytes.subarray(8, 40).equals(player)) {
    throw new FeaturesReadError("registry-player-mismatch", "registry belongs to another wallet");
  }
  // SW-2026-09-26 F-04: the registry carries the features operator it was
  // last vouched for; the assets program refuses every other stamp.
  const configAuthority = base58Encode(bytes.subarray(
    ACHIEVEMENT_REGISTRY_OFFSETS.configAuthority,
    ACHIEVEMENT_REGISTRY_OFFSETS.configAuthority + 32));
  const count = bytes.readUInt32LE(ACHIEVEMENT_REGISTRY_OFFSETS.count);
  const ids: number[] = [];
  for (let word = 0; word < 4; word += 1) {
    const bits = bytes.readBigUInt64LE(ACHIEVEMENT_REGISTRY_OFFSETS.bits + word * 8);
    for (let bit = 0; bit < 64; bit += 1) {
      if ((bits >> BigInt(bit)) & 1n) ids.push(word * 64 + bit);
    }
  }
  if (ids.length > ACHIEVEMENT_BITS || ids.length !== count) {
    throw new FeaturesReadError("registry-count-mismatch",
      `bitmap holds ${ids.length} ids but count says ${count}`);
  }
  if (bytes[ACHIEVEMENT_REGISTRY_OFFSETS.bump] !== pda.bump) {
    throw new FeaturesReadError("registry-bump-mismatch", "registry bump does not match the PDA");
  }
  return { address, bump: pda.bump, count, ids, configAuthority };
}
