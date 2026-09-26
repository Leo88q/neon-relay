/**
 * A small, dependency-free reader + evaluator for the Anchor account
 * constraints declared in `onchain/programs/<name>/src/lib.rs`.
 *
 * WHY THIS EXISTS
 * ---------------
 * The other suites in `onchain/test/*` check the Rust source with regular
 * expressions: they prove a string is present, not that the constraint
 * *rejects an attack*. Real execution needs cargo + solana-program-test
 * (`programs/neonrelay-economy/tests/v2_runtime.rs`), which is a separate CI
 * job. This module closes the gap in plain Node: it parses the
 * `#[derive(Accounts)]` structs into a machine-readable constraint list and
 * evaluates them the way the Anchor runtime does — PDA re-derivation, signer
 * and mutability checks, `has_one`, `address`, `token::mint/authority`,
 * `init`/`payer`/`space`, `close` — against an attacker-controlled "world".
 * An attack scenario is then a plain object: the accounts a thief would pass
 * and the constraint the instruction must die on.
 *
 * WHAT IT IS NOT
 * --------------
 * It is a model, not the program. It evaluates the *declared* constraints plus
 * the pure helpers that are re-implemented here (differentially fuzzed against
 * the Rust bodies in `security_checklist.test.ts`). Anything the model accepts
 * still has to be confirmed by the program-test suite before release; the
 * model's job is to make every declared guard executable so that deleting a
 * `seeds = [...]` or a `has_one = authority` turns a test red immediately.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { findProgramAddress, isOnCurveEncoded, base58Decode } from "../../../backend/src/economy.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
export const PROGRAMS_DIR = resolve(HERE, "..", "..", "programs");

export function programSource(name: string): string {
  return readFileSync(resolve(PROGRAMS_DIR, name, "src", "lib.rs"), "utf8");
}

export const PROGRAM_IDS: Record<string, string> = {
  "neonrelay-economy": "FZcLDdUrs6i1HYFFK2NhqNrbVaP6KTvrqzhyoDGT6CV9",
  "neonrelay-rewards": "2RaaXKUutemHtSZUsmnEv41ytWMkaXD6rcoziHGLRtmj",
  "neonrelay-features": "4PH1dHVBRbfoydBx3SuRjAS46zRRjHvRxWCNcrFBDqYP",
  "neonrelay-assets": "F5VhZxGGEY61TNNexRwJVomMZtHeAZodqVHPMqoxq3oc",
};

/**
 * Solana System Program id, base58. 32 all-zero bytes encode as 32 `1`s — the
 * same literal `backend/src/routes.ts` puts in the instruction it builds, so the
 * two sides of the stack must agree on it byte for byte.
 */
export const SYSTEM = "11111111111111111111111111111111";
export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
export const BPF_UPGRADEABLE = "BPFLoaderUpgradeab1e11111111111111111111111";

// --------------------------------------------------------------------- parsing

export interface AccountField {
  name: string;
  ty: string;
  /** Raw attribute text, whitespace-collapsed. */
  raw: string;
  constrained: boolean;
  mut: boolean;
  signer: boolean;
  init: boolean;
  initIfNeeded: boolean;
  payer?: string;
  space?: string;
  close?: string;
  hasOne: string[];
  address?: string;
  seeds?: string;
  bump?: string;
  tokenMint?: string;
  tokenAuthority?: string;
  associatedTokenMint?: string;
  associatedTokenAuthority?: string;
  constraints: string[];
  unchecked: boolean;
  program: boolean;
}

export interface AccountsStruct {
  name: string;
  instructionArgs: string[];
  fields: AccountField[];
}

/**
 * Split on commas that are not nested inside `[]`, `()`, `{}`, `<>`, a string
 * literal or a char literal. A bare `'` starts a lifetime (`<'info>`), not a
 * char literal, so it never affects the depth — that distinction is what makes
 * Rust attribute text splittable at all.
 */
export function splitTopLevel(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i] as string;
    if (ch === '"') {
      const end = scanString(text, i);
      current += text.slice(i, end);
      i = end;
      continue;
    }
    if (ch === "'") {
      const charLiteral = /^'(\\.|[^'\\])'/.exec(text.slice(i));
      if (charLiteral) { current += charLiteral[0]; i += charLiteral[0].length; continue; }
      current += ch;
      i++;
      continue;
    }
    if (ch === ",") {
      if (depth === 0) { out.push(current.trim()); current = ""; i++; continue; }
      current += ch;
      i++;
      continue;
    }
    if ("[({<".includes(ch)) depth++;
    else if ("])}>".includes(ch)) depth = Math.max(0, depth - 1);
    current += ch;
    i++;
  }
  if (current.trim() !== "") out.push(current.trim());
  return out;
}

/** True when every `[{(<` in the text is closed again. */
function balanced(text: string): boolean {
  let depth = 0;
  let i = 0;
  while (i < text.length) {
    const ch = text[i] as string;
    if (ch === '"') { i = scanString(text, i); continue; }
    if (ch === "'") {
      const charLiteral = /^'(\\.|[^'\\])'/.exec(text.slice(i));
      if (charLiteral) { i += charLiteral[0].length; continue; }
      i++;
      continue;
    }
    if ("[({<".includes(ch)) depth++;
    else if ("])}>".includes(ch)) depth--;
    i++;
  }
  return depth === 0;
}

