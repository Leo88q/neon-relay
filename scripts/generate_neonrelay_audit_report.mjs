#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const reportDir = resolve(root, process.env.NEONRELAY_AUDIT_REPORT_DIR ?? "reports");
mkdirSync(reportDir, { recursive: true });

const files = [
  "onchain/Anchor.toml",
  "onchain/Cargo.toml",
  "onchain/src/assets.ts",
  "onchain/src/constants.ts",
  "onchain/programs/neonrelay-rewards/src/lib.rs",
  "onchain/programs/neonrelay-economy/src/lib.rs",
  "onchain/programs/neonrelay-features/src/lib.rs",
  "onchain/programs/neonrelay-assets/src/lib.rs",
  "onchain/programs/neonrelay-rewards/Cargo.toml",
  "onchain/programs/neonrelay-economy/Cargo.toml",
  "onchain/programs/neonrelay-features/Cargo.toml",
  "onchain/programs/neonrelay-assets/Cargo.toml",
  "onchain/Cargo.lock",
  "backend/migrations/0002_reward_ledger.sql",
  "backend/migrations/0010_anti_sybil.sql",
  "backend/.env.example",
  "backend/package.json",
  "backend/tsconfig.json",
  "backend/src/economy_v2_store.ts",
  "backend/src/economy_v2_rpc.ts",
  "backend/src/config.ts",
  "backend/src/db.ts",
  "backend/src/routes.ts",
  "backend/src/server.ts",
  "backend/src/rewards.ts",
  "backend/src/rpc.ts",
  "backend/src/watchtower.ts",
  "backend/scripts/restore_backup.ts",
  "onchain/scripts/verify_source_ids.mjs",
  "onchain/scripts/verify_toolchain_pin.mjs",
  "onchain/scripts/typecheck.ts",
  "onchain/tsconfig.json",
  "onchain/scripts/verify_deployment.sh",
  "onchain/scripts/create_compressed_tree.sh",
  "onchain/scripts/deploy_prod.sh",
  "onchain/scripts/release_validate.sh",
  "onchain/deployment.example.json",
  "onchain/package.json",
  "scripts/check_audit_report_drift.mjs",
];

const contents = new Map();
const parseFailures = [];
for (const file of files) {
  try {
    contents.set(file, readFileSync(resolve(root, file), "utf8"));
  } catch (error) {
    parseFailures.push({ path: file, error: String(error instanceof Error ? error.message : error) });
  }
}

const finding = (ruleId, severity, file, line, message, help) => ({
  rule_id: ruleId,
  severity,
  location: { path: file, line, column: 1 },
  message,
  help,
});

const lineOf = (text, needle) => {
  const index = text.indexOf(needle);
  if (index < 0) return 1;
  return text.slice(0, index).split("\n").length;
};

const findings = [];
const requireAll = (ruleId, severity, file, checks, message, help) => {
  const text = contents.get(file);
  if (!text) return;
  const missing = checks.find((needle) => !text.includes(needle));
  if (missing) {
    findings.push(finding(ruleId, severity, file, lineOf(text, checks[0]), `${message} Missing marker: ${missing}`, help));
  }
};

requireAll(
  "NR-AUDIT-001",
  "high",
  "onchain/programs/neonrelay-rewards/src/lib.rs",
  [
    "require!(!config.paused, NeonRelayError::Paused);",
    "claim_record.claimed_at = Clock::get()?.unix_timestamp;",
    "address = config.mint @ NeonRelayError::MintMismatch",
    "token::authority = player",
  ],
  "Rewards program no longer proves the pause / no-double-claim / mint-binding invariants expected by the audit.",
  "Restore the pause guard, claim record mutation, configured mint address check, and player token-account authority constraints."
);

requireAll(
  "NR-AUDIT-002",
  "high",
  "onchain/programs/neonrelay-economy/src/lib.rs",
  [
    "require!(!config.paused, EconomyError::Paused);",
    "constraint = player_ata.owner == player.key() @ EconomyError::NotPlayerAta",
    "constraint = vault_ata.owner == config.key() @ EconomyError::WrongVault",
    "constraint = treasury_ata.owner == config.authority @ EconomyError::WrongTreasury",
  ],
  "Economy program lost one of the pause / owner / token-account substitution guards.",
  "Reinstate the pause checks plus owner/mint constraints for player, vault and treasury token accounts."
);

requireAll(
  "NR-AUDIT-003",
  "high",
  "onchain/programs/neonrelay-features/src/lib.rs",
  [
    "require!(!ctx.accounts.config.paused, FeaturesError::Paused);",
    "token::mint_to(cpi_ctx, 1)?;",
    "token::authority = player",
  ],
  "Features program no longer enforces pause or supply-1 minting semantics for badges.",
  "Restore the player-action pause guard and mint exactly one badge token to the player-owned account."
);

