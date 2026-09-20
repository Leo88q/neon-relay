/**
 * Tranche-B beta metrics, computed on demand from the ledger and the game
 * event log (no rollup tables to drift):
 *
 *   dau/sessions   — distinct players + session_start counts per UTC day,
 *                    with matched session_start/end durations;
 *   finish         — match_end outcomes (finished/total, overall + by mode);
 *   claims         — claim_intent status mix, failure rate and stale items;
 *   pipeline       — reward/economy/admin backlog ages (the "what is stuck"
 *                    companion to GET /v1/admin/stuck).
 */
import type { Db } from "./db.ts";

export const STUCK_SUBMITTED_MS = 6 * 60 * 60 * 1000;

export interface StuckReport {
  checked_at: number;
  threshold_ms: number;
  intents: {
    id: string; wallet_binding_id: string; epoch_id: number;
    amount_micro: number; status: string; updated_at: number; age_ms: number;
  }[];
  proposals: {
    id: string; type: string; params: string; proposed_by_role: string;
    created_at: number; age_ms: number;
  }[];
  unreconciled_prize_epochs: number[];
}

/** Rows that need a human: stale submitted intents, stale open proposals and prize closes nobody reconciled. */
export function collectStuck(db: Db, thresholdMs: number, now: number = Date.now()): StuckReport {
  if (!Number.isInteger(thresholdMs) || thresholdMs <= 0 || thresholdMs > 30 * 86_400_000) {
    throw new Error("threshold must be within 1ms..30d");
  }
  const cutoff = now - thresholdMs;
  const intents = db.all<{
    id: string; wallet_binding_id: string; epoch_id: number;
    amount_micro: number; status: string; updated_at: number;
  }>(
    `SELECT id, wallet_binding_id, epoch_id, amount_micro, status, updated_at
     FROM claim_intents WHERE status = 'submitted' AND updated_at < ?
     ORDER BY updated_at LIMIT 200`,
    cutoff).map((row) => ({ ...row, age_ms: now - row.updated_at }));
  const proposals = db.all<{ id: string; type: string; params: string; proposed_by_role: string; created_at: number }>(
    `SELECT id, type, params, proposed_by_role, created_at FROM admin_proposals
     WHERE status = 'open' AND created_at < ? ORDER BY created_at LIMIT 200`,
    cutoff).map((row) => ({ ...row, age_ms: now - row.created_at }));
  const unreconciled = db.all<{ epoch: number }>(
    `SELECT epoch FROM economy_epochs WHERE epoch NOT IN (
       SELECT CAST(ref AS INTEGER) FROM reconcile_snapshots
       WHERE kind = 'prize-epoch' AND (status = 'match' OR status LIKE 'mismatch:%')
     ) ORDER BY epoch LIMIT 50`).map((r) => r.epoch);
  return { checked_at: now, threshold_ms: thresholdMs, intents, proposals, unreconciled_prize_epochs: unreconciled };
}

export interface DayActivity {
  day: string;
  dau: number;
  sessions: number;
  avg_session_s: number | null;
}

export interface Metrics {
  window_days: number;
  since: number;
  now: number;
  activity: DayActivity[];
  finish: {
    total: number;
    finished: number;
    rate: number | null;
    by_mode: { mode: string; total: number; finished: number; rate: number | null }[];
  };
  claims: {
    total: number;
    by_status: Record<string, number>;
    failed_rate: number | null;
    stuck_submitted: number;
  };
  pipeline: {
    open_reward_epochs: number;
    oldest_open_epoch_age_ms: number | null;
    pending_open_value_micro: number;
    open_proposals: number;
    oldest_open_proposal_age_ms: number | null;
    unreconciled_prize_epochs: number[];
  };
}

