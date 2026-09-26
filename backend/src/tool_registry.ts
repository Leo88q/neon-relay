/**
 * Tool/skill description pinning (SW-2026-AGI V78, "tool poisoning / rug pull").
 *
 * The SDK contract catalog (`SDK_CONTRACTS` in watchtower.ts) is the closest
 * thing this repository has to an MCP tool registry: each entry's `purpose`
 * text is a tool description that an integrating agent may consume. A silently
 * edited description is a poisoning channel — the model follows the *new*
 * text even though the tool "looks the same" in a UI. Defense, per the threat
 * model fix: pin the SHA-256 of every canonical description at registration
 * and verify on every use; drift fails closed at boot and is visible at
 * `GET /api/os/tools/integrity`.
 *
 * Pins live in `backend/tool_pins.json` and are regenerated explicitly with
 * `npm run gen:tool-pins` (CI runs it in `--check` mode), so a description
 * change can never land without a reviewed, explicit pin update in the same
 * diff.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SDK_CONTRACTS } from "./watchtower.ts";

export const TOOL_PINS_VERSION = 1;
const TOOL_PINS_PATH = fileURLToPath(new URL("../tool_pins.json", import.meta.url));

/** Canonical JSON: recursively sorted keys, no whitespace variance. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export interface ToolDescriptor {
  id: string;
  /** Canonical description bytes that get pinned. */
  canonical: string;
  sha256: string;
}

/** The pinned registry: every SDK contract, canonically serialized. */
export function toolRegistryManifest(): ToolDescriptor[] {
  return Object.entries(SDK_CONTRACTS).map(([id, contract]) => {
    const canonical = canonicalJson({ id, ...contract });
    return { id, canonical, sha256: createHash("sha256").update(canonical).digest("hex") };
  });
}

export interface ToolPinsFile {
  pins_version: number;
  algo: "sha256";
  pins: Record<string, string>;
}

export function readToolPins(): ToolPinsFile {
  return JSON.parse(readFileSync(TOOL_PINS_PATH, "utf8")) as ToolPinsFile;
}

export interface ToolRegistryStatus {
  status: "pinned" | "drifted";
  pins_version: number;
  tool_count: number;
  drifted: { id: string; expected: string; actual: string }[];
  unpinned: string[];
}

/**
 * Verify the live registry against the pins. Pure function over both inputs
 * so tests can inject a tampered manifest without touching the filesystem.
 */
export function verifyToolRegistry(pins: ToolPinsFile, manifest = toolRegistryManifest()): ToolRegistryStatus {
  const drifted: { id: string; expected: string; actual: string }[] = [];
  const unpinned: string[] = [];
  for (const tool of manifest) {
    const expected = pins.pins[tool.id];
    if (expected === undefined) {
      unpinned.push(tool.id);
      continue;
    }
    if (expected !== tool.sha256) {
      drifted.push({ id: tool.id, expected, actual: tool.sha256 });
    }
  }
  return {
    status: drifted.length > 0 || unpinned.length > 0 ? "drifted" : "pinned",
    pins_version: pins.pins_version,
    tool_count: manifest.length,
    drifted,
    unpinned,
  };
}

/** Full public report for `/api/os/tools/integrity`. No secrets involved. */
export function toolIntegrityReport(): Record<string, unknown> {
  const pins = readToolPins();
  const verdict = verifyToolRegistry(pins);
  return {
    game_id: "neonrelay",
    policy: "SW-2026-AGI V78: tool descriptions are pinned at registration and verified at boot and on every read",
    pins_version: pins.pins_version,
    status: verdict.status,
    tool_count: verdict.tool_count,
    drifted: verdict.drifted,
    unpinned: verdict.unpinned,
    hashes: Object.fromEntries(toolRegistryManifest().map((tool) => [tool.id, tool.sha256])),
    writes: false,
  };
}

/**
 * Boot gate: refuse to serve with a drifted registry. A pin update must be
 * an explicit, reviewed change (`npm run gen:tool-pins`), never a side effect.
 */
export function assertToolRegistryPinned(): void {
  const verdict = verifyToolRegistry(readToolPins());
  if (verdict.status !== "pinned") {
    throw new Error(
      "tool description pins drifted (SW-2026-AGI V78); regenerate with `npm run gen:tool-pins` and review the diff — "
      + JSON.stringify({ drifted: verdict.drifted, unpinned: verdict.unpinned }));
  }
}
