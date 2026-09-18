import test from "node:test";
import assert from "node:assert/strict";
import type { RpcCaller } from "../src/economy.ts";
import { readMarketV2, readTicketV2 } from "../src/economy_v2_rpc.ts";
import { U64_MAX } from "../src/economy_v2_codec.ts";
import { v2Fixture } from "./v2_rpc_fixture.ts";

function transform(f: ReturnType<typeof v2Fixture>, fn: (result: any, method: string) => void): RpcCaller {
  return async (method, params) => { const result = await f.rpc(method, params); fn(result, method); return result; };
}

test("v2 market reads a coherent finalized snapshot and uses actual mint decimals", async () => {
  for (const decimals of [0, 6, 9, 15]) {
    const f = v2Fixture(undefined, undefined, decimals);
    f.vaultData.writeBigUInt64LE(U64_MAX, 64);
    const result = await readMarketV2(f.rpc, f.program, f.mint);
    assert.equal(result.decimals, decimals);
    assert.deepEqual(result.feesBase, f.fees.map(String));
    assert.equal(result.balanceBase, U64_MAX.toString());
    assert.equal(result.availableBase, (U64_MAX - 100n).toString());
    assert.equal(result.paymentsEnabled, false);
    assert.equal(result.slot, 11);
    assert.equal(f.callCount(), 2);
  }
});

test("v2 RPC rejects owner/executable/encoding/layout/discriminator substitutions", async () => {
  const mutations = [
    (a: any) => { a.owner = "wrong"; }, (a: any) => { a.executable = true; },
    (a: any) => { delete a.owner; }, (a: any) => { delete a.executable; },
    (a: any) => { a.data[1] = "base58"; }, (a: any) => { a.data = null; },
    (a: any) => { a.data[0] += "\n"; }, (a: any) => { a.data[0] = "!".repeat(240); },
    (a: any) => { a.data[0] = Buffer.alloc(180).toString("base64"); },
  ];
  for (const mutate of mutations) {
    const f = v2Fixture();
    await assert.rejects(readMarketV2(transform(f, (r, method) => {
      if (method === "getAccountInfo") mutate(r.value);
    }), f.program, f.mint));
  }
  for (let index = 0; index < 4; index++) {
    const f = v2Fixture();
    await assert.rejects(readMarketV2(transform(f, (r, method) => {
      if (method === "getMultipleAccounts") r.value[index].owner = "wrong";
    }), f.program, f.mint), /wrong-account-owner/);
  }
});

test("v2 config rejects wrong mint, bump, vault, pause and rake", async () => {
  for (const offset of [40, 104, 179]) {
    const f = v2Fixture(); f.configData[offset] = f.configData[offset]! ^ 1;
    await assert.rejects(readMarketV2(f.rpc, f.program, f.mint));
  }
  const pause = v2Fixture(); pause.configData[178] = 2;
  await assert.rejects(readMarketV2(pause.rpc, pause.program, pause.mint), /pause/);
  const rake = v2Fixture(); rake.configData.writeUInt16LE(2001, 168);
  await assert.rejects(readMarketV2(rake.rpc, rake.program, rake.mint), /rake/);
  const paused = v2Fixture(); paused.configData[178] = 1;
  assert.equal((await readMarketV2(paused.rpc, paused.program, paused.mint)).paused, true);
});

test("SPL state, owner, decimals, delegation and reserved balance are validated", async () => {
  for (const offset of [0, 32, 72, 108, 109, 129]) {
    const f = v2Fixture(); f.vaultData[offset] = f.vaultData[offset]! ^ 1;
    await assert.rejects(readMarketV2(f.rpc, f.program, f.mint));
  }
  const frozen = v2Fixture(); frozen.treasuryData[108] = 2;
  await assert.rejects(readMarketV2(frozen.rpc, frozen.program, frozen.mint), /token-not-active/);
  for (const [offset, value] of [[44, 16], [45, 0], [0, 2], [46, 2]]) {
    const f = v2Fixture(); f.mintData[offset!] = value!;
    await assert.rejects(readMarketV2(f.rpc, f.program, f.mint));
  }
  const wrongFees = v2Fixture(); wrongFees.configData.writeBigUInt64LE(49n, 136);
  await assert.rejects(readMarketV2(wrongFees.rpc, wrongFees.program, wrongFees.mint), /wrong-tier-fees/);
  const insufficient = v2Fixture(); insufficient.vaultData.writeBigUInt64LE(99n, 64);
  await assert.rejects(readMarketV2(insufficient.rpc, insufficient.program, insufficient.mint), /vault-underfunded/);
});

test("snapshot rejects stale slots, changing market identity and missing accounts", async () => {
  for (const change of [
    (r: any) => { r.context.slot = 9; }, (r: any) => { r.context.slot = 1.5; },
    (r: any) => { r.value.pop(); }, (r: any) => { r.value[2] = null; },
    (r: any) => { const b = Buffer.from(r.value[1].data[0], "base64"); b[72] = b[72]! ^ 1; r.value[1].data[0] = b.toString("base64"); },
  ]) {
    const f = v2Fixture();
    await assert.rejects(readMarketV2(transform(f, (r, method) => {
      if (method === "getMultipleAccounts") change(r);
    }), f.program, f.mint));
  }
});

test("v2 ticket binds expected wallet, mint, reference, kind, tier, fee and bump", async () => {
  const valid = v2Fixture();
  const result = await readTicketV2(valid.rpc, valid.program, valid.mint, valid.expected);
  assert.equal(result.ticket?.ticketed, true);
  assert.equal(result.ticket?.amountBase, "50000000");
  for (const offset of [0, 8, 40, 72, 104, 105, 106, 122]) {
    const f = v2Fixture(); f.ticketData[offset] = f.ticketData[offset]! ^ 1;
    await assert.rejects(readTicketV2(f.rpc, f.program, f.mint, f.expected));
  }
  const time = v2Fixture(); time.ticketData.writeBigInt64LE(-1n, 114);
  await assert.rejects(readTicketV2(time.rpc, time.program, time.mint, time.expected), /ticket-time/);
});

test("missing ticket is distinct from invalid ticket; wrong intent fee never qualifies", async () => {
  const f = v2Fixture();
  const missing = transform(f, (r, method) => { if (method === "getMultipleAccounts") r.value[4] = null; });
  assert.deepEqual((await readTicketV2(missing, f.program, f.mint, f.expected)).ticket, { ticketed: false });
  await assert.rejects(readTicketV2(missing, f.program, f.mint, { ...f.expected, amountBase: 1n }), /intent-fee-mismatch/);
});

test("RPC or input failures never produce an accepted ticket", async () => {
  const f = v2Fixture();
  await assert.rejects(readTicketV2(f.rpc, f.program, f.mint, { ...f.expected, tier: 4 }), /invalid-ticket-expectation/);
  assert.equal(f.callCount(), 0);
  await assert.rejects(readMarketV2(async () => { throw new Error("RPC down"); }, f.program, f.mint), /RPC down/);
  await assert.rejects(readMarketV2(async () => null, f.program, f.mint), /invalid-rpc-object/);
});
