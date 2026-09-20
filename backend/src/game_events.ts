/**
 * Tranche-B minimal game event log: server-signed, idempotent session and
 * match lifecycle events (session_start/end, match_start/end, disconnect).
 *
 * Same trust shape as the reward ledger: authenticity is the per-event Ed25519
 * signature against NEONRELAY_SERVER_SIGNING_PUBLIC_KEY, duplicates collapse
 * on the idempotency hash, and retention is an explicit operator purge (see
 * docs/PRIVACY_GAME_EVENTS.md). Transport is operator-controlled batch POST
 * (scripts/ship_game_events.sh); at-least-once delivery is safe.
 */
import type { Config } from "./config.ts";
import { publicKeyFromBase64Url, sha256Hex, verifySignature } from "./crypto.ts";
import type { Db } from "./db.ts";

export const GAME_EVENT_TYPES = [
  "session_start", "session_end", "match_start", "match_end", "disconnect",
] as const;

export type GameEventType = (typeof GAME_EVENT_TYPES)[number];
export type GameEventStatus = "accepted" | "duplicate" | "rejected_signature" | "rejected_validation";

export interface IncomingGameEvent {
  session_id?: string | null;
  event_type: string;
  player_id?: string | null;
  match_id?: string | null;
  mode?: string | null;
  result?: unknown;
  occurred_at: number;
  server_signature: string;
}

export interface GameIngestResult {
  idempotency_hash: string;
  status: GameEventStatus;
  reason?: string;
}

export interface GameEventRow {
  id: string;
  idempotency_hash: string;
  session_id: string | null;
  event_type: string;
  player_id: string | null;
  match_id: string | null;
  mode: string | null;
  result: string | null;
  occurred_at: number;
  ingested_at: number;
  status: string;
  reason: string | null;
}

/** Canonical signed bytes: fixed key order, stable result encoding, no whitespace. */
export function canonicalGameEventBytes(event: {
  session_id?: string | null; event_type: string; player_id?: string | null;
  match_id?: string | null; mode?: string | null; result?: unknown; occurred_at: number;
}): Buffer {
  return Buffer.from(JSON.stringify({
    session_id: event.session_id ?? null,
    event_type: event.event_type,
    player_id: event.player_id ?? null,
    match_id: event.match_id ?? null,
    mode: event.mode ?? null,
    result: stableResult(event.result),
    occurred_at: event.occurred_at,
  }), "utf8");
}

function stableResult(value: unknown): unknown {
  if (value === undefined) return null;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    out[key] = (value as Record<string, unknown>)[key];
  }
  return out;
}

export function gameIdempotencyHash(event: {
  session_id?: string | null; event_type: string; player_id?: string | null;
  match_id?: string | null; mode?: string | null; result?: unknown; occurred_at: number;
}): string {
  return sha256Hex(canonicalGameEventBytes(event));
}

export class GameEventsError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const MAX_RESULT_BYTES = 2048;

function validateGameEvent(event: IncomingGameEvent): string | null {
  if (!(GAME_EVENT_TYPES as readonly string[]).includes(event.event_type)) {
    return `event_type must be one of ${(GAME_EVENT_TYPES as readonly string[]).join("|")}`;
  }
  for (const [name, value, max] of [
    ["session_id", event.session_id, 128], ["player_id", event.player_id, 128],
    ["match_id", event.match_id, 128], ["mode", event.mode, 32],
  ] as const) {
    if (value !== undefined && value !== null &&
        (typeof value !== "string" || value.length === 0 || value.length > max)) {
      return `${name} invalid`;
    }
  }
  if ((event.event_type === "match_start" || event.event_type === "match_end") &&
      (event.match_id === undefined || event.match_id === null)) {
    return "match events require match_id";
  }
  if (!Number.isInteger(event.occurred_at) || event.occurred_at <= 0) {
    return "occurred_at invalid";
  }
  if (event.result !== undefined && event.result !== null) {
    let text: string;
    try {
      text = JSON.stringify(stableResult(event.result)) ?? "";
    } catch {
      return "result is not JSON-serializable";
    }
    if (Buffer.byteLength(text, "utf8") > MAX_RESULT_BYTES) return "result too large";
  }
  if (typeof event.server_signature !== "string" || event.server_signature.length === 0) {
    return "server_signature missing";
  }
  return null;
}

export class GameEventService {
  private readonly db: Db;
  private readonly config: Config;

  constructor(db: Db, config: Config) {
    this.db = db;
    this.config = config;
  }

