/**
 * SQLite access (node:sqlite, Node >= 22) and forward-only migrations.
 *
 * Migrations are plain SQL files in `backend/migrations`, applied in
 * lexicographic order and recorded in `schema_migrations`. There is no
 * downgrade path by design: production changes go through a new migration.
 */
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, mkdirSync, lstatSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = resolve(HERE, "..", "migrations");

export class Db {
  readonly raw: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.raw = new DatabaseSync(path);
    this.raw.exec("PRAGMA journal_mode = WAL;");
    this.raw.exec("PRAGMA foreign_keys = ON;");
  }

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  run(sql: string, ...args: (string | number | null)[]): void {
    this.raw.prepare(sql).run(...args);
  }

  /** INSERT helper returning the new row id (node:sqlite lastInsertRowid). */
  runInsert(sql: string, ...args: (string | number | null)[]): number {
    return Number(this.raw.prepare(sql).run(...args).lastInsertRowid);
  }

  get<T>(sql: string, ...args: (string | number | null)[]): T | undefined {
    return this.raw.prepare(sql).get(...args) as T | undefined;
  }

  all<T>(sql: string, ...args: (string | number | null)[]): T[] {
    return this.raw.prepare(sql).all(...args) as T[];
  }

  close(): void {
    this.raw.close();
  }
}

export interface BackupInspection {
  path: string;
  bytes: number;
  sha256: string;
  integrity: "ok";
  migration_count: number;
}

/**
 * Verify a SQLite snapshot without opening it in writable mode. This is used
 * by the API and the offline restore command before any atomic replacement.
 */
export function inspectBackup(path: string, expectedSha256?: string | null): BackupInspection {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) {
    throw new Error("backup is not a non-empty regular file");
  }
  const sha256 = createHash("sha256").update(readFileSync(path)).digest("hex");
  if (expectedSha256 !== undefined && expectedSha256 !== null && sha256 !== expectedSha256) {
    throw new Error("backup checksum mismatch");
  }
  const backup = new DatabaseSync(path, { readOnly: true });
  try {
    const integrity = backup.prepare("PRAGMA integrity_check").get() as { integrity_check?: unknown } | undefined;
    if (integrity?.integrity_check !== "ok") throw new Error("SQLite integrity_check failed");
    const row = backup.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get() as { n?: unknown } | undefined;
    if (typeof row?.n !== "number") throw new Error("backup has no readable schema_migrations table");
    return { path, bytes: stat.size, sha256, integrity: "ok", migration_count: row.n };
  } finally {
    backup.close();
  }
}

export interface MigrationRow {
  id: string;
  applied_at: number;
}

/** Apply every not-yet-applied migration; returns the ids applied now. */
export function migrate(db: Db, dir: string = MIGRATIONS_DIR): string[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id TEXT PRIMARY KEY,
    applied_at INTEGER NOT NULL
  );`);
  const applied = new Set(
    db.all<MigrationRow>("SELECT id FROM schema_migrations").map((r) => r.id),
  );
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const now: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(dir, file), "utf8");
    db.raw.exec("BEGIN");
    try {
      db.raw.exec(sql);
      db.raw.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)")
        .run(file, Date.now());
      db.raw.exec("COMMIT");
    } catch (err) {
      db.raw.exec("ROLLBACK");
      throw new Error(`migration ${file} failed: ${(err as Error).message}`);
    }
    now.push(file);
  }
  return now;
}

export function migrationCount(db: Db): number {
  const row = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM schema_migrations");
  return row?.n ?? 0;
}
