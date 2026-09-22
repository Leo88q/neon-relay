# Neon Relay — Watchtower OS v3 integration

**Game ID:** `neonrelay`  
**Tenant:** `neonrelay`  
**API:** backend adapter routes under `/api/*`  
**Version:** `v3`  
**Delivery:** `backend/src/watchtower.ts`, the Watchtower extension in
`backend/migrations/0009_beta_operations.sql`, `integrations/godot/`, and this
document. Existing installations are upgraded defensively by
`ensureWatchtowerSchema()`.

This is an executable integration contract for a server-authoritative Neon Relay
race. It does not pretend that a third-party provider is installed, that a free
tier is an SLA, or that a mainnet program has been deployed. Provider adapters
are selected by the operator and must be pinned and audited before production.
The repository already contains the wallet-auth and reward-ledger primitives;
Watchtower adds the v3 catalog, L2 decision, SDK contracts, ML contract and
bounded telemetry/late-binding store.

## 1. API smoke check

Start the dependency-free Node 22 backend and query the exact verification
surfaces:

```sh
cd backend
npm start

curl -s http://127.0.0.1:8787/api/os/config | jq '.version, .component_count, .game_id'
curl -s 'http://127.0.0.1:8787/api/l2/router?gameId=neonrelay&tps=high&ux=gasless' | jq
curl -s 'http://127.0.0.1:8787/api/sdk/godot-solana?gameId=neonrelay' | jq
curl -s 'http://127.0.0.1:8787/api/game-signals/config?gameId=neonrelay' | jq
curl -s 'http://127.0.0.1:8787/api/ingest/solana' | jq
```

The high-frequency decision must be `HyperGrid`, with `Arcium` privacy,
`PST` private verification, `Xandeum` state, `Sorada` reads, MagicBlock ER for
the gasless path, and Solana mainnet as the fallback. No client should hardcode
`localhost` for a remote service; use the deployment URL or a same-origin proxy.

## 2. The 33 deduplicated components

The API returns this same list from `GET /api/os/config`. A component is a
runtime boundary, not every marketing name. Where two providers do the same
job, they are intentionally one adapter boundary.

| # | Component | Providers / contract |
|---:|---|---|
| 1 | Phantom OAuth | OAuth to a public wallet key; no private key |
| 2 | Mobile Wallet Adapter | MWA deep links and signed approval |
| 3 | FirstStep guest | Guest identity that can be upgraded |
| 4 | Privy embedded | Embedded wallet linked to a user-controlled account |
| 5 | Cross-game PDA | `studio_profile` identity root and explicit linking |
| 6 | Session Keys | `CgInv`, `SessKeys`; scoped move/boost/finish keys |
| 7 | Compressed assets | Bubblegum v2 / Merkle Tree common skins, tracks, emotes |
| 8 | Rare assets | MPL Core Standard NFT and founder badge |
| 9 | Fast asset reads | DAS through a Sorada adapter; target only, not an SLA |
| 10 | Scalable race state | Xandeum adapter; race server remains authoritative |
| 11 | Ticket/wager/jackpot | Gamba and `GambaUi` hooks |
| 12 | Race AI bots | Husks; deterministic and never reward-eligible |
| 13 | Tournament lifecycle | RitArena create/join/retry/settle |
| 14 | ARC Entity | Track entity with Position, Velocity, Owner, Item |
| 15 | Bolt FOCG | MovementSystem/RaceSystem and race instructions |
| 16 | DePIN workers | Physics, matchmaking and leaderboard workers |
| 17 | Confidential payments | Arcium / Arcium Rollups |
| 18 | Private verification | PST proof envelope and verifier |
| 19 | On-chain attributes | Core Attributes fastest-lap key/value |
| 20 | Official scaffold | Preset pinned deployment template |
| 21 | Realtime service | Rust Actix authoritative ticks and fan-out |
| 22 | Premium access | Access Protocol stake-to-access tracks and skins |
| 23 | Cross-chain reward pool | idosgames bridge plus RACE linked-asset message |
| 24 | Dedicated high-frequency L2 | Sonic Atomic SVM / HyperGrid |
| 25 | Declarative ECS runtime | Rush ECS world/entity configuration |
| 26 | Game rollup settlement | REPLA sequencer to Solana Anchor settlement |
| 27 | Ephemeral execution | MagicBlock ER: delegate, execute, commit |
| 28 | Automated actions | Magic Actions for idempotent settlement jobs |
| 29 | Program event stream | LaserStream gRPC |
| 30 | Callback/read model | Shyft, PostgreSQL/TimescaleDB, Redis |
| 31 | Attribution and LiveOps | Helika and GameSight |
| 32 | Cross-game ML signals | Game Signals ML |
| 33 | Marketplace/security gates | ME, GameShift, Tensor, Security Auditing Skill, Sentio, SolGuard, SLAM, relayzero, StealthSDK |

