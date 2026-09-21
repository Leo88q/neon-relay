# Threat model

Scope: the Neon Relay reward pipeline and its clients — game server → reward
backend → Solana program → player wallet, plus the Android/MWA layer and the
repository supply chain. Gameplay cheating *outside* the reward path (aimbots,
map exploits) is upstream DDNet's anti-cheat domain and is only covered where
it touches rewards.

Method: assets → attackers → per-surface threat tables. Every mitigation names
the implementing artifact (file/doc/test) or, when absent, a blocker id from
[`KNOWN_LIMITATIONS.md`](KNOWN_LIMITATIONS.md). "Residual" = what remains true
after the mitigation.

## 1. Assets

| Asset | Why it matters |
| --- | --- |
| Vault token balance (on-chain) | the only real money in the system; test mint on devnet today |
| Operator Solana keypair (`config.authority`) | can publish roots for new epochs ⇒ can direct future vault funds |
| Game-server Ed25519 signing seed | can fabricate match events within backend caps |
| Backend DB (events, bindings, epochs, intents) | source of truth for who earned what |
| `NEONRELAY_OPERATOR_TOKEN` / `NEONRELAY_SUPERADMIN_TOKEN` | propose / approve seals and closes (root selection needs both); legacy single `NEONRELAY_ADMIN_TOKEN` is devnet-only |
| Player wallets / sessions | identity; a stolen session can claim intents (not funds directly — claims are signed by the wallet itself) |
| Repository integrity (licenses, notices, branding) | legal exposure; the fork must stay attributable |

## 2. Attacker profiles

* **A1 — cheating player**: modifies the client, replays traffic, runs patched
  servers; goal: unearned rewards.
* **A2 — malicious/compromised game server operator**: runs a real Neon Relay
  server with its own signing key; goal: farm rewards for own wallets.
* **A3 — network attacker**: MITM, replay, injection into backend APIs.
* **A4 — backend attacker**: SQL injection, auth bypass, cap manipulation,
  operator-token theft.
* **A5 — chain-side attacker**: forged proofs, double claims, front-running,
  rogue upgrade.
* **A6 — supply-chain attacker**: poisoned dependency, secret committed to the
  repo, silent re-introduction of upstream branding or unlicensed assets.
* **A7 — wallet phishing**: fake connect flows, signature-request abuse on
  mobile.

## 3. Game client / server surface (A1, A2)

| Threat | Mitigation | Residual |
| --- | --- | --- |
| Client fabricates reward events | clients produce **no** reward events at all; only `CScore::SaveScore` on the server emits them (`src/game/server/neonrelay_events.cpp`) | none in the reward path |
| Cheated finishes signed as legit | `SaveScore` is skipped when `pCon->Cheated()` or the run is `NotEligible`; upstream anticheat gates the same path real scores use | upstream anticheat quality (out of scope); backend caps bound damage |
| Player identity spoofing | `player_id` is the in-game name — **correlation hint only**; payout requires a wallet link proven by a wallet signature (`docs/WALLET_AUTH.md`) | BL-11: names are not stable; backend keys caps on the linked player |
| Compromised server key farms rewards (A2) | per-match/daily/weekly caps per player, epoch totals visible via `audit_root`; key rotation procedure (`docs/DEVNET_RUNBOOK.md` §8) | a farming server within caps until rotated — bounded, auditable |
| Signing seed exfiltration from server host | seed lives in a 600-mode file outside the repo, never logged, never sent anywhere; public key logged instead (`docs/REWARD_SECURITY.md` §8) | host compromise is out of scope of the app layer |

## 4. Match-event transport & backend (A3, A4)

| Threat | Mitigation | Residual |
| --- | --- | --- |
| Forged/altered events | Ed25519 signature over canonical JSON (fixed key order, no whitespace ⇒ no malleability); 503 until a signing pubkey is configured | key compromise (above) |
| Replay/duplicate delivery | `idempotency_hash = SHA256(canonical bytes)` UNIQUE ⇒ `duplicate` status, no ledger change | none known |
| Back-dating into sealed epochs | `reward_epoch` assigned by the backend clock at ingest; sealed epochs reject (`rejected_epoch_sealed`) | backend clock skew (operator concern) |
| Cap bypass via many players | caps per `player_id` for events, per wallet binding for payouts; linking a wallet requires a wallet-signed challenge | BL-11 name instability handled by binding-keyed payouts |
| SQL injection | `node:sqlite` prepared statements everywhere (`backend/src/db.ts`); zero runtime dependencies reduces attack surface | none known |
| Session hijacking | 256-bit tokens stored SHA-256-hashed, 12 h sliding TTL; TLS termination is a deployment concern (documented, not enforced in code) | plaintext HTTP deployments — runbook requires TLS in production hosting |
| Admin-route abuse (seal/close) | two-person workflow (operator proposes, superadmin approves; constant-time auth), one-way seal/close, append-only audit | both tokens stolen ⇒ bogus root for an epoch — bounded by on-chain publish being operator-only (separate credential) plus vault-coverage checks |
| Rate abuse | per-IP token bucket on auth routes (`docs/WALLET_AUTH.md`) | distributed abuse (generic) |

