/** Apply pending migrations and print the result. */
import { loadConfig } from "../src/config.ts";
import { Db, migrate, migrationCount } from "../src/db.ts";

const config = loadConfig();
const db = new Db(config.dbPath);
const applied = migrate(db);
console.log(`applied: ${applied.length ? applied.join(", ") : "(none)"}; total ${migrationCount(db)}`);
db.close();