ME is a legacy/compatibility adapter and is not required for new cNFT primary
minting. Bubblegum v2 is the primary common-asset path; MPL Core is the rare
asset path. Any quoted `$110/M` figure is a planning reference from the
requested stack, not a price guarantee.

## 3. Program identity and tenant boundaries

The server reports these operator-supplied identifiers without inventing a
mainnet address:

```json
{
  "game_id": "neonrelay",
  "tenant": "neonrelay",
  "program_ids": {
    "rewards": "NEONRELAY_REWARDS_PROGRAM_ID",
    "identity": "CgInv",
    "session_keys": "SessKeys",
    "treasury": "STrEaSuRy"
  }
}
```

Set `NEONRELAY_REWARDS_PROGRAM_ID`, `NEONRELAY_IDENTITY_PROGRAM_ID`,
`NEONRELAY_SESSION_KEYS_PROGRAM_ID`, and `NEONRELAY_TREASURY_PROGRAM_ID` in a
real deployment. The labels above are safe configuration references, not
wallet addresses. All requests carry `game_id`; the router rejects another
game to prevent cross-tenant reads.

## 4. Identity flow and late binding

1. The client chooses Phantom OAuth, MWA, FirstStep guest, or Privy embedded.
2. The backend issues a domain-bound, expiring, single-use challenge.
3. The wallet signs the challenge. A seed phrase, OAuth token, and private key
   never enter the game process or backend.
4. `POST /v1/auth/verify-wallet` returns a hashed-session bearer token.
5. The operator may link that session to `studio_profile` and a cross-game PDA.
6. A race session uses a scoped Session Key for `move`, `boost`, `finish`, and
   `race_session`; it must expire and be revocable. It cannot publish a reward
   root, change a race result, or transfer treasury funds.
7. Analytics may first see `external_id` and later receive `solana_wallet`.
   The telemetry store backfills only events with the same `external_id`.
   This is late ID binding, not an assertion that an external ID is a wallet.

`GET /api/os/config` exposes the identity contract. The existing `/v1/auth/*`
implementation is the security boundary; the Godot sample calls it rather
than implementing signing itself.

## 5. Godot project and client boundary

`integrations/godot/` is a Godot 4 sample project. The main file,
`neonrelay_client.gd`, contains these explicit layers:

- `SolanaClient`: JSON transport to the backend;
- `WalletAdapter`: provider boundary for Phantom OAuth, MWA, FirstStep and
  Privy; replace the stub with the platform SDK;
- `AnchorProgram`: IDL/instruction description boundary for reward claims;
- `SessionKeyAdapter`: CgInv/SessKeys scope boundary;
- `NeonRelayClient`: `start_race`, `move`, `boost`, and `finish` actions.

The sample is intentionally not a fake wallet or fake transaction signer. The
stub reports `wallet-adapter-not-installed` until a real adapter is injected.
The C++ Neon Relay game can use the same backend contracts without embedding
Godot. A Unity client should implement the same HTTP and adapter interfaces;
no Unity-specific dependency is required by the server.

## 6. Assets and on-chain stats

The asset policy is:

- common skins, tracks and emotes: Bubblegum v2 cNFT and an operator-controlled
  Merkle tree;
- rare skins and founder badge: MPL Core Standard NFT with immutable authority
  policy and an audited update authority;
- fastest lap and readable race attributes: Core Attributes key/value;
- ownership/inventory: DAS via the Sorada read adapter;
- high-volume race state: Xandeum adapter, with authoritative final results
  retained in the signed race ledger.

Clients read. They do not mint, update authorities, or settle a reward. A cNFT
mint must be accompanied by a durable asset id and source-game value
`neonrelay`; a result must reference the server-signed `match_id`.