## 5. Wallet auth / Android / MWA (A7)

| Threat | Mitigation | Residual |
| --- | --- | --- |
| Phished "connect" | MWA connect is system-mediated (wallet app itself shows the request); the in-game page states the wallet is optional and never asks for seeds (`menus_settings_wallet.cpp`) | user education |
| Native code seeing secrets | one-way sanitized bridge: only `{connected, account_label, public_key_base64, error_message}` crosses JNI; tokens/signatures stripped in Kotlin (`src/neonrelay/wallet_bridge.h`, `NativeBridge.kt`) | none known |
| Challenge replay across domains | structured challenge with domain + expiry, nonce single-use, Ed25519 verification (`docs/WALLET_AUTH.md`) | none known |
| Blind signing of claim transactions | client pre-verifies the Merkle proof locally before the wallet ever sees the transaction (`docs/DEVNET_RUNBOOK.md` §7); claim binds wallet+amount | MWA wallets show limited tx detail (platform-wide issue) |
| Process death / rotation losing wallet state | lifecycle-aware `WalletHolder`/`WalletBridgeActivity` (`docs/ANDROID_SEEKER.md` §5) | BL-02: never run on a real device in this project |

## 6. On-chain (A5)

| Threat | Mitigation | Residual |
| --- | --- | --- |
| Forged claim proof | on-chain re-verification against the published root; leaf binds signer pubkey + amount (`onchain/…/lib.rs`) | none known |
| Double claim | claim PDA per (epoch, wallet); `init` fails on repeat | none known |
| Root rewrite | epoch PDA `init` is one-way per epoch id | operator key can publish **new** epochs — vault funding policy is the bound |
| Rogue upgrade drains vault | — | **real residual**: devnet deploy keeps the upgrade authority; checklist item: multisig/renounce before any mainnet consideration |
| Griefing via pause spam | `set_paused` is authority-only | operator key compromise |
| Compute exhaustion via huge proofs | `MAX_PROOF_LEN = 32` | none known |
| Forged achievements / badge inflation (features program) | registry writes are authority-only and idempotent; badge mint requires the recorded bit and a per-(achievement, player) mint PDA with supply 1 | operator-key compromise (same residual as roots) |
| Tournament griefing (spam registrations) | one registration per (tournament, wallet), capacity bound, free registration moves no funds; cancel frees the slot | sybil wallets filling capacity — bounded, operator can re-open a new tournament id |

## 7. Supply chain / repository (A6)

| Threat | Mitigation | Residual |
| --- | --- | --- |
| Secrets committed | `scripts/check_secrets.py` (CI gate + self-test proving the detector fires); allowlist by exact documented test vectors only | scanner pattern coverage |
| Upstream branding silently returns | `scripts/check_branding.sh --release` classification gate + translation lockstep | none known |
| Unlicensed/unvetted assets ship | `docs/ASSET_MANIFEST.csv` (853 rows: 603 ship / 250 block-release) + `check_assets.sh`; **release mode fails by design until legal review** (BL-05) | legal review pending |
| Poisoned dependencies | backend/onchain: zero runtime deps; Android: pinned MWA coordinate (BL-06 unverified offline); Rust: pinned anchor versions (BL-03 uncompiled) | pinned-but-unverified coordinates |
| Legally significant history rewriting | policy: no `git filter-repo` on notices; upstream provenance pinned in `UPSTREAM_BASE.md` | none known |
| CI silently disabled/broken | workflow mirrors locally-evidenced gates; first real run blocked by **account billing** (BL-12) — recorded, not hidden | CI currently not executing |

## 8. Explicitly out of scope

* Full native/Android/Solana builds (BL-01/02/03) — the binaries/APKs/program
  were not produced here, so runtime behaviors not covered by the executed
  test suites are unverified.
* Upstream DDNet gameplay anti-cheat robustness.
* Hosting security of a production backend deployment (TLS, backups, WAF).
* Mainnet economics/liquidity — no mainnet deployment exists or is planned
  before legal review.
