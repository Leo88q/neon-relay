/**
 * Generate or verify `backend/tool_pins.json` (SW-2026-AGI V78).
 *
 *   node --experimental-strip-types scripts/gen_tool_pins.ts           # write
 *   node --experimental-strip-types scripts/gen_tool_pins.ts --check   # CI gate
 *
 * `--check` exits non-zero when the live tool descriptions no longer match the
 * pins — the same drift that makes the backend refuse to boot. Update pins
 * only in the reviewed PR that changes the descriptions.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { toolRegistryManifest, readToolPins, verifyToolRegistry, TOOL_PINS_VERSION } from "../src/tool_registry.ts";

const checkOnly = process.argv.includes("--check");
const manifest = toolRegistryManifest();

if (checkOnly) {
  const pins = readToolPins();
  const verdict = verifyToolRegistry(pins, manifest);
  if (verdict.status !== "pinned") {
    console.error(`tool pins DRIFTED: ${JSON.stringify({ drifted: verdict.drifted, unpinned: verdict.unpinned })}`);
    console.error("regenerate with `npm run gen:tool-pins` and review the diff in the same PR");
    process.exit(1);
  }
  console.log(`tool pins verified: ${verdict.tool_count} tools, pins_version=${pins.pins_version}`);
  process.exit(0);
}

let existingVersion: number | null = null;
try {
  existingVersion = readToolPins().pins_version;
} catch {
  existingVersion = null; // first generation — file does not exist yet
}
if (existingVersion !== null && existingVersion !== TOOL_PINS_VERSION) {
  console.error(`refusing to overwrite pins from a different version (expected ${TOOL_PINS_VERSION})`);
  process.exit(1);
}
const pins = {
  pins_version: TOOL_PINS_VERSION,
  algo: "sha256",
  pins: Object.fromEntries(manifest.map((tool) => [tool.id, tool.sha256])),
};
writeFileSync(new URL("../tool_pins.json", import.meta.url), `${JSON.stringify(pins, null, 2)}\n`);
console.log(`tool pins written: ${manifest.length} tools, pins_version=${TOOL_PINS_VERSION}`);
