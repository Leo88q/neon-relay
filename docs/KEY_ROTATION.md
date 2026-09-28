# Key rotation & red button — Neon Relay (checklist 1.3.10, 3.11.6)

## 1. What to rotate, in what order

**If any secret appears in git, in a log, or on a screenshot: it is compromised.** Order matters (checklist 1.2.4–1.2.5):

1. **Rotate first, then clean history.**
2. For wallet private keys: move funds to a new wallet before revoking authority; update all references.

| Secret / key | Where it lives | How to rotate | History cleaning |
|---|---|---|---|
| `NEONRELAY_OPERATOR_TOKEN` / `NEONRELAY_SUPERADMIN_TOKEN` / `NEONRELAY_ADMIN_TOKEN` (legacy) | Secret store / env / CI | Generate 32+ random chars (e.g. `openssl rand -base64 32`), update secret store + all deploys, restart backends | `git filter-repo` / BFG if it ever hit history, force-push, inform all clones |
| `NEONRELAY_SERVER_SIGNING_PUBLIC_KEY` seed | Server host 600-mode file | `openssl rand -hex 32` new seed, write to host, extract pubkey `neonrelay-server --dump-pubkey`, set new env pubkey, restart | Old events signed by old key will correctly fail `rejected_signature` — no purge needed |
| `NEONRELAY_WATCHTOWER_INGEST_TOKEN` / `NEONRELAY_WATCHTOWER_MEMORY_KEY` | Secret store | Generate 32+ chars, update store, restart | Same history purge |
| Chain `config.authority` (rewards/economy/features/assets) | Hardware wallet / Squads | Squads `propose_authority_change` → wait 432k slots → `accept_authority_change` (pause first if active theft) | Update `deployment.<cluster>.json` + re-run `verify_deployment.sh` |
| Solana RPC API keys (Helius/QuickNode/Alchemy/Infura) | Secret store | Rotate in provider dashboard, update `NEONRELAY_RPC_URL` / fallback | Revoke old key in provider |
| Telegram bot token, webhook URLs, DB credentials, cloud keys | Provider + secret store | Provider rotate, update env | Revoke old |

If a **wallet private key with funds** leaked: immediately transfer funds to a fresh wallet, then rotate every authority (upgrade, mint, freeze, admin) that key held.

## 2. 15-minute red button (leak detected)

**Minute 0–2 — contain:**
- Revoke/rotate the leaked credential at the provider / secret store (do not wait for git).
- If chain authority suspected: `set_paused` via Squads (pauses economy/rewards — checklist 3.9.4).
- If backend tokens: rotate both operator & superadmin tokens; old `admin_audit` / `admin_proposals` show what the stolen token did.

**Minute 2–5 — assess:**
- `GET /v1/admin/audit?limit=100` — every action with old token fingerprint.
- `GET /v1/admin/reconcile/{rewards,prizes}` + `GET /v1/admin/treasury` for affected epochs.
- `GET /v1/admin/stuck&alert=1` + `GET /v1/admin/metrics`.

**Minute 5–10 — clean:**
- If secret was in git: `git filter-repo --invert-paths --path <file>` or BFG `--replace-text`, force-push, notify all clones to re-clone. Re-issue any token that was in history — it is burnt.

**Minute 10–15 — communicate:**
- Status to operator channel first, then players (incident template `docs/INCIDENT_RESPONSE.md` §5). No yield promises.
- Open postmortem, attach snapshot/audit ids.

## 3. Routine rotation (non-emergency)

- Tokens: every 90 days or on personnel change.
- Server signing seed: every 6 months or after host migration.
- Chain authority: via Squads proposal with delay — no emergency bypass.

## 4. Proof

- After any rotation, run: `python3 scripts/check_secrets.py --self-test && python3 scripts/check_secrets.py`, `npm test` backend, `verify_deployment.sh` if chain, and attach logs to release tag.
- Document the rotation in `admin_audit` + deployment manifest; never commit new secrets.

*Owner:* IC + chain custodian. Drill this quarterly before mainnet.
