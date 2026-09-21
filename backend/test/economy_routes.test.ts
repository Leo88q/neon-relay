/**
 * Economy route tests: the program guard, deterministic reference derivation,
 * the current-epoch clock and proof input validation.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  authenticate, getJson, makeWallet, startTestApp,
} from "./helpers.ts";
import { entryReference } from "../src/economy.ts";

const PROGRAM = "FZcLDdUrs6i1HYFFK2NhqNrbVaP6KTvrqzhyoDGT6CV9";

test("economy routes are disabled without a program id", async () => {
  const { app, base } = await startTestApp({});
  try {
    const res = await getJson(base, "/v1/economy/current-epoch");
    assert.equal(res.status, 503);
    assert.equal(res.json.error.code, "economy-not-configured");
  } finally {
    await app.close();
  }
});

test("reference derives the deterministic entry reference for the caller", async () => {
  const { app, base } = await startTestApp({ economyProgramId: PROGRAM });
  try {
    const wallet = makeWallet();
    const auth = await authenticate(base, wallet);
    const token = auth.json.session_token as string;
    const res = await getJson(base, "/v1/economy/reference?kind=1&epoch=7&extra=3", token);
    assert.equal(res.status, 200);
    assert.equal(res.json.reference,
      entryReference(1, 7, wallet.rawPublicKey, 3).toString("hex"));
  } finally {
    await app.close();
  }
});

test("reference rejects kinds outside 0|1", async () => {
  const { app, base } = await startTestApp({ economyProgramId: PROGRAM });
  try {
    const auth = await authenticate(base, makeWallet());
    const res = await getJson(base, "/v1/economy/reference?kind=7",
      auth.json.session_token as string);
    assert.equal(res.status, 400);
  } finally {
    await app.close();
  }
});

test("current epoch follows the configured epoch length", async () => {
  const { app, base } = await startTestApp({ economyProgramId: PROGRAM, epochMs: 3_600_000 });
  try {
    const res = await getJson(base, "/v1/economy/current-epoch");
    assert.equal(res.status, 200);
    assert.ok(Math.abs((res.json.epoch as number) - Math.floor(Date.now() / 3_600_000)) <= 1);
  } finally {
    await app.close();
  }
});

test("proof rejects a non-base58 wallet", async () => {
  const { app, base } = await startTestApp({ economyProgramId: PROGRAM });
  try {
    const res = await getJson(base, "/v1/economy/proof?epoch=1&wallet=!!!");
    assert.equal(res.status, 400);
  } finally {
    await app.close();
  }
});
