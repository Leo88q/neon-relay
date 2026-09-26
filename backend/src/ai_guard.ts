/**
 * Agentic-AI content guard (SW-2026-AGI).
 *
 * Threat model: every external string that enters persisted agent-readable
 * state (the Watchtower telemetry store) is untrusted input for any LLM that
 * later reads it through `/watchtower/*` exporter routes. Indirect prompt
 * injection hides instructions in invisible Unicode (zero-width characters,
 * bidirectional overrides, tag characters) so the *displayed* text looks
 * harmless while the *consumed* text carries commands (Bankrbot/Grok class,
 * CurXecute CVE-2025-54135, Kilo Code CVE-2025-11445).
 *
 * Policy, fail-closed by construction:
 *  1. Every telemetry string is sanitized BEFORE length validation, digesting
 *     and storage — invisible/directional formatting characters cannot enter
 *     the store, and two payloads differing only in invisible characters
 *     collapse to the same idempotency digest (they cannot be used to mint
 *     fresh "unique" poisoned memories).
 *  2. JSON metadata is depth-bounded in addition to size-bounded so a hostile
 *     producer cannot ship a parser-stressing nesting bomb to exporter
 *     consumers (hub-side AI included).
 *  3. Known instruction-shaped phrases are detected and reported so an
 *     operator can review who attempted injection; detection never mutates
 *     policy by itself (a comment is data, a ban is a human decision).
 *
 * This module is intentionally dependency-free and mirrors
 * `scripts/check_ai_injection.py`, which applies the same character policy to
 * the repository itself (threat 76: poisoned README/comments fed to the
 * Watchtower audit assistant).
 */

/** Bumped whenever the character policy changes stored bytes. */
export const AI_GUARD_VERSION = "neonrelay-ai-guard-v1";

/**
 * Invisible, directional or otherwise "formatting-only" codepoints that have
 * no legitimate business in telemetry identifiers or metadata. Each entry is
 * removed before validation and storage. Persian ZWNJ and emoji variation
 * selectors are legitimate in *UI copy*, which never flows through this path —
 * telemetry fields are identifiers, ids, modes and machine metadata only.
 */
export const INJECTION_CODEPOINTS: ReadonlyMap<number, string> = new Map([
  [0x00ad, "SOFT-HYPHEN"],
  [0x061c, "ARABIC-LETTER-MARK"],
  [0x115f, "HANGUL-CHOSEONG-FILLER"],
  [0x1160, "HANGUL-JUNGSEONG-FILLER"],
  [0x17b4, "KHMER-VOWEL-INHERENT-AQ"],
  [0x17b5, "KHMER-VOWEL-INHERENT-AA"],
  [0x180b, "MONGOLIAN-FREE-VARIATION-SELECTOR-ONE"],
  [0x180c, "MONGOLIAN-FREE-VARIATION-SELECTOR-TWO"],
  [0x180d, "MONGOLIAN-FREE-VARIATION-SELECTOR-THREE"],
  [0x180e, "MONGOLIAN-VOWEL-SEPARATOR"],
  [0x180f, "MONGOLIAN-FREE-VARIATION-SELECTOR-FOUR"],
  [0x200b, "ZERO-WIDTH-SPACE"],
  [0x200c, "ZERO-WIDTH-NON-JOINER"],
  [0x200d, "ZERO-WIDTH-JOINER"],
  [0x202a, "LEFT-TO-RIGHT-EMBEDDING"],
  [0x202b, "RIGHT-TO-LEFT-EMBEDDING"],
  [0x202c, "POP-DIRECTIONAL-FORMATTING"],
  [0x202d, "LEFT-TO-RIGHT-OVERRIDE"],
  [0x202e, "RIGHT-TO-LEFT-OVERRIDE"],
  [0x2060, "WORD-JOINER"],
  [0x2061, "FUNCTION-APPLICATION"],
  [0x2062, "INVISIBLE-TIMES"],
  [0x2063, "INVISIBLE-SEPARATOR"],
  [0x2064, "INVISIBLE-PLUS"],
  [0x2066, "LEFT-TO-RIGHT-ISOLATE"],
  [0x2067, "RIGHT-TO-LEFT-ISOLATE"],
  [0x2068, "FIRST-STRONG-ISOLATE"],
  [0x2069, "POP-DIRECTIONAL-ISOLATE"],
  [0x2800, "BRAILLE-PATTERN-BLANK"],
  [0x3164, "HANGUL-FILLER"],
  [0xfeff, "ZERO-WIDTH-NO-BREAK-SPACE"],
  [0xffa0, "HALFWIDTH-HANGUL-FILLER"],
  [0xe0001, "LANGUAGE-TAG"],
]);

const CODEPOINT_LIMITS: readonly (readonly [number, number, string])[] = [
  [0xe0000, 0xe007f, "TAG-CHARACTER"], // ASCII-encoding tag block
  [0xfe00, 0xfe0f, "VARIATION-SELECTOR"],
];

export interface SanitizeResult {
  text: string;
  /** Number of removed characters, by class name. */
  removed: Record<string, number>;
  /** Total removed characters. */
  stripped: number;
}

