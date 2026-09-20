/** Confidential token envelope, not encryption/authentication of game traffic. */
import { createPublicKey, generateKeyPairSync, diffieHellman, hkdfSync, createHash, randomBytes, createCipheriv } from "node:crypto";
import { publicKeyFromBase64Url, verifySignature } from "./crypto.ts";
import { HttpError } from "./http.ts";
import type { Config } from "./config.ts";
import type { GamePairing } from "./game_pairing.ts";

export function issueSealedPairing(config: Config, pairing: GamePairing,
  ctx: Parameters<GamePairing["issue"]>[0], offer: string, signature: string, consent: unknown, now = Date.now()) {
  const signer = config.gameIdentityPublicKey;
  if (!signer || !/^[A-Za-z0-9_-]{43}$/.test(signer) || Buffer.from(signer, "base64url").toString("base64url") !== signer) {
    throw new HttpError(503, "identity-not-configured", "canonical server identity public key required");
  }
  const invalid = () => new HttpError(400, "pairing-offer-invalid", "invalid, expired or untrusted encryption offer");
  if (typeof offer !== "string" || Buffer.byteLength(offer) > 2048 || !/^[A-Za-z0-9_-]{86}$/.test(signature) ||
    Buffer.from(signature, "base64url").toString("base64url") !== signature) throw invalid();
  let p: any;
  try { p = JSON.parse(offer); } catch { throw invalid(); }
  if (!p || p.v !== 1 || p.purpose !== "neonrelay-game-pairing-seal" || p.domain !== config.authDomain ||
      typeof p.connection_nonce !== "string" || !/^[0-9a-f]{64}$/.test(p.connection_nonce) ||
      typeof p.server_ephemeral_key !== "string" || !/^[0-9a-f]{64}$/.test(p.server_ephemeral_key) ||
      !Number.isSafeInteger(p.issued_at) || !Number.isSafeInteger(p.expires_at) ||
      p.issued_at < 0 || p.issued_at > now || p.expires_at <= now || p.expires_at - p.issued_at > 120_000 ||
      JSON.stringify({ v: 1, purpose: p.purpose, domain: p.domain, connection_nonce: p.connection_nonce,
        server_ephemeral_key: p.server_ephemeral_key, issued_at: p.issued_at, expires_at: p.expires_at }) !== offer ||
      !verifySignature(Buffer.from(offer), Buffer.from(signature, "base64url"), publicKeyFromBase64Url(signer))) throw invalid();
  const ephemeral = generateKeyPairSync("x25519");
  let shared: Buffer;
  try {
    const peer = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b656e032100", "hex"), Buffer.from(p.server_ephemeral_key, "hex")]), format: "der", type: "spki" });
    shared = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: peer });
  } catch { throw invalid(); }
  const salt = createHash("sha256").update(offer).digest();
  const key = Buffer.from(hkdfSync("sha256", shared, salt, Buffer.from("neonrelay:game-pairing-seal:v1"), 32));
  shared.fill(0);
  try {
    const issued = pairing.issue(ctx, p.connection_nonce, consent, now, p.expires_at);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(offer));
    const encrypted = Buffer.concat([cipher.update(issued.pairing_token, "utf8"), cipher.final()]);
    return { v: 1, sender_key: ephemeral.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex"),
      iv: iv.toString("hex"), ciphertext: encrypted.toString("hex"), tag: cipher.getAuthTag().toString("hex"),
      expires_at: issued.expires_at, admissionEnabled: false };
  } finally { key.fill(0); }
}