/** Index of the first `=` that is not nested, or -1. */
function topLevelEquals(text: string): number {
  let depth = 0;
  let i = 0;
  while (i < text.length) {
    const ch = text[i] as string;
    if (ch === '"') { i = scanString(text, i); continue; }
    if (ch === "'") {
      const charLiteral = /^'(\\.|[^'\\])'/.exec(text.slice(i));
      if (charLiteral) { i += charLiteral[0].length; continue; }
      i++;
      continue;
    }
    if ("[({<".includes(ch)) depth++;
    else if ("])}>".includes(ch)) depth = Math.max(0, depth - 1);
    else if (ch === "=" && depth === 0 && text[i + 1] !== "=" && (i === 0 || text[i - 1] !== "=" && text[i - 1] !== "!" )) return i;
    i++;
  }
  return -1;
}

/** Index just past the double-quoted string that starts at `from`. */
function scanString(text: string, from: number): number {
  let i = from + 1;
  while (i < text.length) {
    if (text[i] === "\\") { i += 2; continue; }
    if (text[i] === '"') return i + 1;
    i++;
  }
  return text.length;
}

/**
 * Body of the first balanced `[...]` following `marker`. When the marker
 * already ends with `[` (e.g. `#[account(`) the bracket to balance is the one
 * that *opens* the marker, not a later one.
 */
function bracketedBody(source: string, marker: string, from: number): { body: string; end: number } | null {
  const start = source.indexOf(marker, from);
  if (start < 0) return null;
  // Every marker used here starts with `#[`, so the bracket to balance is the
  // one right after the `#`.
  const open = marker.startsWith("#[")
    ? start + 1
    : source.indexOf("[", start + marker.length);
  if (open < 0 || source[open] !== "[") return null;
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < source.length; i++) {
    const ch = source[i] as string;
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === '"') { quote = ch; continue; }
    if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) return { body: source.slice(open + 1, i), end: i + 1 };
    }
  }
  return null;
}

function parseFieldAttrs(raw: string): Partial<AccountField> {
  const flat = raw.replace(/\s+/g, " ").trim();
  const field: Partial<AccountField> = {
    mut: false, signer: false, init: false, initIfNeeded: false, hasOne: [],
    constraints: [], unchecked: false, program: false,
  };
  let cursor = 0;
  for (;;) {
    const found = bracketedBody(flat, "#[account", cursor);
    if (!found) break;
    // The body is `account(...)`: drop the `account` head and its parens.
    const inner = found.body.replace(/^\s*account\s*\(/, "").replace(/\)\s*$/, "");
    for (const part of splitTopLevel(inner)) {
      // `bump = config.bump` and `seeds = [A, b.key().as_ref()]` both contain
      // nested text, so split on the first top-level `=` only.
      const eq = topLevelEquals(part);
      const key = (eq < 0 ? part : part.slice(0, eq)).trim();
      const value = eq < 0 ? "" : part.slice(eq + 1).trim();
      switch (key) {
        case "mut": field.mut = true; break;
        case "signer": field.signer = true; break;
        case "init": field.init = true; break;
        case "init_if_needed": field.initIfNeeded = true; break;
        case "payer": field.payer = value; break;
        case "space": field.space = value; break;
        case "close": field.close = value; break;
        case "has_one": field.hasOne = [...(field.hasOne ?? []), value.split("@")[0].trim()]; break;
        case "address": field.address = value.split("@")[0].trim(); break;
        case "seeds": field.seeds = value; break;
        case "bump": field.bump = value === "" ? "canonical" : value; break;
        case "constraint": field.constraints = [...(field.constraints ?? []), value.split(" @ ")[0].trim()]; break;
        case "token::mint": field.tokenMint = value; break;
        case "token::authority": field.tokenAuthority = value; break;
        case "associated_token::mint": field.associatedTokenMint = value; break;
        case "associated_token::authority": field.associatedTokenAuthority = value; break;
        default: break;
      }
    }
    cursor = found.end;
  }
  return field;
}

/** Body of the first brace-balanced `{...}` block at/after `from`. */
function blockBody(source: string, from: number): { body: string; start: number; end: number } {
  const open = source.indexOf("{", from);
  if (open < 0) throw new Error("no block found");
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const ch = source[i] as string;
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) return { body: source.slice(open + 1, i), start: open, end: i }; }
  }
  throw new Error("unbalanced block");
}

/**
 * Split a struct body into raw field declarations. Handles multi-line
 * `#[account(...)]` attributes, nested brackets, `///` doc comments and string
 * literals, which a line-based scan gets wrong.
 */
function splitFields(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  let i = 0;
  while (i < body.length) {
    const ch = body[i] as string;
    if (ch === "/" && body[i + 1] === "/") {
      const nl = body.indexOf("\n", i);
      i = nl < 0 ? body.length : nl + 1;
      current += " ";
      continue;
    }
    if (ch === '"') {
      current += ch;
      i++;
      while (i < body.length) {
        current += body[i];
        if (body[i] === "\\") { current += body[i + 1]; i += 2; continue; }
        if (body[i] === '"') { i++; break; }
        i++;
      }
      continue;
    }
    if (ch === "'") {
      // A lifetime (`<'info>`) is not a char literal; only `'x'`/`'\''` are.
      const charLiteral = /^'(\\.|[^'\\])'/.exec(body.slice(i));
      if (!charLiteral) { current += ch; i++; continue; }
      current += charLiteral[0];
      i += charLiteral[0].length;
      continue;
    }
    if ("[({<".includes(ch)) depth++;
    if ("])}>".includes(ch)) depth = Math.max(0, depth - 1);
    current += ch;
    i++;
    if (ch === "," && depth === 0) {
      out.push(current);
      current = "";
    }
  }
  if (current.trim() !== "") out.push(current);
  return out;
}

