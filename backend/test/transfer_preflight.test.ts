/**
 * Catalog item 127 end-to-end: the operator preflight must be an executable
 * gate, not a document. These tests run the real CLI (`spawn`) against the
 * checked-in example policy and against deliberately hostile batches: a
 * cross-chain velocity breach, an instant above-threshold transfer, and a
 * serialized instruction that does not match the decoded intent.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const script = join(repoRoot, "backend", "scripts", "transfer_preflight.ts");
const policyPath = join(repoRoot, "ops", "transfer_policy.example.json");
const batchPath = join(repoRoot, "ops", "transfer_batch.example.json");
const emptyHistory = join(repoRoot, "ops", "transfer_history.example.json");

interface RunResult { code: number; stdout: string; stderr: string }

function run(args: string[]): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(process.execPath, ["--experimental-strip-types", script, ...args],
      { cwd: repoRoot, timeout: 30_000 }, (error, stdout, stderr) => {
        const code = error && "code" in error && typeof error.code === "number" ? error.code : error ? 1 : 0;
        resolve({ code, stdout, stderr });
      });
  });
}

const NOW = "2026-09-28T00:00:00Z";
const CREATED = Date.parse(NOW);

test("item 127: the example batch passes preflight and prints the human decode", async () => {
  const result = await run(["--policy", policyPath, "--batch", batchPath,
    "--history", emptyHistory, "--warm-balance", "2000000000", "--now", NOW]);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /AUTHORISED/);
  assert.match(result.stdout, /amount_micro=750000000/);
  assert.match(result.stdout, /to=FZcLDdUrs6i1HYFFK2NhqNrbVaP6KTvrqzhyoDGT6CV9/);
  assert.match(result.stdout, /total 750000000 micro/);
});

test("item 127: velocity is summed across chains, so a fresh batch on another chain still fails", async () => {
  const dir = mkdtempSync(join(tmpdir(), "preflight-"));
  const historyPath = join(dir, "history.json");
  writeFileSync(historyPath, JSON.stringify([
    { chain: "solana-devnet", recipient: "2RaaXKUutemHtSZUsmnEv41ytWMkaXD6rcoziHGLRtmj",
      amountMicro: 9_500_000_000, executedAt: CREATED - 60_000, batchId: "earlier", intentHash: "deadbeef" },
  ]));
  const result = await run(["--policy", policyPath, "--batch", batchPath,
    "--history", historyPath, "--warm-balance", "2000000000", "--now", NOW]);
  assert.equal(result.code, 1, result.stdout);
  assert.match(result.stdout, /REFUSED/);
  assert.match(result.stdout, /hour-budget-exceeded/);
});

test("item 127: an above-threshold transfer is refused until it has been queued and the delay elapsed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "preflight-"));
  const batch = JSON.parse(readFileSync(batchPath, "utf8")) as {
    transfers: Record<string, unknown>[];
  };
  batch.transfers[0]!.amountMicro = 3_000_000_000;
  batch.transfers[0]!.approvals = ["ops-a", "ops-b"];
  const decoded = { ...batch.transfers[0] };
  delete (decoded as Record<string, unknown>)["decodedText"];
  delete (decoded as Record<string, unknown>)["signedIntentHash"];
  const { describeIntent, intentHash } = await import("../src/tx_policy.ts");
  batch.transfers[0]!.decodedText = describeIntent(decoded as never);
  batch.transfers[0]!.signedIntentHash = intentHash(decoded as never);
  const path = join(dir, "batch.json");
  writeFileSync(path, JSON.stringify(batch));

  const instant = await run(["--policy", policyPath, "--batch", path,
    "--history", emptyHistory, "--warm-balance", "5000000000", "--now", NOW]);
  assert.equal(instant.code, 1, instant.stdout);
  assert.match(instant.stdout, /delay-not-queued/);

  const queuedPath = join(dir, "queued.json");
  const queued = await run(["--policy", policyPath, "--batch", path, "--queue", "--out", queuedPath,
    "--history", emptyHistory, "--warm-balance", "5000000000", "--now", NOW]);
  assert.equal(queued.code, 0, queued.stdout);
  assert.match(queued.stdout, /execute_after=2026-09-29T00:00:00.000Z/);
  assert.match(queued.stdout, /queued batch written to/);

  // Same day: still inside the delay window, still refused.
  const tooEarly = await run(["--policy", policyPath, "--batch", queuedPath,
    "--history", emptyHistory, "--warm-balance", "5000000000", "--now", "2026-09-28T12:00:00Z"]);
  assert.equal(tooEarly.code, 1, tooEarly.stdout);
  assert.match(tooEarly.stdout, /delay-not-elapsed/);

  // After the delay the queued batch is authorised — and only then.
  const executed = await run(["--policy", policyPath, "--batch", queuedPath,
    "--history", emptyHistory, "--warm-balance", "5000000000", "--now", "2026-09-29T00:00:00Z"]);
  assert.equal(executed.code, 0, executed.stdout);
  assert.match(executed.stdout, /AUTHORISED/);
});

test("item 127: a serialized instruction that disagrees with the decode is refused", async () => {
  const dir = mkdtempSync(join(tmpdir(), "preflight-"));
  const serializedPath = join(dir, "serialized.json");
  writeFileSync(serializedPath, JSON.stringify([
    "transfer amount_micro=999999999 to=FZcLDdUrs6i1HYFFK2NhqNrbVaP6KTvrqzhyoDGT6CV9",
  ]));
  const result = await run(["--policy", policyPath, "--batch", batchPath,
    "--history", emptyHistory, "--serialized", serializedPath,
    "--warm-balance", "2000000000", "--now", NOW]);
  assert.equal(result.code, 1, result.stdout);
  assert.match(result.stderr, /preflight failed: serialized instruction 0/);
});

test("item 127: a halted policy stops everything, whatever the batch says", async () => {
  const dir = mkdtempSync(join(tmpdir(), "preflight-"));
  const policy = JSON.parse(readFileSync(policyPath, "utf8")) as Record<string, unknown>;
  policy["halted"] = true;
  const path = join(dir, "policy.json");
  writeFileSync(path, JSON.stringify(policy));
  const result = await run(["--policy", path, "--batch", batchPath,
    "--history", emptyHistory, "--warm-balance", "2000000000", "--now", NOW]);
  assert.equal(result.code, 1, result.stdout);
  assert.match(result.stdout, /policy-halted/);
});