## 7. Race ECS and authoritative physics

The race domain is represented as:

```text
ARC Entity: race_track
  Components: Position, Velocity, Owner, Item
  source_game: neonrelay
  is_cnft: false for the live entity
  asset_id: optional track/skin asset

Systems: MovementSystem, RaceSystem
Instructions: start_race, finish_race
```

Bolt FOCG and Rush ECS are execution adapters, not authorities. The Rust Actix
service validates tick order, checkpoint sequence, map bounds, speed limits,
finish order and disconnect policy. A client crash is telemetry; it cannot
mint a reward. AI bots are marked bot-controlled and are excluded from player
payouts. DePIN workers may propose physics/matchmaking/leaderboard work, but a
quorum and the signed race server decide the result.

The requested operational stake numbers (`10 SOL` and `0.1 SOL per 100
players`) are policy inputs only. They are not hardcoded, transferred, or
represented as a promise by this repository.

## 8. High-frequency L2 decision

`GET /api/l2/router?gameId=neonrelay&tps=high&ux=gasless` returns:

```json
{
  "execution_layer": "HyperGrid",
  "network": "Sonic Atomic SVM",
  "isolation": "dedicated-grid",
  "privacy_layer": "Arcium",
  "private_verification": "PST",
  "state_layer": "Xandeum",
  "read_layer": "Sorada",
  "gasless_path": ["MagicBlock ER", "delegate_account", "execute_in_er", "commit_state"],
  "fallback": "Solana mainnet"
}
```

The configured endpoint references are `api.mainnet-alpha.sonic.game`,
`rpc.mainnet-alpha.sonic.game`, and `grpc.mainnet-alpha.sonic.game`. The
service must monitor TPS, p50/p99 latency, commit lag, grid health and fallback
rate. If the dedicated grid is unhealthy, the server degrades to the Solana
mainnet path; a client must not silently change the authority.

REPLA is a complementary rollup/settlement boundary. MagicBlock ER is the
short-lived gasless execution boundary. Magic Actions are scheduled/idempotent
jobs for match settlement, level-up, reward grant, and tournament cron. None
of these makes a client authoritative or removes finality checks.

## 9. Privacy and wagers

Arcium wraps confidential wager/payment payloads; PST supplies private
verifiability; the public chain receives a commitment and settlement receipt.
Gamba exposes the ticket/wager/prize/epoch/jackpot UI contract:
`useGamba`, `usePlay`, `useWager`, `GambaUi`, `WagerInput`, `GameResult`, and
`Jackpot`. The house-edge and jackpot parameters are published per epoch and
must be approved by operations. A ticket proves admission only; it does not
prove that the player ran the race or deserves a reward.

The backend tracks pay-without-play and play-without-pay signals, but never
uses an opaque ML result as a confiscation or payout decision. Failed
transactions remain visible as failed events and are never retried with a
new economic meaning.

## 10. Indexing and read path

LaserStream subscribes to `NEONRELAY_REWARDS_PROGRAM_ID` plus ARC, Bolt,
DePIN, Gamba, Husks, RitArena, RACE, Arcium, Xandeum, PST and Core Attributes
adapter events. Shyft supplies NFT/TOKEN callbacks (`TOKEN_MINT`, `NFT_MINT`,
`gPA`) where enabled. PostgreSQL/TimescaleDB is the durable time series and
Redis is a bounded cache; neither is the source of reward truth.

Minimum projections include match start/end, mode, result, disconnect, first
finish, first claim, checkpoints, fastest lap, ticket state, vault balance,
reward pipeline age, failed transaction rate and cross-chain receipts. Every
projection is keyed by tenant and event idempotency hash.

## 11. Analytics and attribution

Helika and GameSight are adapters for acquisition and LiveOps. The canonical
funnel is:

```text
ad_click(campaign_id, gamesight_click_id)
  -> PlayerJoined(external_id, click_id)
  -> WalletConnected(solana_wallet)
  -> on-chain AnonymousEvent(wallet_id, mint/buy/sell)
```

