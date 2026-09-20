/**
 * Tranche-A admin plane: role-separated tokens, constant-time authentication,
 * two-person proposal workflow and an append-only audit log.
 *
 * Roles:
 *   operator   — create proposals (seal / epoch-close), read proposals, audit,
 *                backups and ledger stats. Cannot execute anything alone.
 *   superadmin — approve (execute) or reject proposals, run backups.
 *
 * Legacy `NEONRELAY_ADMIN_TOKEN` acts as a superadmin so single-operator
 * devnet setups keep working; when distinct operator/superadmin tokens are
 * configured, the approver must differ from the proposer. Self-approval in
 * single-token mode is allowed but audit-flagged (`self_approved: true`).
 *
 * Secrets never touch the database: attribution uses sha256(hex) token
 * fingerprints. Comparisons are constant-time over the hashes so tokens of
 * any length compare safely.
 */
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { Config } from "./config.ts";
import type { Db } from "./db.ts";

export type AdminRole = "operator" | "superadmin";

export interface AdminIdentity {
  role: AdminRole;
  /** sha256(hex) fingerprint of the presented token (for audit attribution). */
  fingerprint: string;
  /** True when only one admin token exists, so separation is impossible. */
  singleTokenMode: boolean;
}

/** sha256(hex) fingerprint; also the canonical form for safe comparison. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function constantTimeEqual(a: string, b: string): boolean {
  const ah = createHash("sha256").update(a, "utf8").digest();
  const bh = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ah, bh);
}

/**
 * Authenticate a bearer token against the configured admin tokens.
 * Returns null for missing/unknown tokens. Superadmin is checked first so a
 * token configured in both roles grants the stronger one.
 */
export function authenticateAdmin(config: Config, bearer: string | null): AdminIdentity | null {
  if (!bearer) return null;
  const distinct =
    config.operatorToken !== null && config.superadminToken !== null &&
    config.operatorToken !== config.superadminToken;
  if (config.superadminToken && constantTimeEqual(bearer, config.superadminToken)) {
    return { role: "superadmin", fingerprint: hashToken(bearer), singleTokenMode: !distinct };
  }
  // Legacy single token acts as a superadmin (migration path to role split).
  if (config.adminToken && constantTimeEqual(bearer, config.adminToken)) {
    return { role: "superadmin", fingerprint: hashToken(bearer), singleTokenMode: !distinct };
  }
  if (config.operatorToken && constantTimeEqual(bearer, config.operatorToken)) {
    return { role: "operator", fingerprint: hashToken(bearer), singleTokenMode: !distinct };
  }
  return null;
}

export function adminConfigured(config: Config): boolean {
  return config.adminToken !== null || config.operatorToken !== null || config.superadminToken !== null;
}

export type ProposalType = "seal-reward-epoch" | "close-economy-epoch";
export type ProposalStatus = "open" | "executed" | "rejected" | "expired";

export interface ProposalRow {
  id: string;
  type: ProposalType;
  params: string;
  proposed_by_role: string;
  proposed_by_hash: string;
  created_at: number;
  expires_at: number;
  status: ProposalStatus;
  decided_at: number | null;
  decided_by_hash: string | null;
  result: string | null;
}

export interface AuditRow {
  id: number;
  created_at: number;
  actor_role: string;
  actor_hash: string | null;
  action: string;
  proposal_id: string | null;
  params: string | null;
  result: string | null;
  request_ip: string | null;
}

export class AdminError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const PROPOSAL_TYPES: ProposalType[] = ["seal-reward-epoch", "close-economy-epoch"];

export function parseProposalParams(type: ProposalType, params: unknown): Record<string, number> {
  const body = (params ?? {}) as Record<string, unknown>;
  if (type === "seal-reward-epoch") {
    const epochId = body["epoch_id"];
    if (typeof epochId !== "number" || !Number.isInteger(epochId)) {
      throw new AdminError(400, "bad-request", "epoch_id must be an integer");
    }
    return { epoch_id: epochId };
  }
  const epoch = body["epoch"];
  if (typeof epoch !== "number" || !Number.isInteger(epoch) || epoch <= 0) {
    throw new AdminError(400, "bad-request", "epoch must be a positive integer");
  }
  return { epoch };
}

export class AdminStore {
  private readonly db: Db;
  private readonly config: Config;

  constructor(db: Db, config: Config) {
    this.db = db;
    this.config = config;
  }