export function parseAccountsStructs(source: string): AccountsStruct[] {
  const structs: AccountsStruct[] = [];
  const re = /pub struct (\w+)<'info>\s*\{/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    const name = match[1] as string;
    const body = blockBody(source, match.index).body;
    const before = source.slice(Math.max(0, match.index - 400), match.index);
    const instrMatch = /#\[instruction\(([^)]*)\)\]\s*(?:#\[[^\]]*\]\s*)*$/.exec(before);
    const instructionArgs = instrMatch
      ? splitTopLevel(instrMatch[1] as string).map((arg) => arg.split(":")[0].trim())
      : [];

    // `#[account(mut, ...)] pub config: Account<...>` contains a top-level
    // comma between `mut` and `...`, so splitFields emits the attribute and
    // the declaration as two chunks. Glue attribute-only chunks to the next
    // chunk that actually declares a field.
    const declarations: string[] = [];
    let carry = "";
    for (const chunk of splitFields(body)) {
      const merged = carry + chunk;
      // A field is complete only when it declares a name AND its attribute
      // brackets balance — multi-line `#[account(` blocks are split by their
      // own internal commas, and dropping the trailing `)]` line would make
      // every constraint in them invisible.
      if (/pub\s+\w+\s*:/.test(merged) && balanced(merged)) {
        declarations.push(merged);
        carry = "";
      } else {
        carry = merged;
      }
    }

    const fields: AccountField[] = [];
    for (const chunk of declarations) {
      const decl = /pub\s+(\w+)\s*:/.exec(chunk);
      if (!decl) continue;
      // Attributes precede the declaration, so everything before `pub` is
      // attribute text and everything after the type is the trailing comma.
      const rawAttrs = chunk.slice(0, decl.index).replace(/\s+/g, " ").trim();
      const typeStart = decl.index + decl[0].length;
      let depth = 0;
      let typeEnd = chunk.length;
      for (let i = typeStart; i < chunk.length; i++) {
        const ch = chunk[i] as string;
        if (ch === '"') { i = scanString(chunk, i) - 1; continue; }
        if (ch === "'") {
          const charLiteral = /^'(\\.|[^'\\])'/.exec(chunk.slice(i));
          if (charLiteral) { i += charLiteral[0].length - 1; continue; }
          continue; // lifetime: does not open a generic
        }
        if ("[({<".includes(ch)) depth++;
        else if ("])}>".includes(ch)) depth = Math.max(0, depth - 1);
        else if (ch === "," && depth === 0) { typeEnd = i; break; }
      }
      const ty = chunk.slice(typeStart, typeEnd).replace(/\/\/[^\n]*/g, " ")
        .replace(/\s+/g, " ").trim();
      if (ty === "" || !/^[\w:<>,\'&\[\]\s;.()]+$/.test(ty)) continue;
      const attrs = parseFieldAttrs(rawAttrs);
      fields.push({
        name: decl[1] as string,
        ty,
        raw: rawAttrs,
        constrained: rawAttrs.includes("#[account("),
        mut: attrs.mut ?? false,
        signer: (attrs.signer ?? false) || /Signer<'info>/.test(ty),
        init: attrs.init ?? false,
        initIfNeeded: attrs.initIfNeeded ?? false,
        payer: attrs.payer,
        space: attrs.space,
        close: attrs.close,
        hasOne: attrs.hasOne ?? [],
        address: attrs.address,
        seeds: attrs.seeds,
        bump: attrs.bump,
        tokenMint: attrs.tokenMint,
        tokenAuthority: attrs.tokenAuthority,
        associatedTokenMint: attrs.associatedTokenMint,
        associatedTokenAuthority: attrs.associatedTokenAuthority,
        constraints: attrs.constraints ?? [],
        unchecked: ty.includes("UncheckedAccount"),
        program: ty.startsWith("Program<"),
      });
    }
    structs.push({ name, instructionArgs, fields });
    re.lastIndex = match.index + 1;
  }
  return structs;
}

export function getStruct(structs: AccountsStruct[], name: string): AccountsStruct {
  const found = structs.find((s) => s.name === name);
  if (!found) throw new Error(`accounts struct ${name} not found`);
  return found;
}

/** Body of `pub fn <name>(...)`, brace-balanced. */
export function functionBody(source: string, name: string): string {
  // Matches `pub fn name(`, `fn name(` and `pub(crate) fn name(`,
  // with optional generic parameters between the name and the parens
  // (e.g. `fn helper<'a>(...)`).
  const re = new RegExp(`\\bfn ${name}(?:<[^>]*>)?\\s*\\(`);
  const match = re.exec(source);
  const start = match ? match.index : -1;
  if (start < 0) throw new Error(`function ${name} not found`);
  const brace = source.indexOf("{", start);
  let depth = 0;
  for (let i = brace; i < source.length; i++) {
    const ch = source[i] as string;
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) return source.slice(brace + 1, i); }
  }
  throw new Error(`unbalanced body for ${name}`);
}

/** `pub const NAME: ty = value;` with separators stripped. */
export function constants(source: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /pub const (\w+):\s*[\w:]+\s*=\s*([^;]+);/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    out[match[1] as string] = (match[2] as string).replace(/[_\s]/g, "");
  }
  return out;
}

// ------------------------------------------------------------------ world model

export type Key = string; // 64 lowercase hex chars

