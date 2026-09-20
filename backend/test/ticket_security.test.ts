import test from "node:test";
import assert from "node:assert/strict";
import {
  base58Decode, findProgramAddress, entryReference, parseTicketData,
  ticketStatus, TICKET_DISCRIMINATOR,
} from "../src/economy.ts";

const program = "FZcLDdUrs6i1HYFFK2NhqNrbVaP6KTvrqzhyoDGT6CV9";
const wallet = Buffer.alloc(32, 7);
const reference = entryReference(0, 7, wallet, 42);
const { bump } = findProgramAddress([Buffer.from("neonrelay_entry"), reference, wallet], base58Decode(program));

function data() {
  const bytes = Buffer.alloc(90);
  TICKET_DISCRIMINATOR.copy(bytes);
  wallet.copy(bytes, 8);
  reference.copy(bytes, 40);
  bytes[72] = 0;
  bytes.writeBigUInt64LE(50000000n, 73);
  bytes.writeBigInt64LE(1700000000n, 81);
  bytes[89] = bump;
  return bytes;
}
function account(bytes = data()) {
  return { owner: program, executable: false, data: [bytes.toString("base64"), "base64"] };
}
async function check(value: unknown) {
  return ticketStatus(async () => ({ value }), program, reference, wallet);
}

test("ticket account discriminator matches Anchor golden bytes", () => {
  assert.equal(TICKET_DISCRIMINATOR.toString("hex"), "9bad70c5396ec1cb");
});

test("valid finalized owned account is accepted", async () => {
  const result = await ticketStatus(async (_method, params) => {
    assert.deepEqual(params[1], { encoding: "base64", commitment: "finalized" });
    return { value: account() };
  }, program, reference, wallet);
  assert.deepEqual(result, { ticketed: true, kind: 0, amountMicro: 50000000, paidAt: 1700000000 });
});

test("RPC owner and executable are mandatory", async () => {
  for (const value of [null, {}, { ...account(), owner: "wrong" },
    { ...account(), owner: undefined }, { ...account(), executable: true },
    { ...account(), executable: undefined }]) {
    assert.deepEqual(await check(value), { ticketed: false });
  }
});

test("ticket must bind requested player, reference and derived bump", async () => {
  for (const offset of [8, 39, 40, 71, 89]) {
    const bytes = data(); bytes[offset] = bytes[offset]! ^ 1;
    assert.deepEqual(await check(account(bytes)), { ticketed: false });
  }
});

test("malformed account layouts, kinds and unsafe integers are rejected", () => {
  const invalid = [Buffer.alloc(90), data().subarray(0, 89), Buffer.concat([data(), Buffer.alloc(1)])];
  for (const kind of [2, 255]) { const b = data(); b[72] = kind; invalid.push(b); }
  for (const amount of [0n, BigInt(Number.MAX_SAFE_INTEGER) + 1n, (1n << 64n) - 1n]) {
    const b = data(); b.writeBigUInt64LE(amount, 73); invalid.push(b);
  }
  for (const timestamp of [-1n, BigInt(Number.MAX_SAFE_INTEGER) + 1n]) {
    const b = data(); b.writeBigInt64LE(timestamp, 81); invalid.push(b);
  }
  for (const b of invalid) assert.deepEqual(parseTicketData(b), { ticketed: false });
  const boundary = data(); boundary.writeBigUInt64LE(BigInt(Number.MAX_SAFE_INTEGER), 73);
  assert.equal(parseTicketData(boundary).amountMicro, Number.MAX_SAFE_INTEGER);
});

test("RPC encoding must be canonical base64 with exact bounded length", async () => {
  for (const payload of [null, "bytes", [], [data().toString("base64"), "base58"],
    [data().toString("base64")], [123, "base64"], ["!".repeat(120), "base64"],
    [data().toString("base64") + "\n", "base64"], ["A".repeat(10000), "base64"]]) {
    assert.deepEqual(await check({ ...account(), data: payload }), { ticketed: false });
  }
});

test("invalid address input is rejected without contacting RPC", async () => {
  let calls = 0;
  await assert.rejects(ticketStatus(async () => { calls++; }, program, Buffer.alloc(31), wallet));
  await assert.rejects(ticketStatus(async () => { calls++; }, program, reference, Buffer.alloc(31)));
  await assert.rejects(ticketStatus(async () => { calls++; }, "1", reference, wallet));
  assert.equal(calls, 0);
});

// Pinned also in Android EconomyTxBuilderTest: protects language parity.
test("entry reference and ticket PDA match Android golden vector", () => {
  assert.equal(reference.toString("hex"), "3a3af01a1ec0caa5611de67f03d68f493ba86ac94f732d1712ecc006ce274067");
  const pda = findProgramAddress([Buffer.from("neonrelay_entry"), reference, wallet], base58Decode(program));
  assert.equal(pda.address.toString("hex"), "398b4a9e392f105b2de81ea17dc5b3d827e84bd3a86f89617f44d262a4ac0b5a");
});