  audit(entry: {
    actorRole: string; actorHash?: string | null; action: string;
    proposalId?: string | null; params?: unknown; result?: unknown; ip?: string | null;
  }, now: number = Date.now()): void {
    this.db.run(
      `INSERT INTO admin_audit
         (created_at, actor_role, actor_hash, action, proposal_id, params, result, request_ip)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      now, entry.actorRole, entry.actorHash ?? null, entry.action,
      entry.proposalId ?? null,
      entry.params === undefined ? null : JSON.stringify(entry.params),
      entry.result === undefined ? null : JSON.stringify(entry.result),
      entry.ip ?? null);
  }

  createProposal(
    identity: AdminIdentity, type: unknown, params: unknown, ip: string | null,
    now: number = Date.now(),
  ): ProposalRow {
    if (!PROPOSAL_TYPES.includes(type as ProposalType)) {
      throw new AdminError(400, "bad-proposal-type",
        "type must be one of seal-reward-epoch|close-economy-epoch");
    }
    const clean = parseProposalParams(type as ProposalType, params);
    const row: ProposalRow = {
      id: randomUUID(),
      type: type as ProposalType,
      params: JSON.stringify(clean),
      proposed_by_role: identity.role,
      proposed_by_hash: identity.fingerprint,
      created_at: now,
      expires_at: now + this.config.adminProposalTtlMs,
      status: "open",
      decided_at: null,
      decided_by_hash: null,
      result: null,
    };
    this.db.run(
      `INSERT INTO admin_proposals
         (id, type, params, proposed_by_role, proposed_by_hash, created_at, expires_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'open')`,
      row.id, row.type, row.params, row.proposed_by_role, row.proposed_by_hash,
      row.created_at, row.expires_at);
    this.audit({
      actorRole: identity.role, actorHash: identity.fingerprint,
      action: "proposal-created", proposalId: row.id,
      params: { type: row.type, ...clean }, ip,
    }, now);
    return row;
  }

  getProposal(id: string): ProposalRow {
    const row = this.db.get<ProposalRow>("SELECT * FROM admin_proposals WHERE id = ?", id);
    if (!row) throw new AdminError(404, "proposal-not-found", `no proposal ${id}`);
    return row;
  }

  /** Effective status: an open proposal past its expiry reads as expired. */
  effectiveStatus(row: ProposalRow, now: number = Date.now()): ProposalStatus {
    if (row.status === "open" && now > row.expires_at) return "expired";
    return row.status;
  }

  listProposals(limit: number, offset: number, now: number = Date.now()): { rows: ProposalRow[]; total: number } {
    const total = this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM admin_proposals")?.n ?? 0;
    const rows = this.db.all<ProposalRow>(
      "SELECT * FROM admin_proposals ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?",
      limit, offset);
    return {
      rows: rows.map((r) => ({ ...r, status: this.effectiveStatus(r, now) })),
      total,
    };
  }

  listAudit(limit: number, offset: number): { rows: AuditRow[]; total: number } {
    const total = this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM admin_audit")?.n ?? 0;
    return {
      rows: this.db.all<AuditRow>(
        "SELECT * FROM admin_audit ORDER BY id DESC LIMIT ? OFFSET ?", limit, offset),
      total,
    };
  }

  rejectProposal(
    identity: AdminIdentity, id: string, reason: unknown, ip: string | null,
    now: number = Date.now(),
  ): ProposalRow {
    const row = this.getProposal(id);
    const effective = this.effectiveStatus(row, now);
    if (effective !== "open") {
      throw new AdminError(409, `proposal-${effective}`, `proposal is ${effective}`);
    }
    const text = typeof reason === "string" && reason.length > 0 && reason.length <= 512
      ? reason
      : "rejected by superadmin";
    this.db.run(
      "UPDATE admin_proposals SET status = 'rejected', decided_at = ?, decided_by_hash = ?, result = ? WHERE id = ?",
      now, identity.fingerprint, JSON.stringify({ reason: text }), id);
    this.audit({
      actorRole: identity.role, actorHash: identity.fingerprint,
      action: "proposal-rejected", proposalId: id, params: { reason: text }, ip,
    }, now);
    return this.getProposal(id);
  }

  /**
   * Approve and execute a proposal. The `execute` callback runs the underlying
   * action (seal/close) and returns its result; if it throws, the proposal
   * stays open (approval did not happen) and the failure is audited.
   */
  async approveProposal<T>(
    identity: AdminIdentity, id: string, ip: string | null,
    execute: (row: ProposalRow) => Promise<T> | T,
    now: number = Date.now(),
  ): Promise<{ row: ProposalRow; result: T; selfApproved: boolean }> {
    const row = this.getProposal(id);
    if (this.effectiveStatus(row, now) === "expired") {
      this.db.run(
        "UPDATE admin_proposals SET status = 'expired', decided_at = ?, decided_by_hash = ?, result = ? WHERE id = ?",
        now, identity.fingerprint, JSON.stringify({ reason: "approval after expiry" }), id);
      this.audit({
        actorRole: identity.role, actorHash: identity.fingerprint,
        action: "proposal-expired", proposalId: id, ip,
      }, now);
      throw new AdminError(410, "proposal-expired", "proposal expired before approval");
    }
    if (row.status !== "open") {
      throw new AdminError(409, `proposal-${row.status}`, `proposal is ${row.status}`);
    }
    const selfApproved = row.proposed_by_hash === identity.fingerprint;
    if (selfApproved && !identity.singleTokenMode) {
      throw new AdminError(403, "distinct-approver-required",
        "approver must differ from the proposer when role tokens are split");
    }
    let result: T;
    try {
      result = await execute(row);
    } catch (err) {
      this.audit({
        actorRole: identity.role, actorHash: identity.fingerprint,
        action: "proposal-approve-failed", proposalId: id,
        params: { type: row.type }, result: { error: (err as Error).message }, ip,
      }, now);
      throw err;
    }
    this.db.run(
      "UPDATE admin_proposals SET status = 'executed', decided_at = ?, decided_by_hash = ?, result = ? WHERE id = ?",
      now, identity.fingerprint,
      JSON.stringify({ self_approved: selfApproved, summary: summarize(result) }), id);
    this.audit({
      actorRole: identity.role, actorHash: identity.fingerprint,
      action: "proposal-approved", proposalId: id,
      params: { type: row.type, self_approved: selfApproved },
      result: summarize(result), ip,
    }, now);
    return { row: this.getProposal(id), result, selfApproved };
  }
}

/** Short JSON-safe summary for audit rows (never secrets — results hold roots/counts). */
function summarize(value: unknown): unknown {
  try {
    const text = JSON.stringify(value);
    return text.length > 2048 ? `${text.slice(0, 2048)}…(truncated)` : JSON.parse(text);
  } catch {
    return String(value);
  }
}
