/** Operator-local provisioning. No public registration or private keys. */
import { Db, migrate } from "../src/db.ts";
import { loadConfig } from "../src/config.ts";
import { registerGameAccount } from "../src/game_pairing.ts";
const [playerId, wallet] = process.argv.slice(2);
if (!playerId || !wallet || process.argv.length !== 4) {
  throw new Error("usage: register_game_account.ts STABLE_PLAYER_ID WALLET_BASE64URL");
}
const db = new Db(loadConfig().dbPath);
try { migrate(db); registerGameAccount(db, playerId, wallet); console.log("Game account registered"); }
finally { db.close(); }