  ingest(events: IncomingGameEvent[], now: number = Date.now()): GameIngestResult[] {
    if (!this.config.serverSigningPublicKey) {
      throw new GameEventsError(503, "signing-key-unconfigured",
        "NEONRELAY_SERVER_SIGNING_PUBLIC_KEY is not set; game event ingestion is disabled");
    }
    let serverKey;
    try {
      serverKey = publicKeyFromBase64Url(this.config.serverSigningPublicKey);
    } catch (err) {
      throw new GameEventsError(500, "signing-key-invalid",
        `configured server signing key is invalid: ${(err as Error).message}`);
    }
    return events.map((event) => this.ingestOne(event, serverKey, now));
  }

  private ingestOne(
    event: IncomingGameEvent,
    serverKey: ReturnType<typeof publicKeyFromBase64Url>,
    now: number,
  ): GameIngestResult {
    const hash = gameIdempotencyHash(event);
    const prior = this.db.get<{ status: string }>(
      "SELECT status FROM game_events WHERE idempotency_hash = ?", hash);
    if (prior) {
      return { idempotency_hash: hash, status: "duplicate", reason: `already ingested as ${prior.status}` };
    }
    const problem = validateGameEvent(event);
    if (problem) {
      this.record(event, hash, "rejected_validation", problem, now);
      return { idempotency_hash: hash, status: "rejected_validation", reason: problem };
    }
    const message = canonicalGameEventBytes(event);
    if (!verifySignature(message, Buffer.from(event.server_signature, "base64url"), serverKey)) {
      this.record(event, hash, "rejected_signature",
        "server signature does not match the configured signing key", now);
      return { idempotency_hash: hash, status: "rejected_signature", reason: "bad server signature" };
    }
    this.record(event, hash, "accepted", null, now);
    return { idempotency_hash: hash, status: "accepted" };
  }

  private record(
    event: IncomingGameEvent, hash: string, status: GameEventStatus, reason: string | null, now: number,
  ): void {
    this.db.run(
      `INSERT INTO game_events
         (id, idempotency_hash, session_id, event_type, player_id, match_id, mode,
          result, occurred_at, ingested_at, server_signature, status, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      crypto.randomUUID(), hash, event.session_id ?? null, event.event_type,
      event.player_id ?? null, event.match_id ?? null, event.mode ?? null,
      event.result === undefined || event.result === null
        ? null : JSON.stringify(stableResult(event.result)),
      event.occurred_at, now, event.server_signature, status, reason);
  }

  list(filters: {
    limit: number; offset: number; eventType?: string | null; playerId?: string | null; since?: number | null;
  }): { rows: GameEventRow[]; total: number } {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (filters.eventType) {
      if (!(GAME_EVENT_TYPES as readonly string[]).includes(filters.eventType)) {
        throw new GameEventsError(400, "bad-event-type", "unknown event_type filter");
      }
      where.push("event_type = ?");
      args.push(filters.eventType);
    }
    if (filters.playerId) {
      where.push("player_id = ?");
      args.push(filters.playerId);
    }
    if (filters.since !== undefined && filters.since !== null) {
      where.push("occurred_at >= ?");
      args.push(filters.since);
    }
    const predicate = where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`;
    const total = this.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM game_events ${predicate}`, ...args)?.n ?? 0;
    const rows = this.db.all<GameEventRow>(
      `SELECT * FROM game_events ${predicate} ORDER BY occurred_at DESC, id DESC LIMIT ? OFFSET ?`,
      ...args, filters.limit, filters.offset);
    return { rows, total };
  }

  /**
   * Retention purge. Either deletes events older than the cutoff
   * (rolling retention) or every event of one player (deletion request) —
   * never both at once. Returns the purged row count.
   */
  purge(
    filter: { olderThanMs: number } | { playerId: string },
    now: number = Date.now(),
  ): number {
    const before = this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM game_events")?.n ?? 0;
    if ("playerId" in filter) {
      if (filter.playerId.length === 0 || filter.playerId.length > 128) {
        throw new GameEventsError(400, "bad-request", "player_id invalid");
      }
      this.db.run("DELETE FROM game_events WHERE player_id = ?", filter.playerId);
    } else {
      if (!Number.isInteger(filter.olderThanMs) || filter.olderThanMs <= 0) {
        throw new GameEventsError(400, "bad-request", "older_than_ms must be a positive integer");
      }
      this.db.run("DELETE FROM game_events WHERE occurred_at < ?", now - filter.olderThanMs);
    }
    const after = this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM game_events")?.n ?? 0;
    return before - after;
  }
}