requireAll(
  "NR-AUDIT-004",
  "high",
  "onchain/programs/neonrelay-assets/src/lib.rs",
  [
    "config.paused = true;",
    "require!(!ctx.accounts.config.paused, AssetsError::Paused);",
    "token::mint_to(cpi_ctx, 1)?;",
    "token::authority = player",
  ],
  "Assets program no longer defaults to paused or lost the supply-1 / player-authority badge mint guard.",
  "Keep secure-by-default pause-on-init behaviour and ensure badge minting remains supply-1 into the player's token account."
);

requireAll(
  "NR-AUDIT-005",
  "high",
  "backend/migrations/0002_reward_ledger.sql",
  [
    "UNIQUE (wallet_binding_id, epoch_id)",
    "idempotency_hash  TEXT NOT NULL UNIQUE",
  ],
  "Backend reward ledger lost the uniqueness guarantees needed to prevent duplicate reward events or claims.",
  "Restore unique constraints for reward event idempotency and per-wallet claim intents."
);

requireAll(
  "NR-AUDIT-006",
  "medium",
  "backend/src/watchtower.ts",
  [
    'RaceStarted: "match_start"',
    "late_id_binding: true",
  ],
  "Watchtower telemetry contract no longer documents the RaceStarted mapping or late ID binding behaviour.",
  "Restore the normalized Solana event mapping and late-binding contract for hub ingestion."
);

requireAll(
  "NR-AUDIT-007", "critical", "onchain/programs/neonrelay-rewards/src/lib.rs",
  ["verify_bootstrap_authority", "program_data: UncheckedAccount", "MintAuthorityNotRevoked", "config.paused = true;"],
  "Rewards bootstrap or mint boot gate is missing.",
  "Bind initialization to the upgradeable-loader ProgramData authority and start the reward market paused."
);
requireAll(
  "NR-AUDIT-019", "critical", "onchain/programs/neonrelay-rewards/src/lib.rs",
  ["config.reserved.checked_add(total_micro)", "epoch.remaining_micro = total_micro", "EpochAmountExceeded", "pub reserved: u64"],
  "Rewards publication does not bind Merkle payouts to an aggregate vault ceiling.",
  "Require a declared total at publication, reserve it against the rewards vault, and decrement the epoch/config ceiling atomically on claim."
);
requireAll(
  "NR-AUDIT-008", "critical", "onchain/programs/neonrelay-economy/src/lib.rs",
  ["verify_bootstrap_authority", "amount <= ctx.accounts.prizes.total", "sweep_expired_prizes", "refund_entry_v2", "PrizeNotExpired", "config.paused = true;"],
  "Economy allocation, recovery, or boot-lock invariant is missing.",
  "Keep per-epoch ceilings, delayed treasury sweep, and explicit unpause after deployment verification."
);
requireAll(
  "NR-AUDIT-009", "critical", "onchain/programs/neonrelay-assets/src/lib.rs",
  ["require_achievement_registry", "AssetPathNotConfigured", "InvalidAchievementRegistry", "InvalidTreeOwner"],
  "Assets path is not fail-closed or does not prove the achievement registry.",
  "Require the features-owned registry PDA and bitmap bit; keep unsupported external CPI paths disabled."
);
requireAll(
  "NR-AUDIT-010", "critical", "backend/src/routes.ts",
  ["searchTransactionHistory: true", "confirmationStatus !== \"finalized\"", "entry.err !== null", "meta.err !== null", "programdata-pda-invalid", "programdata-authority-option-invalid", "programdata-loader-state-invalid", "ready: gate.ready && blockers.length === 0", "production-gate-blocked", "requireWatchtowerIngest(ctx)"],
  "Backend money-path or ingestion gate is not fail-closed.",
  "Verify finalized claim state, upgrade authority/program data, strict readiness, and authenticated Watchtower writes."
);
requireAll(
  "NR-AUDIT-020", "high", "backend/src/server.ts",
  ["Kubernetes-style readiness", "readinessBlocked ? 503 : 200"],
  "The readiness payload can report ready=false with an HTTP 200 response.",
  "Return a non-2xx response while `/watchtower/readyz` is blocked and reserve 200 for verified readiness."
);
requireAll(
  "NR-AUDIT-011", "high", "backend/src/config.ts",
  ["NEONRELAY_FEATURES_PROGRAM_ID", "NEONRELAY_ASSETS_PROGRAM_ID", "NEONRELAY_DEPLOYMENT_MANIFEST", "NEONRELAY_RPC_FALLBACK_URL", "distinct RPC infrastructure", "NEONRELAY_MONETIZATION_ENABLED=1", "explicit https URL in production", "must be explicit in production"],
  "Production configuration does not require the complete deployment and monetization gate.",
  "Require all four program ids, a manifest, and an explicit paid-admission enablement flag."
);
requireAll(
  "NR-AUDIT-012", "high", "backend/scripts/restore_backup.ts",
  ["--confirm", "inspectBackup", "renameSync(temporary, target)", "fsyncSync"],
  "Offline backup restore is missing verification or atomic replacement.",
  "Stop the service, verify integrity/checksum, replace in the same directory, fsync, and retain the previous database."
);
requireAll(
  "NR-AUDIT-013", "high", "backend/migrations/0010_anti_sybil.sql",
  ["wallet_bindings_active_player_unique", "revoked_at IS NULL"],
  "The identity layer permits multiple active wallets to own one player id.",
  "Keep the partial unique index and reject conflicting links; on-chain registration must retain its minimum-balance and PDA checks."
);
requireAll(
  "NR-AUDIT-014", "high", "onchain/scripts/verify_source_ids.mjs",
  ["source-ids-consistent", "declare_id", "NEONRELAY_ASSETS_PROGRAM_ID"],
  "Program IDs can drift between Anchor, Rust, backend, and client configuration.",
  "Run the offline source-ID gate before build/deploy and fail on any mismatch."
);
requireAll(
  "NR-AUDIT-015", "critical", "onchain/scripts/deploy_prod.sh",
  ["ALLOW_LIVE_DEPLOY", "release_validate.sh", "anchor build --verifiable", "verify_deployment.sh", "--strict-manifest"],
  "The deployment script can bypass the explicit live-deploy or verifiable-build gate.",
  "Keep live deploy opt-in, require the release gates, and verify the final manifest read-only."
);
requireAll(
  "NR-AUDIT-016", "high", "onchain/scripts/verify_deployment.sh",
  ["--manifest", "verify_source_ids.mjs", "upgrade authority", "dataLen", "TOKEN_PROGRAM", "classic SPL Mint"],
  "Deployment verification does not bind live programs to the source IDs and authority manifest.",
  "Require a manifest, source-ID consistency, non-empty bytecode, and the expected upgrade authority."
);
requireAll(
  "NR-AUDIT-017", "high", "onchain/scripts/release_validate.sh",
  ["SOURCE_ONLY", "AUDIT_REPORT_PATH", "readlink -f", "mktemp -d", "cargo test --workspace --locked", "verify_toolchain_pin.mjs"],
  "The release gate can claim readiness without explicit handling of missing compiler or audit evidence.",
  "Run tests locally, keep audit artifacts external, and fail closed on unavailable type/Rust toolchains unless source-only mode is explicit."
);
requireAll(
  "NR-AUDIT-018", "high", "backend/src/economy_v2_store.ts",
  ["DEFAULT_MAX_INTENTS_PER_PLAYER_EPOCH = 20", "player intent cap exceeded", "BEGIN IMMEDIATE"],
  "A player can create an unbounded number of paid-intent records in one epoch.",
  "Keep a transactional per-player/epoch ceiling while preserving exact idempotent retries."
);

