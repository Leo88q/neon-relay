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
import { raceLobby, parseRaceCurrency, RACE_TIERS } from "./race_catalog.ts";
import { readMarketV2, readTicketV2, V2AccountError } from "./economy_v2_rpc.ts";
import { EconomyV2Store } from "./economy_v2_store.ts";
import type { Config } from "./config.ts";
import { AuthFailure } from "./auth.ts";
import type { AuthService } from "./auth.ts";
import { RewardService, RewardsError } from "./rewards.ts";
import { HttpError, RateLimiter, Router, type RequestContext } from "./http.ts";
import type { SessionStore } from "./sessions.ts";
import type { WalletStore } from "./wallets.ts";
import { migrationCount, type Db } from "./db.ts";
import {
  base58Decode, base58Encode, closeEpochPrizes, entryReference, httpRpc, ticketStatus,
} from "./economy.ts";
import { buildTree, leafHash, proofFor } from "./merkle.ts";

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
      leaf_index: intent.leaf_index,
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

  // Read-only v2 catalog: no legacy ticket or transfer is reused for POTATO.
  router.add("GET", "/v2/economy/lobby", (ctx) => {
    guard(ctx, "lobby");
    const values = ctx.url.searchParams.getAll("currency");
    if (values.length > 1) throw new HttpError(400, "bad-currency", "supply currency once");
    try {
      return raceLobby(config, values.length ? parseRaceCurrency(values[0]!) : undefined);
    } catch {
      throw new HttpError(400, "bad-currency", "currency must be SKR or POTATO");
    }
  });

  const v2Store = new EconomyV2Store(db);
  const configuredV2Market = (ctx: RequestContext) => {
    const values = ctx.url.searchParams.getAll("currency");
    if (values.length !== 1 || !["SKR", "POTATO"].includes(values[0]!)) {
      throw new HttpError(400, "bad-currency", "supply exactly one currency: SKR or POTATO");
    }
    const mintText = values[0] === "SKR" ? config.skrMint : config.potatoMint;
    if (!mintText || !config.economyProgramId) throw new HttpError(503, "economy-not-configured", "operator mint and program configuration required");
    const decode = (value: string) => {
      try {
        if (value.length < 32 || value.length > 44) throw new Error();
        const key = base58Decode(value);
        if (key.length !== 32 || key.every((byte) => byte === 0) || base58Encode(key) !== value) throw new Error();
        return key;
      } catch { throw new HttpError(503, "economy-not-configured", "invalid operator public key configuration"); }
    };
    return { mint: decode(mintText), program: decode(config.economyProgramId) };
  };
  const v2Read = async <T>(work: () => Promise<T>): Promise<T> => {
    try { return await work(); }
    catch (error) {
      if (error instanceof V2AccountError) throw new HttpError(503, "market-invalid", error.message);
      throw new HttpError(502, "economy-rpc-unavailable", "could not verify market accounts");
    }
  };
  router.add("GET", "/v2/economy/market", async (ctx) => {
    guard(ctx, "economy-v2-read");
    requireSession(ctx);
    const { program, mint } = configuredV2Market(ctx);
    return v2Read(() => readMarketV2(rpc, program, mint));
  });
  router.add("GET", "/v2/economy/ticket", async (ctx) => {
    guard(ctx, "economy-v2-read");
    const { binding } = requireSession(ctx);
    const { program, mint } = configuredV2Market(ctx);
    if (!binding.player_id) throw new HttpError(403, "player-link-required", "link a player before inspecting an entry intent");
    const keys = ctx.url.searchParams.getAll("idempotency_key");
    const key = keys.length === 1 ? str(keys[0], "idempotency_key", 128) : null;
    if (!key || /[\u0000-\u001f\u007f]/.test(key)) throw new HttpError(400, "bad-request", "invalid idempotency_key");
    const intent = v2Store.getIntent(mint, binding.player_id, key);
    if (!intent) throw new HttpError(404, "intent-not-found", "no entry intent for this player and mint");
    const wallet = Buffer.from(binding.public_key, "base64url");
    if (intent.wallet !== wallet.toString("hex")) throw new HttpError(403, "intent-wallet-mismatch", "intent belongs to a different wallet");
    const tier = RACE_TIERS.findIndex((row) => row.id === intent.tier);
    if (tier < 0 || tier > 3) throw new HttpError(503, "unsupported-entry-tier", "no verified paid tier for this intent");
    const result = await v2Read(() => readTicketV2(rpc, program, mint, {
      wallet, reference: Buffer.from(intent.reference, "hex"), kind: intent.kind, tier,
      amountBase: BigInt(intent.amount_base),
    }));
    return { ...result, admissionEnabled: false };
  });

  // Surface auth failures with stable codes instead of 500s.
  // ------------------------------------------------------------- economy (15)
  // SKR pay-to-play support routes (docs/PLAY_ECONOMY.md). The backend never
  // signs chain transactions: it derives ticket PDAs, reads them over RPC and
  // stores prize roots for an operator publish step.
  const economyGuard = () => {
    if (!config.economyProgramId) {
      throw new HttpError(503, "economy-not-configured",
        "set NEONRELAY_ECONOMY_PROGRAM_ID to enable economy routes");
    }
  };
  const walletRawOf = (ctx: RequestContext): Buffer => {
    const session = requireSession(ctx);
    const binding = wallets.findBinding(session.session.wallet_binding_id);
    if (!binding) throw new HttpError(401, "binding-missing", "wallet binding is gone");
    return Buffer.from(binding.public_key, "base64url");
  };
  const rpc = httpRpc(config.rpcUrl);

  router.add("GET", "/v1/economy/reference", (ctx) => {
    economyGuard();
    const kind = Number(ctx.url.searchParams.get("kind") ?? "0");
    const epoch = Number(ctx.url.searchParams.get("epoch") ?? "0");
    const extra = Number(ctx.url.searchParams.get("extra") ?? "0");
    if (![0, 1].includes(kind) || !Number.isInteger(epoch) || epoch < 0) {
      throw new HttpError(400, "bad-request", "kind must be 0|1 and epoch a non-negative integer");
    }
    const raw = walletRawOf(ctx);
    return { reference: entryReference(kind, epoch, raw, extra).toString("hex") };
  });

  router.add("GET", "/v1/economy/ticket", async (ctx) => {
    economyGuard();
    const kind = Number(ctx.url.searchParams.get("kind") ?? "0");
    const epoch = Number(ctx.url.searchParams.get("epoch") ?? "0");
    const extra = Number(ctx.url.searchParams.get("extra") ?? "0");
    const raw = walletRawOf(ctx);
    const status = await ticketStatus(rpc, config.economyProgramId as string,
      entryReference(kind, epoch, raw, extra), raw);
    return status;
  });

  router.add("POST", "/v1/economy/epoch-close", async (ctx) => {
    economyGuard();
    if (!config.adminToken || ctx.bearer !== config.adminToken) {
      throw new HttpError(401, "admin-required", "economy epoch close needs the admin token");
    }
    const body = (ctx.body ?? {}) as Record<string, unknown>;
    const epoch = Number(body.epoch);
    const poolMicro = Number(body.poolMicro);
    if (!Number.isInteger(epoch) || epoch <= 0 || !Number.isInteger(poolMicro) || poolMicro <= 0) {
      throw new HttpError(400, "bad-request", "epoch and poolMicro must be positive integers");
    }
    const rows = db.all<{ pk: string; total: number; binding: string }>(
      `SELECT b.public_key AS pk, b.id AS binding, COALESCE(SUM(e.amount_micro), 0) AS total
       FROM reward_events e JOIN wallet_bindings b ON b.id = e.wallet_binding_id
       WHERE e.reward_epoch = ? AND e.status = 'accepted'
       GROUP BY b.id ORDER BY total DESC`, [epoch]);
    const ranked = rows.map((r) => ({ wallet: base58Encode(Buffer.from(r.pk, "base64url")), totalMicro: r.total }));
    const refsByBinding = new Map<string, string[]>();
    for (const row of rows) {
      const intents = db.all<{ reference: string }>(
        "SELECT reference FROM economy_matches WHERE wallet_binding_id = ? AND epoch = ?",
        [row.binding, epoch]);
      refsByBinding.set(row.binding, intents.map((i) => i.reference));
    }
    const bindingOf = new Map(ranked.map((r, i) => [r.wallet, rows[i]?.binding ?? ""]));
    const result = await closeEpochPrizes({
      rankedTotals: ranked,
      hasTicket: async (raw) => {
        const program = config.economyProgramId as string;
        if ((await ticketStatus(rpc, program, entryReference(0, epoch, raw), raw)).ticketed) return true;
        // per-match tickets (stage 17): any paid match intent in the epoch
        const refs = refsByBinding.get(bindingOf.get(base58Encode(raw)) ?? "") ?? [];
        for (const ref of refs) {
          if ((await ticketStatus(rpc, program, Buffer.from(ref, "hex"), raw)).ticketed) return true;
        }
        return false;
      },
      poolMicro,
      epoch,
    });
    db.run("INSERT INTO economy_epochs (epoch, root, total_micro, distribution, created_at) VALUES (?, ?, ?, ?, ?)",
      [epoch, result.root, result.totalMicro,
       JSON.stringify(result.leaves.map((l) => ({ wallet: l.wallet, amount_micro: l.amountMicro, place: l.place }))),
       Date.now()]);
    return { epoch, root: result.root, totalMicro: result.totalMicro,
      leaves: result.leaves.map((l) => ({ place: l.place, wallet: l.wallet, amountMicro: l.amountMicro })) };
  });

  router.add("GET", "/v1/economy/current-epoch", (ctx) => {
    economyGuard();
    void ctx;
    return { epoch: Math.floor(Date.now() / config.epochMs) };
  });

  router.add("POST", "/v1/economy/match-intent", async (ctx) => {
    economyGuard();
    const session = requireSession(ctx);
    const body = (ctx.body ?? {}) as Record<string, unknown>;
    const epoch = Number(body.epoch ?? 0) || Math.floor(Date.now() / config.epochMs);
    const raw = walletRawOf(ctx);
    const id = db.runInsert(
      "INSERT INTO economy_matches (wallet_binding_id, epoch, reference, created_at) VALUES (?, ?, ?, ?)",
      [session.session.wallet_binding_id, epoch, "pending", Date.now()]);
    const reference = entryReference(0, epoch, raw, id).toString("hex");
    db.run("UPDATE economy_matches SET reference = ? WHERE id = ?", [reference, id]);
    return { matchId: id, epoch, reference };
  });

  router.add("GET", "/v1/economy/epochs", (ctx) => {
    economyGuard();
    void ctx;
    return { epochs: db.all<{ epoch: number; root: string; total_micro: number }>(
      "SELECT epoch, root, total_micro FROM economy_epochs ORDER BY epoch DESC") };
  });

  router.add("GET", "/v1/economy/proof", (ctx) => {
    economyGuard();
    const epoch = Number(ctx.url.searchParams.get("epoch") ?? "0");
    // Public by design: the wallet parameter only reveals the caller's own
    // leaf (amount + proof), both already committed in the published root;
    // the Android claim flow calls this without a backend session.
    const walletParam = ctx.url.searchParams.get("wallet") ?? "";
    let raw: Buffer;
    try {
      raw = base58Decode(walletParam);
    } catch {
      throw new HttpError(400, "bad-request", "wallet must be a base58 public key");
    }
    if (raw.length !== 32) throw new HttpError(400, "bad-request", "wallet must be 32 bytes");
    const wallet = walletParam;
    const row = db.get<{ root: string; distribution: string }>(
      "SELECT root, distribution FROM economy_epochs WHERE epoch = ?", [epoch]);
    if (!row) throw new HttpError(404, "epoch-not-found", "no closed prize epoch with this id");
    const dist = JSON.parse(row.distribution) as { wallet: string; amount_micro: number; place: number }[];
    const index = dist.findIndex((d) => d.wallet === wallet);
    if (index < 0) throw new HttpError(404, "not-in-distribution", "wallet has no prize in this epoch");
    const leaves = dist.map((d) => leafHash(base58Decode(d.wallet), d.amount_micro));
    const tree = buildTree(leaves);
    if (tree.root !== row.root) throw new HttpError(500, "root-mismatch", "stored root does not match distribution");
    return { epoch, root: row.root, place: dist[index]?.place, amountMicro: dist[index]?.amount_micro,
      leafIndex: index, proof: proofFor(tree, index) };
  });

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
