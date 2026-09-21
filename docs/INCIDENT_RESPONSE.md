# Incident response (beta)

Lightweight on-call + runbooks for the Neon Relay beta. This document assumes
Tranche A/B tooling: proposal workflow, append-only audit, reconciliation
snapshots, treasury history, stuck reports and alert digests.

## 1. Severity levels and SLOs

| Severity | Examples | Detect (target) | Respond (target) |
| --- | --- | --- | --- |
| SEV-1 money at risk | vault/reserved anomaly, root mismatch on a paid epoch, upgrade-authority alert | < 15 min (alerts) | < 1 h, pause first |
| SEV-2 pipeline stuck | seals/closes failing, `stuck` growing, RPC outage, shipper backlog | < 1 h | < 4 h |
| SEV-3 degraded | single metric anomaly, backup job failed once, docs drift | < 24 h | next business day |
| SEV-4 info | dependency notice, questionable event spike | backlog | scheduled |

Detection sources, in order: alert digests (`&alert=1` on stuck/reconcile),
`GET /v1/admin/metrics` pipeline section, `verify_deployment.sh` in CI/cron,
player reports. Every SEV-1/2 ends with a postmortem (template in §5).

## 2. Roles

- **Incident commander (IC)**: declares severity, runs the response, writes
  the postmortem. Holds the superadmin token path (not the token itself).
- **Operator**: executes backend actions (proposals, purges, backups).
- **Chain custodian**: holds Squads signing rights; executes pauses/upgrades.
- **Comms**: player-facing updates; no earnings language, ever.

Staff the roster before mainnet (release gate). Token/key locations live in
the operator secret store, never in this repo or chat.

## 3. Runbooks

### 3.1 Reconcile mismatch on a paid epoch (SEV-1)

1. Freeze: do NOT approve further seal/close proposals for the affected
   epoch; reject the open ones with reason `incident-<id>`.
2. Capture: `GET /v1/admin/reconcile/{rewards,prizes}` (snapshot id),
   `POST /v1/admin/backup`, `POST /v1/admin/treasury/snapshot`.
3. Triage: `mismatch:root` ⇒ backend distribution and chain disagree —
   compare `audit_root` vs the snapshot payload; `missing-onchain` ⇒ publish
   never landed (retry publish, no money moved); `unexpected-onchain` ⇒
   someone published outside the workflow (treat as compromise until proven
   otherwise → §3.4).
4. If the chain root is wrong and claims are live: Squads-pause the program,
   then follow §3.4.

### 3.2 Treasury anomaly (SEV-1)

1. `GET /v1/admin/treasury` — identify the moving leg (vault/treasury/
   reserved) and the first anomalous snapshot.
2. Correlate with `reconcile_snapshots` (claimed totals) and `admin_audit`
   (who approved what, when).
3. Unexpected outflow with no matching claims ⇒ pause + §3.4. Expected
   movement (rake/claims) ⇒ downgrade to SEV-3 with a note.

### 3.3 Stuck pipeline (SEV-2)

1. `GET /v1/admin/stuck` — classify: stale intents (player/RPC side),
   stale proposals (approve/reject them), unreconciled closes (run
   reconcile; `missing-onchain` means publish is pending).
2. RPC 502/503s: check provider status, switch `NEONRELAY_RPC_URL` to the
   fallback, re-run. No distribution is ever computed from a failed read.
3. Shipper backlog: re-run `scripts/ship_game_events.sh` (idempotent);
   duplicates in the output are normal.

### 3.4 Suspected key/token compromise (SEV-1)

1. Backend tokens: rotate `NEONRELAY_OPERATOR_TOKEN` /
   `NEONRELAY_SUPERADMIN_TOKEN` immediately; old fingerprints in
   `admin_audit`/`admin_proposals` identify what the stolen token did.
2. Game-server key: rotate the seed, update
   `NEONRELAY_SERVER_SIGNING_PUBLIC_KEY`; events signed by the old key start
   failing closed (`rejected_signature`) — no purge needed.
3. Chain authority: Squads-rotates via `propose/accept_authority_change`
   (48h timelock); pause first if active theft is suspected.
4. Postmortem must list every action the compromised credential took
   (audit log) and every epoch touched (reconcile history).

## 4. Communications

- Status updates go to the operator channel first, players second.
- Never promise reimbursements, yields or timelines in writing during the
  incident; the IC approves every external message.
- Prize-affecting incidents disclose: what happened, which epochs, what the
  ledger shows, what happens next.

## 5. Postmortem template

```
# Incident <id> — <title> (SEV-n, YYYY-MM-DD)
## Summary (3 lines)
## Impact (epochs, players, amounts in base units — no USD promises)
## Timeline (UTC, with snapshot/audit ids as evidence)
## Root cause
## What went well / poorly
## Action items (owner + date)
```
