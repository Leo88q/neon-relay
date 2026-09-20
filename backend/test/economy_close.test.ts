/**
 * Tranche-A economy close tests: the prize pool is derived from vault state
 * (balance minus reservations) over RPC, never from the request, and the
 * close executes only through the proposal workflow. A stub RPC server stands
 * in for Solana; ticket/config/vault bytes follow the on-chain layouts.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  authenticate, getJson, makeTestServer, makeWallet, postJson, startTestApp,
} from "./helpers.ts";
import {
  TICKET_DISCRIMINATOR, base58Decode, base58Encode, entryReference,
  findProgramAddress, ticketAddress, ENTRY_SEED,
  ECONOMY_CONFIG_SEED, ECONOMY_V1_CONFIG_DISCRIMINATOR,
} from "../src/economy.ts";
import { leafHash, verifyProofIndexed } from "../src/merkle.ts";

const PROGRAM = "FZcLDdUrs6i1HYFFK2NhqNrbVaP6KTvrqzhyoDGT6CV9";
const OPERATOR = "op-close";
const SUPERADMIN = "sup-close";

/** Mutable stub-RPC state: address -> account bytes (absent = empty slot). */
interface StubState {
  accounts: Map<string, Buffer>;
  vaultBalance: string;
}

function startStub(state: StubState): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const msg = JSON.parse(body) as { id: number; method: string; params: unknown[] };
      let result: unknown = null;
      if (msg.method === "getAccountInfo") {
        const data = state.accounts.get(msg.params[0] as string);
        result = data === undefined
          ? { value: null }
          : { value: { owner: PROGRAM, executable: false, data: [data.toString("base64"), "base64"] } };
      } else if (msg.method === "getTokenAccountBalance") {
        result = { value: { amount: state.vaultBalance, decimals: 6, uiAmount: 1 } };
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

function configBytes(mint: Buffer, vault: Buffer, reserved: bigint): Buffer {
  const data = Buffer.alloc(204);
  ECONOMY_V1_CONFIG_DISCRIMINATOR.copy(data, 0);
  Buffer.alloc(32, 5).copy(data, 8);
  mint.copy(data, 40);
  createHash("sha256").update("treasury").digest().copy(data, 72);
  vault.copy(data, 104);
  data.writeUInt16LE(1000, 136);
  data.writeBigUInt64LE(1_000_000n, 138);
  data.writeBigUInt64LE(5_000_000n, 146);
  data.writeBigUInt64LE(reserved, 156);
  return data;
}

function ticketBytes(wallet: Buffer, reference: Buffer, bump: number): Buffer {
  const data = Buffer.alloc(90);
  TICKET_DISCRIMINATOR.copy(data, 0);
  wallet.copy(data, 8);
  reference.copy(data, 40);
  data.writeUInt8(0, 72);
  data.writeBigUInt64LE(1_000_000n, 73);
  data.writeBigInt64LE(1_700_000_000n, 81);
  data[89] = bump;
  return data;
}

test("close derives the pool from vault state and redistributes to winners", async () => {
  const programRaw = base58Decode(PROGRAM);
  const mint = createHash("sha256").update("test-skr-mint").digest();
  const vault = createHash("sha256").update("test-vault").digest();
  const stub: StubState = { accounts: new Map(), vaultBalance: "1100000" };
  const configAddr = base58Encode(findProgramAddress([ECONOMY_CONFIG_SEED], programRaw).address);
  stub.accounts.set(configAddr, configBytes(mint, vault, 100_000n)); // available = 1_000_000
  const rpc = await startStub(stub);

  const server = makeTestServer();
  const { app, base } = await startTestApp({
    serverSigningPublicKey: server.publicKeyBase64,
    epochMs: 3_600_000,
    capPerMatchMicro: 100_000,
    capDailyMicro: 1_000_000,
    capWeeklyMicro: 5_000_000,
    operatorToken: OPERATOR,
    superadminToken: SUPERADMIN,
    economyProgramId: PROGRAM,
    skrMint: base58Encode(mint),
    rpcUrl: rpc.url,
  });
  try {
    // Rank 1 takes 1000, rank 2 takes 500; both will hold tickets.
    const wallets = [makeWallet(), makeWallet()];
    const totals = [1000, 500];
    for (let i = 0; i < 2; i++) {
      const w = wallets[i] as { publicKeyBase64: string; rawPublicKey: Buffer; sign: (m: Buffer) => Buffer };
      const auth = await authenticate(base, w);
      const token = auth.json.session_token as string;
      await postJson(base, "/v1/wallet/link", { player_id: `close-p${i}` }, token);
      const ingested = await postJson(base, "/v1/rewards/events", {
        events: [server.signEvent({
          match_id: "m-close", player_id: `close-p${i}`,
          wallet_binding_id: auth.json.wallet_binding_id as string,
          event_type: "match_win", amount_micro: totals[i] as number, occurred_at: Date.now(),
        })],
      });
      assert.equal(ingested.json.results[0].status, "accepted");
    }
    const epochs = await getJson(base, "/v1/rewards/epochs");
    const epochId = epochs.json[0].id as number;

    // Publish ticket accounts for both winners at their derived PDAs.
    for (const w of wallets) {
      const ref = entryReference(0, epochId, w.rawPublicKey);
      const { address, bump } = findProgramAddress([ENTRY_SEED, ref, w.rawPublicKey], programRaw);
      assert.equal(base58Encode(ticketAddress(ref, w.rawPublicKey, programRaw)), base58Encode(address));
      stub.accounts.set(base58Encode(address), ticketBytes(w.rawPublicKey, ref, bump));
    }

    // The legacy direct route is gone, even with a pool in the body.
    const direct = await postJson(base, "/v1/economy/epoch-close",
      { epoch: epochId, poolMicro: 999_999_999 }, SUPERADMIN);
    assert.equal(direct.status, 410);
    assert.equal(direct.json.error.code, "admin-workflow-required");

    const proposed = await postJson(base, "/v1/admin/proposals",
      { type: "close-economy-epoch", params: { epoch: epochId } }, OPERATOR);
    assert.equal(proposed.status, 200);
    const approved = await postJson(base, "/v1/admin/proposals/approve",
      { proposal_id: proposed.json.id }, SUPERADMIN);
    assert.equal(approved.status, 200);
    const result = approved.json.result;
    assert.equal(result.pool.available, 1_000_000);
    assert.equal(result.pool.balance, "1100000");
    assert.equal(result.pool.reserved, "100000");
    assert.equal(result.leaves.length, 2);
    // Redistribution of 1e6 over occupied bps [2500, 1800].
    assert.deepEqual(result.leaves.map((l: { amountMicro: number }) => l.amountMicro), [581395, 418605]);
    assert.equal(result.totalMicro, 1_000_000);
    assert.equal(result.leaves[0].wallet, base58Encode(wallets[0]!.rawPublicKey));

    // The published proof verifies against the stored root.
    const proof = await getJson(base,
      `/v1/economy/proof?epoch=${epochId}&wallet=${base58Encode(wallets[1]!.rawPublicKey)}`);
    assert.equal(proof.status, 200);
    assert.equal(proof.json.amountMicro, 418605);
    assert.equal(
      verifyProofIndexed(
        leafHash(wallets[1]!.rawPublicKey, 418605),
        proof.json.leafIndex as number,
        proof.json.proof as string[],
        result.root as string),
      true);

    const closed = await getJson(base, "/v1/economy/epochs");
    assert.equal(closed.json.epochs.length, 1);

    // Closing twice is a clean 409 through a fresh proposal.
    const again = await postJson(base, "/v1/admin/proposals",
      { type: "close-economy-epoch", params: { epoch: epochId } }, OPERATOR);
    const reapproved = await postJson(base, "/v1/admin/proposals/approve",
      { proposal_id: again.json.id }, SUPERADMIN);
    assert.equal(reapproved.status, 409);
    assert.equal(reapproved.json.error.code, "epoch-already-closed");
  } finally {
    await app.close();
    await rpc.close();
  }
});

test("close refuses epochs with no ticketed winners", async () => {
  const programRaw = base58Decode(PROGRAM);
  const mint = createHash("sha256").update("test-skr-mint").digest();
  const vault = createHash("sha256").update("test-vault").digest();
  const stub: StubState = { accounts: new Map(), vaultBalance: "500000" };
  const configAddr = base58Encode(findProgramAddress([ECONOMY_CONFIG_SEED], programRaw).address);
  stub.accounts.set(configAddr, configBytes(mint, vault, 0n));
  const rpc = await startStub(stub);

  const server = makeTestServer();
  const { app, base } = await startTestApp({
    serverSigningPublicKey: server.publicKeyBase64,
    epochMs: 3_600_000,
    capPerMatchMicro: 100_000,
    capDailyMicro: 1_000_000,
    capWeeklyMicro: 5_000_000,
    operatorToken: OPERATOR,
    superadminToken: SUPERADMIN,
    economyProgramId: PROGRAM,
    skrMint: base58Encode(mint),
    rpcUrl: rpc.url,
  });
  try {
    // An event exists (so ranking is non-empty) but no ticket account does.
    const wallet = makeWallet();
    const auth = await authenticate(base, wallet);
    const token = auth.json.session_token as string;
    await postJson(base, "/v1/wallet/link", { player_id: "unticketed-p" }, token);
    await postJson(base, "/v1/rewards/events", {
      events: [server.signEvent({
        match_id: "m-unt", player_id: "unticketed-p",
        wallet_binding_id: auth.json.wallet_binding_id as string,
        event_type: "match_win", amount_micro: 100, occurred_at: Date.now(),
      })],
    });
    const epochs = await getJson(base, "/v1/rewards/epochs");
    const epochId = epochs.json[0].id as number;
    const proposed = await postJson(base, "/v1/admin/proposals",
      { type: "close-economy-epoch", params: { epoch: epochId } }, OPERATOR);
    const approved = await postJson(base, "/v1/admin/proposals/approve",
      { proposal_id: proposed.json.id }, SUPERADMIN);
    assert.equal(approved.status, 409);
    assert.equal(approved.json.error.code, "no-eligible-winners");
    const closed = await getJson(base, "/v1/economy/epochs");
    assert.deepEqual(closed.json.epochs, []);
  } finally {
    await app.close();
    await rpc.close();
  }
});
