/**
 * Session tokens: 256-bit random bearer values, returned exactly once and
 * stored only as SHA-256 hashes, with a sliding expiry and explicit revocation.
 */
import type { Db } from "./db.ts";
import { constantTimeEqual, randomToken, sha256Hex } from "./crypto.ts";

export interface SessionRow {
  id: string;
  token_hash: string;
  wallet_binding_id: string;
  created_at: number;
  expires_at: number;
  last_seen_at: number;
  revoked_at: number | null;
}

export interface IssuedSession {
  token: string;
  row: SessionRow;
}

export class SessionStore {
  private readonly db: Db;
  private readonly ttlMs: number;

  constructor(db: Db, ttlMs: number) {
    this.db = db;
    this.ttlMs = ttlMs;
  }

  issue(walletBindingId: string, now: number = Date.now()): IssuedSession {
    const token = randomToken(32);
    const row: SessionRow = {
      id: crypto.randomUUID(),
      token_hash: sha256Hex(token),
      wallet_binding_id: walletBindingId,
      created_at: now,
      expires_at: now + this.ttlMs,
      last_seen_at: now,
      revoked_at: null,
    };
    this.db.run(
      `INSERT INTO sessions
         (id, token_hash, wallet_binding_id, created_at, expires_at, last_seen_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL)`,
      row.id, row.token_hash, row.wallet_binding_id,
      row.created_at, row.expires_at, row.last_seen_at,
    );
    return { token, row };
  }

  /**
   * Validate a bearer token; slides the expiry. Returns the session or a
   * reason: `missing` | `expired` | `revoked`.
   */
  validate(token: string | null, now: number = Date.now()):
    { session: SessionRow; reason: null } | { session: null; reason: string } {
    if (!token) return { session: null, reason: "missing" };
    const hash = sha256Hex(token);
    const rows = this.db.all<SessionRow>("SELECT * FROM sessions WHERE token_hash = ?", hash);
    const row = rows.find((r) => constantTimeEqual(r.token_hash, hash));
    if (!row) return { session: null, reason: "missing" };
    if (row.revoked_at !== null) return { session: null, reason: "revoked" };
    if (now > row.expires_at) return { session: null, reason: "expired" };
    this.db.run("UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?",
      now, now + this.ttlMs, row.id);
    return { session: { ...row, last_seen_at: now, expires_at: now + this.ttlMs }, reason: null };
  }

  revoke(sessionId: string, now: number = Date.now()): void {
    this.db.run("UPDATE sessions SET revoked_at = ? WHERE id = ?", now, sessionId);
  }

  revokeForBinding(bindingId: string, now: number = Date.now()): void {
    this.db.run(
      "UPDATE sessions SET revoked_at = ? WHERE wallet_binding_id = ? AND revoked_at IS NULL",
      now, bindingId);
  }
}
