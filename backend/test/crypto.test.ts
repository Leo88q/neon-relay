import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import {
  constantTimeEqual, parseChallenge, publicKeyFromRaw, serializeChallenge,
  sha256Hex, verifySignature,
} from "../src/crypto.ts";
import { makeWallet } from "./helpers.ts";

test("raw ed25519 keys round-trip and verify", () => {
  const wallet = makeWallet();
  const key = publicKeyFromRaw(wallet.rawPublicKey);
  const message = Buffer.from("neonrelay");
  const signature = wallet.sign(message);
  assert.equal(verifySignature(message, signature, key), true);
  assert.equal(verifySignature(Buffer.from("tampered"), signature, key), false);
});

test("wrong-length public keys are rejected", () => {
  assert.throws(() => publicKeyFromRaw(Buffer.alloc(31)), /expected 32 bytes/);
});

test("challenge serialization is canonical and stable", () => {
  const payload = {
    v: 1 as const, purpose: "neonrelay-wallet-auth" as const,
    domain: "d.example", nonce: "n", issued_at: 1, expires_at: 2,
  };
  const a = serializeChallenge(payload);
  const b = serializeChallenge(payload);
  assert.equal(a.toString("utf8"), b.toString("utf8"));
  assert.equal(parseChallenge(a).domain, "d.example");
  assert.equal(a.toString("utf8"),
    '{"v":1,"purpose":"neonrelay-wallet-auth","domain":"d.example","nonce":"n","issued_at":1,"expires_at":2}');
});

test("parse rejects wrong purpose and version", () => {
  const bad = Buffer.from(JSON.stringify(
    { v: 2, purpose: "neonrelay-wallet-auth", domain: "d", nonce: "n", issued_at: 1, expires_at: 2 }));
  assert.throws(() => parseChallenge(bad), /unsupported challenge version/);
  const badPurpose = Buffer.from(JSON.stringify(
    { v: 1, purpose: "other", domain: "d", nonce: "n", issued_at: 1, expires_at: 2 }));
  assert.throws(() => parseChallenge(badPurpose), /wrong challenge purpose/);
});

test("sha256 and constant-time compare behave", () => {
  assert.equal(sha256Hex("x").length, 64);
  assert.equal(constantTimeEqual("abc", "abc"), true);
  assert.equal(constantTimeEqual("abc", "abd"), false);
  assert.equal(constantTimeEqual("abc", "ab"), false);
});

test("signatures from another key never verify", () => {
  const a = makeWallet();
  const b = makeWallet();
  const message = Buffer.from("challenge-bytes");
  const sigByB = b.sign(message);
  assert.equal(verifySignature(message, sigByB, publicKeyFromRaw(a.rawPublicKey)), false);
  // sanity: the same wallet does verify
  assert.equal(verifySignature(message, a.sign(message), publicKeyFromRaw(a.rawPublicKey)), true);
  void edSign; void generateKeyPairSync;
});
