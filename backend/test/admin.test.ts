/**
 * Tranche-A admin plane tests: role separation, constant-time auth behavior,
 * the propose -> approve/reject workflow, expiry, append-only audit, backups,
 * ledger stats and list pagination.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  authenticate, getJson, makeTestServer, makeWallet, postJson, startTestApp,
} from "./helpers.ts";
import type { App } from "../src/server.ts";
import type { Config } from "../src/config.ts";
import { Db } from "../src/db.ts";

const OPERATOR = "operator-token-abc";
const SUPERADMIN = "superadmin-token-xyz";

async function withApp<T>(
  overrides: Partial<Config>,
  fn: (base: string, app: App) => Promise<T>,
): Promise<T> {
  const { app, base } = await startTestApp({
    operatorToken: OPERATOR,
    superadminToken: SUPERADMIN,
    ...overrides,
  });
  try {
    return await fn(base, app);
  } finally {
    await app.close();
  }
}

/** Start an app whose game-server key we hold, then ingest one accepted event. */
async function withSeededApp<T>(fn: (base: string, app: App, epochId: number) => Promise<T>): Promise<T> {
  const server = makeTestServer();
  return withApp({
    serverSigningPublicKey: server.publicKeyBase64,
    epochMs: 3_600_000,
    capPerMatchMicro: 10_000,
    capDailyMicro: 100_000,
    capWeeklyMicro: 500_000,
  }, async (base, app) => {
    const wallet = makeWallet();
    const auth = await authenticate(base, wallet);
    const token = auth.json.session_token as string;
    const binding = auth.json.wallet_binding_id as string;
    await postJson(base, "/v1/wallet/link", { player_id: "admin-p1" }, token);
    const ingested = await postJson(base, "/v1/rewards/events", {
      events: [server.signEvent({
        match_id: "m1", player_id: "admin-p1", wallet_binding_id: binding,
        event_type: "match_win", amount_micro: 500, occurred_at: Date.now(),
      })],
    });
    assert.equal(ingested.json.results[0].status, "accepted");
    const epochs = await getJson(base, "/v1/rewards/epochs");
    return fn(base, app, epochs.json[0].id as number);
  });
}

test("admin routes are disabled without tokens", async () => {
  const { app, base } = await startTestApp({
    operatorToken: null, superadminToken: null, adminToken: null,
  });
  try {
    const paths: [string, string][] = [
      ["POST", "/v1/admin/proposals"], ["POST", "/v1/admin/proposals/approve"],
      ["POST", "/v1/admin/proposals/reject"], ["GET", "/v1/admin/proposals"],
      ["GET", "/v1/admin/audit"], ["POST", "/v1/admin/backup"],
      ["GET", "/v1/admin/backups"], ["GET", "/v1/admin/ledger-stats"],
    ];
    for (const [method, path] of paths) {
      const res = method === "POST"
        ? await postJson(base, path, {}, "whatever")
        : await getJson(base, path, "whatever");
      assert.equal(res.status, 503, path);
      assert.equal(res.json.error.code, "admin-disabled", path);
    }
  } finally {
    await app.close();
  }
});

test("lookalike tokens are rejected with a flat 403", () => withApp({}, async (base) => {
  for (const token of [OPERATOR.slice(0, -1), `${OPERATOR}x`, "x".repeat(200), SUPERADMIN.toUpperCase()]) {
    const res = await postJson(base, "/v1/admin/proposals",
      { type: "seal-reward-epoch", params: { epoch_id: 1 } }, token);
    assert.equal(res.status, 403, JSON.stringify(token));
    assert.equal(res.json.error.code, "admin-forbidden");
  }
  const anon = await postJson(base, "/v1/admin/proposals",
    { type: "seal-reward-epoch", params: { epoch_id: 1 } });
  assert.equal(anon.status, 403);
  // The wrong role is also a flat 403, not a distinct oracle.
  const proposed = await postJson(base, "/v1/admin/proposals",
    { type: "seal-reward-epoch", params: { epoch_id: 1 } }, OPERATOR);
  assert.equal(proposed.status, 200);
  const denied = await postJson(base, "/v1/admin/proposals/approve",
    { proposal_id: proposed.json.id }, OPERATOR);
  assert.equal(denied.status, 403);
  assert.equal(denied.json.error.code, "admin-forbidden");
}));

