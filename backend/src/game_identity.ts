/** Short-lived server-attested player identity. NOT permission to pay or join.
 * Server must independently authenticate the actual player before signing. */
import { randomNonce, publicKeyFromBase64Url, verifySignature } from "./crypto.ts";
import type { Db } from "./db.ts";
import type { Config } from "./config.ts";
import { HttpError } from "./http.ts";
import type { BindingRow } from "./wallets.ts";
import type { SessionRow } from "./sessions.ts";
interface IdentityContext { binding: BindingRow; session: SessionRow }
interface Challenge {
  nonce: string; session_id: string; binding_id: string; player_id: string;
  wallet: string; signer: string; domain: string; payload: string; expires_at: number; consumed_at: number | null;
}
export class GameIdentity {
  private readonly db: Db;
  private readonly config: Config;
  constructor(db: Db, config: Config) { this.db = db; this.config = config; }
  private signer(): string {
    const key = this.config.gameIdentityPublicKey;
    if (!key || !/^[A-Za-z0-9_-]{43}$/.test(key) || Buffer.from(key, "base64url").toString("base64url") !== key) {
      throw new HttpError(503, "identity-not-configured", "configure a canonical game identity signing public key");
    }
    return key;
  }
  private active(ctx: IdentityContext, now: number) {
    const live = this.db.get<{ public_key: string; player_id: string | null }>(
      `SELECT b.public_key, b.player_id FROM sessions s JOIN wallet_bindings b ON b.id=s.wallet_binding_id
       WHERE s.id=? AND b.id=? AND s.revoked_at IS NULL AND b.revoked_at IS NULL AND s.expires_at>?`,
      ctx.session.id, ctx.binding.id, now);
    if (!live || live.public_key !== ctx.binding.public_key) throw new HttpError(401, "identity-session-invalid", "active wallet session required");
    return live;
  }
  private registered(wallet: string, playerId: string) {
    return !!this.db.get("SELECT 1 FROM game_accounts WHERE wallet=? AND player_id=? AND enabled=1", wallet, playerId);
  }
  issue(ctx: IdentityContext, playerId: string, now = Date.now()) {
    const signer = this.signer(); this.active(ctx, now);
    if (typeof playerId !== "string" || playerId.length < 1 || playerId.length > 128 || /[\u0000-\u001f\u007f]/.test(playerId)) {
      throw new HttpError(400, "bad-player-id", "invalid player identifier");
    }
    if (!this.registered(ctx.binding.public_key, playerId)) throw new HttpError(403, "game-account-required", "active registered player/wallet required");
    const nonce = randomNonce(32), expiresAt = now + 120_000;
    // Only public session UUID, never bearer token or its hash, is disclosed.
    const payload = JSON.stringify({ v: 1, purpose: "neonrelay-game-identity", domain: this.config.authDomain,
      nonce, session_id: ctx.session.id, wallet_binding_id: ctx.binding.id,
      wallet: ctx.binding.public_key, player_id: playerId, signer, issued_at: now, expires_at: expiresAt });
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.active(ctx, now);
      this.db.run("DELETE FROM game_identity_challenges WHERE expires_at < ?", now - 86_400_000);
      // One outstanding challenge per session, bounded even across client retries.
      this.db.run("DELETE FROM game_identity_challenges WHERE session_id=? AND consumed_at IS NULL", ctx.session.id);
      this.db.run(`INSERT INTO game_identity_challenges
        (nonce,session_id,binding_id,player_id,wallet,signer,domain,payload,expires_at) VALUES (?,?,?,?,?,?,?,?,?)`,
        nonce, ctx.session.id, ctx.binding.id, playerId, ctx.binding.public_key, signer, this.config.authDomain, payload, expiresAt);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return { nonce, challenge: Buffer.from(payload).toString("base64url"), expires_at: expiresAt };
  }
  verify(ctx: IdentityContext, nonce: string, signature: string, now = Date.now()) {
    const signer = this.signer();
    if (!/^[A-Za-z0-9_-]{43}$/.test(nonce) || !/^[A-Za-z0-9_-]{86}$/.test(signature) ||
        Buffer.from(signature, "base64url").toString("base64url") !== signature) {
      throw new HttpError(400, "bad-identity-proof", "invalid nonce or signature encoding");
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.active(ctx, now);
      const row = this.db.get<Challenge>("SELECT * FROM game_identity_challenges WHERE nonce=?", nonce);
      if (!row || row.session_id !== ctx.session.id || row.binding_id !== ctx.binding.id || row.wallet !== ctx.binding.public_key || row.signer !== signer || row.domain !== this.config.authDomain) {
        throw new HttpError(403, "identity-challenge-mismatch", "challenge does not belong to this session and signer");
      }
      if (!this.registered(row.wallet, row.player_id)) throw new HttpError(403, "game-account-required", "active registered player/wallet required");
      if (row.consumed_at !== null || row.expires_at <= now) throw new HttpError(409, "identity-challenge-used-or-expired", "request a fresh identity challenge");
      if (!verifySignature(Buffer.from(row.payload), Buffer.from(signature, "base64url"), publicKeyFromBase64Url(signer))) {
        throw new HttpError(403, "identity-signature-invalid", "trusted game server signature required");
      }
      this.db.run("UPDATE game_identity_challenges SET consumed_at=? WHERE nonce=?", now, nonce);
      // Trigger revokes any old grants and other pending challenges for this wallet.
      this.db.run("UPDATE wallet_bindings SET player_id=? WHERE id=?", row.player_id, row.binding_id);
      this.db.run(`INSERT INTO game_identity_grants(session_id,binding_id,player_id,wallet,signer,domain,expires_at)
        VALUES (?,?,?,?,?,?,?)`, row.session_id, row.binding_id, row.player_id, row.wallet, signer, this.config.authDomain, now + 300_000);
      this.db.exec("COMMIT");
      return { verified: true, player_id: row.player_id, verified_until: now + 300_000, admissionEnabled: false };
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  status(ctx: IdentityContext, now = Date.now()) {
    const signer = this.signer(), live = this.active(ctx, now);
    const grant = this.db.get<{ player_id: string; expires_at: number }>(
      `SELECT player_id, expires_at FROM game_identity_grants WHERE session_id=? AND binding_id=?
       AND wallet=? AND signer=? AND domain=? AND expires_at>? AND player_id=?`,
      ctx.session.id, ctx.binding.id, ctx.binding.public_key, signer, this.config.authDomain, now, live.player_id);
    return grant && this.registered(ctx.binding.public_key, grant.player_id) ? { verified: true, player_id: grant.player_id, verified_until: grant.expires_at, admissionEnabled: false }
      : { verified: false, player_id: null, verified_until: null, admissionEnabled: false };
  }
}
