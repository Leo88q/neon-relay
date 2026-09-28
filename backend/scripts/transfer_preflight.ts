#!/usr/bin/env node
/**
 * Operator preflight for every outbound transfer (catalog item 127).
 *
 * Run this before proposing anything to the treasury multisig:
 *
 *   node --experimental-strip-types backend/scripts/transfer_preflight.ts \
 *     --policy ops/transfer_policy.example.json \
 *     --batch  ops/transfer_batch.example.json \
 *     --history ops/transfer_history.example.json \
 *     --warm-balance 500000000
 *
 * Above-threshold transfers are queued first:
 *
 *   ... --queue --out ops/queued/2026-09-28-a.json       # records queuedAt, prints execute_after
 *   ... --policy ... --batch ops/queued/2026-09-28-a.json # after the delay: executes
 *
 * Exit 0 means the batch is authorised by policy; exit 1 prints every
 * violation and the batch must not be signed. `--queue` records the delay for
 * above-threshold transfers instead of executing them.
 *
 * The tool reads JSON files, evaluates the pure policy engine and prints a
 * human-readable decode of each transfer. It never touches a key, an RPC or a
 * transaction: "what the operator reads" is produced by the same code that
 * hashes the intent (`assertSerializedMatchesBatch` compares the instructions
 * the signer will actually see against this decode).
 */
import { readFileSync, writeFileSync } from "node:fs";
import {
  assertPolicyShape, assertSerializedMatchesBatch, evaluateTransferBatch,
  queueDelayedTransfer,
  type EvaluationContext, type LedgerEntry, type TransferBatch, type TransferPolicy,
} from "../src/tx_policy.ts";

interface Args {
  policy: string;
  batch: string;
  history: string | null;
  serialized: string | null;
  warmBalance: number;
  now: number;
  queue: boolean;
  /** With --queue: where to write the queued batch (queuedAt added to intents). */
  out: string | null;
}

function parseArgs(argv: string[]): Args {
  const value = (name: string): string | null => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] ?? null : null;
  };
  const policy = value("--policy");
  const batch = value("--batch");
  if (!policy || !batch) {
    console.error("usage: transfer_preflight.ts --policy <file> --batch <file> " +
      "[--history <file>] [--serialized <file>] [--warm-balance <micro>] [--now <ISO>] [--queue [--out <file>]]");
    process.exit(2);
  }
  return {
    policy,
    batch,
    history: value("--history"),
    serialized: value("--serialized"),
    warmBalance: Number(value("--warm-balance") ?? "0"),
    now: value("--now") ? Date.parse(value("--now")!) : Date.now(),
    queue: argv.includes("--queue"),
    out: value("--out"),
  };
}

export function preflight(args: Args): { ok: boolean; lines: string[] } {
  const lines: string[] = [];
  const policy = JSON.parse(readFileSync(args.policy, "utf8")) as TransferPolicy;
  assertPolicyShape(policy);
  let batch = JSON.parse(readFileSync(args.batch, "utf8")) as TransferBatch;
  const history = args.history
    ? JSON.parse(readFileSync(args.history, "utf8")) as LedgerEntry[]
    : [];
  const context: EvaluationContext = {
    history,
    now: args.now,
    warmWalletBalanceMicro: args.warmBalance,
    seenBatchIds: [...new Set(history.map((entry) => entry.batchId))],
  };
  if (args.queue) {
    batch = {
      ...batch,
      transfers: batch.transfers.map((intent) => queueDelayedTransfer(policy, intent, args.now).intent),
    };
    if (args.out) {
      writeFileSync(args.out, `${JSON.stringify(batch, null, 2)}\n`);
      lines.push(`queued batch written to ${args.out} (execute after the printed delay, without --queue)`);
    }
  }
  const verdict = evaluateTransferBatch(policy, batch, context, { queueing: args.queue });
  lines.push(`policy version ${policy.version} (${args.policy})`);
  lines.push(`batch ${batch.batchId} with ${batch.transfers.length} transfer(s)`);
  verdict.decoded.forEach((text, index) => {
    const when = verdict.executeAfter[index] && verdict.executeAfter[index]! > args.now
      ? ` execute_after=${new Date(verdict.executeAfter[index]!).toISOString()}` : "";
    lines.push(`  [${index}] ${text}${when}`);
  });
  lines.push(`  total ${verdict.totals.grandTotalMicro} micro across ${Object.keys(verdict.totals.perChainMicro).length} chain(s)`);
  if (!verdict.ok) {
    lines.push("REFUSED:");
    for (const violation of verdict.violations) {
      lines.push(`  - [${violation.code}] ${violation.index >= 0 ? `transfer #${violation.index}: ` : ""}${violation.detail}`);
    }
    return { ok: false, lines };
  }
  if (args.serialized) {
    const serialized = JSON.parse(readFileSync(args.serialized, "utf8")) as string[];
    assertSerializedMatchesBatch(verdict, serialized);
    lines.push("serialized instructions match the evaluated intents");
  }
  lines.push("AUTHORISED (nothing was signed; propose only this batch)");
  return { ok: true, lines };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "")) {
  try {
    const result = preflight(parseArgs(process.argv));
    for (const line of result.lines) console.log(line);
    process.exit(result.ok ? 0 : 1);
  } catch (error) {
    console.error(`preflight failed: ${(error as Error).message}`);
    process.exit(1);
  }
}
