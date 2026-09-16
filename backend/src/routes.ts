/**
 * HTTP route table for stage 6 (wallet authentication and binding management).
 *
 *   POST /v1/auth/challenge        issue a single-use wallet challenge
 *   POST /v1/auth/verify-wallet    verify signature, create session + binding
 *   GET  /v1/wallet                current binding for the bearer session
 *   POST /v1/wallet/link           bind the session wallet to a player id
 *   POST /v1/wallet/unlink         revoke binding and its sessions
 *   GET  /v1/health                liveness + migration count
 *
 * Reward routes (/v1/rewards/…) arrive in stage 7 and are intentionally absent:
 * an unknown path is a 404, never a silent stub.
 */
import type { Config } from "./config.ts";
import { AuthFailure } from "./auth.ts";
import type { AuthService } from "./auth.ts";
import { RewardService, RewardsError } from "./rewards.ts";
import { HttpError, RateLimiter, Router, type RequestContext } from "./http.ts";
import type { SessionStore } from "./sessions.ts";
import type { WalletStore } from "./wallets.ts";
import { migrationCount, type Db } from "./db.ts";

const str = (value: unknown, field: string, max = 512): string => {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new HttpError(400, "bad-request", `${field} must be a non-empty string <= ${max} chars`);
  }
  return value;
};

const optStr = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 && value.length <= 512 ? value : null;