test("operator proposes, superadmin approves: seal executes and audits", () =>
  withSeededApp(async (base, _app, epochId) => {
    const badType = await postJson(base, "/v1/admin/proposals",
      { type: "mint-money", params: {} }, OPERATOR);
    assert.equal(badType.status, 400);
    assert.equal(badType.json.error.code, "bad-proposal-type");
    const badParams = await postJson(base, "/v1/admin/proposals",
      { type: "seal-reward-epoch", params: { epoch_id: "x" } }, OPERATOR);
    assert.equal(badParams.status, 400);

    const proposed = await postJson(base, "/v1/admin/proposals",
      { type: "seal-reward-epoch", params: { epoch_id: epochId } }, OPERATOR);
    assert.equal(proposed.status, 200);
    assert.equal(proposed.json.status, "open");
    assert.equal(proposed.json.proposed_by_role, "operator");
    // Attribution is a fingerprint, never the secret.
    assert.equal(proposed.json.proposed_by_hash, createHash("sha256").update(OPERATOR).digest("hex"));
    assert.ok(!JSON.stringify(proposed.json).includes(OPERATOR));
    const id = proposed.json.id as string;

    const approved = await postJson(base, "/v1/admin/proposals/approve",
      { proposal_id: id }, SUPERADMIN);
    assert.equal(approved.status, 200);
    assert.equal(approved.json.row.status, "executed");
    assert.equal(approved.json.selfApproved, false);
    assert.equal(approved.json.result.epoch.state, "sealed");
    assert.equal(approved.json.result.epoch.total_micro, 500);
    assert.equal(approved.json.result.audit_root, approved.json.result.epoch.merkle_root);

    const reapproved = await postJson(base, "/v1/admin/proposals/approve",
      { proposal_id: id }, SUPERADMIN);
    assert.equal(reapproved.status, 409);
    assert.equal(reapproved.json.error.code, "proposal-executed");

    const list = await getJson(base, "/v1/admin/proposals?limit=10&offset=0", OPERATOR);
    assert.equal(list.json.pagination.total, 1);
    assert.equal(list.json.proposals[0].status, "executed");

    const audit = await getJson(base, "/v1/admin/audit", OPERATOR);
    const actions = (audit.json.entries as { action: string }[]).map((e) => e.action);
    assert.ok(actions.includes("proposal-created"));
    assert.ok(actions.includes("proposal-approved"));
    assert.ok(!JSON.stringify(audit.json).includes(OPERATOR));
    assert.ok(!JSON.stringify(audit.json).includes(SUPERADMIN));
  }));

test("split roles reject self-approval; legacy single token allows it flagged", () =>
  withSeededApp(async (base, _app, epochId) => {
    // A superadmin proposing under split roles cannot approve their own row.
    const own = await postJson(base, "/v1/admin/proposals",
      { type: "seal-reward-epoch", params: { epoch_id: epochId } }, SUPERADMIN);
    const selfDenied = await postJson(base, "/v1/admin/proposals/approve",
      { proposal_id: own.json.id }, SUPERADMIN);
    assert.equal(selfDenied.status, 403);
    assert.equal(selfDenied.json.error.code, "distinct-approver-required");
    // …but may still reject it to clear the queue.
    const rejected = await postJson(base, "/v1/admin/proposals/reject",
      { proposal_id: own.json.id, reason: "wrong epoch" }, SUPERADMIN);
    assert.equal(rejected.json.status, "rejected");
    const afterReject = await postJson(base, "/v1/admin/proposals/approve",
      { proposal_id: own.json.id }, SUPERADMIN);
    assert.equal(afterReject.status, 409);
    assert.equal(afterReject.json.error.code, "proposal-rejected");
  }));

test("legacy single token self-approves with an audit flag", async () => {
  const server = makeTestServer();
  const { app, base } = await startTestApp({
    operatorToken: null, superadminToken: null, adminToken: "legacy-one",
    serverSigningPublicKey: server.publicKeyBase64, epochMs: 3_600_000,
  });
  try {
    const wallet = makeWallet();
    const auth = await authenticate(base, wallet);
    const token = auth.json.session_token as string;
    await postJson(base, "/v1/wallet/link", { player_id: "legacy-p1" }, token);
    await postJson(base, "/v1/rewards/events", {
      events: [server.signEvent({
        match_id: "m1", player_id: "legacy-p1",
        wallet_binding_id: auth.json.wallet_binding_id as string,
        event_type: "match_win", amount_micro: 100, occurred_at: Date.now(),
      })],
    });
    const epochs = await getJson(base, "/v1/rewards/epochs");
    const epochId = epochs.json[0].id as number;
    const proposed = await postJson(base, "/v1/admin/proposals",
      { type: "seal-reward-epoch", params: { epoch_id: epochId } }, "legacy-one");
    assert.equal(proposed.status, 200);
    const approved = await postJson(base, "/v1/admin/proposals/approve",
      { proposal_id: proposed.json.id }, "legacy-one");
    assert.equal(approved.status, 200);
    assert.equal(approved.json.selfApproved, true);
    assert.equal(approved.json.result.epoch.state, "sealed");
    const audit = await getJson(base, "/v1/admin/audit", "legacy-one");
    const entry = (audit.json.entries as { action: string; params: string }[])
      .find((e) => e.action === "proposal-approved");
    assert.ok(entry && JSON.parse(entry.params).self_approved === true);
  } finally {
    await app.close();
  }
});

test("proposals expire and read back as expired", () => withApp(
  { adminProposalTtlMs: 5 }, async (base) => {
    const proposed = await postJson(base, "/v1/admin/proposals",
      { type: "seal-reward-epoch", params: { epoch_id: 1 } }, OPERATOR);
    await new Promise((r) => setTimeout(r, 15));
    const approved = await postJson(base, "/v1/admin/proposals/approve",
      { proposal_id: proposed.json.id }, SUPERADMIN);
    assert.equal(approved.status, 410);
    assert.equal(approved.json.error.code, "proposal-expired");
    const list = await getJson(base, "/v1/admin/proposals", OPERATOR);
    assert.equal(list.json.proposals[0].status, "expired");
  }));

