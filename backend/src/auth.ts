/**
 * Wallet authentication service: challenge issuing and verification.
 *
 * Flow (docs/WALLET_AUTH.md):
 *   1. client POSTs /v1/auth/challenge            -> {challenge, nonce, expires_at}
 *   2. wallet signs the challenge bytes via MWA   -> signature + public key
 *   3. client POSTs /v1/auth/verify-wallet        -> {session_token, binding, …}
 *
 * Verification checks, in order: structure → domain → expiry → nonce single-use
 * → Ed25519 signature → binding state. Every failure is a typed AuthFailure so
 * the HTTP layer never leaks internals.
 */
import type { Config } from "./config.ts";
import {
  CryptoError,
  parseChallenge,
  publicKeyFromBase64Url,
  serializeChallenge,
  verifySignature,
  type ChallengePayload,
} from "./crypto.ts";
import type { SessionStore } from "./sessions.ts";
import type { BindingRow, WalletStore } from "./wallets.ts";

export interface IssuedChallenge {
  challenge: string; // base64url of the canonical JSON bytes
  nonce: string;
  expires_at: number;
}

export type AuthFailureCode =
  | "bad-request"
  | "bad-challenge"
  | "wrong-domain"
  | "challenge-expired"
  | "nonce-unknown"
  | "nonce-replayed"
  | "bad-signature"
  | "bad-public-key"
  | "binding-revoked";

export class AuthFailure extends Error {
  readonly code: AuthFailureCode;

  constructor(code: AuthFailureCode, message: string) {
    super(message);
    this.code = code;
    this.name = "AuthFailure";
  }
}

export interface VerifiedWallet {
  sessionToken: string;
  sessionExpiresAt: number;
  binding: BindingRow;
  publicKeyBase64: string;
}

export class AuthService {
  private readonly config: Config;
  private readonly wallets: WalletStore;
  private readonly sessions: SessionStore;

  constructor(config: Config, wallets: WalletStore, sessions: SessionStore) {
    this.config = config;
    this.wallets = wallets;
    this.sessions = sessions;
  }

  issueChallenge(now: number = Date.now()): IssuedChallenge {
    const nonce = this.wallets.issueNonce(this.config.challengeTtlMs, now);
    const payload: ChallengePayload = {
      v: 1,
      purpose: "neonrelay-wallet-auth",
      domain: this.config.authDomain,
      nonce: nonce.nonce,
      issued_at: now,
      expires_at: nonce.expires_at,
    };
    return {
      challenge: serializeChallenge(payload).toString("base64url"),
      nonce: nonce.nonce,
      expires_at: nonce.expires_at,
    };
  }

  verifyWallet(input: {
    challenge: string;
    signature: string;
    publicKey: string;
    accountLabel?: string | null;
  }, now: number = Date.now()): VerifiedWallet {
    const challengeBytes = decodeBase64Url(input.challenge, "challenge");
    const signature = decodeBase64Url(input.signature, "signature");
    let payload: ChallengePayload;
    try {
      payload = parseChallenge(challengeBytes);
    } catch (err) {
      if (err instanceof CryptoError) throw new AuthFailure("bad-challenge", err.message);
      throw err;
    }
    // re-serialize: the signed bytes must be exactly the canonical form
    const canonical = serializeChallenge(payload);
    if (canonical.length !== challengeBytes.length ||
      !canonical.equals(challengeBytes)) {
      throw new AuthFailure("bad-challenge", "challenge is not in canonical form");
    }
    if (payload.domain !== this.config.authDomain) {
      throw new AuthFailure("wrong-domain",
        `challenge was issued for ${payload.domain}, expected ${this.config.authDomain}`);
    }
    if (now > payload.expires_at) {
      throw new AuthFailure("challenge-expired", "challenge expired");
    }
    const nonceProblem = this.wallets.consumeNonce(payload.nonce, now);
    if (nonceProblem === "unknown") throw new AuthFailure("nonce-unknown", "unknown nonce");
    if (nonceProblem === "expired") throw new AuthFailure("challenge-expired", "nonce expired");
    if (nonceProblem === "replayed") throw new AuthFailure("nonce-replayed", "nonce already used");

    let publicKey;
    try {
      publicKey = publicKeyFromBase64Url(input.publicKey);
    } catch (err) {
      throw new AuthFailure("bad-public-key", (err as Error).message);
    }
    if (!verifySignature(canonical, signature, publicKey)) {
      throw new AuthFailure("bad-signature", "Ed25519 signature does not match the challenge");
    }

    const publicKeyBase64 = input.publicKey;
    const binding = this.wallets.upsertBinding(
      publicKeyBase64, input.accountLabel ?? null, now);
    if (binding.revoked_at !== null) {
      throw new AuthFailure("binding-revoked", "wallet binding is revoked");
    }
    const issued = this.sessions.issue(binding.id, now);
    return {
      sessionToken: issued.token,
      sessionExpiresAt: issued.row.expires_at,
      binding,
      publicKeyBase64,
    };
  }
}

function decodeBase64Url(value: string, what: string): Buffer {
  if (typeof value !== "string" || value.length === 0 || value.length > 65_536) {
    throw new AuthFailure("bad-request", `${what} must be a base64url string`);
  }
  const buf = Buffer.from(value, "base64url");
  if (buf.length === 0) throw new AuthFailure("bad-request", `${what} is empty`);
  return buf;
}
