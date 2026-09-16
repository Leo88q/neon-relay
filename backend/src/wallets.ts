/**
 * Persistence for wallet authentication: single-use nonces, wallet bindings
 * (the stable identity rewards are bound to) and player links.
 */
import type { Db } from "./db.ts";
import { randomNonce } from "./crypto.ts";

export interface NonceRow {
  nonce: string;
  created_at: number;
  expires_at: number;
  consumed_at: number | null;
}

export interface BindingRow {
  id: string;
  public_key: string;
  label: string | null;
  player_id: string | null;
  created_at: number;
  revoked_at: number | null;
}

export class WalletStore {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  issueNonce(ttlMs: number, now: number = Date.now()): NonceRow {
    const row: NonceRow = {
      nonce: randomNonce(),
      created_at: now,
      expires_at: now + ttlMs,
      consumed_at: null,
    };
    this.db.run(
      "INSERT INTO auth_nonces (nonce, created_at, expires_at, consumed_at) VALUES (?, ?, ?, NULL)",
      row.nonce, row.created_at, row.expires_at,
    );
    return row;
  }

  /**
   * Atomically consume a nonce. Returns an error code instead of throwing so
   * the HTTP layer can map it to a status:
   * `unknown` | `expired` | `replayed` | null (success).
   */
  consumeNonce(nonce: string, now: number = Date.now()): string | null {
    const row = this.db.get<NonceRow>(
      "SELECT nonce, created_at, expires_at, consumed_at FROM auth_nonces WHERE nonce = ?",
      nonce,
    );
    if (!row) return "unknown";
    if (row.consumed_at !== null) return "replayed";
    if (now > row.expires_at) return "expired";
    this.db.run("UPDATE auth_nonces SET consumed_at = ? WHERE nonce = ? AND consumed_at IS NULL",
      now, nonce);
    const check = this.db.get<NonceRow>(
      "SELECT consumed_at FROM auth_nonces WHERE nonce = ?", nonce);
    return check?.consumed_at === now ? null : "replayed";
  }

  purgeNonces(now: number = Date.now()): void {
    this.db.run("DELETE FROM auth_nonces WHERE expires_at < ?", now - 86_400_000);
  }

  findBindingByPublicKey(publicKeyBase64: string): BindingRow | undefined {
    return this.db.get<BindingRow>(
      "SELECT * FROM wallet_bindings WHERE public_key = ?", publicKeyBase64);
  }

  findBinding(id: string): BindingRow | undefined {
    return this.db.get<BindingRow>("SELECT * FROM wallet_bindings WHERE id = ?", id);
  }

  /** Create or revive the binding for a wallet public key. */
  upsertBinding(publicKeyBase64: string, label: string | null,
    now: number = Date.now()): BindingRow {
    const existing = this.findBindingByPublicKey(publicKeyBase64);
    if (existing) {
      if (existing.revoked_at !== null) {
        this.db.run(
          "UPDATE wallet_bindings SET revoked_at = NULL, label = ? WHERE id = ?",
          label, existing.id);
      } else if (label !== null && label !== existing.label) {
        this.db.run("UPDATE wallet_bindings SET label = ? WHERE id = ?", label, existing.id);
      }
      return this.findBinding(existing.id) as BindingRow;
    }
    const id = crypto.randomUUID();
    this.db.run(
      `INSERT INTO wallet_bindings (id, public_key, label, player_id, created_at, revoked_at)
       VALUES (?, ?, ?, NULL, ?, NULL)`,
      id, publicKeyBase64, label, now);
    return this.findBinding(id) as BindingRow;
  }

  revokeBinding(id: string, now: number = Date.now()): void {
    this.db.run("UPDATE wallet_bindings SET revoked_at = ? WHERE id = ?", now, id);
  }

  setPlayerLink(bindingId: string, playerId: string | null): void {
    this.db.run("UPDATE wallet_bindings SET player_id = ? WHERE id = ?", playerId, bindingId);
  }
}
