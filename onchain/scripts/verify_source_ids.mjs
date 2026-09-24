#!/usr/bin/env node
/** Offline ID-drift gate. It never contacts an RPC and never handles keys. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname, "..");
const text = (file) => readFileSync(resolve(root, file), "utf8");
const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function canonical(value) {
  if (typeof value !== "string" || value.length < 32 || value.length > 44) return false;
  let n = 0n;
  for (const c of value) { const i = alphabet.indexOf(c); if (i < 0) return false; n = n * 58n + BigInt(i); }
  let bytes = n === 0n ? 0 : Math.ceil(n.toString(2).length / 8);
  bytes += [...value].findIndex((c) => c !== "1") > 0 ? [...value].findIndex((c) => c !== "1") : 0;
  return bytes === 32 && value[0] !== "0";
}
const anchor = text("onchain/Anchor.toml");
const manifestArg = process.argv.indexOf("--manifest");
const manifestPath = manifestArg >= 0 ? process.argv[manifestArg + 1] : null;
const clusterArg = process.argv.indexOf("--cluster");
const expectedCluster = clusterArg >= 0 ? process.argv[clusterArg + 1] : null;
const strictManifest = process.argv.includes("--strict-manifest");
const ids = {
  rewards: anchor.match(/^neonrelay_rewards\s*=\s*"([^"]+)"/m)?.[1],
  features: anchor.match(/^neonrelay_features\s*=\s*"([^"]+)"/m)?.[1],
  economy: anchor.match(/^neonrelay_economy\s*=\s*"([^"]+)"/m)?.[1],
  assets: anchor.match(/^neonrelay_assets\s*=\s*"([^"]+)"/m)?.[1],
};
for (const [name, id] of Object.entries(ids)) {
  if (!id || !canonical(id)) throw new Error(`${name}: Anchor.toml id is missing or non-canonical`);
  if (new Set(Object.values(ids)).size !== 4) throw new Error("program ids must be distinct");
}
const sources = {
  rewards: ["programs/neonrelay-rewards/src/lib.rs", /declare_id!\("([^"]+)"\)/],
  features: ["programs/neonrelay-features/src/lib.rs", /declare_id!\("([^"]+)"\)/],
  economy: ["programs/neonrelay-economy/src/lib.rs", /declare_id!\("([^"]+)"\)/],
  assets: ["programs/neonrelay-assets/src/lib.rs", /declare_id!\("([^"]+)"\)/],
};
for (const [name, [file, pattern]] of Object.entries(sources)) {
  const found = text(`onchain/${file}`).match(pattern)?.[1];
  if (found !== ids[name]) throw new Error(`${name}: declare_id drift (${found ?? "missing"} != ${ids[name]})`);
}
const assetsSource = text("onchain/programs/neonrelay-assets/src/lib.rs");
const featuresRegistryProgram = assetsSource.match(/FEATURES_PROGRAM_ID:\s*Pubkey\s*=\s*pubkey!\("([^"]+)"\)/)?.[1];
if (featuresRegistryProgram !== ids.features) {
  throw new Error(`assets: features registry program drift (${featuresRegistryProgram ?? "missing"} != ${ids.features})`);
}
const constants = text("onchain/src/constants.ts");
for (const [name, marker] of Object.entries({ rewards: "PROGRAM_ID_PLACEHOLDER", features: "FEATURES_PROGRAM_ID_PLACEHOLDER", economy: "ECONOMY_PROGRAM_ID_PLACEHOLDER", assets: "ASSETS_PROGRAM_ID_PLACEHOLDER" })) {
  const re = name === "rewards" ? /PROGRAM_ID_PLACEHOLDER\s*=\s*"([^"]+)"/ : new RegExp(`${marker}\\s*=\\s*"([^"]+)"`);
  const found = constants.match(re)?.[1];
  if (found !== ids[name]) throw new Error(`${name}: TypeScript constant drift`);
}
const env = text("backend/.env.example");
const envNames = { rewards: "NEONRELAY_REWARDS_PROGRAM_ID", features: "NEONRELAY_FEATURES_PROGRAM_ID", economy: "NEONRELAY_ECONOMY_PROGRAM_ID", assets: "NEONRELAY_ASSETS_PROGRAM_ID" };
for (const [name, key] of Object.entries(envNames)) {
  const found = env.match(new RegExp(`^${key}=([^\\n#]+)`, "m"))?.[1]?.trim();
  if (found !== ids[name]) throw new Error(`${key}: .env.example drift`);
}
if (strictManifest && !manifestPath) throw new Error("--strict-manifest requires --manifest");
if (manifestPath) {
  if (!readFileSync(manifestPath, "utf8")) throw new Error("manifest is unreadable");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  for (const [name, id] of Object.entries(ids)) {
    const manifestName = `neonrelay_${name}`;
    if (manifest?.programs?.[manifestName] !== id) throw new Error(`${manifestName}: deployment manifest drift`);
  }
  if (strictManifest) {
    const manifestCluster = manifest?.cluster;
    if (!["devnet", "testnet", "mainnet-beta"].includes(manifestCluster)) {
      throw new Error("manifest cluster is missing or unsupported");
    }
    if (expectedCluster && manifestCluster !== expectedCluster) {
      throw new Error(`manifest cluster drift (${manifestCluster} != ${expectedCluster})`);
    }
    const required = [
      ["genesis_hash", manifest?.genesis_hash],
      ["mints.reward", manifest?.mints?.reward],
      ["mints.skr", manifest?.mints?.skr],
      ["upgrade_authority", manifest?.upgrade_authority],
    ];
    for (const [name, value] of required) {
      const authority = name === "upgrade_authority";
      if (authority && value === "none") continue;
      if (!canonical(value)) throw new Error(`${name}: strict manifest requires a canonical base58 value`);
    }
    if (manifest.mints.reward === manifest.mints.skr) throw new Error("strict manifest requires distinct reward and payment mints");
  }
}
console.log(JSON.stringify({ status: "source-ids-consistent", program_ids: ids, strict_manifest: strictManifest }, null, 2));