export interface WorldAccount {
  key: Key;
  owner: Key;
  lamports: number;
  /** Anchor account payload; `undefined` means "not an Anchor account". */
  data?: Record<string, unknown>;
  mint?: Key;
  tokenOwner?: Key;
  amount?: bigint;
  delegate?: Key | null;
  isNative?: boolean;
  closeAuthority?: Key | null;
  state?: "initialized" | "uninitialized";
  mintAuthority?: Key | null;
  freezeAuthority?: Key | null;
  decimals?: number;
  exists?: boolean;
}

export interface World {
  programId: Key;
  accounts: Map<Key, WorldAccount>;
  /** Field name -> key passed for that slot (`__key_<field>` in `args`). */
  signers: Set<Key>;
  args: Record<string, unknown>;
  clock: { slot: number; unixTimestamp: number };
  created: { key: Key; payer: Key; space: number; lamports: number }[];
  closed: { key: Key; to: Key; lamports: number }[];
  transfers: { from: Key; to: Key; amount: bigint }[];
  events: { name: string; fields: Record<string, unknown> }[];
  /** Set when evaluation stopped early. */
  failure?: Failure;
}

export interface WorldOptions {
  programId?: Key;
  accounts?: WorldAccount[];
  signers?: Key[];
  args?: Record<string, unknown>;
  clock?: { slot: number; unixTimestamp: number };
}

export function makeWorld(options: WorldOptions = {}): World {
  return {
    programId: options.programId ?? k("program"),
    accounts: new Map((options.accounts ?? []).map((a) => [a.key, { exists: true, ...a }])),
    signers: new Set(options.signers ?? []),
    args: options.args ?? {},
    clock: options.clock ?? { slot: 100, unixTimestamp: 1_700_000_000 },
    created: [], closed: [], transfers: [], events: [],
  };
}

/** Deterministic, obviously-synthetic key for a scenario label. */
export function k(label: string): Key {
  return createHash("sha256").update(`neonrelay-test:${label}`).digest("hex");
}

export function keyOfBase58(value: string): Key {
  return base58Decode(value).toString("hex");
}

/**
 * Solana `Rent::minimum_balance`, i.e. what `initialize_account` really charges.
 *
 * The default rent sysvar is `lamports_per_uint8_year = 3_480` and
 * `exemption_threshold = 2.0` years, and the runtime formula is
 *   `(data_len + 128) * lamports_per_uint8_year * exemption_threshold`
 * with NO division: the 128 bytes of account metadata are billed at the same
 * rate as data. That gives the two numbers every Solana developer recognises —
 * 890_880 for an empty account and 2_039_280 for a 165-byte SPL token account.
 * An earlier version of this helper divided by 1 MiB (mixing up "mebi" with the
 * 3_480 constant), which under-provisioned every created account by ~4.6%.
 */
export function rentExempt(space: number): number {
  const lamportsPerUint8Year = 3_480;
  const exemptionThresholdYears = 2;
  return (space + 128) * lamportsPerUint8Year * exemptionThresholdYears;
}

export function addAccount(world: World, acc: WorldAccount): WorldAccount {
  const stored: WorldAccount = { exists: true, ...acc };
  world.accounts.set(stored.key, stored);
  return stored;
}

export function plainWallet(world: World, key: Key, lamports = 10_000_000_000): WorldAccount {
  return addAccount(world, { key, owner: keyOfBase58(SYSTEM), lamports });
}

export function tokenAccount(world: World, key: Key, init: {
  mint: Key; owner: Key; amount?: bigint; delegate?: Key | null; isNative?: boolean;
  closeAuthority?: Key | null; state?: "initialized" | "uninitialized"; lamports?: number;
}): WorldAccount {
  return addAccount(world, {
    key, owner: keyOfBase58(TOKEN_PROGRAM), lamports: init.lamports ?? 2_039_280,
    mint: init.mint, tokenOwner: init.owner, amount: init.amount ?? 0n,
    delegate: init.delegate ?? null, isNative: init.isNative ?? false,
    closeAuthority: init.closeAuthority ?? null, state: init.state ?? "initialized",
  });
}

export function anchorAccount(world: World, key: Key, data: Record<string, unknown>,
  lamports = 2_000_000): WorldAccount {
  return addAccount(world, { key, owner: world.programId, lamports, data });
}

/** Associated-token address: ATA program PDA over owner/token-program/mint. */
export function ataAddress(owner: Key, mint: Key): Key {
  return findProgramAddress(
    [Buffer.from(owner, "hex"), Buffer.from(keyOfBase58(TOKEN_PROGRAM)), Buffer.from(mint, "hex")],
    keyOfBase58(ATA_PROGRAM),
  ).address.toString("hex");
}

export function pda(seeds: (Buffer | string)[], programId: Key): { address: Key; bump: number } {
  const found = findProgramAddress(
    seeds.map((s) => (typeof s === "string" ? Buffer.from(s, "hex") : s)),
    Buffer.from(programId, "hex"),
  );
  return { address: found.address.toString("hex"), bump: found.bump };
}

/** `Pubkey::find_program_address` must never land on the ed25519 curve. */
export function offCurve(key: Key): boolean {
  return !isOnCurveEncoded(Buffer.from(key, "hex"));
}

// ------------------------------------------------------------ constraint eval

export type FailureKind =
  | "missing-account" | "not-signer" | "wrong-owner" | "pda-mismatch" | "bump-mismatch"
  | "already-initialized" | "address-mismatch" | "has-one-mismatch" | "token-mint-mismatch"
  | "token-authority-mismatch" | "constraint-failed" | "payer-not-signer" | "payer-missing"
  | "space-invalid" | "close-target-missing" | "account-not-writable"
  | "unsafe-token-account" | "unknown-path";

