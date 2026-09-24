#!/usr/bin/env node
/**
 * Compare a committed/local audit report with a freshly generated report.
 * Generation happens in a temporary directory, never in the checkout. A
 * report without the source digest is deliberately unverifiable rather than
 * silently accepted as current evidence.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(process.cwd());
const reportPath = resolve(process.argv[2] ?? "reports/neon-relay-audit.json");
if (reportPath === root || reportPath.startsWith(`${root}/`)) {
  console.error("AUDIT_REPORT_UNVERIFIABLE: report must be outside the audited checkout");
  process.exit(2);
}
const temp = mkdtempSync(join(tmpdir(), "neonrelay-audit-"));
try {
  const generated = spawnSync(process.execPath, ["scripts/generate_neonrelay_audit_report.mjs"], {
    cwd: root, env: { ...process.env, NEONRELAY_AUDIT_REPORT_DIR: temp }, stdio: "inherit",
  });
  if (generated.status !== 0) process.exit(generated.status ?? 2);
  let current;
  try { current = JSON.parse(readFileSync(reportPath, "utf8")); }
  catch { console.error(`AUDIT_REPORT_UNVERIFIABLE: cannot read ${reportPath}`); process.exit(2); }
  const fresh = JSON.parse(readFileSync(join(temp, "neon-relay-audit.json"), "utf8"));
  if (typeof current.source_digest !== "string" || !Array.isArray(current.audit_scope) ||
      !Array.isArray(current.findings) || current.files_scanned !== current.files_parsed) {
    console.error("AUDIT_REPORT_UNVERIFIABLE: report lacks the current digest/scope/empty-findings schema");
    process.exit(2);
  }
  if (current.source_digest !== fresh.source_digest ||
      JSON.stringify(current.audit_scope) !== JSON.stringify(fresh.audit_scope) ||
      current.files_scanned !== fresh.files_scanned || current.files_parsed !== fresh.files_parsed) {
    console.error("AUDIT_REPORT_DRIFT: report scope or source digest differs from the current checkout");
    console.error(`  report=${current.source_digest}`);
    console.error(`  fresh=${fresh.source_digest}`);
    process.exit(1);
  }
  if (current.findings?.length > 0) {
    console.error(`AUDIT_REPORT_FINDINGS: external report contains ${current.findings.length} finding(s)`);
    process.exit(1);
  }
  if (fresh.findings?.length > 0) {
    console.error(`AUDIT_REPORT_FINDINGS: ${fresh.findings.length} finding(s) remain`);
    process.exit(1);
  }
  console.log(`AUDIT_REPORT_CURRENT: ${fresh.source_digest}`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
