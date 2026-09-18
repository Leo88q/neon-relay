/** Operator registry + one-use game pairing. No nickname identity or admission. */
import { randomToken, sha256Hex, publicKeyFromBase64Url, verifySignature } from "./crypto.ts";
import type { Db } from "./db.ts";
import type { Config } from "./config.ts";
import type { BindingRow } from "./wallets.ts";
import type { SessionRow } from "./sessions.ts";
import { HttpError } from "./http.ts";
function key(value: string): boolean {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value) &&
    Buffer.from(value, "base64url").toString("base64url") === value &&
    !Buffer.from(value, "base64url").every((b) => b === 0);
}
/** Called only by operator provisioning, never from a public HTTP route. */
export function registerGameAccount(db: Db, playerId: string, wallet: string) {
  if (!key(wallet) || typeof playerId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(playerId)) {
    throw new Error("expected stable ASCII player id and canonical wallet public key");
  }
  db.run("INSERT INTO game_accounts(player_id,wallet) VALUES (?,?)", playerId, wallet);
}
export function pairingProofBytes(domain: string, tokenHash: string, connectionNonce: string): Buffer {
  return Buffer.from(JSON.stringify({ v: 1, purpose: "neonrelay-game-pairing", domain,
    token_hash: tokenHash, connection_nonce: connectionNonce }));
}
interface PairingRow {
  token_hash: string; session_id: string; binding_id: string; player_id: string;
  wallet: string; signer: string; domain: string; connection_nonce: string;
  expires_at: number; consumed_at: number | null;
}
export class GamePairing {
  private readonly db: Db;
  private readonly config: Config;
  constructor(db: Db, config: Config) { this.db = db; this.config = config; }
  private signer() {
    const signer = this.config.gameIdentityPublicKey;
    if (!signer || !key(signer)) throw new HttpError(503, "identity-not-configured", "game identity public key required");
    return signer;
  }
  issue(ctx: { binding: BindingRow; session: SessionRow }, connectionNonce: string, consent: unknown, now = Date.now()) {
    const signer = this.signer();
    if (consent !== true || !/^[0-9a-f]{64}$/.test(connectionNonce)) {
      throw new HttpError(400, "pairing-invalid-request", "explicit consent and 32-byte lowercase hex connection nonce required");
    }
    const token = randomToken(32), hash = sha256Hex(token);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.get<{ player_id: string; wallet: string; expires_at: number }>(
        `SELECT a.player_id, a.wallet, s.expires_at FROM game_accounts a
         JOIN wallet_bindings b ON b.public_key=a.wallet JOIN sessions s ON s.wallet_binding_id=b.id
         WHERE b.id=? AND s.id=? AND a.enabled=1 AND b.revoked_at IS NULL
         AND s.revoked_at IS NULL AND s.expires_at>?`, ctx.binding.id, ctx.session.id, now);
      if (!row || row.wallet !== ctx.binding.public_key) throw new HttpError(403, "game-account-required", "operator-provisioned active game account required");
      const expiresAt = Math.min(now + 120_000, row.expires_at);
      this.db.run("DELETE FROM game_pairings WHERE expires_at<?", now - 86_400_000);
      this.db.run("DELETE FROM game_pairings WHERE session_id=? AND consumed_at IS NULL", ctx.session.id);
      this.db.run(`INSERT INTO game_pairings
        (token_hash,session_id,binding_id,player_id,wallet,signer,domain,connection_nonce,expires_at)
        VALUES (?,?,?,?,?,?,?,?,?)`, hash, ctx.session.id, ctx.binding.id, row.player_id, row.wallet,
        signer, this.config.authDomain, connectionNonce, expiresAt);
      this.db.exec("COMMIT");
      return { pairing_token: token, player_id: row.player_id, expires_at: expiresAt, admissionEnabled: false };
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  redeem(token: string, connectionNonce: string, signature: string, now = Date.now()) {
    const signer = this.signer();
    if (!key(token) || !/^[0-9a-f]{64}$/.test(connectionNonce) ||
        !/^[A-Za-z0-9_-]{86}$/.test(signature) || Buffer.from(signature, "base64url").toString("base64url") !== signature) {
      throw new HttpError(400, "pairing-invalid-proof", "invalid pairing proof encoding");
    }
    const hash = sha256Hex(token);
    if (!verifySignature(pairingProofBytes(this.config.authDomain, hash, connectionNonce),
      Buffer.from(signature, "base64url"), publicKeyFromBase64Url(signer))) {
      throw new HttpError(403, "pairing-signature-invalid", "trusted game server proof required");
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.get<PairingRow>("SELECT * FROM game_pairings WHERE token_hash=?", hash);
      if (!row || row.consumed_at !== null || row.expires_at <= now || row.signer !== signer ||
          row.domain !== this.config.authDomain || row.connection_nonce !== connectionNonce) {
        throw new HttpError(409, "pairing-unavailable", "pairing expired, consumed or mismatched");
      }
      const active = this.db.get<{ expires_at: number }>(
        `SELECT s.expires_at FROM sessions s JOIN wallet_bindings b ON b.id=s.wallet_binding_id
         JOIN game_accounts a ON a.wallet=b.public_key
         WHERE s.id=? AND b.id=? AND b.public_key=? AND a.player_id=? AND a.enabled=1
         AND s.revoked_at IS NULL AND b.revoked_at IS NULL AND s.expires_at>?`,
        row.session_id, row.binding_id, row.wallet, row.player_id, now);
      if (!active) throw new HttpError(403, "pairing-identity-revoked", "account or session is no longer active");
      this.db.run("UPDATE game_pairings SET consumed_at=? WHERE token_hash=?", now, hash);
      this.db.exec("COMMIT");
      // No bearer token/hash is disclosed. No identity grant is installed yet.
      return { domain: row.domain, player_id: row.player_id, wallet: row.wallet,
        session_id: row.session_id, wallet_binding_id: row.binding_id,
        connection_nonce: row.connection_nonce, authentication_expires_at: Math.min(row.expires_at, active.expires_at),
        explicit_link_confirmed: true, admissionEnabled: false };
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
}