function classify(cp: number): string | null {
  const named = INJECTION_CODEPOINTS.get(cp);
  if (named) return named;
  for (const [lo, hi, name] of CODEPOINT_LIMITS) {
    if (cp >= lo && cp <= hi) return name;
  }
  // C0/C1 controls except tab/line feed/carriage return: no telemetry field
  // has a legitimate reason to carry them, and terminal escapes (ESC) are a
  // classic log-viewer injection vector for human reviewers.
  if (cp < 0x20 && cp !== 0x09 && cp !== 0x0a && cp !== 0x0d) return "C0-CONTROL";
  if (cp >= 0x7f && cp < 0xa0) return "C1-CONTROL";
  return null;
}

/** Remove invisible/directional/control characters and report what was cut. */
export function stripInvisibleUnicode(input: string): SanitizeResult {
  const removed: Record<string, number> = {};
  let stripped = 0;
  let out = "";
  for (const ch of input) {
    const cls = classify(ch.codePointAt(0)!);
    if (cls === null) {
      out += ch;
    } else {
      removed[cls] = (removed[cls] ?? 0) + 1;
      stripped += 1;
    }
  }
  return { text: out, removed, stripped };
}

/** True when the string contains any character the guard would remove. */
export function containsInjectionVectors(input: string): boolean {
  for (const ch of input) {
    if (classify(ch.codePointAt(0)!) !== null) return true;
  }
  return false;
}

/**
 * Instruction-shaped phrases that Watchtower flags in stored metadata. These
 * are *signals for human review*, never automatic bans: games legitimately
 * ship quests whose text may quote game lore. Matching phrases are recorded
 * (via ingest return value) and surfaced by `/watchtower/security`.
 */
export const INSTRUCTION_PATTERNS: readonly { name: string; pattern: RegExp }[] = [
  { name: "override-instructions", pattern: /ignore\s+(all\s+)?(previous|prior|above|earlier)\s+instructions/i },
  { name: "suppress-findings", pattern: /(do\s+not|don't|never)\s+(report|mention|flag|disclose|reveal)/i },
  { name: "audit-scope-override", pattern: /(out\s+of\s+scope|exempt)\s+(of|from)\s+(the\s+)?(audit|review|scan)/i },
  { name: "disregard-policy", pattern: /disregard\s+(your|the|all|previous)\s+(instructions|rules|policy)/i },
  { name: "role-hijack", pattern: /you\s+are\s+now\s+(an?\s+)?(admin|operator|developer|auditor|signer)/i },
  { name: "credential-exfil", pattern: /(send|post|forward|exfiltrate|upload)\s+(the\s+)?(seed|private\s+key|mnemonic|token|credential)/i },
];

export interface InjectionMatch {
  name: string;
  excerpt: string;
}

/** Detect instruction-shaped phrases in already-sanitized text. */
export function scanInjectionInstructions(text: string): InjectionMatch[] {
  const matches: InjectionMatch[] = [];
  for (const { name, pattern } of INSTRUCTION_PATTERNS) {
    const hit = pattern.exec(text);
    if (hit) {
      matches.push({
        name,
        excerpt: text.slice(Math.max(0, hit.index - 24), hit.index + hit[0].length + 24),
      });
    }
  }
  return matches;
}

const MAX_JSON_DEPTH = 8;

export class TextTooLargeError extends Error {}
export class JsonTooComplexError extends Error {}

/**
 * Sanitize a bounded telemetry text field. Same error semantics as the
 * previous plain `text()` helper (throws on non-string / oversize), but the
 * stored value can no longer carry invisible instructions.
 */
export function sanitizeTelemetryText(value: unknown, field: string, max: number,
  optional = true): string | null {
  if (value === undefined || value === null || value === "") {
    if (optional) return null;
    throw new Error(`${field} is required`);
  }
  if (typeof value !== "string") throw new Error(`${field} is invalid`);
  // Length is checked on the raw input first so an attacker cannot smuggle a
  // 10x expansion past validation, then on the sanitized output so removal
  // can only shrink, never grow, the accepted payload.
  if (value.length > max) throw new TextTooLargeError(`${field} is invalid`);
  const { text } = stripInvisibleUnicode(value);
  if (text.length > max) throw new TextTooLargeError(`${field} is invalid`);
  return text;
}

/**
 * Sanitize a bounded JSON cell: strings are stripped recursively and the
 * nesting depth is capped. Returns the canonical JSON encoding (or null).
 */
export function sanitizeTelemetryJsonValue(value: unknown, field: string, max: number,
  depth = 0): unknown {
  if (value === undefined || value === null) return null;
  if (depth > MAX_JSON_DEPTH) throw new JsonTooComplexError(`${field} is too deeply nested`);
  if (typeof value === "string") {
    if (value.length > max) throw new TextTooLargeError(`${field} is too large`);
    return stripInvisibleUnicode(value).text;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    const items = value.slice(0, 256).map((item) =>
      sanitizeTelemetryJsonValue(item, field, max, depth + 1));
    return items;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).slice(0, 256);
    const out: Record<string, unknown> = {};
    for (const [key, item] of entries) {
      const safeKey = stripInvisibleUnicode(key).text;
      out[safeKey] = sanitizeTelemetryJsonValue(item, field, max, depth + 1);
    }
    return out;
  }
  throw new Error(`${field} is not JSON serializable`);
}
