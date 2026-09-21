/**
 * Migration tests: a failing migration rolls its own file back, reports the
 * file name, and leaves the database usable.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db, migrate } from "../src/db.ts";

test("a failing migration rolls back and surfaces which file broke", () => {
  const dir = mkdtempSync(join(tmpdir(), "neon-relay-migrate-"));
  writeFileSync(join(dir, "001_ok.sql"), "CREATE TABLE t_ok (id INTEGER PRIMARY KEY);");
  writeFileSync(join(dir, "002_bad.sql"),
    "CREATE TABLE t_bad (id INTEGER PRIMARY KEY);\nTHIS IS NOT SQL;");
  const db = new Db(":memory:");
  assert.throws(() => migrate(db, dir), /migration 002_bad\.sql failed/);
  // The failed file rolled back: its table is absent, the earlier file stays,
  // and the database is still usable.
  const tables = (name: string) =>
    db.get<{ n: number }>("SELECT count(*) AS n FROM sqlite_master WHERE name = ?", name)!.n;
  assert.equal(tables("t_bad"), 0);
  assert.equal(tables("t_ok"), 1);
  db.run("INSERT INTO t_ok (id) VALUES (1)");
  db.close();
});