export interface Failure {
  kind: FailureKind;
  accountField: string;
  detail: string;
}

export class FailureError extends Error {
  readonly failure: Failure;
  constructor(kind: FailureKind, accountField: string, detail: string) {
    super(`${kind}: ${accountField} — ${detail}`);
    this.name = "FailureError";
    this.failure = { kind, accountField, detail };
  }
}

const KEYISH = /^([A-Za-z_]\w*)\.key\(\)$/;
const FIELD = /^([A-Za-z_]\w*)((?:\.[A-Za-z_]\w*)*)$/;
const HEX32 = /^[0-9a-fA-F]{64}$/;

/**
 * Seed-namespace constants, keyed by the program that declares them.
 *
 * The four programs reuse the same Rust identifier for different namespaces
 * (`CONFIG_SEED` is `neonrelay_economy_config` in economy but `neonrelay_config`
 * in rewards), so a single flat table would silently cross-wire PDAs whenever a
 * test loads more than one program. Registration is therefore per `declare_id!`
 * and resolution prefers the table of the program currently being evaluated.
 */
const seedConstantsByProgram = new Map<string, Map<string, string>>();
/** Namespace of the program most recently passed to `useConstants`. */
let lastConstantsProgram = "";

export function useConstants(source: string): Map<string, string> {
  const id = /declare_id!\("([1-9A-HJ-NP-Za-km-z]+)"\)/.exec(source)?.[1] ?? "";
  const key = id ? keyOfBase58(id) : `source:${createHash("sha256").update(source).digest("hex").slice(0, 16)}`;
  let table = seedConstantsByProgram.get(key);
  if (!table) {
    table = new Map<string, string>();
    seedConstantsByProgram.set(key, table);
  }
  const re = /const (\w+):\s*&\[u8\]\s*=\s*b"([^"]*)";/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) table.set(match[1] as string, match[2] as string);
  lastConstantsProgram = key;
  return table;
}

export function seedConstant(name: string): string | undefined {
  return seedConstantsByProgram.get(lastConstantsProgram)?.get(name);
}

/** Constants visible to `evalAccounts` for the program the world targets. */
function seedConstantsFor(world: World): Map<string, string> {
  const table = seedConstantsByProgram.get(world.programId);
  if (table) return table;
  // Fall back to the most recently loaded program so single-program tests keep
  // working even when the world was built with a placeholder program id.
  return seedConstantsByProgram.get(lastConstantsProgram) ?? new Map<string, string>();
}

/** `#[derive(InitSpace)]` sizes — populated by `useInitSpace`. */
const initSpaceCache = new Map<string, number>();
export function useInitSpace(source: string): Map<string, number> {
  initSpaceCache.clear();
  // Manual `impl X { const LEN }` sizes ride along with the InitSpace table so
  // a program load registers both account-sizing styles at once.
  useLen(source);
  const sizes: Record<string, number> = {
    Pubkey: 32, u64: 8, i64: 8, u32: 4, i32: 4, u16: 2, i16: 2, u8: 1, i8: 1, bool: 1,
  };
  const re = /pub struct (\w+)\s*\{/g;
  let match: RegExpExecArray | null;
  const pending: [string, string][] = [];
  while ((match = re.exec(source)) !== null) {
    pending.push([match[1] as string, blockBody(source, match.index).body]);
    re.lastIndex = match.index + 1;
  }
  for (const [name, body] of pending) {
    let total = 0;
    let usable = true;
    for (const line of body.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith("//") || trimmed === "") continue;
      const field = /^pub \w+:\s*(.+?),?\s*$/.exec(trimmed);
      if (!field) { usable = false; break; }
      try {
        total += sizeOf((field[1] as string).trim(), sizes);
      } catch {
        usable = false; // not a plain data struct (e.g. an Accounts struct)
        break;
      }
    }
    if (!usable) continue;
    sizes[name] = total;
    initSpaceCache.set(name, total);
  }
  return initSpaceCache;
}

function sizeOf(ty: string, sizes: Record<string, number>): number {
  const array = /^\[(.+);\s*(\d+)\]$/.exec(ty);
  if (array) return sizeOf((array[1] as string).trim(), sizes) * Number(array[2]);
  const option = /^Option<(.+)>$/.exec(ty);
  if (option) return 1 + sizeOf((option[1] as string).trim(), sizes);
  const known = sizes[ty];
  if (known === undefined) throw new Error(`InitSpace: unknown type ${ty}`);
  return known;
}

interface Ctx {
  world: World;
  local: Map<string, Key>;
}

function localKey(ctx: Ctx, name: string): Key {
  const key = ctx.local.get(name);
  if (!key) throw new FailureError("unknown-path", name, `account ${name} was not bound yet`);
  return key;
}

/** `seeds = [A, b.key().as_ref()]` -> resolved byte parts. */
function seedParts(expression: string, ctx: Ctx): Buffer[] {
  const inner = expression.trim().replace(/^\[/, "").replace(/\]$/, "");
  return splitTopLevel(inner).map((part) => resolveSeedPart(part, ctx));
}

