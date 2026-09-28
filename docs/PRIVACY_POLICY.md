# Privacy Policy — Neon Relay (draft v0.1, 2026-09-28)

> **Status:** Template for operator legal review. Not yet approved. Once approved, pin the version/date, archive prior versions, and link from every page footer plus the wallet-connect screen. Checklist 5.2.1, 7.1.

## 1. Controller

- **Operator / Controller:** [LEGAL_ENTITY_NAME, address, email dpo@neonrelay.example] — fill before production.
- **DPO / contact:** dpo@neonrelay.example
- **Representative (EEA/UK if controller outside):** [if applicable]

## 2. Data we process, purposes, legal bases (5.1)

| Category | Examples | Purpose | Legal basis (GDPR Art.6) | Retention |
|---|---|---|---|---|
| Wallet identity | Ed25519 public key (base58), binding id, session token hash | Authentication (SIWS-like challenge), binding to player id | Contract / Legitimate interest (security) | Session TTL 12h sliding; binding until unlink/purge |
| Game account | `player_id` (currently in-game name), link consent flag | Reward eligibility, verified showcase | Contract | Until unlink + 90d purge |
| Match events (minimal) | `session_id`, `player_id`, `match_id`, `mode`, `result {finished, place, duration}`, `occurred_at` | Session accounting, match outcome rates, abuse investigation | Legitimate interest | 90d rolling; aggregates not stored. See `docs/PRIVACY_GAME_EVENTS.md` |
| Reward ledger | `wallet_binding_id`, `amount_micro`, Merkle leaf/proof, epoch id | Reward calculation, anti-double-claim | Contract | Indefinite for audit (ledger); personal link pseudonymized on deletion request |
| Watchtower telemetry (if enabled) | `external_id`, `event_type`, `solana_wallet`, sanitized `result_json`/`metadata_json`, HMAC | Cross-game analytics, funnel | Consent / Legitimate interest | As per telemetry policy; exporter MAC verified |
| Technical logs | IP (rate-limit buckets in-memory only, not persisted with events), User-Agent, timestamps | Security, rate limiting, fraud prevention | Legitimate interest | In-memory buckets evicted; access logs 30d |
| Support / admin | `admin_audit` entries (hashed token fingerprint, IP, action) | Accountability, incident response | Legal obligation / Legitimate interest | 1 year |

- **No blockchain writes of personal data** (5.1.5): wallet public keys are pseudonymous but treated as personal data when linked; no names, emails, or IP are written on-chain or into NFT metadata.

## 3. Recipients / processors (5.5.1)

- Hosting/CDN: [provider + country]
- RPC providers: Helius / QuickNode / Triton (or self-hosted) — only public keys / chain reads, no personal data enrichment.
- Alert sinks: webhook / Telegram (if configured) — only incident digests, no player data.
- All processors covered by DPA; international transfers via SCCs where needed.

## 4. International transfers

- Primary processing in [EEA/country]. If transferred outside EEA (e.g., US CDN/RPC), SCCs + TIA applied.

## 5. Your rights (5.4)

- Access, rectification, erasure, restriction, portability, objection; withdraw consent.
- Channel: `privacy@neonrelay.example` or in-game Settings → Wallet → Privacy request (wallet signature verification to prevent data leaks to third parties — checklist 5.4.3).
- Response within 1 month (GDPR). See also CCPA “Do Not Sell or Share” if serving California (link in footer + GPC honoured).

## 6. Storage, security (5.5.2–5.5.3)

- TLS in transit, SQLite with `STRICT` tables, prepared statements, HMAC for agent memory, constant-time token comparison, no secrets in logs (`backend/src/server.ts` never logs token values).
- Game events purged via `POST /v1/admin/game-events/purge {player_id | older_than_days}` — see `docs/PRIVACY_GAME_EVENTS.md` §3.

## 7. Cookies / local storage (4.x)

- Backend API uses `Authorization: Bearer` (no cookie session in beta). If a future web frontend sets cookies, they will be classified (necessary / functional / analytics / marketing), prior consent required for non-necessary (4.3), and documented in `docs/COOKIE_POLICY.md`.
- No third-party SDKs, no fingerprinting in beta. Self-hosted fonts only.

## 8. Automated decision-making

- No automated payouts solely by AI (Watchtower Game Signals is advisory only — requires human review).

## 9. Complaints

- Right to lodge with supervisory authority (GDPR Art.77). EU users: [lead DPA contact].

## 10. Changes / versioning

- Version 0.1 — 2026-09-28 — draft. Changes trigger re-consent where required; archive at `docs/PRIVACY_POLICY.v*.md`.

---

**Before mainnet:** replace brackets, have counsel approve, publish at `https://neonrelay.example/privacy`, add footer link + version date, translate if serving multiple languages, and align `docs/COOKIE_POLICY.md` and `docs/TERMS.md` cross-references.
