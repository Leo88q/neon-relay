import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db, inspectBackup, migrate } from "../src/db.ts";
import { postJson, startTestApp } from "./helpers.ts";

function createDb(path: string, marker: string): void {
  const db = new Db(path);
  migrate(db);
  db.run("INSERT INTO wallet_bindings (id, public_key, label, player_id, created_at, revoked_at) VALUES (?, ?, ?, NULL, ?, NULL)",
    `binding-${marker}`, Buffer.alloc(32, marker === "backup" ? 7 : 8).toString("base64url"), marker, Date.now());
  db.close();
}

test("restore drill verifies, atomically installs, preserves mode, and rejects a bad checksum", () => {
  const dir = mkdtempSync(join(tmpdir(), "neonrelay-restore-drill-"));
  try {
    const backup = join(dir, "backup.db");
    const target = join(dir, "live", "neonrelay.db");
    createDb(backup, "backup");
    createDb(target, "live");
    const backupMode = statSync(backup).mode & 0o7777;
    const output = execFileSync(process.execPath, [
      "--experimental-strip-types", "scripts/restore_backup.ts",
      "--backup", backup, "--target", target, "--confirm",
    ], { cwd: join(process.cwd()), encoding: "utf8" });
    const result = JSON.parse(output) as { previous: string | null; copied: { sha256: string } };
    assert.ok(result.previous);
    assert.equal(result.copied.sha256.length, 64);
    assert.equal(statSync(target).mode & 0o7777, backupMode);
    const restored = new Db(target);
    assert.equal(restored.get<{ label: string }>("SELECT label FROM wallet_bindings WHERE id = ?", "binding-backup")?.label, "backup");
    assert.equal(restored.get<{ n: number }>("SELECT COUNT(*) AS n FROM wallet_bindings WHERE id = 'binding-live'")?.n, 0);
    restored.close();

    const before = readFileSync(target);
    assert.throws(() => execFileSync(process.execPath, [
      "--experimental-strip-types", "scripts/restore_backup.ts",
      "--backup", backup, "--target", target, "--confirm", "--sha256", "0".repeat(64),
    ], { cwd: join(process.cwd()), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
    assert.deepEqual(readFileSync(target), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("backup inspection rejects symlink paths", () => {
  const dir = mkdtempSync(join(tmpdir(), "neonrelay-restore-symlink-"));
  try {
    const backup = join(dir, "backup.db");
    const link = join(dir, "backup-link.db");
    createDb(backup, "backup");
    symlinkSync(backup, link);
    assert.throws(() => inspectBackup(link), /regular file/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("restore opens the backup without following a symlink and leaves the target unchanged", () => {
  const dir = mkdtempSync(join(tmpdir(), "neonrelay-restore-race-"));
  try {
    const real = join(dir, "backup.db");
    const link = join(dir, "backup-link.db");
    const target = join(dir, "target.db");
    createDb(real, "backup");
    createDb(target, "live");
    symlinkSync(real, link);
    const before = readFileSync(target);
    assert.throws(() => execFileSync(process.execPath, [
      "--experimental-strip-types", "scripts/restore_backup.ts",
      "--backup", link, "--target", target, "--confirm",
    ], { cwd: process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
    assert.deepEqual(readFileSync(target), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("restore refuses to run without explicit confirmation", () => {
  const dir = mkdtempSync(join(tmpdir(), "neonrelay-restore-confirm-"));
  try {
    const result = execFile(process.execPath, [
      "--experimental-strip-types", "scripts/restore_backup.ts", "--backup", "missing", "--target", "target",
    ], { cwd: process.cwd() });
    return new Promise<void>((resolve, reject) => {
      result.on("close", (code) => {
        try { assert.equal(code, 2); resolve(); } catch (error) { reject(error); }
      });
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("admin restore verification accepts a server-generated .db basename", async () => {
  const dir = mkdtempSync(join(tmpdir(), "neonrelay-restore-route-"));
  const { app, base } = await startTestApp({ backupDir: dir, superadminToken: "restore-superadmin" });
  try {
    const created = await postJson(base, "/v1/admin/backup", {}, "restore-superadmin");
    assert.equal(created.status, 200);
    const verified = await postJson(base, "/v1/admin/restore/verify", {
      file: created.json.file,
      sha256: created.json.sha256,
    }, "restore-superadmin");
    assert.equal(verified.status, 200);
    assert.equal(verified.json.restore, "verified-only");
    assert.equal(verified.json.integrity, "ok");
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
