/** Read actual finalized validator accounts using the production v2 decoder. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { httpRpc, base58Decode } from "../../backend/src/economy.ts";
import { readTicketV2 } from "../../backend/src/economy_v2_rpc.ts";
assert.equal(process.env.NEONRELAY_LOCAL_VALIDATOR, "1");
const fixtures = JSON.parse(readFileSync(process.env.NEONRELAY_PUBLIC_FIXTURE!, "utf8"));
assert.equal(fixtures.length, 2);
assert.notEqual(fixtures[0].mint, fixtures[1].mint);
const rpc = httpRpc("http://127.0.0.1:8899");
const program = base58Decode("FZcLDdUrs6i1HYFFK2NhqNrbVaP6KTvrqzhyoDGT6CV9");
for (const row of fixtures) {
  const result = await readTicketV2(rpc, program, base58Decode(row.mint), {
    wallet: base58Decode(row.wallet), reference: Buffer.from(row.reference, "hex"),
    kind: 0, tier: 0, amountBase: 50n,
  });
  assert.equal(result.ticket?.ticketed, true);
  assert.equal(result.ticket?.amountBase, "50");
  assert.equal(result.market.decimals, 0);
  assert.equal(result.market.balanceBase, "0");
  assert.equal(result.market.reservedBase, "0");
  assert.equal(result.market.paymentsEnabled, false);
}
console.log("PASS: production backend decoder verified both finalized validator markets and tickets");