function resolveSeedPart(part: string, ctx: Ctx): Buffer {
  const trimmed = part.trim();
  const asRef = /^(.*?)\.as_ref\(\)$/.exec(trimmed);
  if (asRef) return resolveSeedPart(asRef[1] as string, ctx);
  const le = /^(.*?)\.to_le_bytes\(\)$/.exec(trimmed);
  if (le) {
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64LE(BigInt(resolveScalar(le[1] as string, ctx) as number));
    return buf;
  }
  const be = /^(.*?)\.to_be_bytes\(\)$/.exec(trimmed);
  if (be) {
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64BE(BigInt(resolveScalar(be[1] as string, ctx) as number));
    return buf;
  }
  const byteStr = /^b"(.*)"$/.exec(trimmed);
  if (byteStr) return Buffer.from(byteStr[1] as string, "utf8");
  const seedTable = seedConstantsFor(ctx.world);
  if (seedTable.has(trimmed)) return Buffer.from(seedTable.get(trimmed) as string, "utf8");
  if (trimmed.includes(".")) {
    // `config.mint.as_ref()` was stripped above; a remaining dotted path is a
    // stored pubkey or an instruction argument.
    const value = resolveValue(trimmed, ctx, trimmed);
    if (typeof value === "string" && HEX32.test(value)) return Buffer.from(value, "hex");
    if (typeof value === "number" || typeof value === "bigint") {
      const buf = Buffer.alloc(8);
      buf.writeBigUInt64LE(BigInt(value));
      return buf;
    }
    throw new FailureError("unknown-path", trimmed, `seed part ${trimmed} is not 32 bytes`);
  }
  if (/^[A-Za-z_]\w*$/.test(trimmed)) {
    const value = ctx.world.args[trimmed];
    if (typeof value === "string") {
      if (HEX32.test(value)) return Buffer.from(value, "hex");
      return Buffer.from(value, "utf8");
    }
    if (Buffer.isBuffer(value)) return value;
    if (typeof value === "number") {
      const buf = Buffer.alloc(8);
      buf.writeBigUInt64LE(BigInt(value));
      return buf;
    }
  }
  throw new FailureError("unknown-path", trimmed, `cannot resolve seed part ${trimmed}`);
}

function resolveScalar(path: string, ctx: Ctx): unknown {
  const trimmed = path.trim();
  if (/^-?\d[\d_]*$/.test(trimmed)) return Number(trimmed.replace(/_/g, ""));
  if (trimmed in ctx.world.args) return ctx.world.args[trimmed];
  throw new FailureError("unknown-path", trimmed, `cannot resolve ${trimmed}`);
}

function dataField(acc: WorldAccount, field: string, where: string): unknown {
  if (field === "key") return acc.key;
  // A stored Anchor field shadows the SPL account property of the same name:
  // `config.mint` is the configured mint key, `vault_ata.mint` the SPL mint.
  if (acc.data && field in acc.data) return acc.data[field];
  if (field === "amount") return acc.amount;
  if (field === "mint") return acc.mint;
  if (field === "owner") return acc.tokenOwner;
  if (field === "lamports") return acc.lamports;
  if (field === "delegate") return acc.delegate;
  if (field === "close_authority") return acc.closeAuthority;
  throw new FailureError("unknown-path", where, `no such field ${field}`);
}

function resolveValue(expr: string, ctx: Ctx, where: string): unknown {
  const trimmed = expr.trim();
  const keyish = KEYISH.exec(trimmed);
  if (keyish) return localKey(ctx, keyish[1] as string);
  if (trimmed === "Pubkey::default()") return "0".repeat(64);
  if (/^\[\s*0(u8)?\s*;\s*32\s*\]$/.test(trimmed)) return "0".repeat(64);
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  if (trimmed.startsWith("Clock::get()")) {
    return trimmed.includes("slot") ? ctx.world.clock.slot : ctx.world.clock.unixTimestamp;
  }
  const parts = FIELD.exec(trimmed);
  if (parts) {
    const head = parts[1] as string;
    const rest = parts[2] as string;
    // A bound account field wins over an instruction argument of the same name
    // (`config.mint` is a stored key, `epoch` in ClaimPrize is an account).
    if (ctx.local.has(head)) {
      const acc = ctx.world.accounts.get(localKey(ctx, head));
      if (!acc) throw new FailureError("missing-account", where, `${head} is not present`);
      if (rest === "") return acc.key;
      return dataField(acc, rest.slice(1), trimmed);
    }
  }
  if (trimmed in ctx.world.args) return ctx.world.args[trimmed];
  throw new FailureError("unknown-path", trimmed, `cannot resolve ${trimmed}`);
}

function norm(value: unknown): string {
  if (typeof value === "string") return value.toLowerCase();
  if (Buffer.isBuffer(value)) return value.toString("hex");
  if (typeof value === "bigint" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return Buffer.from(value.map((v) => Number(v))).toString("hex");
  if (value === undefined || value === null) return "null";
  throw new Error(`cannot compare ${typeof value}`);
}

function equalHex(a: unknown, b: unknown): boolean {
  return norm(a) === norm(b);
}

function checkConstraint(expr: string, ctx: Ctx, where: string): void {
  const negated = /^!\s*/.exec(expr);
  const body = negated ? expr.slice(negated[0].length) : expr;
  const comparison = /^(.*?)(==|!=)(.*)$/.exec(body);
  let verdict: boolean;
  if (comparison) {
    const left = resolveValue(comparison[1] as string, ctx, where);
    const right = resolveValue(comparison[3] as string, ctx, where);
    verdict = equalHex(left, right);
    if (comparison[2] === "!=") verdict = !verdict;
  } else {
    verdict = Boolean(resolveValue(body, ctx, where));
  }
  if (negated) verdict = !verdict;
  if (!verdict) throw new FailureError("constraint-failed", where, expr);
}

/** Manual `impl X { pub const LEN: usize = <arithmetic>; }` sizes, e.g. the
 * features AchievementRegistry, which does not derive InitSpace. */
const lenCache = new Map<string, number>();
export function useLen(source: string): Map<string, number> {
  lenCache.clear();
  const re = /impl\s+(\w+)\s*\{[^}]*pub const LEN:\s*usize\s*=\s*([^;]+);/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    const expr = (match[2] as string).replace(/[_\s]/g, "");
    if (!/^[\d+*()-]+$/.test(expr)) continue; // non-arithmetic LEN: skip, never guess
    lenCache.set(match[1] as string, Function(`"use strict"; return (${expr});`)() as number);
    re.lastIndex = match.index + 1;
  }
  return lenCache;
}