`solana_wallet` is the external attribution id only after the player connects.
`POST /api/ingest/solana` applies late ID binding and never accepts a seed
phrase or access token. Game Signals ML receives bounded signals for churn,
LTV, cross-game retention, whale radar and campaign proposals. The baseline
contract references 60M+ transactions across 12 games and a 14-day churn
signal; these are provider/model metadata, not evidence generated by this
repository.

`POST /api/campaigns/proposals` returns `human-review` when `churn_risk > 0.7`.
It creates no campaign, payout, ban, or wallet transaction automatically.

## 12. Telemetry contract

The endpoint accepts `GET` for the requested smoke/API contract and `POST` for
real ingestion. A `GET` without `event_type` describes the contract. A minimal
POST is:

```json
{
  "event_type": "match_end",
  "external_id": "player-session-1",
  "solana_wallet": "public-key-only",
  "session_id": "session-1",
  "match_id": "match-1",
  "mode": "race",
  "result": { "place": 1, "fastest_lap_ms": 4210 },
  "metadata": { "map": "chrome", "speedrun": true }
}
```

Supported event types are `match_start`, `match_end`, `session_start`,
`session_end`, `disconnect`, `first_finish`, `first_claim`, `client_crash`,
`race`, `anti_cheat`, `map`, `speedrun`, `checkpoint`, `anomalies`,
`reward_velocity`, `pay_without_play`, `play_without_pay`,
`ticket_claim_conversion`, `vault_forecast`, `reward_pipeline_age`, and
`failed_tx_rate`. Batches are limited to 500 and bounded JSON fields are
stored. The SHA-256 event digest makes transport retries idempotent.

For production, put the endpoint behind the game-server authentication already
used by `/v1/game/events` or a trusted ingestion gateway. The public sample
route is intentionally usable in a local smoke test; it is not a production
DDoS boundary.

## 13. Reward ledger handoff

`NEONRELAY_REWARDS_PROGRAM_ID` is the only reward program authority. The
existing server-signed event ledger validates `match_id`, `player_id`, event
signature, idempotency and reward caps before epoch sealing. A client receives
only a claim intent and Merkle proof. The on-chain program checks the root,
leaf, player wallet, claim PDA and pause state.

Magic Actions may trigger a settlement request, but the operator/admin
proposal workflow remains the authority for epoch publication. HyperGrid,
Arcium, PST and Xandeum can accelerate or protect execution; none can bypass
the reward program's one-way root and no-double-claim rules.

## 14. Marketplace and bridge policy

ME remains a compatibility adapter. New common cNFT primary issuance uses
Bubblegum v2; Tensor is the primary marketplace adapter where enabled;
GameShift is an optional USD/chargeback and gas-abstraction adapter. RACE and
idosgames bridge receipts are accepted only after chain, nonce, source game,
asset id and destination owner are verified. A bridge receipt cannot be treated
as a race result.

Access Protocol controls premium access only. Ownership, access, wager, race
result and reward entitlement are separate facts in the ledger.

## 15. Security Auditing Skill — systematic runbook

Run this checklist for every provider or IDL update:

1. Define the trust boundary and write the intended authority for each field.
2. Inventory wallet keys, OAuth tokens, session keys, RPC credentials and logs.
3. Confirm secrets are absent from client payloads, telemetry and crash dumps.
4. Verify challenge domain, expiry, nonce single use and Ed25519 signature.
5. Verify wallet-to-player and cross-game PDA links require explicit consent.
6. Verify Session Keys have action scopes, expiry, revocation and rate limits.
7. Verify server tick, map bounds, checkpoint order and finish sequence.
8. Replay the same move, finish, wager, bridge and reward event.
9. Fuzz malformed JSON, oversized result, NaN, negative and overflow values.
10. Check cNFT/Core authority, collection, source-game and asset-id bindings.
11. Check Gamba ticket, epoch, house edge and jackpot arithmetic.
12. Prove AI bot and disconnected clients cannot earn player rewards.
13. Check Arcium/PST envelopes for nonce, commitment and verifier binding.
14. Check RPC/grid chain identity, finality, fallback and fail-closed behavior.
15. Check LaserStream/Shyft delivery retries and idempotency hashes.
16. Check Timescale/Redis are projections and cannot author reward roots.
17. Check attribution late binding does not merge two external identities.
18. Check bridge chain id, nonce, replay protection and destination ownership.
19. Run Sentio/SolGuard/SLAM tests and static scans with pinned versions.
20. Record evidence, residual risk, rollback owner and approval before enabling.

