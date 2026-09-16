/**
 * Cryptographic primitives for wallet authentication.
 *
 * Design rules (see docs/WALLET_AUTH.md):
 *  - the backend never holds a wallet private key; it only *verifies* Ed25519
 *    signatures produced by the wallet over a challenge we issued;
 *  - challenges are canonical JSON bound to our domain with a short expiry and
 *    a single-use nonce;
 *  - session tokens are 256-bit random values, returned once, stored only as
 *    SHA-256 hashes, compared in constant time.
 */
import {
  createHash,
  createPublicKey,
  randomBytes,
  timingSafeEqual,
  verify as edVerify,
} from "node:crypto";

/** DER SPKI prefix for a raw 32-byte Ed25519 public key. */
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export class CryptoError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "CryptoError";
  }
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function randomNonce(bytes = 24): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Wrap a raw 32-byte Ed25519 public key into a Node KeyObject. */
export function publicKeyFromRaw(raw: Buffer): ReturnType<typeof createPublicKey> {
  if (raw.length !== 32) {
    throw new CryptoError("bad-public-key", `expected 32 bytes, got ${raw.length}`);
  }
  return createPublicKey({
    key: Buffer.concat([SPKI_ED25519_PREFIX, raw]),
    format: "der",
    type: "spki",
  });
}

export function publicKeyFromBase64Url(value: string): ReturnType<typeof createPublicKey> {
  return publicKeyFromRaw(Buffer.from(value, "base64url"));
}

/** Verify an Ed25519 signature over `message`. Never throws for bad input. */
export function verifySignature(
  message: Buffer,
  signature: Buffer,
  publicKey: ReturnType<typeof createPublicKey>,
): boolean {
  try {
    return edVerify(null, message, publicKey, signature);
  } catch {
    return false;
  }
}

export function constantTimeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * Canonical serialization of a challenge: fixed key order, no insignificant
 * whitespace, UTF-8. Both the issuer and the verifier use this exact byte
 * string, and it is what the wallet signs.
 */
export interface ChallengePayload {
  v: 1;
  purpose: "neonrelay-wallet-auth";
  domain: string;
  nonce: string;
  issued_at: number;
  expires_at: number;
}

export function serializeChallenge(payload: ChallengePayload): Buffer {
  const ordered = {
    v: payload.v,
    purpose: payload.purpose,
    domain: payload.domain,
    nonce: payload.nonce,
    issued_at: payload.issued_at,
    expires_at: payload.expires_at,
  };
  return Buffer.from(JSON.stringify(ordered), "utf8");
}

export function parseChallenge(bytes: Buffer): ChallengePayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new CryptoError("bad-challenge", "challenge is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new CryptoError("bad-challenge", "challenge is not an object");
  }
  const obj = parsed as Record<string, unknown>;
  const str = (key: string): string => {
    const value = obj[key];
    if (typeof value !== "string") throw new CryptoError("bad-challenge", `missing ${key}`);
    return value;
  };
  const int = (key: string): number => {
    const value = obj[key];
    if (typeof value !== "number" || !Number.isInteger(value)) {
      throw new CryptoError("bad-challenge", `missing ${key}`);
    }
    return value;
  };
  if (obj["v"] !== 1) throw new CryptoError("bad-challenge", "unsupported challenge version");
  if (obj["purpose"] !== "neonrelay-wallet-auth") {
    throw new CryptoError("bad-challenge", "wrong challenge purpose");
  }
  return {
    v: 1,
    purpose: "neonrelay-wallet-auth",
    domain: str("domain"),
    nonce: str("nonce"),
    issued_at: int("issued_at"),
    expires_at: int("expires_at"),
  };
}
