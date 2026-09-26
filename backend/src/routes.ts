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
 * an unknown path is a 404, never a silent stub. The one exception is the
 * read-only GET /v1/rewards/verified (stage 12): server-confirmed results for
 * the client's "verified" showcase, no writes, no admin surface.
 *
 * Tranche A: direct seal/close execution was replaced by the two-person
 * proposal workflow (POST /v1/admin/proposals → approve/reject); the old
 * paths answer 410 with migration guidance. List routes accept optional
 * ?limit=&offset= pagination.
 */
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { raceLobby, parseRaceCurrency, RACE_TIERS } from "./race_catalog.ts";
import { readMarketV2, readTicketV2, V2AccountError } from "./economy_v2_rpc.ts";
import { issueSealedPairing } from "./game_pairing_seal.ts";
import { GamePairing } from "./game_pairing.ts";
import { GameIdentity } from "./game_identity.ts";
import { DEFAULT_MAX_INTENTS_PER_PLAYER_EPOCH, EconomyV2Store } from "./economy_v2_store.ts";
import type { Config } from "./config.ts";
import { AuthFailure } from "./auth.ts";
import type { AuthService } from "./auth.ts";
import { RewardService, RewardsError } from "./rewards.ts";
import { readAchievementRegistry, type AchievementRegistryView } from "./features_read.ts";
import { GameEventService, GameEventsError } from "./game_events.ts";
import { collectStuck, computeMetrics, STUCK_SUBMITTED_MS } from "./metrics.ts";
import { alertSinks, formatDigest, sendAlertText } from "./alerts.ts";
import {
  ReconcileError, readTreasuryState, reconcilePrizeEpoch,
  reconcileRewardsEpoch, recordTreasury,
} from "./reconcile.ts";
import {
  AdminStore, adminConfigured, authenticateAdmin, type AdminIdentity, type ProposalRow,
} from "./admin.ts";
import { HttpError, RateLimiter, Router, type RequestContext } from "./http.ts";
import type { SessionStore } from "./sessions.ts";
import type { WalletStore } from "./wallets.ts";
import { inspectBackup, migrationCount, type Db } from "./db.ts";
import {
  base58Decode, base58Encode, closeEpochPrizes, entryReference, findProgramAddress,
  readVaultPool, ticketStatus, VaultReadError,
} from "./economy.ts";
import { createRpcPool } from "./rpc.ts";
import { buildTree, leafHash, proofFor } from "./merkle.ts";
import {
  WATCHTOWER_GAME_ID, WATCHTOWER_NETWORK, WATCHTOWER_PARSER_VERSION,
  WATCHTOWER_SOURCE, WATCHTOWER_STAGE, gameSignalsConfig, ingestContract,
  ingestWatchtowerEvent, normalizeSolanaEvent, routeL2, sdkConfig,
  watchtowerConfig, type TelemetryInput,
  memoryMacRecord, scanMemoryIntegrity, verifyMemoryMac,
} from "./watchtower.ts";
import { toolIntegrityReport } from "./tool_registry.ts";

const str = (value: unknown, field: string, max = 512): string => {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new HttpError(400, "bad-request", `${field} must be a non-empty string <= ${max} chars`);
  }
  return value;
};

const optStr = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 && value.length <= 512 ? value : null;

/** Optional ?limit=&offset= pagination. `present` is false when neither param was sent. */
const parsePagination = (ctx: RequestContext, defaultLimit: number, maxLimit: number):
  { limit: number; offset: number; present: boolean } => {
  const rawLimit = ctx.url.searchParams.get("limit");
  const rawOffset = ctx.url.searchParams.get("offset");
  if (rawLimit === null && rawOffset === null) {
    return { limit: defaultLimit, offset: 0, present: false };
  }
  const limit = rawLimit === null ? defaultLimit : Number(rawLimit);
  const offset = rawOffset === null ? 0 : Number(rawOffset);
  if (!Number.isInteger(limit) || limit < 1 || limit > maxLimit) {
    throw new HttpError(400, "bad-pagination", `limit must be an integer within 1..${maxLimit}`);
  }
  if (!Number.isInteger(offset) || offset < 0) {
    throw new HttpError(400, "bad-pagination", "offset must be a non-negative integer");
  }
  return { limit, offset, present: true };
};

type WatchtowerDataQuality = "complete" | "partial" | "unavailable";

const isoOrNull = (value: number | null | undefined): string | null =>
  typeof value === "number" && Number.isFinite(value) ? new Date(value).toISOString() : null;

const parseJsonCell = (value: string | null): unknown => {
  if (value === null || value === "") return null;
  try {
    return JSON.parse(value);
  } catch {
    return { _raw: value, _parse_error: true };
  }
};

const intQuery = (ctx: RequestContext, name: string, fallback: number, min: number, max: number): number => {
  const raw = ctx.url.searchParams.get(name);
  if (raw === null || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new HttpError(400, "bad-query", `${name} must be an integer within ${min}..${max}`);
  }
  return parsed;
};

const parseSinceMs = (value: string | null): number | null => {
  if (value === null || value === "") return null;
  if (/^\d+$/.test(value)) {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
      throw new HttpError(400, "bad-query", "since must be a non-negative epoch millisecond value");
    }
    return parsed;
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new HttpError(400, "bad-query", "since must be an ISO timestamp, YYYY-MM-DD, or epoch ms");
  }
  return parsed;
};

const encodeCursor = (occurredAt: number, id: string): string =>
  Buffer.from(JSON.stringify({ occurredAt, id })).toString("base64url");

const decodeCursor = (cursor: string | null): { occurredAt: number; id: string } | null => {
  if (cursor === null || cursor === "") return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Record<string, unknown>;
    if (typeof parsed.occurredAt !== "number" || !Number.isSafeInteger(parsed.occurredAt) ||
        typeof parsed.id !== "string" || parsed.id.length === 0) {
      throw new Error("cursor shape");
    }
    return { occurredAt: parsed.occurredAt, id: parsed.id };
  } catch {
    throw new HttpError(400, "bad-cursor", "cursor is invalid");
  }
};

interface WatchtowerEventRow {
  id: string;
  idempotency_hash: string;
  event_type: string;
  external_id: string | null;
  solana_wallet: string | null;
  wallet_id: string | null;
  session_id: string | null;
  match_id: string | null;
  mode: string | null;
  result_json: string | null;
  metadata_json: string | null;
  occurred_at: number;
  received_at: number;
  memory_mac: string | null;
}

const normalizeWatchtowerEventRow = (row: WatchtowerEventRow, config: Config): Record<string, unknown> => {
  const metadataValue = parseJsonCell(row.metadata_json);
  const metadata = metadataValue && typeof metadataValue === "object" && !Array.isArray(metadataValue)
    ? metadataValue as Record<string, unknown>
    : {};
  const payload = metadata.payload && typeof metadata.payload === "object" && !Array.isArray(metadata.payload)
    ? metadata.payload as Record<string, unknown>
    : {};
  return {
    chain: WATCHTOWER_NETWORK,
    cluster: typeof metadata.cluster === "string" ? metadata.cluster : "unknown",
    slot: Number.isSafeInteger(metadata.slot) ? metadata.slot : null,
    blockTime: new Date(row.occurred_at).toISOString(),
    signature: typeof metadata.signature === "string" ? metadata.signature : `watchtower-${row.id}`,
    programId: typeof metadata.program_id === "string"
      ? metadata.program_id
      : config.rewardsProgramId,
    instructionIndex: 0,
    innerIndex: 0,
    eventType: typeof metadata.eventType === "string" ? metadata.eventType : row.event_type,
    telemetryType: row.event_type,
    commitment: metadata.source === "solana-indexer" ? "finalized" : "offchain",
    success: true,
    accounts: [],
    payload: Object.keys(payload).length > 0 ? payload : (parseJsonCell(row.result_json) ?? {}),
    source: typeof metadata.source === "string" ? metadata.source : WATCHTOWER_SOURCE,
    parserVersion: WATCHTOWER_PARSER_VERSION,
    observedAt: new Date(row.received_at).toISOString(),
    dataQuality: "partial",
    externalId: row.external_id,
    solanaWallet: row.solana_wallet,
    walletId: row.wallet_id,
    sessionId: row.session_id,
    matchId: row.match_id,
    mode: row.mode,
    idempotencyHash: row.idempotency_hash,
    // SW-2026-AGI T74: every exported row announces its memory integrity so a
    // consuming agent can fail closed on "tampered" instead of trusting it.
    integrity: verifyMemoryMac(config.watchtowerMemoryKey, memoryMacRecord(row), row.memory_mac),
  };
};

const confidenceForQuality = (quality: WatchtowerDataQuality): number => {
  // Confidence is a consequence of the declared evidence quality, not a
  // hardcoded optimism score. `partial` means locally observed but not
  // independently verified; `unavailable` is never presented as evidence.
  return quality === "complete" ? 1 : quality === "partial" ? 0.5 : 0;
};

