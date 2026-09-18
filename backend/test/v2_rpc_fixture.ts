/** Synthetic public accounts only; not a network or payment simulator. */
import assert from "node:assert/strict";
import { base58Encode } from "../src/economy.ts";
import type { RpcCaller } from "../src/economy.ts";
import { configPdaV2, ticketPdaV2 } from "../src/economy_v2_codec.ts";
import { anchorDiscriminator, TOKEN_PROGRAM, vaultAddressV2 } from "../src/economy_v2_rpc.ts";

export function v2Fixture(wallet = Buffer.alloc(32, 7), reference = Buffer.alloc(32, 4), decimals = 6) {
  const program = Buffer.alloc(32, 3), mint = Buffer.alloc(32, 9), authority = Buffer.alloc(32, 2), treasury = Buffer.alloc(32, 5);
  const configPda = configPdaV2(mint, program), ticketPda = ticketPdaV2(mint, reference, wallet, program);
  const vault = vaultAddressV2(configPda.address, mint);
  const fees = [50n, 100n, 500n, 2000n].map((n) => n * 10n ** BigInt(decimals));
  const configData = Buffer.alloc(180);
  anchorDiscriminator("EconomyConfigV2").copy(configData);
  authority.copy(configData, 8); mint.copy(configData, 40); treasury.copy(configData, 72); vault.copy(configData, 104);
  fees.forEach((n, i) => configData.writeBigUInt64LE(n, 136 + i * 8));
  configData.writeUInt16LE(1000, 168); configData.writeBigUInt64LE(100n, 170); configData[179] = configPda.bump;
  const mintData = Buffer.alloc(82); mintData[44] = decimals; mintData[45] = 1;
  function token(owner: Buffer) {
    const bytes = Buffer.alloc(165); mint.copy(bytes); owner.copy(bytes, 32);
    bytes.writeBigUInt64LE(100000000000n, 64); bytes[108] = 1; return bytes;
  }
  const vaultData = token(configPda.address), treasuryData = token(authority);
  const ticketData = Buffer.alloc(123); anchorDiscriminator("EntryTicketV2").copy(ticketData);
  mint.copy(ticketData, 8); wallet.copy(ticketData, 40); reference.copy(ticketData, 72);
  ticketData.writeBigUInt64LE(fees[0]!, 106); ticketData.writeBigInt64LE(1700000000n, 114); ticketData[122] = ticketPda.bump;
  const envelope = (bytes: Buffer, owner = base58Encode(program)) => ({ owner, executable: false, data: [bytes.toString("base64"), "base64"] });
  let calls = 0;
  const rpc: RpcCaller = async (method, params) => {
    calls++;
    if (method === "getAccountInfo") {
      assert.equal(params[0], base58Encode(configPda.address));
      assert.deepEqual(params[1], { encoding: "base64", commitment: "finalized" });
      return { context: { slot: 10 }, value: envelope(configData) };
    }
    assert.equal(method, "getMultipleAccounts");
    const addresses = params[0] as string[];
    assert.deepEqual(addresses.slice(0, 4), [mint, configPda.address, vault, treasury].map(base58Encode));
    assert.deepEqual(params[1], { encoding: "base64", commitment: "finalized", minContextSlot: 10 });
    const value = [envelope(mintData, TOKEN_PROGRAM), envelope(configData), envelope(vaultData, TOKEN_PROGRAM), envelope(treasuryData, TOKEN_PROGRAM)];
    if (addresses.length === 5) {
      assert.equal(addresses[4], base58Encode(ticketPda.address)); value.push(envelope(ticketData));
    }
    return { context: { slot: 11 }, value };
  };
  return { program, mint, wallet, reference, fees, configData, mintData, vaultData, treasuryData, ticketData,
    rpc, envelope, callCount: () => calls,
    expected: { wallet, reference, kind: 0 as const, tier: 0, amountBase: fees[0]! } };
}
