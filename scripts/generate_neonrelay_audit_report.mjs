#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const reportDir = resolve(root, "reports");
mkdirSync(reportDir, { recursive: true });

const files = [
  "onchain/Anchor.toml",
  "onchain/programs/neonrelay-rewards/src/lib.rs",
  "onchain/programs/neonrelay-economy/src/lib.rs",
  "onchain/programs/neonrelay-features/src/lib.rs",
  "onchain/programs/neonrelay-assets/src/lib.rs",
  "backend/migrations/0002_reward_ledger.sql",
  "backend/src/rewards.ts",
  "backend/src/watchtower.ts",
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

const filesScanned = files.length;
const filesParsed = contents.size;
const summary = {
  findings,
  files_scanned: filesScanned,
  files_parsed: filesParsed,
  parse_failures: parseFailures,
  engine: "local-static-audit",
  generated_at: new Date().toISOString(),
  rules_checked: 6,
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
