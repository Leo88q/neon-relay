#!/usr/bin/env node
/** Offline production pin gate. It does not install dependencies or contact crates.io. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname, "..");
const read = (file) => readFileSync(resolve(root, file), "utf8");
const expected = process.env.NEONRELAY_REQUIRED_ANCHOR ?? "0.31.1";
const anchor = read("onchain/Anchor.toml").match(/anchor_version\s*=\s*"([^"]+)"/)?.[1];
const lock = read("onchain/Cargo.lock");
const crates = [...read("onchain/Cargo.toml").matchAll(/anchor-(?:lang|spl)\s*=\s*"([^"]+)"/g)].map((m) => m[1]);
for (const file of ["onchain/programs/neonrelay-rewards/Cargo.toml", "onchain/programs/neonrelay-features/Cargo.toml", "onchain/programs/neonrelay-economy/Cargo.toml", "onchain/programs/neonrelay-assets/Cargo.toml"]) {
  const value = [...read(file).matchAll(/anchor-(?:lang|spl)\s*=\s*"([^"]+)"/g)].map((m) => m[1]);
  crates.push(...value);
}
const lockEntries = [...lock.matchAll(/^name = "(anchor-[^"]+)"\nversion = "([^"]+)"/gm)]
  .map((match) => ({ name: match[1], version: match[2] }));
// anchor-lang-idl* has its own independent version line; every package in the
// actual Anchor release family must remain on the required release.
const lockPins = lockEntries.filter(({ name }) =>
  name === "anchor-lang" || name === "anchor-spl" || name === "anchor-syn" ||
  name.startsWith("anchor-attribute-") || name.startsWith("anchor-derive-"));
const lockVersions = Object.fromEntries(lockPins.map(({ name, version }) => [name, version]));
if (anchor !== expected || crates.length !== 8 || crates.some((version) => version !== expected) ||
    lockPins.length === 0 || lockPins.some(({ version }) => version !== expected)) {
  throw new Error(`toolchain pin mismatch: expected Anchor ${expected}; Anchor.toml=${anchor ?? "missing"}; crates=${crates.join(",")}; lock=${JSON.stringify(lockVersions)}`);
}
console.log(JSON.stringify({ status: "toolchain-pin-consistent", anchor: expected, crates: crates.length, lock: lockVersions }, null, 2));
