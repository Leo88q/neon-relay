/** Shared test helpers: ephemeral app + a real ed25519 wallet stand-in. */
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import { loadConfig, type Config } from "../src/config.ts";
import { createApp, type App } from "../src/server.ts";
import { canonicalEventBytes, type IncomingEvent } from "../src/rewards.ts";

export interface TestWallet {
  publicKeyBase64: string;
  rawPublicKey: Buffer;
  sign: (message: Buffer) => Buffer;
}

export function makeWallet(): TestWallet {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  return {
    publicKeyBase64: raw.toString("base64url"),
    rawPublicKey: raw,
    sign: (message: Buffer) => edSign(null, message, privateKey),
  };
}

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    ...loadConfig({}),
    dbPath: ":memory:",
    authDomain: "test.neonrelay.example",
    challengeTtlMs: 60_000,
    sessionTtlMs: 60_000,
    ...overrides,
  };
}

export async function startTestApp(overrides: Partial<Config> = {}):
  Promise<{ app: App; base: string }> {
  const app = createApp(testConfig(overrides));
  const port = await app.listen(0);
  return { app, base: `http://127.0.0.1:${port}` };
}

export async function postJson(base: string, path: string, body: unknown,
  token?: string): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers["authorization"] = `Bearer ${token}`;
  const res = await fetch(base + path, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

export async function getJson(base: string, path: string, token?: string):
  Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = {};
  if (token) headers["authorization"] = `Bearer ${token}`;
  const res = await fetch(base + path, { headers });
  return { status: res.status, json: await res.json() };
}

/** Full happy path: challenge -> wallet sign -> verify -> session token. */
export async function authenticate(base: string, wallet: TestWallet,
  label = "test wallet"): Promise<{ status: number; json: any; challengeBytes: Buffer }> {
  const challengeRes = await postJson(base, "/v1/auth/challenge", {});
  const challengeBytes = Buffer.from(challengeRes.json.challenge as string, "base64url");
  const signature = wallet.sign(challengeBytes);
  const verifyRes = await postJson(base, "/v1/auth/verify-wallet", {
    challenge: challengeBytes.toString("base64url"),
    signature: signature.toString("base64url"),
    public_key: wallet.publicKeyBase64,
    account_label: label,
  });
  return { status: verifyRes.status, json: verifyRes.json, challengeBytes };
}

/** Game-server stand-in: signs match events with its own ed25519 key. */
export interface TestServer {
  publicKeyBase64: string;
  signEvent: (event: Omit<IncomingEvent, "server_signature">) => IncomingEvent;
}

export function makeTestServer(): TestServer {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  return {
    publicKeyBase64: raw.toString("base64url"),
    signEvent: (event) => ({
      ...event,
      server_signature: edSign(null, canonicalEventBytes(event), privateKey)
        .toString("base64url"),
    }),
  };
}