function resolveSpace(expr: string): number {
  const match = /8\s*\+\s*(\w+)::INIT_SPACE/.exec(expr);
  if (match) {
    const size = initSpaceCache.get(match[1] as string);
    if (size === undefined) throw new FailureError("space-invalid", "space", `unknown INIT_SPACE for ${match[1]}`);
    return 8 + size;
  }
  const lenMatch = /^(\w+)::LEN$/.exec(expr.trim());
  if (lenMatch) {
    const size = lenCache.get(lenMatch[1] as string);
    if (size === undefined) throw new FailureError("space-invalid", "space", `unknown LEN for ${lenMatch[1]}`);
    return size;
  }
  if (/^\d+$/.test(expr.trim())) return Number(expr.trim());
  throw new FailureError("space-invalid", "space", `cannot resolve space ${expr}`);
}

function expectedOwner(field: AccountField, world: World): Key | null {
  if (field.signer || field.unchecked) return null;
  if (/Mint|TokenAccount/.test(field.ty)) return keyOfBase58(TOKEN_PROGRAM);
  if (field.program) return keyOfBase58(BPF_UPGRADEABLE);
  if (/(Account|AccountLoader|Box<Account)/.test(field.ty)) return world.programId;
  return null;
}

export type EvalResult = { ok: true } | { ok: false; failure: Failure };

/**
 * Evaluate every declared constraint of `struct` against `world` in field
 * order, like the Anchor-generated `try_accounts`.
 */