const filesScanned = files.length;
const filesParsed = contents.size;
const sourceDigest = createHash("sha256")
  .update(files.map((file) => `${file}\0${contents.get(file) ?? "<missing>"}\0`).join(""))
  .digest("hex");
const summary = {
  findings,
  files_scanned: filesScanned,
  files_parsed: filesParsed,
  parse_failures: parseFailures,
  engine: "local-static-audit",
  generated_at: new Date().toISOString(),
  rules_checked: 20,
  audit_scope: files,
  source_digest: sourceDigest,
  notes: [
    "This report is a repository-local structural audit that emits the Watchtower-compatible schema.",
    "External vendor CLIs (Sentio / SolGuard / SLAM) were not available in this sandbox, so their runtimes were not executed here.",
  ],
};
writeFileSync(resolve(reportDir, "neon-relay-audit.json"), `${JSON.stringify(summary, null, 2)}\n`);

const counts = { critical: 0, high: 0, medium: 0, low: 0 };
for (const item of findings) counts[item.severity] += 1;
const lines = [
  "# Neon Relay audit report",
  "",
  `- Generated at: ${summary.generated_at}`,
  `- Engine: ${summary.engine}`,
  `- Files scanned / parsed: ${filesScanned} / ${filesParsed}`,
  `- Source digest: ${sourceDigest}`,
  `- Critical: ${counts.critical}`,
  `- High: ${counts.high}`,
  `- Medium: ${counts.medium}`,
  `- Low: ${counts.low}`,
  "",
  ...summary.notes.map((note) => `- ${note}`),
  "",
];
if (findings.length === 0) {
  lines.push("No findings.");
} else {
  lines.push("## Findings", "");
  for (const item of findings) {
    lines.push(`- **${item.severity.toUpperCase()} ${item.rule_id}** ${item.location.path}:${item.location.line} — ${item.message}`);
    lines.push(`  - Help: ${item.help}`);
  }
}
writeFileSync(resolve(reportDir, "neon-relay-audit.md"), `${lines.join("\n")}\n`);

console.log(`wrote ${resolve(reportDir, "neon-relay-audit.json")}`);
console.log(`wrote ${resolve(reportDir, "neon-relay-audit.md")}`);
