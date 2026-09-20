/**
 * Golden rewards-program PDAs for the mobile claim builder.
 *
 * The backend never derives these addresses itself (claiming is client-side),
 * but it owns the only TS PDA implementation — so this suite pins the exact
 * bytes the Android builder must reproduce, using the same seeds and the
 * big-endian epoch order as the program. Shared with
 * android/.../wallet/RewardsTxBuilderTest.kt: program
 * 2RaaXKUutemHtSZUsmnEv41ytWMkaXD6rcoziHGLRtmj, player 0x07 * 32, epoch 7.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { base58Decode, findProgramAddress } from "../src/economy.ts";

const PROGRAM = base58Decode("2RaaXKUutemHtSZUsmnEv41ytWMkaXD6rcoziHGLRtmj");
const PLAYER = Buffer.alloc(32, 7);
const EPOCH_BE = Buffer.alloc(8);
EPOCH_BE.writeBigUInt64BE(7n);

const pda = (seeds: Buffer[]): string =>
  findProgramAddress(seeds, PROGRAM).address.toString("hex");

test("rewards config PDA", () => {
  assert.equal(pda([Buffer.from("neonrelay_config")]),
    "44cc50e3b33d76d6062d779b385a853e3bf2c225d375322d6e65d94352075e7c");
});

test("rewards epoch PDA binds the big-endian epoch id", () => {
  assert.equal(pda([Buffer.from("neonrelay_epoch"), EPOCH_BE]),
    "870396b6b6f2f3425637741b085f8ee58f5d911eab21a383eddb7b9cd9763afb");
  // Little-endian is a DIFFERENT address: the builder must use big-endian.
  const le = Buffer.alloc(8);
  le.writeBigUInt64LE(7n);
  assert.notEqual(pda([Buffer.from("neonrelay_epoch"), le]),
    "870396b6b6f2f3425637741b085f8ee58f5d911eab21a383eddb7b9cd9763afb");
});

test("rewards claim PDA binds epoch (BE) and player", () => {
  assert.equal(pda([Buffer.from("neonrelay_claim"), EPOCH_BE, PLAYER]),
    "9de9e925dae9005efdbc4870753598287060dcfc7063fc316ec67e79ca186387");
});

test("rewards vault PDA", () => {
  assert.equal(pda([Buffer.from("neonrelay_vault")]),
    "8aa581920e01b4d317deb42c7f49e80921069c3c5b78d2d0ae48600b0ae496f7");
});