export function buildRouter(deps: {
  config: Config;
  db: Db;
  auth: AuthService;
  wallets: WalletStore;
  sessions: SessionStore;
  rewards: RewardService;
}): Router {
  const { config, db, auth, wallets, sessions, rewards } = deps;
  const router = new Router();
  // ~5 challenge/verify attempts per minute per IP, burst 10
  const limiter = new RateLimiter(10, 5 / 60_000);

  const guard = (ctx: RequestContext, bucket: string) => {
    if (!limiter.allow(`${bucket}:${ctx.ip}`)) {
      throw new HttpError(429, "rate-limited", "too many requests, slow down");
    }
  };

  const requireSession = (ctx: RequestContext) => {
    const result = sessions.validate(ctx.bearer);
    if (!result.session) {
      throw new HttpError(401, `session-${result.reason}`, "authentication required");
    }
    const binding = wallets.findBinding(result.session.wallet_binding_id);
    if (!binding || binding.revoked_at !== null) {
      throw new HttpError(401, "binding-revoked", "wallet binding is revoked");
    }
    return { session: result.session, binding };
  };

  router.add("GET", "/v1/health", () => ({
    status: "ok",
    service: "neonrelay-backend",
    version: config.version,
    migrations: migrationCount(db),
  }));

  router.add("POST", "/v1/auth/challenge", (ctx) => {
    guard(ctx, "challenge");
    return auth.issueChallenge();
  });

  router.add("POST", "/v1/auth/verify-wallet", (ctx) => {
    guard(ctx, "verify");
    const body = (ctx.body ?? {}) as Record<string, unknown>;
    const result = auth.verifyWallet({
      challenge: str(body["challenge"], "challenge", 8192),
      signature: str(body["signature"], "signature", 512),
      publicKey: str(body["public_key"], "public_key", 128),
      accountLabel: optStr(body["account_label"]),
    });
    return {
      session_token: result.sessionToken,
      session_expires_at: result.sessionExpiresAt,
      wallet_binding_id: result.binding.id,
      account: {
        public_key: result.publicKeyBase64,
        label: result.binding.label,
      },
    };
  });

  router.add("GET", "/v1/wallet", (ctx) => {
    const { binding, session } = requireSession(ctx);
    return {
      wallet_binding_id: binding.id,
      account: { public_key: binding.public_key, label: binding.label },
      player_id: binding.player_id,
      session_expires_at: session.expires_at,
    };
  });

  router.add("POST", "/v1/wallet/link", (ctx) => {
    const { binding } = requireSession(ctx);
    const body = (ctx.body ?? {}) as Record<string, unknown>;
    const playerId = str(body["player_id"], "player_id", 128);
    wallets.setPlayerLink(binding.id, playerId);
    return { wallet_binding_id: binding.id, player_id: playerId };
  });

  router.add("POST", "/v1/wallet/unlink", (ctx) => {
    const { binding } = requireSession(ctx);
    wallets.setPlayerLink(binding.id, null);
    wallets.revokeBinding(binding.id);
    sessions.revokeForBinding(binding.id);
    return { unlinked: true, wallet_binding_id: binding.id };
  });

  // ------------------------------------------------------------ rewards (stage 7)

  router.add("POST", "/v1/rewards/events", (ctx) => {
    guard(ctx, "ingest");
    const body = (ctx.body ?? {}) as Record<string, unknown>;
    const events = body["events"];
    if (!Array.isArray(events) || events.length === 0 || events.length > 500) {
      throw new HttpError(400, "bad-request", "events must be an array of 1..500 items");
    }
    const results = rewards.ingestEvents(events as never[], Date.now());
    return {
      results,
      accepted: results.filter((r) => r.status === "accepted").length,
    };
  });

  router.add("GET", "/v1/rewards/balance", (ctx) => {
    const { binding } = requireSession(ctx);
    return rewards.balance(binding);
  });

  router.add("GET", "/v1/rewards/eligibility", (ctx) => {
    const { binding } = requireSession(ctx);
    return rewards.eligibility(binding.player_id, binding);
  });

  router.add("GET", "/v1/rewards/epochs", () => rewards.listEpochs());

  router.add("POST", "/v1/rewards/epochs/seal", (ctx) => {
    if (!config.adminToken) {
      throw new HttpError(503, "admin-disabled", "operator routes are not configured");
    }
    if (ctx.bearer !== config.adminToken) {
      throw new HttpError(403, "admin-forbidden", "operator token required");
    }
    const body = (ctx.body ?? {}) as Record<string, unknown>;
    const epochId = body["epoch_id"];
    if (typeof epochId !== "number" || !Number.isInteger(epochId)) {
      throw new HttpError(400, "bad-request", "epoch_id must be an integer");
    }
    const epoch = rewards.sealEpoch(epochId);
    return { epoch, audit_root: rewards.auditRoot(epochId) };
  });

  router.add("POST", "/v1/rewards/claim-intent", (ctx) => {
    const { binding } = requireSession(ctx);
    const body = (ctx.body ?? {}) as Record<string, unknown>;
    const epochId = body["epoch_id"];
    if (typeof epochId !== "number" || !Number.isInteger(epochId)) {
      throw new HttpError(400, "bad-request", "epoch_id must be an integer");
    }
    const intent = rewards.claimIntent(binding, epochId);
    return {
      intent_id: intent.id,
      epoch_id: intent.epoch_id,
      amount_micro: intent.amount_micro,
      leaf_hash: intent.leaf_hash,
      merkle_proof: JSON.parse(intent.merkle_proof) as string[],
      status: intent.status,
    };
  });

  router.add("POST", "/v1/rewards/claim-confirmation", (ctx) => {
    const { binding } = requireSession(ctx);
    const body = (ctx.body ?? {}) as Record<string, unknown>;
    const intentId = str(body["intent_id"], "intent_id", 64);
    const transactionId = str(body["transaction_id"], "transaction_id", 128);
    const status = body["status"];
    if (status !== "submitted" && status !== "confirmed" && status !== "failed") {
      throw new HttpError(400, "bad-request",
        "status must be one of submitted|confirmed|failed");
    }
    const intent = rewards.claimConfirmation(binding, intentId, transactionId, status);
    return { intent_id: intent.id, status: intent.status, transaction_id: intent.transaction_id };
  });

  router.add("GET", "/v1/rewards/intents", (ctx) => {
    const { binding } = requireSession(ctx);
    return { intents: rewards.intentsFor(binding) };
  });

  // Surface auth failures with stable codes instead of 500s.
  return router;
}

export { RewardsError };

export function authFailureStatus(code: AuthFailure["code"]): number {
  switch (code) {
    case "bad-request": return 400;
    case "bad-challenge": return 400;
    case "bad-public-key": return 400;
    case "wrong-domain": return 422;
    case "challenge-expired": return 410;
    case "nonce-unknown": return 404;
    case "nonce-replayed": return 409;
    case "bad-signature": return 401;
    case "binding-revoked": return 403;
  }
}