const watchtowerEnvelope = <T>(data: T, options: {
  period?: string;
  source?: string;
  dataQuality?: WatchtowerDataQuality;
  lastVerifiedAt?: string | null;
} = {}) => {
  const dataQuality = options.dataQuality ?? "partial";
  return {
    data,
    generatedAt: new Date().toISOString(),
    period: options.period ?? "point-in-time UTC",
    source: options.source ?? WATCHTOWER_SOURCE,
    dataQuality,
    parserVersion: WATCHTOWER_PARSER_VERSION,
    network: WATCHTOWER_NETWORK,
    stage: WATCHTOWER_STAGE,
    lastVerifiedAt: options.lastVerifiedAt ?? null,
  };
};

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
  // Read-only economy routes (ticket status, proofs, epoch listings) are
  // polled by live clients and may hit RPC. SW-2026-09-26 F-12: they used
  // to run with no rate limit at all — `/v1/economy/ticket` amplified every
  // request into a Solana RPC read. A generous read bucket (burst 60,
  // 1/s sustained) bounds that amplification without throttling a normal UI.
  const readLimiter = new RateLimiter(60, 60 / 60_000);

  // Dual-provider chain-read pool (docs/DEPLOYMENT_POLICY.md §6): every RPC
  // call below — tickets, vault pool, reconciliation, treasury — fails
  // over to the fallback provider while primary is down and fails back
  // automatically. Both endpoints are genesis-pinned to one chain.
  const rpcPool = createRpcPool({
    primary: config.rpcUrl,
    fallback: config.rpcFallbackUrl,
    timeoutMs: config.rpcTimeoutMs,
    cooldownMs: config.rpcCooldownMs,
    expectedGenesis: config.expectedGenesisHash,
    requireGenesis: config.environment === "production",
  });
  const rpc = rpcPool.call;
  const BPF_LOADER_UPGRADEABLE = "BPFLoaderUpgradeab1e11111111111111111111111";
  const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
  let productionGate: {
    checkedAt: number | null;
    ready: boolean;
    blockers: string[];
  } = { checkedAt: null, ready: false, blockers: ["production-chain-verification-required"] };

  const canonicalPublicKey = (value: string | null): boolean => {
    if (!value) return false;
    try {
      const raw = base58Decode(value);
      return raw.length === 32 && raw.some((byte) => byte !== 0) && base58Encode(raw) === value;
    } catch {
      return false;
    }
  };

  const readManifest = (): Record<string, unknown> => {
    if (!config.deploymentManifestPath) throw new Error("NEONRELAY_DEPLOYMENT_MANIFEST is not configured");
    const parsed: unknown = JSON.parse(readFileSync(config.deploymentManifestPath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("deployment manifest must be an object");
    return parsed as Record<string, unknown>;
  };

  type RpcAccount = { owner?: unknown; executable?: unknown; data?: unknown };
  const readAccount = async (address: string): Promise<RpcAccount> => {
    const reply = await rpc("getAccountInfo", [address, { encoding: "base64", commitment: "finalized" }]) as {
      value?: RpcAccount | null;
    };
    const account = reply?.value;
    if (!account || typeof account.executable !== "boolean" || !Array.isArray(account.data) ||
        account.data[1] !== "base64" || typeof account.data[0] !== "string" || account.data[0].length === 0) {
      throw new Error("account-missing-or-invalid");
    }
    const encoded = account.data[0] as string;
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.length === 0 || bytes.toString("base64") !== encoded) {
      throw new Error("account-data-noncanonical");
    }
    return account;
  };
  const readTokenAccount = async (address: string, expectedMint: Buffer, expectedOwner: Buffer): Promise<bigint> => {
    const account = await readAccount(address);
    if (account.owner !== TOKEN_PROGRAM || account.executable !== false) throw new Error("token-account-owner-invalid");
    const data = account.data as [string, string];
    const bytes = Buffer.from(data[0], "base64");
    // Classic SPL TokenAccount layout: reject frozen/uninitialized accounts,
    // delegates, native-token wrappers and close authorities. A production
    // money path must not trust an account that can be drained by another key.
    if (bytes.length !== 165 || bytes.toString("base64") !== data[0] || bytes[108] !== 1 ||
        bytes.readUInt32LE(72) !== 0 || bytes.readUInt32LE(109) !== 0 || bytes.readUInt32LE(129) !== 0) {
      throw new Error("token-account-layout-invalid");
    }
    if (!bytes.subarray(0, 32).equals(expectedMint) || !bytes.subarray(32, 64).equals(expectedOwner)) {
      throw new Error("token-account-binding-invalid");
    }
    return bytes.readBigUInt64LE(64);
  };

  const verifyProductionGate = async (): Promise<typeof productionGate> => {
    if (config.environment !== "production") {
      productionGate = { checkedAt: Date.now(), ready: false, blockers: ["NODE_ENV=production is required"] };
      return productionGate;
    }
    const blockers: string[] = [];
    if (!canonicalPublicKey(config.rewardsProgramId)) blockers.push("rewards-program-id-invalid");
    if (!canonicalPublicKey(config.economyProgramId)) blockers.push("economy-program-id-invalid");
    if (!canonicalPublicKey(config.featuresProgramId)) blockers.push("features-program-id-invalid");
    if (!canonicalPublicKey(config.assetsProgramId)) blockers.push("assets-program-id-invalid");
    if (!canonicalPublicKey(config.skrMint)) blockers.push("skr-mint-invalid");
    if (!canonicalPublicKey(config.rewardMint)) blockers.push("reward-mint-invalid");
    if (!canonicalPublicKey(config.expectedGenesisHash)) blockers.push("expected-genesis-invalid");
    if (!config.monetizationEnabled) blockers.push("monetization-disabled");
    if (!config.watchtowerIngestToken) blockers.push("watchtower-ingest-token-missing");
    if (!config.serverSigningPublicKey) blockers.push("server-signing-key-missing");
    let manifest: Record<string, unknown> | null = null;
    if (blockers.length === 0) {
      try { manifest = readManifest(); } catch { blockers.push("deployment-manifest-unreadable"); }
    }
    const programs = manifest?.["programs"];
    const manifestAuthority = manifest?.["upgrade_authority"];
    const manifestCluster = manifest?.["cluster"];
    const manifestGenesis = manifest?.["genesis_hash"];
    const manifestMints = manifest?.["mints"];
    if (manifestCluster !== config.cluster) blockers.push("manifest-cluster-mismatch");
    if (manifestGenesis !== config.expectedGenesisHash) blockers.push("manifest-genesis-mismatch");
    if (!manifestMints || typeof manifestMints !== "object" || Array.isArray(manifestMints) ||
        (manifestMints as Record<string, unknown>).skr !== config.skrMint) blockers.push("manifest-skr-mint-mismatch");
    if (!manifestMints || typeof manifestMints !== "object" || Array.isArray(manifestMints) ||
        (manifestMints as Record<string, unknown>).reward !== config.rewardMint) blockers.push("manifest-reward-mint-mismatch");
    if (!programs || typeof programs !== "object" || Array.isArray(programs)) blockers.push("deployment-programs-missing");
    if (typeof manifestAuthority !== "string" ||
        (manifestAuthority !== "none" && !canonicalPublicKey(manifestAuthority))) {
      blockers.push("upgrade-authority-invalid");
    }
    if (blockers.length === 0) {
      const expected = {
        neonrelay_rewards: config.rewardsProgramId,
        neonrelay_features: config.featuresProgramId,
        neonrelay_economy: config.economyProgramId,
        neonrelay_assets: config.assetsProgramId,
      } as const;
      const manifestPrograms = programs as Record<string, unknown>;
      for (const [name, id] of Object.entries(expected)) {
        if (manifestPrograms[name] !== id) blockers.push(`manifest-${name}-mismatch`);
      }
    }
    const checkProgram = async (address: string, expectedAuthority: string): Promise<void> => {
      const account = await readAccount(address);
      if (account.owner !== BPF_LOADER_UPGRADEABLE || account.executable !== true) {
        throw new Error("program-owner-or-executable-invalid");
      }
      const programDataEncoded = (account.data as [string, string])[0];
      const programDataBytes = Buffer.from(programDataEncoded, "base64");
      if (programDataBytes.toString("base64") !== programDataEncoded) throw new Error("program-data-noncanonical");
      // UpgradeableLoaderState::Program is bincode variant 2 (u32) + Pubkey.
      if (programDataBytes.length < 36 || programDataBytes.readUInt32LE(0) !== 2) {
        throw new Error("program-loader-state-invalid");
      }
      const programDataKey = programDataBytes.subarray(4, 36);
      const expectedProgramData = findProgramAddress(
        [base58Decode(address)], base58Decode(BPF_LOADER_UPGRADEABLE),
      ).address;
      if (!programDataKey.equals(expectedProgramData)) throw new Error("programdata-pda-invalid");
      const programData = base58Encode(programDataKey);
      const dataAccount = await readAccount(programData);
      if (dataAccount.owner !== BPF_LOADER_UPGRADEABLE || dataAccount.executable !== false) {
        throw new Error("programdata-owner-invalid");
      }
      const programDataAccountEncoded = (dataAccount.data as [string, string])[0];
      const bytes = Buffer.from(programDataAccountEncoded, "base64");
      if (bytes.toString("base64") !== programDataAccountEncoded) throw new Error("programdata-noncanonical");
      // ProgramData is variant 3, slot u64, then Option<Pubkey>.
      if (bytes.length < 13 || bytes.readUInt32LE(0) !== 3) throw new Error("programdata-loader-state-invalid");
      const authorityOption = bytes[12];
      if (authorityOption !== 0 && authorityOption !== 1) throw new Error("programdata-authority-option-invalid");
      if (authorityOption === 1 && bytes.length < 45) throw new Error("programdata-authority-truncated");
      const authority = authorityOption === 1 ? base58Encode(bytes.subarray(13, 45)) : "none";
      if (authority !== expectedAuthority) throw new Error("upgrade-authority-drift");
    };
    const checkMint = async (address: string, expectedDecimals?: number): Promise<number> => {
      const account = await readAccount(address);
      if (account.owner !== TOKEN_PROGRAM || account.executable !== false) throw new Error("mint-owner-invalid");
      const data = account.data as [string, string];
      const bytes = Buffer.from(data[0], "base64");
      if (bytes.toString("base64") !== data[0]) throw new Error("mint-data-noncanonical");
      // Rewards/economy boot gates deliberately accept only the classic SPL
      // Mint ABI. Unknown Token-2022 extensions (PermanentDelegate,
      // TransferHook, TransferFee) are not safe to infer from an RPC snapshot.
      if (bytes.length !== 82 || bytes[45] !== 1 || bytes.readUInt32LE(0) !== 0 || bytes.readUInt32LE(46) !== 0) {
        throw new Error("mint-authority-or-extension-invalid");
      }
      if (expectedDecimals !== undefined && bytes[44] !== expectedDecimals) {
        throw new Error("reward-mint-decimals-invalid");
      }
      return bytes[44]!;
    };
    const accountDiscriminator = (name: string): Buffer =>
      createHash("sha256").update(`account:${name}`, "utf8").digest().subarray(0, 8);
    const readState = async (address: string, owner: string, name: string, size: number, pausedOffset: number): Promise<Buffer> => {
      const account = await readAccount(address);
      if (account.owner !== owner || account.executable !== false) throw new Error(`${name}-owner-invalid`);
      const data = account.data as [string, string];
      const bytes = Buffer.from(data[0], "base64");
      if (bytes.length !== size || bytes.toString("base64") !== data[0]) throw new Error(`${name}-layout-invalid`);
      if (!bytes.subarray(0, 8).equals(accountDiscriminator(name))) throw new Error(`${name}-discriminator-invalid`);
      if (bytes.subarray(8, 40).equals(Buffer.alloc(32))) throw new Error(`${name}-authority-invalid`);
      if (bytes[pausedOffset] !== 0) throw new Error(`${name}-paused`);
      return bytes;
    };
    if (blockers.length === 0) {
      try {
        const genesis = await rpc("getGenesisHash", []);
        if (genesis !== config.expectedGenesisHash) throw new Error("genesis-hash-mismatch");
        await checkProgram(config.rewardsProgramId as string, manifestAuthority as string);
        await checkProgram(config.featuresProgramId as string, manifestAuthority as string);
        await checkProgram(config.economyProgramId as string, manifestAuthority as string);
        await checkProgram(config.assetsProgramId as string, manifestAuthority as string);
        const paymentDecimals = await checkMint(config.skrMint as string);
        await checkMint(config.rewardMint as string, 6);

        const rewardsProgram = base58Decode(config.rewardsProgramId as string);
        const economyProgram = base58Decode(config.economyProgramId as string);
        const featuresProgram = base58Decode(config.featuresProgramId as string);
        const assetsProgram = base58Decode(config.assetsProgramId as string);
        const rewardMint = base58Decode(config.rewardMint as string);
        const paymentMint = base58Decode(config.skrMint as string);
        const rewardsConfigPda = findProgramAddress([Buffer.from("neonrelay_config")], rewardsProgram);
        const rewardsConfig = rewardsConfigPda.address;
        const rewardsConfigBytes = await readState(
          base58Encode(rewardsConfig), config.rewardsProgramId as string, "Config", 131, 72,
        );
        if (rewardsConfigBytes[81] !== rewardsConfigPda.bump) throw new Error("rewards-config-bump-mismatch");
        if (!rewardsConfigBytes.subarray(40, 72).equals(rewardMint)) throw new Error("rewards-config-mint-mismatch");
        const rewardsVault = findProgramAddress([Buffer.from("neonrelay_vault")], rewardsProgram).address;
        const rewardsVaultBalance = await readTokenAccount(base58Encode(rewardsVault), rewardMint, rewardsConfig);
        const rewardsReserved = rewardsConfigBytes.readBigUInt64LE(123);
        if (rewardsReserved > rewardsVaultBalance) throw new Error("rewards-vault-underfunded");

        const featuresConfigPda = findProgramAddress([Buffer.from("neonrelay_features_config")], featuresProgram);
        const featuresConfigBytes = await readState(
          base58Encode(featuresConfigPda.address), config.featuresProgramId as string, "FeaturesConfig", 98, 40,
        );
        if (featuresConfigBytes[57] !== featuresConfigPda.bump) throw new Error("features-config-bump-mismatch");
        const assetsConfigPda = findProgramAddress([Buffer.from("neonrelay_assets_config")], assetsProgram);
        const assetsConfigBytes = await readState(
          base58Encode(assetsConfigPda.address), config.assetsProgramId as string, "AssetsConfig", 106, 80,
        );
        if (assetsConfigBytes[105] !== assetsConfigPda.bump) throw new Error("assets-config-bump-mismatch");

        const economyConfigPda = findProgramAddress(
          [Buffer.from("neonrelay_economy_v2"), paymentMint], economyProgram,
        );
        const economyConfig = economyConfigPda.address;
        const economyConfigBytes = await readState(
          base58Encode(economyConfig), config.economyProgramId as string, "EconomyConfigV2", 180, 178,
        );
        if (economyConfigBytes[179] !== economyConfigPda.bump) throw new Error("economy-config-bump-mismatch");
        if (!economyConfigBytes.subarray(40, 72).equals(paymentMint)) throw new Error("economy-config-mint-mismatch");
        const treasury = economyConfigBytes.subarray(72, 104);
        const vault = economyConfigBytes.subarray(104, 136);
        if (treasury.equals(vault)) throw new Error("economy-treasury-vault-alias");
        const vaultBalance = await readTokenAccount(base58Encode(vault), paymentMint, economyConfig);
        await readTokenAccount(base58Encode(treasury), paymentMint, economyConfigBytes.subarray(8, 40));
        const rakeBps = economyConfigBytes.readUInt16LE(168);
        if (rakeBps > 2000) throw new Error("economy-rake-invalid");
        const scale = 10n ** BigInt(paymentDecimals);
        const expectedFees = [50n, 100n, 500n, 2000n].map((tokens) => tokens * scale);
        for (let index = 0; index < expectedFees.length; index += 1) {
          if (economyConfigBytes.readBigUInt64LE(136 + index * 8) !== expectedFees[index]) {
            throw new Error("economy-fees-invalid");
          }
        }
        const reserved = economyConfigBytes.readBigUInt64LE(170);
        if (reserved > vaultBalance) throw new Error("economy-vault-underfunded");
      } catch (error) {
        blockers.push(error instanceof Error ? error.message : "production-chain-verification-failed");
      }
    }
    productionGate = { checkedAt: Date.now(), ready: blockers.length === 0, blockers };
    return productionGate;
  };

  const latestObservedAt = (...values: (number | null | undefined)[]): string | null => {
    const filtered = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    return filtered.length === 0 ? null : new Date(Math.max(...filtered)).toISOString();
  };

  const latestValue = (sql: string, ...args: (string | number | null)[]): number | null => {
    const row = db.get<{ t: number | null }>(sql, ...args);
    return row?.t ?? null;
  };

  const rewardsConfigured = (): boolean => config.rewardsProgramId !== null;

  const buildWatchtowerAlerts = (): { alerts: Record<string, unknown>[]; lastVerifiedAt: string | null } => {
    const now = Date.now();
    const alerts: Record<string, unknown>[] = [];
    if (!rewardsConfigured()) {
      alerts.push({
        id: "program-ids-unverified",
        severity: "critical",
        type: "ProgramIdsUnverified",
        detectedAt: new Date(now).toISOString(),
        payload: { missing: ["NEONRELAY_REWARDS_PROGRAM_ID"] },
        acknowledged: false,
      });
    }
    if (config.serverSigningPublicKey === null) {
      alerts.push({
        id: "reward-signing-disabled",
        severity: "high",
        type: "MissingEventStream",
        detectedAt: new Date(now).toISOString(),
        payload: { missing: ["NEONRELAY_SERVER_SIGNING_PUBLIC_KEY"], note: "signed reward ingestion is disabled" },
        acknowledged: false,
      });
    }
    const stuck = collectStuck(db, STUCK_SUBMITTED_MS, now);
    if (stuck.intents.length > 0) {
      alerts.push({
        id: "reward-stuck",
        severity: "high",
        type: "RewardStuck",
        detectedAt: new Date(now).toISOString(),
        payload: { stale_intents: stuck.intents.length, oldest_age_ms: stuck.intents[0]?.age_ms ?? null },
        acknowledged: false,
      });
    }
    if (stuck.unreconciled_prize_epochs.length > 0) {
      alerts.push({
        id: "prize-reconcile-gap",
        severity: "high",
        type: "MissingEventStream",
        detectedAt: new Date(now).toISOString(),
        payload: { unreconciled_prize_epochs: stuck.unreconciled_prize_epochs },
        acknowledged: false,
      });
    }
    const rpcStatus = rpcPool.getStatus();
    if (rpcStatus.failovers_total > 0 || rpcStatus.endpoints.primary.chain_rejected || rpcStatus.endpoints.fallback?.chain_rejected) {
      alerts.push({
        id: "rpc-degraded",
        severity: "medium",
        type: "RpcDegraded",
        detectedAt: new Date(now).toISOString(),
        payload: rpcStatus,
        acknowledged: false,
      });
    }
    // SW-2026-AGI T74: a MAC mismatch means the agent memory store was edited
    // outside the ingest path (direct DB write, restored backup, tamper).
    // A poisoned record that reaches an exporter-reading agent is an attack,
    // not bad data. Un-MACed legacy rows are reported as counts, not alerts.
    const memoryScan = scanMemoryIntegrity(db, config.watchtowerMemoryKey);
    if (memoryScan.tampered.length > 0) {
      alerts.push({
        id: "watchtower-memory-tampered",
        severity: "high",
        type: "AgentMemoryTampered",
        detectedAt: new Date(now).toISOString(),
        payload: {
          checked: memoryScan.checked,
          tampered: memoryScan.tampered.slice(0, 50),
          tampered_total: memoryScan.tampered.length,
          policy: "do not feed flagged rows to any agent; quarantine and investigate the writer",
        },
        acknowledged: false,
      });
    }
    const lastVerifiedAt = latestObservedAt(
      latestValue("SELECT MAX(received_at) AS t FROM watchtower_events"),
      latestValue("SELECT MAX(created_at) AS t FROM reconcile_snapshots"),
      latestValue("SELECT MAX(created_at) AS t FROM treasury_snapshots"),
    );
    return { alerts, lastVerifiedAt };
  };

  const guardWith = (rl: RateLimiter, ctx: RequestContext, bucket: string) => {
    if (!rl.allow(`${bucket}:${ctx.ip}`)) {
      throw new HttpError(429, "rate-limited", "too many requests, slow down");
    }
  };
  const guard = (ctx: RequestContext, bucket: string) => guardWith(limiter, ctx, bucket);
  const guardRead = (ctx: RequestContext, bucket: string) => guardWith(readLimiter, ctx, bucket);

  // SW-2026-09-26 F-15 (off-chain race, checklist §O): proposal decisions
  // read `status = open`, then `approve` awaits async execution (RPC vault
  // reads for economy close). Two concurrent decisions could both pass the
  // status check and execute twice, or interleave approve/reject. The chain
  // below serializes approve/reject in this process; admin traffic must be
  // routed to a single backend instance (documented in docs/DATABASE.md) —
  // SQLite alone cannot order two connections' check-then-act windows.
  let decisionChain: Promise<unknown> = Promise.resolve();
  const withDecisionLock = <T>(work: () => T | Promise<T>): Promise<T> => {
    const run = decisionChain.then(work, work);
    decisionChain = run.then(() => undefined, () => undefined);
    return run;
  };

  const requireWatchtowerIngest = (ctx: RequestContext): void => {
    guard(ctx, "watchtower-ingest");
    const configured = config.watchtowerIngestToken;
    if (configured === null) {
      if (config.environment === "production") {
        throw new HttpError(503, "watchtower-ingest-disabled", "production ingestion credential is not configured");
      }
      return;
    }
    const presented = ctx.bearer;
    if (presented === null) {
      throw new HttpError(401, "watchtower-auth-required", "Watchtower ingestion requires a service bearer token");
    }
    const expectedHash = createHash("sha256").update(configured, "utf8").digest();
    const presentedHash = createHash("sha256").update(presented, "utf8").digest();
    if (!timingSafeEqual(expectedHash, presentedHash)) {
      throw new HttpError(401, "watchtower-auth-invalid", "invalid Watchtower ingestion credential");
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

  // ------------------------------------------------------------ admin (Tranche A)
  // Role-separated, constant-time admin plane. Operators propose, superadmins
  // approve (execution happens inside approval); everything is audit-logged.
  const admin = new AdminStore(db, config);

  const requireAdmin = (ctx: RequestContext, role: "operator" | "superadmin" = "operator"): AdminIdentity => {
    if (!adminConfigured(config)) {
      throw new HttpError(503, "admin-disabled", "admin routes are not configured");
    }
    const identity = authenticateAdmin(config, ctx.bearer);
    if (!identity) {
      throw new HttpError(403, "admin-forbidden", "admin authentication required");
    }
    if (role === "superadmin" && identity.role !== "superadmin") {
      throw new HttpError(403, "admin-forbidden", "this action requires the superadmin role");
    }
    return identity;
  };

  router.add("GET", "/v1/health", () => ({
    status: "ok",
    service: "neonrelay-backend",
    version: config.version,
    migrations: migrationCount(db),
  }));

  // ------------------------------------------------------------ Watchtower OS v3
  // These routes are intentionally provider-neutral. They expose the selected
  // adapter contracts and telemetry shape, not credentials or unverified
  // promises from third-party services.
  router.add("GET", "/api/os/config", () => watchtowerConfig(config));

  router.add("GET", "/api/l2/router", (ctx) => {
    const gameId = ctx.url.searchParams.get("gameId") ?? WATCHTOWER_GAME_ID;
    const tps = ctx.url.searchParams.get("tps") ?? "standard";
    const ux = ctx.url.searchParams.get("ux") ?? "signed";
    if (gameId !== WATCHTOWER_GAME_ID) {
      throw new HttpError(400, "unknown-game", `gameId must be ${WATCHTOWER_GAME_ID}`);
    }
    if (!["standard", "high", "very_high"].includes(tps)) {
      throw new HttpError(400, "bad-tps", "tps must be standard, high or very_high");
    }
    if (!["signed", "gasless"].includes(ux)) {
      throw new HttpError(400, "bad-ux", "ux must be signed or gasless");
    }
    return routeL2(gameId, tps, ux);
  });

  const sdkNames = [
    "godot-solana", "gamba", "preset", "ritarena", "xandeum", "pst",
    "core-attributes", "access-protocol", "idosgames-wallet",
    "security-auditing-skill", "sentio-cli", "solguard", "solana-slam", "arcium",
  ];
  for (const sdkName of sdkNames) {
    router.add("GET", `/api/sdk/${sdkName}`, (ctx) => {
      const gameId = ctx.url.searchParams.get("gameId") ?? WATCHTOWER_GAME_ID;
      if (gameId !== WATCHTOWER_GAME_ID) {
        throw new HttpError(400, "unknown-game", `gameId must be ${WATCHTOWER_GAME_ID}`);
      }
      return sdkConfig(sdkName, gameId);
    });
  }

  // SW-2026-AGI V78: pinned tool-description integrity. Integrating agents
  // verify this before trusting any SDK contract description; drift also
  // fails the backend boot (see assertToolRegistryPinned in server.ts).
  router.add("GET", "/api/os/tools/integrity", () => toolIntegrityReport());

  router.add("GET", "/api/game-signals/config", (ctx) => {
    const gameId = ctx.url.searchParams.get("gameId") ?? WATCHTOWER_GAME_ID;
    if (gameId !== WATCHTOWER_GAME_ID) {
      throw new HttpError(400, "unknown-game", `gameId must be ${WATCHTOWER_GAME_ID}`);
    }
    return gameSignalsConfig(gameId);
  });

  const watchtowerRoutes = [
    "/watchtower/health",
    "/watchtower/readyz",
    "/watchtower/config",
    "/watchtower/events",
    "/watchtower/events/:signature",
    "/watchtower/metrics/daily",
    "/watchtower/players/cohorts",
    "/watchtower/players/retention",
    "/watchtower/players/cross-game",
    "/watchtower/economy",
    "/watchtower/treasury",
    "/watchtower/security",
    "/watchtower/alerts",
    "/watchtower/funnels",
    "/watchtower/forecast",
  ];

  router.add("GET", "/watchtower/health", () => {
    const watchtowerEvents = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM watchtower_events")?.n ?? 0;
    const gameEvents = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM game_events")?.n ?? 0;
    const rewardEvents = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM reward_events")?.n ?? 0;
    const lastVerifiedAt = latestObservedAt(
      latestValue("SELECT MAX(received_at) AS t FROM watchtower_events"),
      latestValue("SELECT MAX(ingested_at) AS t FROM game_events"),
      latestValue("SELECT MAX(ingested_at) AS t FROM reward_events"),
    );
    return watchtowerEnvelope({
      gameId: WATCHTOWER_GAME_ID,
      tenant: WATCHTOWER_GAME_ID,
      readOnly: true,
      writes: false,
      routeCount: watchtowerRoutes.length,
      health: {
        backendOk: true,
        writes: false,
        migrations: migrationCount(db),
        rewardsProgramConfigured: rewardsConfigured(),
        rewardSigningConfigured: config.serverSigningPublicKey !== null,
      },
      counters: { watchtowerEvents, gameEvents, rewardEvents },
    }, {
      dataQuality: watchtowerEvents > 0 || gameEvents > 0 || rewardEvents > 0 ? "partial" : "unavailable",
      lastVerifiedAt,
    });
  });

  router.add("GET", "/watchtower/readyz", async () => {
    const basicBlockers: string[] = [];
    if (!rewardsConfigured()) basicBlockers.push("NEONRELAY_REWARDS_PROGRAM_ID is not set");
    if (config.serverSigningPublicKey === null) basicBlockers.push("NEONRELAY_SERVER_SIGNING_PUBLIC_KEY is not set");
    const gate = await verifyProductionGate();
    const blockers = [...new Set([...basicBlockers, ...gate.blockers])];
    const lastVerifiedAt = latestObservedAt(
      latestValue("SELECT MAX(received_at) AS t FROM watchtower_events"),
      latestValue("SELECT MAX(ingested_at) AS t FROM reward_events"),
    );
    return watchtowerEnvelope({
      gameId: WATCHTOWER_GAME_ID,
      // Readiness is a deployment gate, not a liveness signal. Do not report
      // ready merely because the SQLite process is alive while RPC, manifest,
      // program authority, mint, or signed-ingest checks are unverified.
      ready: gate.ready && blockers.length === 0,
      readOnlyReady: gate.ready && blockers.length === 0,
      productionReady: gate.ready && blockers.length === 0,
      writes: false,
      blockers,
      productionVerification: {
        checkedAt: gate.checkedAt,
        status: gate.ready && blockers.length === 0 ? "verified" : "blocked",
      },
    }, {
      dataQuality: blockers.length === 0 ? "complete" : "unavailable",
      lastVerifiedAt,
    });
  });

  router.add("GET", "/watchtower/config", () => watchtowerEnvelope({
    gameId: WATCHTOWER_GAME_ID,
    tenant: WATCHTOWER_GAME_ID,
    readOnly: true,
    writes: false,
    routes: watchtowerRoutes.map((path) => ({ method: "GET", path })),
    aliases: {
      "/api/os/config": "/watchtower/config",
      "/api/ingest/solana": "/watchtower/events",
      "/api/games/neonrelay/ingestion": "/api/ingest/solana",
    },
    programIds: watchtowerConfig(config).program_ids,
    environment: "unknown",
  }, {
    dataQuality: "partial",
    lastVerifiedAt: latestObservedAt(latestValue("SELECT MAX(received_at) AS t FROM watchtower_events")),
  }));

  router.add("GET", "/watchtower/events", (ctx) => {
    const limit = intQuery(ctx, "limit", 100, 1, 500);
    const cursor = decodeCursor(ctx.url.searchParams.get("cursor"));
    const since = parseSinceMs(ctx.url.searchParams.get("since"));
    const eventType = ctx.url.searchParams.get("eventType");
    const args: (string | number | null)[] = [];
    let sql = `SELECT id, idempotency_hash, event_type, external_id, solana_wallet, wallet_id,
      session_id, match_id, mode, result_json, metadata_json, occurred_at, received_at, memory_mac
      FROM watchtower_events WHERE 1 = 1`;
    if (since !== null) {
      sql += " AND occurred_at >= ?";
      args.push(since);
    }
    if (eventType !== null && eventType !== "") {
      sql += " AND event_type = ?";
      args.push(eventType);
    }
    if (cursor !== null) {
      sql += " AND (occurred_at > ? OR (occurred_at = ? AND id > ?))";
      args.push(cursor.occurredAt, cursor.occurredAt, cursor.id);
    }
    sql += " ORDER BY occurred_at, id LIMIT ?";
    args.push(limit + 1);
    const rows = db.all<WatchtowerEventRow>(sql, ...args);
    const page = rows.slice(0, limit);
    const next = rows.length > limit ? rows[limit] : undefined;
    const lastVerifiedAt = page.length === 0 ? null : isoOrNull(page[page.length - 1]?.received_at ?? null);
    return watchtowerEnvelope({
      items: page.map((row) => normalizeWatchtowerEventRow(row, config)),
      nextCursor: next ? encodeCursor(next.occurred_at, next.id) : null,
      replayable: true,
      backfill: true,
      deduplicated: true,
    }, {
      period: since === null ? "all-time UTC" : `since ${new Date(since).toISOString()} UTC`,
      dataQuality: page.length === 0 ? "unavailable" : "partial",
      lastVerifiedAt,
    });
  });

  router.add("GET", "/watchtower/events/:signature", (ctx) => {
    const signature = ctx.params.signature;
    // SW-2026-AGI F-AI-01: the previous implementation interpolated the raw
    // signature into a LIKE pattern, so `%`/`_` wildcards let one signature
    // lookup match arbitrary other rows. Validate the base58-ish signature
    // shape AND escape the remaining LIKE metacharacters.
    // Charset note: real Solana signatures are pure base58, but the repository
    // fixtures and smoke checks use hyphenated labels ("test-neon-1"); the
    // security property is a bounded charset without LIKE metacharacters.
    if (!/^[A-Za-z0-9_-]{8,96}$/.test(signature)) {
      throw new HttpError(400, "bad-signature", "signature must be 8..96 url-safe signature characters");
    }
    const escaped = signature.replace(/[\\%_]/g, (ch) => `\\${ch}`);
    const row = db.get<WatchtowerEventRow>(`SELECT id, idempotency_hash, event_type, external_id, solana_wallet, wallet_id,
      session_id, match_id, mode, result_json, metadata_json, occurred_at, received_at, memory_mac
      FROM watchtower_events WHERE metadata_json LIKE ? ESCAPE '\\' ORDER BY received_at DESC LIMIT 1`,
    `%\"signature\":\"${escaped}\"%`);
    if (!row) throw new HttpError(404, "not-found", `no watchtower event for signature ${signature}`);
    return watchtowerEnvelope(normalizeWatchtowerEventRow(row, config), {
      dataQuality: "partial",
      lastVerifiedAt: isoOrNull(row.received_at),
    });
  });

  router.add("GET", "/watchtower/metrics/daily", (ctx) => {
    const days = intQuery(ctx, "days", 7, 1, 90);
    const now = Date.now();
    const metrics = computeMetrics(db, days, now, rpcPool.getStatus());
    const telemetry = db.all<{ day: string; event_type: string; n: number }>(
      `SELECT strftime('%Y-%m-%d', occurred_at / 1000, 'unixepoch') AS day,
              event_type, COUNT(*) AS n
       FROM watchtower_events WHERE occurred_at >= ?
       GROUP BY day, event_type ORDER BY day, event_type`,
      metrics.since);
    return watchtowerEnvelope({
      windowDays: days,
      activity: metrics.activity,
      finish: metrics.finish,
      claims: metrics.claims,
      pipeline: metrics.pipeline,
      telemetry,
    }, {
      period: `${days}d UTC`,
      dataQuality: telemetry.length > 0 || metrics.activity.length > 0 ? "partial" : "unavailable",
      lastVerifiedAt: latestObservedAt(
        latestValue("SELECT MAX(received_at) AS t FROM watchtower_events"),
        latestValue("SELECT MAX(ingested_at) AS t FROM game_events"),
      ),
    });
  });

  router.add("GET", "/watchtower/players/cohorts", (ctx) => {
    const days = intQuery(ctx, "days", 30, 1, 180);
    const since = Date.now() - days * 86_400_000;
    const cohorts = db.all<{ day: string; walletBindings: number; linkedPlayers: number }>(
      `SELECT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch') AS day,
              COUNT(*) AS walletBindings,
              SUM(CASE WHEN player_id IS NOT NULL THEN 1 ELSE 0 END) AS linkedPlayers
       FROM wallet_bindings WHERE created_at >= ?
       GROUP BY day ORDER BY day`,
      since);
    return watchtowerEnvelope({
      windowDays: days,
      cohorts,
      note: "wallet-binding cohorts only; acquisition source is unavailable in this repository",
    }, {
      period: `${days}d UTC`,
      dataQuality: cohorts.length > 0 ? "partial" : "unavailable",
      lastVerifiedAt: latestObservedAt(latestValue("SELECT MAX(created_at) AS t FROM wallet_bindings")),
    });
  });

  router.add("GET", "/watchtower/players/retention", (ctx) => {
    const requested = ctx.url.searchParams.get("days");
    const horizons = (requested ?? "1,3,7,14,30").split(",")
      .map((value) => Number(value.trim()))
      .filter((value, index, array) => Number.isInteger(value) && value > 0 && value <= 60 && array.indexOf(value) === index)
      .sort((a, b) => a - b);
    if (horizons.length === 0) {
      throw new HttpError(400, "bad-query", "days must contain at least one retention horizon");
    }
    const since = parseSinceMs(ctx.url.searchParams.get("since")) ?? (Date.now() - 35 * 86_400_000);
    const rows = db.all<{ player_id: string; day: string }>(
      `SELECT player_id, strftime('%Y-%m-%d', occurred_at / 1000, 'unixepoch') AS day
       FROM game_events
       WHERE event_type = 'session_start' AND status = 'accepted'
         AND player_id IS NOT NULL AND occurred_at >= ?`,
      since);
    const playersByDay = new Map<string, Set<string>>();
    for (const row of rows) {
      const set = playersByDay.get(row.day) ?? new Set<string>();
      set.add(row.player_id);
      playersByDay.set(row.day, set);
    }
    const daysSorted = [...playersByDay.keys()].sort();
    const retention = horizons.map((horizon) => {
      let base = 0;
      let retained = 0;
      for (const day of daysSorted) {
        const cohort = playersByDay.get(day) ?? new Set<string>();
        if (cohort.size === 0) continue;
        const targetDate = new Date(`${day}T00:00:00.000Z`);
        targetDate.setUTCDate(targetDate.getUTCDate() + horizon);
        const target = playersByDay.get(targetDate.toISOString().slice(0, 10));
        if (!target) continue;
        base += cohort.size;
        for (const player of cohort) {
          if (target.has(player)) retained += 1;
        }
      }
      return {
        days: horizon,
        cohortPlayers: base,
        retainedPlayers: retained,
        rate: base === 0 ? null : Math.round((retained / base) * 10000) / 10000,
      };
    });
    const quality: WatchtowerDataQuality = retention.some((row) => row.cohortPlayers > 0) ? "partial" : "unavailable";
    return watchtowerEnvelope({ horizons: retention }, {
      period: `since ${new Date(since).toISOString()} UTC`,
      dataQuality: quality,
      lastVerifiedAt: latestObservedAt(latestValue("SELECT MAX(occurred_at) AS t FROM game_events")),
    });
  });

  router.add("GET", "/watchtower/players/cross-game", () => {
    const gameAccounts = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM game_accounts WHERE enabled = 1")?.n ?? 0;
    const grants = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM game_identity_grants")?.n ?? 0;
    const pairings = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM game_pairings")?.n ?? 0;
    return watchtowerEnvelope({
      compatibleStudioProfileKey: "studio_profile",
      localGameAccounts: gameAccounts,
      activeIdentityGrants: grants,
      issuedPairings: pairings,
      crossGameWarehouseAvailable: false,
      note: "this repository exposes identity edges only; studio-wide cross-game projections are unavailable here",
    }, {
      dataQuality: gameAccounts > 0 || grants > 0 || pairings > 0 ? "partial" : "unavailable",
      lastVerifiedAt: latestObservedAt(
        latestValue("SELECT MAX(expires_at) AS t FROM game_identity_grants"),
        latestValue("SELECT MAX(expires_at) AS t FROM game_pairings"),
      ),
    });
  });

  router.add("GET", "/watchtower/economy", (ctx) => {
    const days = intQuery(ctx, "days", 7, 1, 90);
    const since = Date.now() - days * 86_400_000;
    const rewards = db.all<{ day: string; accepted_micro: number }>(
      `SELECT strftime('%Y-%m-%d', ingested_at / 1000, 'unixepoch') AS day,
              COALESCE(SUM(amount_micro), 0) AS accepted_micro
       FROM reward_events
       WHERE status = 'accepted' AND ingested_at >= ?
       GROUP BY day ORDER BY day`,
      since);
    const claims = db.all<{ day: string; confirmed_claims: number }>(
      `SELECT strftime('%Y-%m-%d', updated_at / 1000, 'unixepoch') AS day,
              COUNT(*) AS confirmed_claims
       FROM claim_intents
       WHERE status = 'confirmed' AND updated_at >= ?
       GROUP BY day ORDER BY day`,
      since);
    const prizeEpochs = db.all<{ epoch: number; total_micro: number; created_at: number }>(
      `SELECT epoch, total_micro, created_at FROM economy_epochs
       WHERE created_at >= ? ORDER BY epoch DESC LIMIT 20`,
      since);
    const v2 = {
      openEpochs: db.get<{ n: number }>("SELECT COUNT(*) AS n FROM economy_v2_epochs WHERE state = 'OPEN'")?.n ?? 0,
      sealedEpochs: db.get<{ n: number }>("SELECT COUNT(*) AS n FROM economy_v2_epochs WHERE state = 'SEALED'")?.n ?? 0,
      intents: db.get<{ n: number }>("SELECT COUNT(*) AS n FROM economy_v2_intents")?.n ?? 0,
    };
    return watchtowerEnvelope({ rewards, claims, prizeEpochs, economyV2: v2 }, {
      period: `${days}d UTC`,
      dataQuality: rewards.length > 0 || claims.length > 0 || prizeEpochs.length > 0 || v2.intents > 0 ? "partial" : "unavailable",
      lastVerifiedAt: latestObservedAt(
        latestValue("SELECT MAX(ingested_at) AS t FROM reward_events"),
        latestValue("SELECT MAX(updated_at) AS t FROM claim_intents"),
        latestValue("SELECT MAX(created_at) AS t FROM economy_epochs"),
      ),
    });
  });

  router.add("GET", "/watchtower/treasury", () => {
    const row = db.get<{
      created_at: number; program: string; mint: string; vault: string; treasury: string;
      vault_balance: string; treasury_balance: string; reserved: string;
    }>(`SELECT created_at, program, mint, vault, treasury, vault_balance, treasury_balance, reserved
        FROM treasury_snapshots ORDER BY created_at DESC LIMIT 1`);
    return watchtowerEnvelope({
      latest: row ?? null,
      note: row ? null : "treasury snapshots have not been recorded yet",
    }, {
      dataQuality: row ? "partial" : "unavailable",
      lastVerifiedAt: isoOrNull(row?.created_at),
    });
  });

  router.add("GET", "/watchtower/security", () => {
    const memoryScan = scanMemoryIntegrity(db, config.watchtowerMemoryKey);
    const reconcile = db.all<{ kind: string; status: string; n: number }>(
      `SELECT kind, status, COUNT(*) AS n FROM reconcile_snapshots GROUP BY kind, status ORDER BY kind, status`);
    const adminActions = db.all<{ action: string; n: number }>(
      `SELECT action, COUNT(*) AS n FROM admin_audit GROUP BY action ORDER BY action`);
    const { alerts, lastVerifiedAt } = buildWatchtowerAlerts();
    return watchtowerEnvelope({
      serverAuthoritative: true,
      rewardSigningConfigured: config.serverSigningPublicKey !== null,
      rewardsProgramConfigured: rewardsConfigured(),
      reconcile,
      adminActions,
      openAlerts: alerts.length,
      // SW-2026-AGI T74: exporter-reading agents must be able to fail closed
      // on poisoned memory; tampered rows are named, not silently dropped.
      memoryIntegrity: {
        checked: memoryScan.checked,
        tampered: memoryScan.tampered.length,
        tamperedIds: memoryScan.tampered.slice(0, 20).map((row) => row.id),
        unsigned: memoryScan.unsigned,
        policy: "rows flagged tampered must never be fed to an agent; investigate the writer",
      },
      auditReport: "external AUDIT_REPORT_PATH required; committed reports are not release evidence",
    }, {
      dataQuality: reconcile.length > 0 || adminActions.length > 0 ? "partial" : "unavailable",
      lastVerifiedAt,
    });
  });

  router.add("GET", "/watchtower/alerts", () => {
    const { alerts, lastVerifiedAt } = buildWatchtowerAlerts();
    return watchtowerEnvelope({
      open: alerts,
      total: alerts.length,
      acknowledgement: "read-only exporter; acknowledgement happens in Watchtower, not in Neon Relay",
    }, {
      dataQuality: alerts.length > 0 ? "partial" : "unavailable",
      lastVerifiedAt,
    });
  });

  router.add("GET", "/watchtower/funnels", () => {
    const sessions = db.get<{ n: number }>(
      "SELECT COUNT(DISTINCT session_id) AS n FROM game_events WHERE event_type = 'session_start' AND status = 'accepted'")?.n ?? 0;
    const matches = db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM watchtower_events WHERE event_type = 'match_start'")?.n ?? 0;
    const firstFinishes = db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM watchtower_events WHERE event_type = 'first_finish'")?.n ?? 0;
    const firstClaims = db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM watchtower_events WHERE event_type = 'first_claim'")?.n ?? 0;
    const confirmedClaims = db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM claim_intents WHERE status = 'confirmed'")?.n ?? 0;
    const linkedWallets = db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM wallet_bindings WHERE revoked_at IS NULL")?.n ?? 0;
    return watchtowerEnvelope({
      stages: [
        { id: "wallet_linked", count: linkedWallets },
        { id: "session_start", count: sessions },
        { id: "match_start", count: matches },
        { id: "first_finish", count: firstFinishes },
        { id: "first_claim", count: firstClaims },
        { id: "claim_confirmed", count: confirmedClaims },
      ],
    }, {
      dataQuality: linkedWallets > 0 || sessions > 0 || matches > 0 ? "partial" : "unavailable",
      lastVerifiedAt: latestObservedAt(
        latestValue("SELECT MAX(created_at) AS t FROM wallet_bindings"),
        latestValue("SELECT MAX(received_at) AS t FROM watchtower_events"),
        latestValue("SELECT MAX(updated_at) AS t FROM claim_intents"),
      ),
    });
  });

  router.add("GET", "/watchtower/forecast", () => watchtowerEnvelope({
    forecast: null,
    note: "forecasting is intentionally unavailable until a verified production data stream exists",
  }, {
    dataQuality: "unavailable",
    lastVerifiedAt: null,
  }));

  const fromTelemetryQuery = (ctx: RequestContext): TelemetryInput | null => {
    const eventType = ctx.url.searchParams.get("event_type");
    if (!eventType) return null;
    let result: unknown = undefined;
    const resultText = ctx.url.searchParams.get("result");
    if (resultText !== null) {
      try { result = JSON.parse(resultText); } catch {
        throw new HttpError(400, "bad-telemetry", "result must be valid JSON");
      }
    }
    return {
      event_type: eventType as TelemetryInput["event_type"],
      external_id: ctx.url.searchParams.get("external_id"),
      solana_wallet: ctx.url.searchParams.get("solana_wallet"),
      wallet_id: ctx.url.searchParams.get("wallet_id"),
      session_id: ctx.url.searchParams.get("session_id"),
      match_id: ctx.url.searchParams.get("match_id"),
      mode: ctx.url.searchParams.get("mode"),
      result,
      metadata: (() => {
        const metadataText = ctx.url.searchParams.get("metadata");
        if (!metadataText) return undefined;
        try { return JSON.parse(metadataText); } catch {
          throw new HttpError(400, "bad-telemetry", "metadata must be valid JSON");
        }
      })(),
      occurred_at: ctx.url.searchParams.get("occurred_at")
        ? Number(ctx.url.searchParams.get("occurred_at")) : undefined,
    };
  };

  const ingestTelemetry = (input: unknown): ReturnType<typeof ingestWatchtowerEvent> => {
    try {
      // SW-2026-AGI T74: every stored event is MACed with the deployment
      // memory key so exporter-reading agents can detect poisoned records.
      return ingestWatchtowerEvent(db, normalizeSolanaEvent(input), Date.now(),
        { memoryKey: config.watchtowerMemoryKey });
    } catch (err) {
      throw new HttpError(400, "bad-telemetry", (err as Error).message);
    }
  };

  const contractOnlyIngestion = () => ({ ...ingestContract(), accepted: 0, results: [] });

  const hubIngestionPayload = (results: ReturnType<typeof ingestWatchtowerEvent>[]) => ({
    ...ingestContract(),
    accepted: results.some((result) => result.status === "accepted"),
    duplicate: results.length === 1 && results[0]?.status === "duplicate",
    accepted_count: results.filter((result) => result.status === "accepted").length,
    duplicate_count: results.filter((result) => result.status === "duplicate").length,
    results,
  });

  router.add("GET", "/api/ingest/solana", (ctx) => {
    const input = fromTelemetryQuery(ctx);
    if (!input) return contractOnlyIngestion();
    requireWatchtowerIngest(ctx);
    const result = ingestTelemetry(input);
    return { ...ingestContract(), accepted: result.status === "accepted" ? 1 : 0, results: [result] };
  });

  router.add("POST", "/api/ingest/solana", (ctx) => {
    requireWatchtowerIngest(ctx);
    const body = (ctx.body ?? {}) as Record<string, unknown>;
    const rawEvents = Array.isArray(body.events) ? body.events : [body];
    if (rawEvents.length < 1 || rawEvents.length > 500) {
      throw new HttpError(400, "bad-telemetry", "events must contain 1..500 items");
    }
    db.raw.exec("BEGIN");
    try {
      const results = rawEvents.map((event) => ingestTelemetry(event));
      db.raw.exec("COMMIT");
      return { ...ingestContract(), accepted: results.filter((r) => r.status === "accepted").length, results };
    } catch (err) {
      db.raw.exec("ROLLBACK");
      throw err;
    }
  });

  router.add("GET", "/api/games/neonrelay/ingestion", (ctx) => {
    const input = fromTelemetryQuery(ctx);
    if (!input) return hubIngestionPayload([]);
    requireWatchtowerIngest(ctx);
    const result = ingestTelemetry(input);
    return hubIngestionPayload([result]);
  });

  router.add("POST", "/api/games/neonrelay/ingestion", (ctx) => {
    requireWatchtowerIngest(ctx);
    const body = (ctx.body ?? {}) as Record<string, unknown>;
    const rawEvents = Array.isArray(body.events) ? body.events : [body];
    if (rawEvents.length < 1 || rawEvents.length > 500) {
      throw new HttpError(400, "bad-telemetry", "events must contain 1..500 items");
    }
    db.raw.exec("BEGIN");
    try {
      const results = rawEvents.map((event) => ingestTelemetry(event));
      db.raw.exec("COMMIT");
      return hubIngestionPayload(results);
    } catch (err) {
      db.raw.exec("ROLLBACK");
      throw err;
    }
  });

  router.add("POST", "/api/campaigns/proposals", (ctx) => {
    requireWatchtowerIngest(ctx);
    const body = (ctx.body ?? {}) as Record<string, unknown>;
    const risk = Number(body.churn_risk ?? body.risk ?? 0);
    if (!Number.isFinite(risk) || risk < 0 || risk > 1) {
      throw new HttpError(400, "bad-campaign-proposal", "churn_risk must be between 0 and 1");
    }
    return {
      game_id: WATCHTOWER_GAME_ID,
      proposal_id: randomUUID(),
      status: risk > 0.7 ? "human-review" : "below-threshold",
      churn_risk: risk,
      campaign_id: optStr(body.campaign_id),
      human_review_required: true,
    };
  });

  router.add("POST", "/v1/auth/challenge", (ctx) => {
    guard(ctx, "challenge");
    return auth.issueChallenge();
  });

  router.add("POST", "/v1/auth/verify-wallet", (ctx) => {
    guard(ctx, "verify");
    const body = (ctx.body ?? {}) as Record<string, unknown>;
    const result = auth.verifyWallet({
      challenge: str(body["challenge"], "challenge", 2048),
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
    guard(ctx, "wallet-link");
    const { binding } = requireSession(ctx);
    const body = (ctx.body ?? {}) as Record<string, unknown>;
    const playerId = str(body["player_id"], "player_id", 128);
    // SW-2026-09-26 F-11 (HIGH): a self-declared player id is an identity
    // claim with no proof of control. Reward events resolve to the newest
    // active binding of the event's player_id, so whoever links an
    // unclaimed id first collects that player's sealed Merkle leaves.
    // Production (and any staging that opts in) therefore only accepts ids
    // the operator provisioned for THIS wallet in `game_accounts`.
    if (config.playerLinkRequiresRegistration) {
      const account = db.get<{ wallet: string; enabled: number }>(
        "SELECT wallet, enabled FROM game_accounts WHERE player_id = ?", playerId);
      if (!account || account.enabled !== 1 || account.wallet !== binding.public_key) {
        throw new HttpError(403, "player-not-registered",
          "player id must be operator-provisioned for this wallet "
          + "(backend/scripts/register_game_account.ts)");
      }
    }
    try {
      wallets.setPlayerLink(binding.id, playerId);
    } catch (error) {
      if (String((error as Error).message).includes("UNIQUE")) {
        throw new HttpError(409, "player-already-linked", "player identity is already linked to another active wallet");
      }
      throw error;
    }
    return { wallet_binding_id: binding.id, player_id: playerId };
  });

  router.add("POST", "/v1/wallet/unlink", (ctx) => {
    guard(ctx, "wallet-unlink");
    const { binding } = requireSession(ctx);
    // SW-2026-09-26 F-18: single atomic statement clears the link and revokes
    // the binding (the identity-invalidation trigger sees one consistent row).
    wallets.unlinkAndRevoke(binding.id);
    sessions.revokeForBinding(binding.id);
    return { unlinked: true, wallet_binding_id: binding.id };
  });

  const pairing = new GamePairing(db, config);
  router.add("POST", "/v2/game/pair", (ctx) => {
    guard(ctx, "game-pairing");
    const auth = requireSession(ctx);
    const body = (ctx.body ?? {}) as Record<string, unknown>;
    return pairing.issue(auth, str(body["connection_nonce"], "connection_nonce", 64), body["consent"]);
  });
  router.add("POST", "/v2/game/pair-sealed", (ctx) => {
    guard(ctx, "game-pairing");
    const auth = requireSession(ctx);
    const body = (ctx.body ?? {}) as Record<string, unknown>;
    return issueSealedPairing(config, pairing, auth, str(body["offer"], "offer", 2048),
      str(body["signature"], "signature", 86), body["consent"]);
  });
  // Server-authenticated via Ed25519 proof, NOT a wallet bearer session.
  router.add("POST", "/v2/game/redeem", (ctx) => {
    guard(ctx, "game-pairing-redeem");
    const body = (ctx.body ?? {}) as Record<string, unknown>;
    return pairing.redeem(str(body["pairing_token"], "pairing_token", 43),
      str(body["connection_nonce"], "connection_nonce", 64), str(body["signature"], "signature", 86));
  });

  const identity = new GameIdentity(db, config);
  router.add("POST", "/v2/identity/challenge", (ctx) => {
    guard(ctx, "game-identity");
    const auth = requireSession(ctx);
    const body = (ctx.body ?? {}) as Record<string, unknown>;
    return identity.issue(auth, str(body["player_id"], "player_id", 128));
  });
  router.add("POST", "/v2/identity/verify", (ctx) => {
    guard(ctx, "game-identity");
    const auth = requireSession(ctx);
    const body = (ctx.body ?? {}) as Record<string, unknown>;
    return identity.verify(auth, str(body["nonce"], "nonce", 43), str(body["signature"], "signature", 86));
  });
  router.add("GET", "/v2/identity", (ctx) => {
    guard(ctx, "game-identity-status");
    return identity.status(requireSession(ctx));
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

  // Read-only verified-results route (docs/UI_POTATO_ARENA_REDESIGN_RU.md §7.7).
  // The single server-confirmed source for the client's "verified" showcase:
  // DB-side accepted events only (signature-verified at ingest), plus the
  // on-chain achievement registry when the program id is configured. No writes,
  // no admin surface; the on-chain half degrades to "unavailable" so the DB
  // stats are still served when RPC is down.
  router.add("GET", "/v1/rewards/verified", async (ctx) => {
    const { binding } = requireSession(ctx);
    const stats = rewards.verifiedStats(binding);
    let achievements: AchievementRegistryView | null = null;
    let achievements_status = "disabled";
    if (config.featuresProgramId) {
      try {
        achievements = await readAchievementRegistry(
          rpc, config.featuresProgramId, binding.public_key);
        achievements_status = achievements ? "on-chain" : "none-recorded";
      } catch {
        achievements_status = "unavailable";
      }
    }
    return { source: "server-verified", ...stats, achievements, achievements_status };
  });

  router.add("GET", "/v1/rewards/epochs", (ctx) => {
    const page = parsePagination(ctx, 50, 200);
    const epochs = rewards.listEpochs();
    if (!page.present) return epochs;
    return {
      epochs: epochs.slice(page.offset, page.offset + page.limit),
      pagination: { limit: page.limit, offset: page.offset, total: epochs.length },
    };
  });

  // Direct seal was removed in Tranche A: sealing runs only through the
  // two-person proposal workflow below (410, not a silent stub).
  router.add("POST", "/v1/rewards/epochs/seal", () => {
    throw new HttpError(410, "admin-workflow-required",
      "direct seal is disabled; POST /v1/admin/proposals {type:\"seal-reward-epoch\"} then approve");
  });

  router.add("POST", "/v1/admin/proposals", (ctx) => {
    guard(ctx, "admin-propose");
    const identity = requireAdmin(ctx, "operator");
    const body = (ctx.body ?? {}) as Record<string, unknown>;
    const params = (body["params"] ?? body) as Record<string, unknown>;
    return admin.createProposal(identity, body["type"], params, ctx.ip);
  });

  router.add("POST", "/v1/admin/proposals/approve", async (ctx) => {
    guard(ctx, "admin-approve");
    const identity = requireAdmin(ctx, "superadmin");
    const body = (ctx.body ?? {}) as Record<string, unknown>;
    const id = str(body["proposal_id"], "proposal_id", 64);
    // F-15: serialized with reject so the open->terminal check and the
    // execution window are one critical section (see withDecisionLock).
    return withDecisionLock(() =>
      admin.approveProposal(identity, id, ctx.ip, executeProposal));
  });

  router.add("POST", "/v1/admin/proposals/reject", (ctx) => {
    guard(ctx, "admin-approve");
    const identity = requireAdmin(ctx, "superadmin");
    const body = (ctx.body ?? {}) as Record<string, unknown>;
    const id = str(body["proposal_id"], "proposal_id", 64);
    return withDecisionLock(() =>
      admin.rejectProposal(identity, id, body["reason"], ctx.ip));
  });

  router.add("GET", "/v1/admin/proposals", (ctx) => {
    guard(ctx, "admin-read");
    requireAdmin(ctx, "operator");
    const page = parsePagination(ctx, 50, 200);
    const { rows, total } = admin.listProposals(page.limit, page.offset);
    return { proposals: rows, pagination: { limit: page.limit, offset: page.offset, total } };
  });

  router.add("GET", "/v1/admin/audit", (ctx) => {
    guard(ctx, "admin-read");
    requireAdmin(ctx, "operator");
    const page = parsePagination(ctx, 50, 200);
    const { rows, total } = admin.listAudit(page.limit, page.offset);
    return { entries: rows, pagination: { limit: page.limit, offset: page.offset, total } };
  });

  router.add("POST", "/v1/admin/backup", (ctx) => {
    guard(ctx, "admin-backup");
    const identity = requireAdmin(ctx, "superadmin");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = `neonrelay-${stamp}-${randomUUID().slice(0, 8)}.db`;
    mkdirSync(config.backupDir, { recursive: true });
    const full = join(config.backupDir, file);
    // The name is fully server-generated; escape it for the SQL string literal.
    db.exec(`VACUUM INTO '${full.replace(/'/g, "''")}'`);
    const bytes = statSync(full).size;
    const sha256 = createHash("sha256").update(readFileSync(full)).digest("hex");
    const inspection = inspectBackup(full, sha256);
    const result = { file, bytes, sha256, integrity: inspection.integrity, migration_count: inspection.migration_count, created_at: Date.now() };
    admin.audit({
      actorRole: identity.role, actorHash: identity.fingerprint,
      action: "backup-created", result, ip: ctx.ip,
    });
    return result;
  });

  router.add("GET", "/v1/admin/backups", (ctx) => {
    guard(ctx, "admin-read");
    requireAdmin(ctx, "operator");
    let files: string[] = [];
    try {
      files = readdirSync(config.backupDir);
    } catch {
      files = [];
    }
    const backups = files
      .filter((f) => f.startsWith("neonrelay-") && f.endsWith(".db"))
      .sort().reverse().slice(0, 200)
      .map((f) => {
        try {
          const st = lstatSync(join(config.backupDir, f));
          if (!st.isFile() || st.isSymbolicLink()) return null;
          return { file: f, bytes: st.size, modified_at: Math.floor(st.mtimeMs) };
        } catch {
          return null;
        }
      })
      .filter((row): row is { file: string; bytes: number; modified_at: number } => row !== null);
    return { backups };
  });

  router.add("POST", "/v1/admin/restore/verify", (ctx) => {
    guard(ctx, "admin-restore");
    const identity = requireAdmin(ctx, "superadmin");
    const body = (ctx.body ?? {}) as Record<string, unknown>;
    const file = str(body["file"], "file", 255);
    if (basename(file) !== file || !/^neonrelay-[A-Za-z0-9_.-]+\.db$/.test(file)) {
      throw new HttpError(400, "bad-backup-file", "file must be a server-generated backup basename");
    }
    const root = resolve(config.backupDir);
    const full = resolve(root, file);
    if (relative(root, full).startsWith("..") || resolve(root, relative(root, full)) !== full) {
      throw new HttpError(400, "bad-backup-file", "backup path escapes the configured backup directory");
    }
    const checksum = body["sha256"] === undefined ? null : str(body["sha256"], "sha256", 64);
    if (checksum !== null && !/^[0-9a-f]{64}$/.test(checksum)) {
      throw new HttpError(400, "bad-checksum", "sha256 must be 64 lowercase hexadecimal characters");
    }
    try {
      const inspection = inspectBackup(full, checksum);
      admin.audit({
        actorRole: identity.role, actorHash: identity.fingerprint,
        action: "backup-restore-verified", result: inspection, ip: ctx.ip,
      });
      return {
        ...inspection,
        restore: "verified-only",
        note: "stop the backend and run backend/scripts/restore_backup.ts for atomic replacement",
      };
    } catch (error) {
      throw new HttpError(409, "backup-invalid", error instanceof Error ? error.message : "backup verification failed");
    }
  });

  const LEDGER_TABLES = [
    "wallet_bindings", "auth_nonces", "sessions", "reward_events", "reward_epochs",
    "reward_leaves", "claim_intents", "economy_epochs", "economy_matches",
    "economy_v2_epochs", "economy_v2_intents", "game_identity_challenges",
    "game_identity_grants", "game_accounts", "game_pairings",
    "admin_proposals", "admin_audit", "game_events",
    "reconcile_snapshots", "treasury_snapshots", "schema_migrations",
  ];

  router.add("GET", "/v1/admin/ledger-stats", (ctx) => {
    guard(ctx, "admin-read");
    requireAdmin(ctx, "operator");
    let dbBytes: number | null = null;
    try {
      dbBytes = statSync(config.dbPath).size;
    } catch {
      const pages = db.get<{ page_count: number }>("PRAGMA page_count")?.page_count ?? 0;
      const size = db.get<{ page_size: number }>("PRAGMA page_size")?.page_size ?? 0;
      dbBytes = pages * size;
    }
    const tables: Record<string, number> = {};
    for (const table of LEDGER_TABLES) {
      tables[table] = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)?.n ?? 0;
    }
    return { db_bytes: dbBytes, tables };
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

  router.add("POST", "/v1/rewards/claim-confirmation", async (ctx) => {
    const { binding } = requireSession(ctx);
    const body = (ctx.body ?? {}) as Record<string, unknown>;
    const intentId = str(body["intent_id"], "intent_id", 64);
    const transactionId = str(body["transaction_id"], "transaction_id", 128);
    const status = body["status"];
    if (status !== "submitted" && status !== "confirmed" && status !== "failed") {
      throw new HttpError(400, "bad-request",
        "status must be one of submitted|confirmed|failed");
    }
    if (config.environment === "production" &&
        !/^[1-9A-HJ-NP-Za-km-z]{87,88}$/.test(transactionId)) {
      throw new HttpError(400, "bad-transaction-signature", "transaction_id must be a valid base58 Solana signature");
    }
    if (status === "confirmed" && config.environment === "production") {
      const gate = await verifyProductionGate();
      if (!gate.ready) {
        throw new HttpError(503, "production-gate-blocked", "claim confirmation is disabled until the finalized deployment gate passes");
      }
      try {
        const statuses = await rpcPool.call(
          "getSignatureStatuses", [[transactionId], { searchTransactionHistory: true, commitment: "finalized" }],
        ) as { value?: ({ confirmationStatus?: string; err?: unknown } | null)[] };
        const entry = statuses?.value?.[0];
        if (!entry) {
          throw new HttpError(409, "transaction-not-found", "the claim transaction is not visible at finalized commitment");
        }
        // Solana returns `err: null` for success. Missing `err` is not
        // equivalent to success; reject incomplete RPC envelopes.
        if (entry.err !== null) {
          throw new HttpError(400, "transaction-failed-onchain", "transaction failed on-chain");
        }
        if (entry.confirmationStatus !== "finalized") {
          throw new HttpError(409, "transaction-not-finalized", "the claim transaction is not finalized");
        }

        const intent = db.get<{
          wallet_binding_id: string; epoch_id: number; amount_micro: number;
          leaf_index: number; merkle_proof: string;
        }>(
          `SELECT i.wallet_binding_id, i.epoch_id, i.amount_micro,
                  l.leaf_index, i.merkle_proof
             FROM claim_intents i
             JOIN reward_leaves l ON l.epoch_id = i.epoch_id
                                  AND l.wallet_binding_id = i.wallet_binding_id
            WHERE i.id = ? AND i.wallet_binding_id = ?`,
          intentId, binding.id);
        if (!intent) throw new HttpError(404, "intent-not-found", "claim intent not found");
        if (!config.rewardsProgramId || !config.rewardMint) {
          throw new HttpError(503, "claim-verification-unavailable", "rewards program and reward mint are not configured");
        }
        const transaction = await rpcPool.call(
          "getTransaction", [transactionId, {
            encoding: "jsonParsed", commitment: "finalized", maxSupportedTransactionVersion: 0,
          }],
        ) as {
          meta?: { err?: unknown } | null;
          transaction?: { message?: { accountKeys?: unknown[]; instructions?: unknown[] } };
        } | null;
        if (!transaction || !transaction.meta || transaction.meta.err !== null || !transaction.transaction?.message) {
          throw new HttpError(400, "transaction-not-claim", "finalized transaction is not a successful claim");
        }
        const message = transaction.transaction.message;
        const keyName = (key: unknown): string | null => {
          if (typeof key === "string") return key;
          if (key && typeof key === "object" && typeof (key as { pubkey?: unknown }).pubkey === "string") {
            return (key as { pubkey: string }).pubkey;
          }
          return null;
        };
        const accountKeyEntries = (message.accountKeys ?? []).map((raw) => {
          const pubkey = keyName(raw);
          const signer = raw !== null && typeof raw === "object" &&
            (raw as { signer?: unknown }).signer === true;
          return { pubkey, signer };
        });
        const accountKeys = accountKeyEntries.map((entry) => entry.pubkey);
        const playerKey = base58Encode(Buffer.from(binding.public_key, "base64url"));
        const playerAccount = accountKeyEntries.find((entry) => entry.pubkey === playerKey);
        if (!playerAccount?.signer) {
          throw new HttpError(400, "transaction-claim-mismatch", "claim transaction does not prove this wallet signed");
        }
        const claimDiscriminator = createHash("sha256").update("global:claim", "utf8").digest().subarray(0, 8);
        const claimInstruction = (message.instructions ?? []).find((raw) => {
          if (!raw || typeof raw !== "object") return false;
          const instruction = raw as { programId?: unknown; data?: unknown };
          return instruction.programId === config.rewardsProgramId && typeof instruction.data === "string";
        }) as { accounts?: unknown[]; data?: string } | undefined;
        if (!claimInstruction?.data) {
          throw new HttpError(400, "transaction-not-claim", "finalized transaction has no rewards claim instruction");
        }
        const instructionData = Buffer.from(base58Decode(claimInstruction.data));
        // Anchor Borsh layout: discriminator (8), epoch (u64 LE), amount
        // (u64 LE), leaf index (u32 LE), proof length (u32 LE), proof hashes.
        // Parse and bind every argument to the server-created intent; matching
        // only epoch and amount would permit a valid leaf from another index.
        if (base58Encode(instructionData) !== claimInstruction.data || instructionData.length < 32 ||
            !instructionData.subarray(0, 8).equals(claimDiscriminator)) {
          throw new HttpError(400, "transaction-not-claim", "rewards instruction discriminator does not match claim");
        }
        const epochValue = instructionData.readBigUInt64LE(8);
        const amountValue = instructionData.readBigUInt64LE(16);
        const leafIndex = instructionData.readUInt32LE(24);
        const proofLength = instructionData.readUInt32LE(28);
        if (proofLength > 32 || instructionData.length !== 32 + proofLength * 32) {
          throw new HttpError(400, "transaction-claim-mismatch", "on-chain claim proof encoding is invalid");
        }
        if (epochValue !== BigInt(intent.epoch_id) || amountValue !== BigInt(intent.amount_micro) ||
            leafIndex !== intent.leaf_index) {
          throw new HttpError(400, "transaction-claim-mismatch", "on-chain claim does not match the claim intent");
        }
        let storedProof: unknown;
        try { storedProof = JSON.parse(intent.merkle_proof); } catch {
          throw new HttpError(503, "claim-verification-unavailable", "stored claim proof is invalid");
        }
        if (!Array.isArray(storedProof) || storedProof.length !== proofLength ||
            storedProof.some((hash, index) => typeof hash !== "string" ||
              !/^[0-9a-f]{64}$/.test(hash) ||
              !Buffer.from(hash, "hex").equals(instructionData.subarray(32 + index * 32, 64 + index * 32)))) {
          throw new HttpError(400, "transaction-claim-mismatch", "on-chain claim proof does not match the claim intent");
        }
        const claimAccounts = (claimInstruction.accounts ?? []).map((account) =>
          typeof account === "number" ? accountKeys[account] ?? null : keyName(account));
        if (!claimAccounts.includes(playerKey)) {
          throw new HttpError(400, "transaction-claim-mismatch", "on-chain claim is not signed for this wallet");
        }
        const program = base58Decode(config.rewardsProgramId as string);
        const wallet = Buffer.from(binding.public_key, "base64url");
        const epochBytes = Buffer.alloc(8);
        epochBytes.writeBigUInt64BE(BigInt(intent.epoch_id));
        const expectedConfig = findProgramAddress([Buffer.from("neonrelay_config")], program).address;
        const expectedEpoch = findProgramAddress([Buffer.from("neonrelay_epoch"), epochBytes], program).address;
        const expectedClaim = findProgramAddress([Buffer.from("neonrelay_claim"), epochBytes, wallet], program).address;
        const expectedVault = findProgramAddress([Buffer.from("neonrelay_vault")], program).address;
        const expected = [
          base58Encode(expectedConfig), base58Encode(expectedEpoch), base58Encode(expectedClaim),
          playerKey, null, config.rewardMint,
          base58Encode(expectedVault), TOKEN_PROGRAM, "11111111111111111111111111111111",
        ];
        for (let index = 0; index < expected.length; index += 1) {
          const value = expected[index];
          if (value !== null && claimAccounts[index] !== value) {
            throw new HttpError(400, "transaction-claim-mismatch", `claim account ${index} does not match the intent`);
          }
        }
        const playerToken = claimAccounts[4];
        if (!playerToken) throw new HttpError(400, "transaction-claim-mismatch", "claim token account is missing");
        await readTokenAccount(playerToken, base58Decode(config.rewardMint as string), wallet);
      } catch (err) {
        if (err instanceof HttpError) throw err;
        throw new HttpError(503, "claim-verification-unavailable", "claim confirmation is unavailable while RPC verification is failing");
      }
    }
    const intent = rewards.claimConfirmation(binding, intentId, transactionId, status);
    return { intent_id: intent.id, status: intent.status, transaction_id: intent.transaction_id };
  });

  router.add("GET", "/v1/rewards/intents", (ctx) => {
    const { binding } = requireSession(ctx);
    const page = parsePagination(ctx, 50, 200);
    const intents = rewards.intentsFor(binding);
    if (!page.present) return { intents };
    return {
      intents: intents.slice(page.offset, page.offset + page.limit),
      pagination: { limit: page.limit, offset: page.offset, total: intents.length },
    };
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

  // Bound paid-intent fan-out per player/epoch; idempotent retries are still
  // allowed, but a wallet cannot manufacture an unbounded admission queue.
  const v2Store = new EconomyV2Store(db, DEFAULT_MAX_INTENTS_PER_PLAYER_EPOCH);
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

  router.add("POST", "/v2/economy/intent", async (ctx) => {
    guard(ctx, "economy-v2-write");
    const { binding } = requireSession(ctx);
    if (!config.monetizationEnabled) {
      throw new HttpError(503, "monetization-disabled", "paid admission is disabled until the operator enables the production gate");
    }
    if (config.environment === "production") {
      const gate = await verifyProductionGate();
      if (!gate.ready) throw new HttpError(503, "production-gate-blocked", "paid admission is unavailable while deployment verification is incomplete");
    }
    if (!binding.player_id) throw new HttpError(403, "player-link-required", "link a player before creating an entry intent");
    const { program, mint } = configuredV2Market(ctx);
    const body = (ctx.body ?? {}) as Record<string, unknown>;
    const idempotencyKey = str(body["idempotency_key"], "idempotency_key", 128);
    const tierName = str(body["tier"], "tier", 64);
    const tierIndex = RACE_TIERS.findIndex((row) => row.id === tierName);
    if (tierIndex < 0 || tierIndex > 3) throw new HttpError(400, "bad-tier", "tier must be copper, bronze, silver, or gold");
    const kind = Number(body["kind"] ?? 0);
    if (kind !== 0 && kind !== 1) throw new HttpError(400, "bad-kind", "kind must be 0 (match) or 1 (tournament)");
    const epoch = BigInt(Math.floor(Date.now() / config.epochMs));
    const wallet = Buffer.from(binding.public_key, "base64url");
    const market = await v2Read(() => readMarketV2(rpc, program, mint, { allowPayments: true }));
    if (!market.paymentsEnabled || market.paused) {
      throw new HttpError(503, "market-paused", "on-chain economy market is not unpaused and verified");
    }
    const feeBase = BigInt(market.feesBase[tierIndex]!);
    const result = v2Store.createIntent({
      mint,
      epoch,
      playerId: binding.player_id,
      wallet,
      idempotencyKey,
      kind: kind as 0 | 1,
      tier: tierName,
      amountBase: feeBase,
    });
    return { ...result, epoch: epoch.toString(), tier: tierName, amountBase: feeBase.toString() };
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

  // SW-2026-09-26 F-14: entryReference() throws RangeError on a non-integer
  // or out-of-u64 `epoch`/`extra` (BigInt/writeBigUInt64LE), which used to
  // surface as an unhandled 500 — and `/v1/economy/ticket` validated nothing
  // at all. One strict parser serves both query routes.
  const entryQuery = (ctx: RequestContext): { kind: number; epoch: number; extra: number } => {
    // Absent parameter → default; present-but-empty or malformed → 400.
    // (Number("") is 0, which silently accepted `?kind=` before.)
    const read = (name: string, fallback: number): number => {
      const raw = ctx.url.searchParams.get(name);
      if (raw === null) return fallback;
      const value = raw === "" ? Number.NaN : Number(raw);
      return value;
    };
    const kind = read("kind", 0);
    const epoch = read("epoch", 0);
    const extra = read("extra", 0);
    if (![0, 1].includes(kind) || !Number.isSafeInteger(epoch) || epoch < 0 ||
        !Number.isSafeInteger(extra) || extra < 0) {
      throw new HttpError(400, "bad-request",
        "kind must be 0|1 and epoch/extra must be non-negative safe integers");
    }
    return { kind, epoch, extra };
  };

  router.add("GET", "/v1/economy/reference", (ctx) => {
    economyGuard();
    guardRead(ctx, "economy-ref");
    const { kind, epoch, extra } = entryQuery(ctx);
    const raw = walletRawOf(ctx);
    return { reference: entryReference(kind, epoch, raw, extra).toString("hex") };
  });

  router.add("GET", "/v1/economy/ticket", async (ctx) => {
    economyGuard();
    // F-12: every ticket read is one `getAccountInfo` against RPC — bound it.
    guardRead(ctx, "economy-ticket");
    const { kind, epoch, extra } = entryQuery(ctx);
    const raw = walletRawOf(ctx);
    const status = await ticketStatus(rpc, config.economyProgramId as string,
      entryReference(kind, epoch, raw, extra), raw);
    return status;
  });

  // Direct close was removed in Tranche A: the prize pool is derived from
  // vault state and execution runs only through the proposal workflow.
  router.add("POST", "/v1/economy/epoch-close", () => {
    throw new HttpError(410, "admin-workflow-required",
      "direct close is disabled; POST /v1/admin/proposals {type:\"close-economy-epoch\"} then approve "
      + "(the pool is derived from vault balance minus reservations, never from the request)");
  });

  const executeEconomyClose = async (epoch: number) => {
    economyGuard();
    const existing = db.get<{ epoch: number }>(
      "SELECT epoch FROM economy_epochs WHERE epoch = ?", epoch);
    if (existing) {
      throw new HttpError(409, "epoch-already-closed", `economy epoch ${epoch} is already closed`);
    }
    let pool;
    try {
      pool = await readVaultPool(rpc, config.economyProgramId as string, config.skrMint);
    } catch (err) {
      if (err instanceof VaultReadError) {
        const status = err.code === "rpc-unavailable" ? 502
          : err.code === "vault-underfunded" || err.code === "empty-pool" ? 409
          : 503;
        throw new HttpError(status, err.code, err.message);
      }
      throw err;
    }
    const rows = db.all<{ pk: string; total: number; binding: string }>(
      `SELECT b.public_key AS pk, b.id AS binding, COALESCE(SUM(e.amount_micro), 0) AS total
       FROM reward_events e JOIN wallet_bindings b ON b.id = e.wallet_binding_id
       WHERE e.reward_epoch = ? AND e.status = 'accepted'
       GROUP BY b.id ORDER BY total DESC`, epoch);
    const ranked = rows.map((r) => ({ wallet: base58Encode(Buffer.from(r.pk, "base64url")), totalMicro: r.total }));
    const refsByBinding = new Map<string, string[]>();
    for (const row of rows) {
      const intents = db.all<{ reference: string }>(
        "SELECT reference FROM economy_matches WHERE wallet_binding_id = ? AND epoch = ?",
        row.binding, epoch);
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
      poolMicro: pool.available,
      epoch,
    });
    if (result.leaves.length === 0) {
      throw new HttpError(409, "no-eligible-winners",
        "no ticketed winners in this epoch; the pool stays vaulted for the next epoch");
    }
    try {
      db.run("INSERT INTO economy_epochs (epoch, root, total_micro, distribution, created_at, vault_ata, vault_balance, vault_reserved) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        epoch, result.root, result.totalMicro,
        JSON.stringify(result.leaves.map((l) => ({ wallet: l.wallet, amount_micro: l.amountMicro, place: l.place }))),
        Date.now(), pool.vault, pool.balance, pool.reserved);
    } catch (error) {
      // F-15 defence in depth: even if a second backend instance races past
      // the SELECT pre-check, the epoch primary key turns a duplicate close
      // into a clean 409 instead of a 500.
      if (String((error as Error).message).includes("UNIQUE")) {
        throw new HttpError(409, "epoch-already-closed", `economy epoch ${epoch} is already closed`);
      }
      throw error;
    }
    return { epoch, root: result.root, totalMicro: result.totalMicro,
      pool: { available: pool.available, vault: pool.vault, balance: pool.balance, reserved: pool.reserved },
      leaves: result.leaves.map((l) => ({ place: l.place, wallet: l.wallet, amountMicro: l.amountMicro })) };
  };

  const executeSeal = (epochId: number) => {
    const epoch = rewards.sealEpoch(epochId);
    return { epoch, audit_root: rewards.auditRoot(epochId) };
  };

  const executeProposal = async (row: ProposalRow) => {
    const params = JSON.parse(row.params) as Record<string, number>;
    if (row.type === "seal-reward-epoch") return executeSeal(params["epoch_id"] as number);
    return executeEconomyClose(params["epoch"] as number);
  };

  router.add("GET", "/v1/economy/current-epoch", (ctx) => {
    economyGuard();
    guardRead(ctx, "economy-epoch");
    return { epoch: Math.floor(Date.now() / config.epochMs) };
  });

  router.add("POST", "/v1/economy/match-intent", async (ctx) => {
    economyGuard();
    // F-12/F-13: this route writes a DB row per call and its stored
    // references become one RPC ticket read each at epoch close — bound both
    // the request rate and the per-player inventory.
    guard(ctx, "economy-match");
    const session = requireSession(ctx);
    const body = (ctx.body ?? {}) as Record<string, unknown>;
    const currentEpoch = Math.floor(Date.now() / config.epochMs);
    // Coerce numeric strings (legacy client behaviour) but reject anything
    // that is not a safe integer; 0/null keeps its legacy "current epoch"
    // meaning and is then window-checked like every other value.
    const coerced = body.epoch === undefined ? currentEpoch : Number(body.epoch);
    // Legacy clients signal "current epoch" with a missing/0/null value.
    const epoch = coerced === 0 ? currentEpoch : coerced;
    // SW-2026-09-26 F-13: the epoch used to be taken from the body
    // unvalidated — negative/float/absurd values either crashed the
    // reference derivation (RangeError 500) or polluted economy_matches for
    // epochs that can never close. Accept only the current epoch and one of
    // clock-skew slack in either direction.
    if (!Number.isSafeInteger(epoch) || epoch < currentEpoch - 1 ||
        epoch > currentEpoch + 1) {
      throw new HttpError(400, "bad-epoch",
        `epoch must be the current epoch (${currentEpoch}) or ±1`);
    }
    const bindingId = session.session.wallet_binding_id;
    const intents = db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM economy_matches WHERE wallet_binding_id = ? AND epoch = ?",
      bindingId, epoch)?.n ?? 0;
    if (intents >= config.maxMatchIntentsPerEpoch) {
      throw new HttpError(429, "match-intent-cap",
        `at most ${config.maxMatchIntentsPerEpoch} match intents per wallet and epoch`);
    }
    const raw = walletRawOf(ctx);
    const id = db.runInsert(
      "INSERT INTO economy_matches (wallet_binding_id, epoch, reference, created_at) VALUES (?, ?, ?, ?)",
      bindingId, epoch, "pending", Date.now());
    const reference = entryReference(0, epoch, raw, id).toString("hex");
    db.run("UPDATE economy_matches SET reference = ? WHERE id = ?", reference, id);
    return { matchId: id, epoch, reference };
  });

  router.add("GET", "/v1/economy/epochs", (ctx) => {
    economyGuard();
    guardRead(ctx, "economy-epochs");
    const page = parsePagination(ctx, 50, 200);
    if (!page.present) {
      return { epochs: db.all<{ epoch: number; root: string; total_micro: number }>(
        "SELECT epoch, root, total_micro FROM economy_epochs ORDER BY epoch DESC") };
    }
    const total = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM economy_epochs")?.n ?? 0;
    return {
      epochs: db.all<{ epoch: number; root: string; total_micro: number }>(
        "SELECT epoch, root, total_micro FROM economy_epochs ORDER BY epoch DESC LIMIT ? OFFSET ?",
        page.limit, page.offset),
      pagination: { limit: page.limit, offset: page.offset, total },
    };
  });

  // ------------------------------------------------- Tranche B: game events
  const gameEvents = new GameEventService(db, config);

  router.add("POST", "/v1/game/events", (ctx) => {
    guard(ctx, "game-ingest");
    const body = (ctx.body ?? {}) as Record<string, unknown>;
    const events = body["events"];
    if (!Array.isArray(events) || events.length === 0 || events.length > 500) {
      throw new HttpError(400, "bad-request", "events must be an array of 1..500 items");
    }
    const results = gameEvents.ingest(events as never[], Date.now());
    return {
      results,
      accepted: results.filter((r) => r.status === "accepted").length,
    };
  });

  router.add("GET", "/v1/admin/game-events", (ctx) => {
    guard(ctx, "admin-read");
    requireAdmin(ctx, "operator");
    const page = parsePagination(ctx, 50, 200);
    const sinceRaw = ctx.url.searchParams.get("since");
    const since = sinceRaw === null ? null : Number(sinceRaw);
    if (sinceRaw !== null && (!Number.isInteger(since) || (since as number) < 0)) {
      throw new HttpError(400, "bad-request", "since must be a non-negative integer timestamp");
    }
    const eventType = ctx.url.searchParams.get("event_type");
    const playerId = ctx.url.searchParams.get("player_id");
    if (playerId !== null && (playerId.length === 0 || playerId.length > 128)) {
      throw new HttpError(400, "bad-request", "player_id filter invalid");
    }
    try {
      const { rows, total } = gameEvents.list({
        limit: page.limit, offset: page.offset,
        eventType, playerId, since,
      });
      return { events: rows, pagination: { limit: page.limit, offset: page.offset, total } };
    } catch (err) {
      if (err instanceof GameEventsError) throw new HttpError(err.status, err.code, err.message);
      throw err;
    }
  });

  router.add("POST", "/v1/admin/game-events/purge", (ctx) => {
    guard(ctx, "admin-backup");
    const identity = requireAdmin(ctx, "superadmin");
    const body = (ctx.body ?? {}) as Record<string, unknown>;
    const days = body["older_than_days"];
    const playerId = body["player_id"];
    const byAge = typeof days === "number";
    const byPlayer = typeof playerId === "string";
    if (byAge === byPlayer) {
      throw new HttpError(400, "bad-request", "supply exactly one of older_than_days|player_id");
    }
    if (byAge && (!Number.isInteger(days) || (days as number) < 1 || (days as number) > 3650)) {
      throw new HttpError(400, "bad-request", "older_than_days must be an integer within 1..3650");
    }
    if (byPlayer && ((playerId as string).length === 0 || (playerId as string).length > 128)) {
      throw new HttpError(400, "bad-request", "player_id invalid");
    }
    const now = Date.now();
    const purged = byPlayer
      ? gameEvents.purge({ playerId: playerId as string }, now)
      : gameEvents.purge({ olderThanMs: (days as number) * 86_400_000 }, now);
    const result = byPlayer
      ? { purged, player_id: playerId }
      : { purged, older_than_days: days, cutoff: now - (days as number) * 86_400_000 };
    admin.audit({
      actorRole: identity.role, actorHash: identity.fingerprint,
      action: "game-events-purged",
      params: byPlayer ? { player_id: playerId } : { older_than_days: days },
      result, ip: ctx.ip,
    }, now);
    return result;
  });

  // ------------------------------------------------- Tranche B: metrics
  router.add("GET", "/v1/admin/metrics", (ctx) => {
    guard(ctx, "admin-read");
    requireAdmin(ctx, "operator");
    const rawDays = ctx.url.searchParams.get("days");
    const days = rawDays === null ? 7 : Number(rawDays);
    if (!Number.isInteger(days) || days < 1 || days > 90) {
      throw new HttpError(400, "bad-request", "days must be an integer within 1..90");
    }
    return computeMetrics(db, days, Date.now(), rpcPool.getStatus());
  });

  router.add("GET", "/v1/admin/rpc-status", (ctx) => {
    guard(ctx, "admin-read");
    requireAdmin(ctx, "operator");
    return rpcPool.getStatus();
  });

  // ------------------------------------------------- Tranche B: stuck + reconcile
  const reconcileStatus = (code: string): number =>
    code === "rpc-unavailable" ? 502 : code === "bad-epoch" ? 400 : 503;

  const maybeAlert = async (
    identity: { role: string; fingerprint: string },
    ctx: RequestContext,
    reason: string,
    lines: string[],
  ): Promise<unknown> => {
    if (ctx.url.searchParams.get("alert") !== "1" || lines.length === 0) {
      return { alerted: false };
    }
    const text = formatDigest(`Neon Relay: ${reason}`, lines);
    const result = await sendAlertText(config, text);
    admin.audit({
      actorRole: identity.role, actorHash: identity.fingerprint,
      action: "alert-sent", params: { reason, lines }, result, ip: ctx.ip,
    });
    return { alerted: result.sent, sinks: result.sinks, errors: result.errors };
  };

  router.add("GET", "/v1/admin/stuck", async (ctx) => {
    guard(ctx, "admin-read");
    const identity = requireAdmin(ctx, "operator");
    const rawHours = ctx.url.searchParams.get("threshold_hours");
    const hours = rawHours === null ? 6 : Number(rawHours);
    if (!Number.isInteger(hours) || hours < 1 || hours > 720) {
      throw new HttpError(400, "bad-request", "threshold_hours must be an integer within 1..720");
    }
    const report = collectStuck(db, hours * 3_600_000);
    const lines: string[] = [];
    if (report.intents.length > 0) {
      lines.push(`${report.intents.length} claim intents stuck in submitted `
        + `(oldest ${Math.round((report.intents[0] as { age_ms: number }).age_ms / 3_600_000)}h)`);
    }
    if (report.proposals.length > 0) lines.push(`${report.proposals.length} proposals open past threshold`);
    if (report.unreconciled_prize_epochs.length > 0) {
      lines.push(`prize epochs never reconciled: ${report.unreconciled_prize_epochs.join(",")}`);
    }
    const rpcStatus = rpcPool.getStatus();
    if (rpcStatus.active === "fallback") {
      lines.push(`rpc serving from fallback provider (failovers ${rpcStatus.failovers_total})`);
    }
    for (const role of ["primary", "fallback"] as const) {
      const ep = rpcStatus.endpoints[role];
      if (ep?.chain_rejected) lines.push(`rpc ${role} rejected: ${ep.last_error ?? "chain mismatch"}`);
    }
    return { ...report, alert: await maybeAlert(identity, ctx, "stuck pipeline items", lines) };
  });

  const rewardsGuard = () => {
    if (!config.rewardsProgramId) {
      throw new HttpError(503, "rewards-not-configured",
        "set NEONRELAY_REWARDS_PROGRAM_ID to enable rewards reconciliation");
    }
  };

  router.add("GET", "/v1/admin/reconcile/rewards", async (ctx) => {
    guard(ctx, "admin-read");
    const identity = requireAdmin(ctx, "operator");
    rewardsGuard();
    const epochId = Number(ctx.url.searchParams.get("epoch_id") ?? "NaN");
    if (!Number.isInteger(epochId) || epochId < 0) {
      throw new HttpError(400, "bad-request", "epoch_id must be a non-negative integer");
    }
    try {
      const result = await reconcileRewardsEpoch(db, rpc, config.rewardsProgramId as string, epochId);
      const lines = result.status === "match" || result.status === "not-sealed"
        ? []
        : [`rewards epoch ${epochId}: ${result.status} (snapshot ${result.snapshot_id})`];
      return { ...result, alert: await maybeAlert(identity, ctx, "rewards reconcile", lines) };
    } catch (err) {
      if (err instanceof ReconcileError) throw new HttpError(reconcileStatus(err.code), err.code, err.message);
      throw err;
    }
  });

  router.add("GET", "/v1/admin/reconcile/prizes", async (ctx) => {
    guard(ctx, "admin-read");
    const identity = requireAdmin(ctx, "operator");
    economyGuard();
    const epoch = Number(ctx.url.searchParams.get("epoch") ?? "NaN");
    if (!Number.isInteger(epoch) || epoch <= 0) {
      throw new HttpError(400, "bad-request", "epoch must be a positive integer");
    }
    try {
      const result = await reconcilePrizeEpoch(db, rpc, config.economyProgramId as string, epoch);
      const lines = result.status === "match"
        ? []
        : [`prize epoch ${epoch}: ${result.status} (snapshot ${result.snapshot_id})`];
      return { ...result, alert: await maybeAlert(identity, ctx, "prize reconcile", lines) };
    } catch (err) {
      if (err instanceof ReconcileError) throw new HttpError(reconcileStatus(err.code), err.code, err.message);
      throw err;
    }
  });

  router.add("GET", "/v1/admin/reconcile/snapshots", (ctx) => {
    guard(ctx, "admin-read");
    requireAdmin(ctx, "operator");
    const page = parsePagination(ctx, 50, 200);
    const kind = ctx.url.searchParams.get("kind");
    if (kind !== null && !["rewards-epoch", "prize-epoch"].includes(kind)) {
      throw new HttpError(400, "bad-request", "kind must be rewards-epoch|prize-epoch");
    }
    const where = kind === null ? "" : "WHERE kind = ?";
    const args = kind === null ? [] : [kind];
    const total = db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM reconcile_snapshots ${where}`, ...args)?.n ?? 0;
    const snapshots = db.all(
      `SELECT * FROM reconcile_snapshots ${where} ORDER BY id DESC LIMIT ? OFFSET ?`,
      ...args, page.limit, page.offset);
    return { snapshots, pagination: { limit: page.limit, offset: page.offset, total } };
  });

  router.add("POST", "/v1/admin/treasury/snapshot", async (ctx) => {
    guard(ctx, "admin-read");
    const identity = requireAdmin(ctx, "operator");
    economyGuard();
    try {
      const state = await readTreasuryState(rpc, config.economyProgramId as string, config.skrMint);
      const recorded = recordTreasury(db, state);
      admin.audit({
        actorRole: identity.role, actorHash: identity.fingerprint,
        action: "treasury-snapshotted", result: { id: recorded.id }, ip: ctx.ip,
      });
      return recorded;
    } catch (err) {
      if (err instanceof ReconcileError) throw new HttpError(reconcileStatus(err.code), err.code, err.message);
      throw err;
    }
  });

  router.add("GET", "/v1/admin/treasury", (ctx) => {
    guard(ctx, "admin-read");
    requireAdmin(ctx, "operator");
    const page = parsePagination(ctx, 50, 200);
    const total = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM treasury_snapshots")?.n ?? 0;
    const rows = db.all<{
      id: number; created_at: number; program: string; mint: string; vault: string;
      treasury: string; vault_balance: string; treasury_balance: string; reserved: string;
    }>("SELECT * FROM treasury_snapshots ORDER BY id DESC LIMIT ? OFFSET ?", page.limit, page.offset);
    // Deltas against the chronologically previous row (null when unknown).
    const chronological = [...rows].reverse();
    const withDeltas = chronological.map((row, i) => {
      const prev = i === 0 ? undefined : chronological[i - 1];
      const previous = prev ?? (page.offset === 0 ? undefined : db.get<{
        vault_balance: string; treasury_balance: string; reserved: string;
      }>("SELECT vault_balance, treasury_balance, reserved FROM treasury_snapshots WHERE id < ? ORDER BY id DESC LIMIT 1",
        row.id));
      const delta = (nowText: string, before?: string): string | null =>
        before === undefined ? null : (BigInt(nowText) - BigInt(before)).toString();
      return {
        ...row,
        vault_delta: delta(row.vault_balance, previous?.vault_balance),
        treasury_delta: delta(row.treasury_balance, previous?.treasury_balance),
        reserved_delta: delta(row.reserved, previous?.reserved),
      };
    }).reverse();
    return { snapshots: withDeltas, pagination: { limit: page.limit, offset: page.offset, total } };
  });

  router.add("POST", "/v1/admin/alerts/test", async (ctx) => {
    guard(ctx, "admin-backup");
    const identity = requireAdmin(ctx, "superadmin");
    const sinks = alertSinks(config);
    if (sinks.length === 0) {
      throw new HttpError(503, "alerts-not-configured",
        "set NEONRELAY_ALERT_WEBHOOK_URL and/or the Telegram pair to enable alerts");
    }
    const body = (ctx.body ?? {}) as Record<string, unknown>;
    const custom = typeof body["text"] === "string" ? body["text"].slice(0, 500) : "";
    const text = formatDigest("Neon Relay alert test", custom ? [custom] : ["if you read this, the sink works"]);
    const result = await sendAlertText(config, text);
    admin.audit({
      actorRole: identity.role, actorHash: identity.fingerprint,
      action: "alert-sent", params: { reason: "test" }, result, ip: ctx.ip,
    });
    return result;
  });

  router.add("GET", "/v1/economy/proof", (ctx) => {
    economyGuard();
    guardRead(ctx, "economy-proof");
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
      "SELECT root, distribution FROM economy_epochs WHERE epoch = ?", epoch);
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

  router.add("GET", "/v2/economy/proof", (ctx) => {
    economyGuard();
    guardRead(ctx, "economy-proof");
    const mintStr = ctx.url.searchParams.get("mint") ?? config.skrMint;
    if (!mintStr) throw new HttpError(400, "bad-request", "mint query parameter or skrMint config required");
    let mint: Buffer;
    try {
      mint = base58Decode(mintStr);
    } catch {
      throw new HttpError(400, "bad-request", "mint must be a base58 public key");
    }
    if (mint.length !== 32) throw new HttpError(400, "bad-request", "mint must be 32 bytes");
    const epochParam = ctx.url.searchParams.get("epoch");
    if (!epochParam || !/^\d+$/.test(epochParam)) {
      throw new HttpError(400, "bad-request", "epoch must be a non-negative integer");
    }
    const epoch = BigInt(epochParam);
    const walletParam = ctx.url.searchParams.get("wallet") ?? "";
    let wallet: Buffer;
    try {
      wallet = base58Decode(walletParam);
    } catch {
      throw new HttpError(400, "bad-request", "wallet must be a base58 public key");
    }
    if (wallet.length !== 32) throw new HttpError(400, "bad-request", "wallet must be 32 bytes");
    const v2Store = new EconomyV2Store(db);
    const res = v2Store.proof(mint, epoch, wallet);
    if (!res) throw new HttpError(404, "not-found", "no proof found for this wallet/epoch/mint");
    return res;
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
    case "challenge-cap": return 429;
    case "nonce-unknown": return 404;
    case "nonce-replayed": return 409;
    case "bad-signature": return 401;
    case "binding-revoked": return 403;
  }
}