test("failed execution keeps the proposal open and audits the failure", () => withApp({}, async (base) => {
  const proposed = await postJson(base, "/v1/admin/proposals",
    { type: "seal-reward-epoch", params: { epoch_id: 424242 } }, OPERATOR);
  const approved = await postJson(base, "/v1/admin/proposals/approve",
    { proposal_id: proposed.json.id }, SUPERADMIN);
  assert.equal(approved.status, 404);
  assert.equal(approved.json.error.code, "epoch-not-found");
  const list = await getJson(base, "/v1/admin/proposals", OPERATOR);
  assert.equal(list.json.proposals[0].status, "open");
  const audit = await getJson(base, "/v1/admin/audit", OPERATOR);
  const actions = (audit.json.entries as { action: string }[]).map((e) => e.action);
  assert.ok(actions.includes("proposal-approve-failed"));
}));

test("audit log and proposals are append-only in SQL", () => withApp({}, async (base, app) => {
  const proposed = await postJson(base, "/v1/admin/proposals",
    { type: "seal-reward-epoch", params: { epoch_id: 1 } }, OPERATOR);
  assert.equal(proposed.status, 200);
  assert.throws(() => app.db.run("UPDATE admin_audit SET action = 'x' WHERE id = 1"));
  assert.throws(() => app.db.run("DELETE FROM admin_audit WHERE id = 1"));
  assert.throws(() => app.db.run("DELETE FROM admin_proposals WHERE id = ?", proposed.json.id as string));
  // Illegal transition: open -> open (status rewrite) is rejected by trigger.
  assert.throws(() => app.db.run(
    "UPDATE admin_proposals SET status = 'open' WHERE id = ?", proposed.json.id as string));
  // The queue still holds the untouched proposal.
  const list = await getJson(base, "/v1/admin/proposals", OPERATOR);
  assert.equal(list.json.pagination.total, 1);
}));

test("backup creates a restorable snapshot; operators cannot trigger it", () => {
  const dir = mkdtempSync(join(tmpdir(), "neon-backup-"));
  return withApp({ backupDir: dir }, async (base) => {
    const denied = await postJson(base, "/v1/admin/backup", {}, OPERATOR);
    assert.equal(denied.status, 403);
    const made = await postJson(base, "/v1/admin/backup", {}, SUPERADMIN);
    assert.equal(made.status, 200);
    assert.match(made.json.file as string, /^neonrelay-.*\.db$/);
    assert.ok((made.json.bytes as number) > 0);
    const full = join(dir, made.json.file as string);
    const bytes = readFileSync(full);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), made.json.sha256);
    // The snapshot opens as a working database with our schema.
    const copy = new Db(full);
    try {
      const tables = copy.all<{ n: string }>(
        "SELECT name AS n FROM sqlite_master WHERE type = 'table'");
      assert.ok(tables.some((t) => t.n === "admin_audit"));
      assert.ok(tables.some((t) => t.n === "reward_events"));
    } finally {
      copy.close();
    }
    const listed = await getJson(base, "/v1/admin/backups", OPERATOR);
    assert.equal(listed.json.backups.length, 1);
    assert.equal(listed.json.backups[0].file, made.json.file);
    rmSync(dir, { recursive: true, force: true });
  });
});

test("ledger-stats reports table sizes for operators", () =>
  withSeededApp(async (base, _app, _epoch) => {
    const denied = await getJson(base, "/v1/admin/ledger-stats");
    assert.equal(denied.status, 403);
    const stats = await getJson(base, "/v1/admin/ledger-stats", OPERATOR);
    assert.equal(stats.status, 200);
    assert.ok((stats.json.db_bytes as number) > 0);
    assert.equal(stats.json.tables.reward_events, 1);
    assert.equal(stats.json.tables.reward_epochs, 1);
    assert.ok(stats.json.tables.schema_migrations >= 8);
  }));

test("legacy list routes paginate without breaking the default shape", () =>
  withSeededApp(async (base, _app, _epoch) => {
    const legacy = await getJson(base, "/v1/rewards/epochs");
    assert.ok(Array.isArray(legacy.json));
    const page = await getJson(base, "/v1/rewards/epochs?limit=1&offset=0");
    assert.equal(page.json.epochs.length, 1);
    assert.deepEqual(page.json.pagination, { limit: 1, offset: 0, total: 1 });
    const empty = await getJson(base, "/v1/rewards/epochs?limit=1&offset=5");
    assert.deepEqual(empty.json.epochs, []);
    assert.equal(empty.json.pagination.total, 1);
    const bad = await getJson(base, "/v1/rewards/epochs?limit=9999");
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error.code, "bad-pagination");
    const badOffset = await getJson(base, "/v1/rewards/epochs?offset=-1");
    assert.equal(badOffset.status, 400);
  }));