export function computeMetrics(db: Db, days: number, now: number = Date.now()): Metrics {
  if (!Number.isInteger(days) || days < 1 || days > 90) {
    throw new Error("window must be within 1..90 days");
  }
  const since = now - days * 86_400_000;

  const activityRows = db.all<{ day: string; dau: number; sessions: number }>(
    `SELECT strftime('%Y-%m-%d', occurred_at / 1000, 'unixepoch') AS day,
            COUNT(DISTINCT player_id) AS dau, COUNT(*) AS sessions
     FROM game_events
     WHERE event_type = 'session_start' AND status = 'accepted' AND occurred_at >= ?
     GROUP BY day ORDER BY day`,
    since);
  const durations = db.all<{ day: string; ms: number }>(
    `SELECT strftime('%Y-%m-%d', s.occurred_at / 1000, 'unixepoch') AS day,
            (e.occurred_at - s.occurred_at) AS ms
     FROM game_events s JOIN game_events e ON e.session_id = s.session_id
     WHERE s.event_type = 'session_start' AND s.status = 'accepted'
       AND e.event_type = 'session_end' AND e.status = 'accepted'
       AND s.occurred_at >= ? AND e.occurred_at >= s.occurred_at`,
    since);
  const msByDay = new Map<string, number[]>();
  for (const row of durations) {
    const list = msByDay.get(row.day) ?? [];
    list.push(row.ms);
    msByDay.set(row.day, list);
  }
  const activity: DayActivity[] = activityRows.map((row) => {
    const list = msByDay.get(row.day) ?? [];
    return {
      day: row.day,
      dau: row.dau,
      sessions: row.sessions,
      avg_session_s: list.length === 0
        ? null
        : Math.round((list.reduce((a, b) => a + b, 0) / list.length / 1000) * 10) / 10,
    };
  });

  const finishRows = db.all<{ mode: string; total: number; finished: number }>(
    `SELECT COALESCE(mode, 'unknown') AS mode, COUNT(*) AS total,
            SUM(CASE WHEN json_extract(result, '$.finished') IN (1, 'true', '1') THEN 1 ELSE 0 END) AS finished
     FROM game_events
     WHERE event_type = 'match_end' AND status = 'accepted' AND occurred_at >= ?
     GROUP BY mode ORDER BY mode`,
    since);
  const finishTotal = finishRows.reduce((a, r) => a + r.total, 0);
  const finishDone = finishRows.reduce((a, r) => a + (r.finished ?? 0), 0);

  const claimRows = db.all<{ status: string; n: number }>(
    "SELECT status, COUNT(*) AS n FROM claim_intents GROUP BY status");
  const byStatus: Record<string, number> = {};
  for (const row of claimRows) byStatus[row.status] = row.n;
  const claimTotal = Object.values(byStatus).reduce((a, b) => a + b, 0);
  const claimFailed = byStatus["failed"] ?? 0;
  const stuckSubmitted = db.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM claim_intents WHERE status = 'submitted' AND updated_at < ?",
    now - STUCK_SUBMITTED_MS)?.n ?? 0;

  const openEpochs = db.all<{ id: number; started_at: number }>(
    "SELECT id, started_at FROM reward_epochs WHERE state = 'open' ORDER BY started_at");
  const pendingValue = db.get<{ s: number }>(
    `SELECT COALESCE(SUM(e.amount_micro), 0) AS s FROM reward_events e
     JOIN reward_epochs ep ON ep.id = e.reward_epoch
     WHERE e.status = 'accepted' AND ep.state = 'open'`)?.s ?? 0;
  const openProposals = db.all<{ id: string; created_at: number }>(
    "SELECT id, created_at FROM admin_proposals WHERE status = 'open' ORDER BY created_at");
  const unreconciled = db.all<{ epoch: number }>(
    `SELECT epoch FROM economy_epochs WHERE epoch NOT IN (
       SELECT CAST(ref AS INTEGER) FROM reconcile_snapshots
       WHERE kind = 'prize-epoch' AND (status = 'match' OR status LIKE 'mismatch:%')
     ) ORDER BY epoch LIMIT 50`).map((r) => r.epoch);

  return {
    window_days: days,
    since,
    now,
    activity,
    finish: {
      total: finishTotal,
      finished: finishDone,
      rate: finishTotal === 0 ? null : Math.round((finishDone / finishTotal) * 10000) / 10000,
      by_mode: finishRows.map((r) => ({
        mode: r.mode,
        total: r.total,
        finished: r.finished ?? 0,
        rate: r.total === 0 ? null : Math.round(((r.finished ?? 0) / r.total) * 10000) / 10000,
      })),
    },
    claims: {
      total: claimTotal,
      by_status: byStatus,
      failed_rate: claimTotal === 0 ? null : Math.round((claimFailed / claimTotal) * 10000) / 10000,
      stuck_submitted: stuckSubmitted,
    },
    pipeline: {
      open_reward_epochs: openEpochs.length,
      oldest_open_epoch_age_ms: openEpochs.length === 0
        ? null : now - (openEpochs[0] as { started_at: number }).started_at,
      pending_open_value_micro: pendingValue,
      open_proposals: openProposals.length,
      oldest_open_proposal_age_ms: openProposals.length === 0
        ? null : now - (openProposals[0] as { created_at: number }).created_at,
      unreconciled_prize_epochs: unreconciled,
    },
  };
}
