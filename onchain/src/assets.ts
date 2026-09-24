/**
 * Client-side mirrors for neonrelay-assets (source-gated asset paths).
 * Zero deps — Node 22 only. Mirrors lib.rs seeds / program ids / leaf hash.
 * External CPI and cost parameters are intentionally not treated as verified.
 */
import { createHash } from "node:crypto";

export const ASSETS_PROGRAM_ID_PLACEHOLDER =
  "F5VhZxGGEY61TNNexRwJVomMZtHeAZodqVHPMqoxq3oc";

export const ASSETS_SEEDS = {
  config: "neonrelay_assets_config",
  collection: "neonrelay_collection",
  badge: "neonrelay_badge_asset",
  treeConfig: "neonrelay_tree_config",
  mintConfig: "neonrelay_mint_config",
} as const;

export const BUBBLEGUM_PROGRAM_ID =
  "BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY";
export const COMPRESSION_PROGRAM_ID =
  "cmtDvXumGCrqC1Age74AVPhSRVXJMd8PJS91L8KbNCK";
export const NOOP_PROGRAM_ID =
  "noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV";
export const MPL_CORE_PROGRAM_ID =
  "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d";

/**
 * Compressed badge leaf (simplified LeafSchemaV2 hash).
 * lib.rs: SHA256(player || badge_id BE || metadata_hash || creator_hash)
 */
export function compressedBadgeLeaf(
  playerRaw: Buffer,
  badgeId: number,
  metadataHash: Buffer,
  creatorHash: Buffer
): string {
  if (playerRaw.length !== 32) throw new Error("player must be 32 bytes");
  if (!Number.isInteger(badgeId) || badgeId < 0 || badgeId > 255)
    throw new Error("badgeId 0..255");
  if (metadataHash.length !== 32 || creatorHash.length !== 32)
    throw new Error("hashes must be 32 bytes");
  const idBuf = Buffer.alloc(4);
  idBuf.writeUInt32BE(badgeId, 0);
  return createHash("sha256")
    .update(playerRaw)
    .update(idBuf)
    .update(metadataHash)
    .update(creatorHash)
    .digest("hex");
}

/** Verify bubblegum/compression program ids are pinned correctly. */
export function isBubblegumProgram(id: string): boolean {
  return id === BUBBLEGUM_PROGRAM_ID;
}
export function isCompressionProgram(id: string): boolean {
  return id === COMPRESSION_PROGRAM_ID;
}
