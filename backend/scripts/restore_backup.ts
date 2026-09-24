#!/usr/bin/env node
/**
 * Offline SQLite restore tool.
 *
 * The running HTTP process never replaces its own database. Stop the service,
 * verify a snapshot, then run this command with --confirm. The current target
 * (including SQLite sidecars) is retained as a timestamped .pre-restore copy
 * and the verified snapshot is installed with an atomic same-directory rename.
 */
import {
  chmodSync, constants, existsSync, fstatSync, fsyncSync, mkdirSync, openSync,
  readSync, renameSync, unlinkSync, writeSync, closeSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { inspectBackup } from "../src/db.ts";

function value(name: string): string {
  const index = process.argv.indexOf(name);
  const result = index >= 0 ? process.argv[index + 1] : undefined;
  if (!result || result.startsWith("--")) throw new Error(`${name} requires a value`);
  return result;
}

if (!process.argv.includes("--confirm")) {
  console.error("Refusing restore: pass --confirm after stopping the backend");
  process.exit(2);
}

/**
 * Copy from an already-open descriptor, not from the backup pathname. This
 * closes the inspect/copy TOCTOU window: a symlink or replacement at the
 * pathname cannot change the bytes that are installed after verification.
 */
function copyBackupDescriptor(source: string, destination: string, expected: string | null) {
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const sourceFd = openSync(source, constants.O_RDONLY | noFollow);
  let destinationFd: number | null = null;
  try {
    const before = fstatSync(sourceFd);
    if (!before.isFile() || before.size === 0) {
      throw new Error("backup is not a non-empty regular file");
    }
    const mode = before.mode & 0o7777;
    destinationFd = openSync(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, mode);
    const hash = createHash("sha256");
    const chunk = Buffer.allocUnsafe(1024 * 1024);
    let remaining = before.size;
    let position = 0;
    while (remaining > 0) {
      const want = Math.min(chunk.length, remaining);
      const read = readSync(sourceFd, chunk, 0, want, position);
      if (read <= 0) throw new Error("backup changed while it was being copied");
      let written = 0;
      while (written < read) {
        written += writeSync(destinationFd, chunk, written, read - written);
      }
      hash.update(chunk.subarray(0, read));
      position += read;
      remaining -= read;
    }
    const after = fstatSync(sourceFd);
    if (after.size !== before.size || after.dev !== before.dev || after.ino !== before.ino) {
      throw new Error("backup changed while it was being copied");
    }
    const sha256 = hash.digest("hex");
    if (expected !== null && sha256 !== expected) throw new Error("backup checksum mismatch");
    fsyncSync(destinationFd);
    return { bytes: before.size, mode, sha256 };
  } finally {
    if (destinationFd !== null) closeSync(destinationFd);
    closeSync(sourceFd);
  }
}

try {
  const backup = resolve(value("--backup"));
  const target = resolve(value("--target"));
  const expected = process.argv.includes("--sha256") ? value("--sha256") : null;
  if (backup === target) throw new Error("backup and target must be different files");
  if (expected !== null && !/^[a-f0-9]{64}$/.test(expected)) {
    throw new Error("--sha256 must be a 64-character lowercase SHA-256 digest");
  }

  const targetDirectory = dirname(target);
  mkdirSync(targetDirectory, { recursive: true });
  const temporary = `${target}.restore-${randomUUID()}.tmp`;
  const previous = `${target}.pre-restore-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`;
  const sidecars = ["", "-wal", "-shm", "-journal"];
  const moved: Array<{ original: string; retained: string }> = [];
  let installed = false;

  try {
    const copiedSource = copyBackupDescriptor(backup, temporary, expected);
    // Validate the exact temporary bytes that will be renamed into place.
    const copied = inspectBackup(temporary, copiedSource.sha256);
    chmodSync(temporary, copiedSource.mode);
    const inspection = { ...copied, path: backup };

    // WAL/shm/journal files belong to the old main database. Keeping them next
    // to a newly restored target would let SQLite replay stale pages.
    for (const suffix of sidecars) {
      const original = `${target}${suffix}`;
      if (!existsSync(original)) continue;
      const retained = `${previous}${suffix}`;
      renameSync(original, retained);
      moved.push({ original, retained });
    }
    renameSync(temporary, target);
    installed = true;

    const fd = openSync(target, constants.O_RDONLY);
    try { fsyncSync(fd); } finally { closeSync(fd); }
    const dirFd = openSync(targetDirectory, constants.O_RDONLY);
    try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
    console.log(JSON.stringify({
      restored: target,
      previous: moved.length > 0 ? previous : null,
      backup: inspection,
      copied,
    }, null, 2));
  } catch (error) {
    // If installation happened but a later fsync failed, first move the new
    // candidate out of the way. Then put every retained old file back.
    if (installed && existsSync(target)) {
      try { renameSync(target, temporary); } catch { /* preserve original error */ }
    }
    for (const item of [...moved].reverse()) {
      if (existsSync(item.retained) && !existsSync(item.original)) {
        try { renameSync(item.retained, item.original); } catch { /* preserve original error */ }
      }
    }
    if (existsSync(temporary)) {
      try { unlinkSync(temporary); } catch { /* preserve original error */ }
    }
    throw error;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