export function evalAccounts(struct: AccountsStruct, world: World): EvalResult {
  const ctx: Ctx = { world, local: new Map() };
  try {
    // Anchor collects every passed key before it validates anything, so a
    // `has_one = authority` on the first field may reference a later one.
    for (const field of struct.fields) {
      const key = world.args[`__key_${field.name}`] as Key | undefined;
      if (key !== undefined) ctx.local.set(field.name, key);
    }
    for (const field of struct.fields) {
      if (field.program) {
        const key = world.args[`__key_${field.name}`] as Key | undefined;
        if (key === undefined) throw new FailureError("missing-account", field.name, "program account not passed");
        ctx.local.set(field.name, key);
        continue;
      }
      const key = world.args[`__key_${field.name}`] as Key | undefined;
      if (key === undefined) {
        throw new FailureError("missing-account", field.name, "scenario did not pass this account");
      }
      ctx.local.set(field.name, key);
      const acc = world.accounts.get(key);

      if (field.signer && !world.signers.has(key)) {
        throw new FailureError("not-signer", field.name, "missing required signature");
      }
      if (acc && acc.exists === false && !field.init) {
        throw new FailureError("missing-account", field.name, "account was closed and no longer exists");
      }
      if (!acc && !field.init) {
        throw new FailureError("missing-account", field.name, "account is not in the transaction");
      }

      if (field.init) {
        if (acc && acc.exists !== false) {
          throw new FailureError("already-initialized", field.name,
            "a value must be zero for init to succeed (account already exists)");
        }
        if (field.seeds) {
          const seeds = seedParts(field.seeds, ctx);
          const derived = pda(seeds, world.programId);
          if (derived.address !== key) {
            throw new FailureError("pda-mismatch", field.name,
              `derived ${derived.address.slice(0, 8)}… but ${key.slice(0, 8)}… was passed`);
          }
        }
        if (!field.payer) throw new FailureError("payer-missing", field.name, "init without payer");
        const payerKey = localKey(ctx, field.payer);
        if (!world.signers.has(payerKey)) {
          throw new FailureError("payer-not-signer", field.name, `payer ${field.payer} did not sign`);
        }
        if (field.associatedTokenMint) {
          // `init, associated_token::mint = M, associated_token::authority = A`
          // is an ATA: the address is itself a PDA of the ATA program.
          const ownerKey = resolveValue(field.associatedTokenAuthority, ctx, field.name);
          const mintKey = resolveValue(field.associatedTokenMint, ctx, field.name);
          if (ataAddress(norm(ownerKey), norm(mintKey)) !== key) {
            throw new FailureError("pda-mismatch", field.name, "not the associated token account of that owner/mint");
          }
        }
        const space = field.space ? resolveSpace(field.space) : 165;
        if (!field.space && !field.associatedTokenMint) {
          throw new FailureError("space-invalid", field.name, "init without space");
        }
        const lamports = rentExempt(space);
        world.created.push({ key, payer: payerKey, space, lamports });
        addAccount(world, { key, owner: world.programId, lamports, data: {}, state: "initialized" });
        continue;
      }

      const owner = expectedOwner(field, world);
      if (owner && acc && acc.owner !== owner) {
        throw new FailureError("wrong-owner", field.name,
          `account is owned by ${acc.owner.slice(0, 8)}…, expected ${owner.slice(0, 8)}…`);
      }

      if (field.seeds && acc) {
        const seeds = seedParts(field.seeds, ctx);
        const derived = pda(seeds, world.programId);
        if (derived.address !== key) {
          throw new FailureError("pda-mismatch", field.name,
            `derived ${derived.address.slice(0, 8)}… but ${key.slice(0, 8)}… was passed`);
        }
        const stored = acc.data?.["bump"];
        if (field.bump === "canonical") {
          if (stored !== undefined && stored !== derived.bump) {
            throw new FailureError("bump-mismatch", field.name,
              `stored bump ${String(stored)} is not the canonical bump ${derived.bump}`);
          }
        } else if (field.bump) {
          const declared = resolveValue(field.bump, ctx, field.name);
          if (declared !== derived.bump) {
            throw new FailureError("bump-mismatch", field.name,
              `declared bump ${String(declared)} is not the canonical bump ${derived.bump}`);
          }
          if (stored !== undefined && stored !== derived.bump) {
            throw new FailureError("bump-mismatch", field.name, "stored bump is not canonical");
          }
        }
      }

      // NOTE: seeds and has_one are *both* enforced by Anchor. Deriving the
      // right PDA proves nothing about its contents — a seed-pinned config whose
      // stored `authority` field differs from the signer must still be rejected.

      if (field.address) {
        const expected = resolveValue(field.address, ctx, field.name);
        if (!equalHex(expected, key)) {
          throw new FailureError("address-mismatch", field.name,
            `expected ${norm(expected).slice(0, 8)}…, got ${key.slice(0, 8)}…`);
        }
      }

      for (const one of field.hasOne) {
        const fieldName = one.split(".").pop() as string;
        if (!acc) throw new FailureError("missing-account", field.name, `${field.name} missing for has_one`);
        // `has_one = authority` is sugar for `constraint = config.authority ==
        // authority.key()`: the value compared against the passed account is the
        // STORED field of this account, never the key of the account itself.
        const expected = acc.data ? acc.data[one] : undefined;
        if (expected === undefined) {
          throw new FailureError("unknown-path", field.name,
            `${field.name} does not store a \`${one}\` field, so has_one cannot be satisfied`);
        }
        if (!equalHex(expected, localKey(ctx, fieldName))) {
          throw new FailureError("has-one-mismatch", field.name,
            `${field.name}.${one} does not match the ${fieldName} account that was passed`);
        }
      }

      if (field.tokenMint && acc) {
        const expected = resolveValue(field.tokenMint, ctx, field.name);
        if (!equalHex(expected, acc.mint)) {
          throw new FailureError("token-mint-mismatch", field.name, "token account is not the configured mint");
        }
      }
      if (field.tokenAuthority && acc) {
        const expected = resolveValue(field.tokenAuthority, ctx, field.name);
        if (!equalHex(expected, acc.tokenOwner)) {
          throw new FailureError("token-authority-mismatch", field.name, "token account authority mismatch");
        }
      }

      for (const expr of field.constraints) checkConstraint(expr, ctx, field.name);

      if (field.mut && acc && acc.exists === false) {
        throw new FailureError("account-not-writable", field.name, "cannot mutate a closed account");
      }
    }

    return { ok: true };
  } catch (err) {
    if (err instanceof FailureError) {
      world.failure = err.failure;
      return { ok: false, failure: err.failure };
    }
    throw err;
  }
}

/**
 * Anchor runs `close = target` in the exit handler, i.e. AFTER the instruction
 * body. Call this once the simulated handler succeeded: it moves the rent to
 * `target` and marks the account gone, so a replayed instruction fails with
 * `missing-account` exactly like the runtime.
 */
export function applyCloses(struct: AccountsStruct, world: World): EvalResult {
  const ctx: Ctx = { world, local: new Map() };
  for (const field of struct.fields) {
    const key = world.args[`__key_${field.name}`] as Key | undefined;
    if (key !== undefined) ctx.local.set(field.name, key);
  }
  try {
    for (const field of struct.fields) {
      if (!field.close) continue;
      const key = localKey(ctx, field.name);
      const acc = world.accounts.get(key);
      if (!acc || acc.exists === false) {
        throw new FailureError("close-target-missing", field.name, "close of a missing account");
      }
      const target = localKey(ctx, field.close);
      const destination = world.accounts.get(target);
      if (!destination) {
        throw new FailureError("close-target-missing", field.close, "rent destination was not passed");
      }
      destination.lamports += acc.lamports;
      world.closed.push({ key, to: target, lamports: acc.lamports });
      world.accounts.set(key, { ...acc, exists: false, data: undefined, lamports: 0 });
    }
    return { ok: true };
  } catch (err) {
    if (err instanceof FailureError) {
      world.failure = err.failure;
      return { ok: false, failure: err.failure };
    }
    throw err;
  }
}

/**
 * The program's own `require_safe_token_account` guard: only plain initialized
 * classic-SPL accounts may take part in a payment or payout.
 */
export function requireSafeTokenAccount(acc: WorldAccount | undefined, where: string): void {
  if (!acc) throw new FailureError("missing-account", where, "token account missing");
  if (acc.state !== "initialized" || acc.delegate || acc.isNative || acc.closeAuthority) {
    throw new FailureError("unsafe-token-account", where,
      "token account has unsupported delegate, native wrapper, or close authority");
  }
}