The `Security Auditing Skill` SDK route points to this runbook. This document is
not a substitute for an independent audit or a legal review of wagering,
privacy, or cross-border bridge operations.

## 16. API response and error policy

All routes return JSON with `cache-control: no-store`. Unknown games, SDK names
and invalid telemetry answer a 4xx error rather than a permissive fallback.
The backend never leaks stack traces. `adapter-contract` means the boundary is
available; it does not mean that a provider has been provisioned.

The existing `/v1` authentication, reward, admin and reconciliation routes
remain versioned separately. Watchtower routes do not weaken their bearer,
operator, superadmin, or server-signature requirements.

## 17. Operations and fallback

Pin provider versions and program IDs in deployment configuration. Monitor:
TPS, p50/p99 latency, grid health, MagicBlock commit lag, RPC failover,
LaserStream lag, Shyft callback age, Redis hit rate, match finish anomalies,
reward velocity, ticket/claim conversion, vault forecast, failed transaction
rate, and reward pipeline age.

On provider failure, stop settlement writes, preserve signed events, switch to
the configured read/fallback path, and reconcile before resuming. Do not
silently pay from a stale cache or re-run an ambiguous bridge transaction.

## 18. Local tests and verification

The repository's dependency-free checks are:

```sh
cd backend && npm test
cd ../onchain && npm test
```

For the v3 route smoke test, start the backend and run the curl commands in
section 1. The Godot project can be opened in Godot 4; without an installed
wallet provider it intentionally reports `wallet-adapter-not-installed`.
Rust/Actix, Sonic, MagicBlock, Arcium, Xandeum, PST, Shyft, Helika and other
third-party deployments require operator credentials and are not simulated by
these tests.

## 19. What is and is not shipped

Shipped: a 33-component catalog, deterministic high-frequency router, SDK
contracts, game-signals contract, telemetry persistence with late binding,
Godot 4 adapter project, identity/session-key boundaries, race/asset/economy
schemas, and this integration/security runbook.

Not shipped: private keys, OAuth credentials, provider SDK binaries, a fake
mainnet program id, a fake gasless signature, a fabricated 5 ms or sub-10 ms
SLA, automatic ML payouts, or an unreviewed wager/bridge deployment. The
existing Anchor source and offline tests still require a connected Solana/
Anchor toolchain for a real devnet deployment.

## 20. Final handoff report

1. Game and tenant are fixed to `neonrelay`.
2. The Watchtower API reports version `v3` and exactly 33 components.
3. Identity supports Phantom OAuth, MWA, FirstStep, Privy and a cross-game PDA
   contract without moving private keys into the game.
4. Session Keys are limited to frequent racing actions and require expiry and
   revocation.
5. Bubblegum v2 is the common cNFT path; MPL Core is the rare asset path.
6. DAS/Sorada reads, Core Attributes and Xandeum state are separate read/state
   boundaries.
7. ARC Entity and Bolt FOCG model track entities and race systems.
8. DePIN, Husks and RitArena contracts separate workers/bots/tournaments from
   player reward authority.
9. Sonic HyperGrid is selected for high TPS and dedicated isolation.
10. MagicBlock ER and Magic Actions cover gasless execution and automated,
    idempotent settlement jobs.
11. REPLA is the complementary rollup settlement boundary.
12. Arcium and PST are selected for confidential/private-verifiable flows.
13. Gamba models ticket, wager, prize epoch and jackpot separately from a win.
14. LaserStream, Shyft, TimescaleDB and Redis form the event/read path.
15. Helika, GameSight and Game Signals ML form attribution/ML adapters with
    human review.
16. ME, GameShift, Tensor, RACE and idosgames are compatibility marketplace/
    cross-chain adapters with receipt verification.
17. Session telemetry includes match, disconnect, finish, crash, anti-cheat,
    checkpoint, payment and pipeline signals.
18. `/api/ingest/solana` supports solana-wallet late ID binding and idempotency.
19. The Godot sample exposes SolanaClient, WalletAdapter, AnchorProgram and
    SessionKeyAdapter without pretending to sign transactions.
20. The security runbook, fallback policy and honest verification boundaries are
    recorded for operator handoff.
