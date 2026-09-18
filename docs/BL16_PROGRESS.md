# BL-16: asset stage (not a release)

## Implemented

- Ten generated potato sheets, RGBA 256x128, body at most 80x80 inside the 96x96 body cell.
- Female character faces kept as approved. New guy_3 without ground clouds; horizontal ninja.
- Six weapon body rects baked in the 1024x512 atlas. All pixels outside those rects match baseline aef3363.
- 512x512 potato sources, 256x256 weapon sources and both collages.
- Normalized sources are never rematted on rebuild. New raw inputs are retained under `raw/`; old originals overwritten in earlier session steps are not recoverable.
- Corrected compositing: copying RGBA into transparent cells no longer multiplies alpha by itself.
- `data/skins/potato_catalog.json`: 5 Common at 500 SKR, 3 Rare at 1000 SKR, 2 Legendary at 2000 SKR, royalty policy 500 bps. This is catalog metadata, NOT an implemented payment/NFT flow.
- Generated C++ allowlist restricts the classic skin list to catalog names. Existing files and rendering of remote legacy skins remain intact. This is not ownership enforcement.
- `scripts/ci-local.sh` collects existing offline gates plus asset regression tests.

## Verification

Asset regression tests: 3/3, including byte-identical repeat builds and atlas boundaries.
Backend: 39/39 existing tests. Onchain: 25/25 existing offline TypeScript tests.
Branding release/translations, asset licenses, secrets, config, local syntax probe and signer passed.
The syntax probe excludes client translation units and external-dependency units; it is not a complete client build.
Asset manifest still contains block-release rows; passing `--licenses` is not release clearance.

## Not implemented / not verified

- Five-button menu, removal of editor code/data and other legacy entry points.
- Protocol 0.7 skin selector/catalog support.
- Dual-mint end-to-end economy, migrations, mint-bound ticket/claim PDAs and Merkle leaves.
- Tournament lobby, ranked per-match fees, Legendary ownership/freeroll verification.
- NFT issuance, SKR transfer to developer and enforced secondary royalties.
- Native client build and movement/weapon attachment visual playtest; validator program tests/deployment.

Graphics do not change the fixed 28x28 core physics. However, legs and eyes are painted into the body and their separate cells are empty: walk/eye animation differs from legacy skins. Weapon attachment origins and muzzle alignment still need visual review. Do not describe these artifacts as gameplay-validated or pixel-identical copies of the user's screenshots; they were generated anew.

## Rebuild

Install Pillow and NumPy in a Python environment, then run:

```sh
python3 scripts/build_potato_skins.py
python3 scripts/build_potato_weapon_sheet.py
python3 scripts/gen_potato_catalog.py
python3 scripts/gen_asset_manifest.py
./scripts/ci-local.sh
```

Do not run destructive matting helpers on already normalized sources. For replacing a source with another normalized RGBA PNG, preserve its canonical dimensions.

## Part 2: read-only dual-currency lobby

- Added validated `NEONRELAY_POTATO_MINT` alongside SKR, distinct-mint validation,
  and a base58 all-zero decode regression fix.
- Added `/v2/economy/lobby`, both categories and five race policies, exact bigint
  pool/share preview helpers and 10 new tests (backend total 49).
- No on-chain PDA/state migration or payment endpoint in this stage. Catalog
  explicitly disables joining/payment even when both mints are configured.
- See `DUAL_CURRENCY_LOBBY.md` for the coordinated backend/Rust/Android migration
  requirements and remaining security checks.

## Part 3: legacy payment transport hardening before v2 migration

- Backend ticket reads now require finalized commitment, matching program owner,
  non-executable account, canonical base64, exact Borsh layout/discriminator,
  player/reference/bump binding, supported kind and safe positive amount.
  Unsafe u64 -> number coercion fails closed. This does not yet compare against
  mint-qualified v2 configuration or tier-specific expected fees.
- Android base58 encoding now reverses the accumulated digits; message compiler
  includes program ID before serialization, writes program_id_index, merges
  duplicate account privileges and places the payer first.
- WalletManager decodes blockhash as base58, validates RPC config owner/encoding,
  and wraps messages in a one-signature unsigned transaction for the wallet.
- Config discriminator/layout, claim proof sizes, entry inputs, key sizes, hex
  and the 1232-byte transaction limit are validated before submission.
- Added backend negative tests and Android pure JVM tests with pinned shared
  reference/PDA vectors and a wire-message parser. Backend total: 57 tests.
- Android tests have NOT run in this sandbox: no Java/Kotlin/Android toolchain;
  attempts to install it failed because the package mirror was unreachable.
  Run `cd android && ./gradlew :app:testDebugUnitTest` in an Android build
  environment. No wallet or validator transaction was broadcast here.
- V2 state/DB/PDA migration, tier fee enforcement and the five-button client
  menu are still pending. All v2 payments remain disabled.

## Part 4: native five-destination navigation

- Home and offline navigation now expose Play, Characters, Wallet, Leaders,
  Settings. Skip-start-menu opens the race catalog rather than the legacy
  browser. Match controls remain available while connected.
- Native race catalog has SKR/POTATO tabs and generated policy rows (same
  source as backend). This is an offline preview, not an HTTP live-lobby client;
  no join/payment action is offered. Ordinary play remains available through
  the explicitly labelled Practice/server-browser button.
- Character page previews the ten classic potato skins with rarity and SKR
  prices from the JSON manifest. No purchase/equip or false ownership claim.
  The same preview is used independently of protocol version; 0.7 in-match
  skin rendering/equipping is still not implemented.
- Wallet opens the existing connection screen. Leaders displays an unavailable
  state until live ranking integration exists; no fabricated standings.
- Editor/Demos/Local Server shortcuts removed from the main/menu bars. Settings
  navigation is limited to language, graphics, sound and controls, with a legal
  Credits link retained. Saved legacy settings IDs are normalized. Asset,
  texture and community-icon customization tabs are no longer exposed here.
- Editor code/data, console functionality and demo playback infrastructure are
  still present; this is NOT full physical removal of the editor.
- Added Russian translations, four source/generation regression tests and a
  separate syntax check of all four modified menu translation units.
- No native client link/run, screenshot, input or visual playtest in this
  environment. Syntax checks and contract tests do not prove visual layout.

## Part 5: isolated v2 backend ledger and mint-bound wire primitives

- Added a forward-only migration with separate v2 tables; no automatic mapping
  of old rows onto a mint. Internal ledger keys include mint, and idempotency
  keys bind the full intent payload. Caps are keyed by player/mint/epoch.
- Epochs transition once from OPEN to SEALED with immutable snapshots, exact
  u64 base-unit amounts, budget checks, atomic transactions and SQL guards.
- Added separate v2 leaf/proof/PDA helpers and a TypeScript offline claim
  verifier. Shared independent leaf vectors cover two mints and u64 maximum.
- Backend 69/69; onchain TypeScript tests 28/28. No Rust v2 instructions yet,
  no public v2 intent/payment/claim route and no deployed v2 vaults/treasuries.
- See ECONOMY_V2_LEDGER.md for API boundaries, reserved wire formats and the
  authentication/fee/funding checks still required before exposing payments.

## Part 6: additive Rust v2 instructions (validation in progress)

- Added initialize_v2, set_paused_v2, pay_entry_v2, publish_prizes_v2 and
  claim_prize_v2 alongside the legacy instructions. Account types and PDA
  namespaces are separate; bootstrap is gated by the existing legacy operator.
- One config/vault/treasury per mint, fixed paid tiers scaled by SPL decimals,
  capped rake, mint-bound leaf/PDAs, pause checks and init-only ticket/claim/root.
- Aggregate reservation plus epoch remaining balance prevents overlapping
  epochs from committing the same funds. Checked u128 rake intermediate avoids
  multiplying a u64 fee in u64. No withdrawal or unverified free-entry path.
- Corrected two legacy Anchor compile issues while preserving wire layouts:
  SPL TokenAccount owner field (not authority), and writable publication payer.
- Added seven Rust host tests and four TypeScript source contract checks.
  Existing local offline checks remain distinct from Rust execution.
- A dedicated GitHub workflow compiles Anchor constraints and runs host tests;
  results must be checked before treating the Rust additions as validated.
  Local Rust toolchain download failed. No SBF build, validator test, deployment
  or Android v2 transaction wiring yet. V2 payments remain disabled.

### Part 6 verification update

GitHub workflow `Economy Rust host tests` run 35303726125 succeeded:
https://github.com/Leo88q/neon-relay/actions/runs/35303726125
It compiled the Anchor economy crate and executed the Rust host test suite,
including the seven new v2 tests. This is not an SBF/validator/deployment test.
The resolved Cargo.lock is retained as a CI artifact; artifact download from
this sandbox failed, so no local dependency lock is claimed here.

Inspection also found earlier GitHub CI runs failed at the procedural skin
check despite local gates passing. The workflow had no image dependency setup.
Added pinned Pillow/NumPy installation and the new asset/menu regression checks.
The UI check also referenced obsolete builders for strong_weak/deadtee; it now
uses the existing misc-sheet builders. Pixels of all assets are unchanged.
PNG compression bytes are no longer mistaken for pixel changes by the UI
check; manifest SHA256 validation remains separate. Alphabetical hygiene now
uses --dry-run, with existing sorting issues fixed. Local CI includes these
same checks so this gap does not recur silently.

### Part 7 — read-only v2 RPC validation

- Added separate strict Anchor/SPL v2 account reader, coherent finalized
  snapshots, PDA/ATA/owner/mint/fee/reserve/ticket checks and bigint outputs.
- Added authenticated/rate-limited market and existing-intent ticket inspection;
  wallet binding is checked in addition to player ID. No public intent creation,
  payment transaction, race admission, or v1 decoder reuse.
- Added adversarial account fixtures and HTTP/session tests. Backend: 80 passing
  tests (11 new). Payment/admission flags remain false; no validator/deployment
  or native/Android runtime verification is claimed.

### Part 8 — native bank/runtime integration (verified)

- Added real Anchor entrypoint + SPL Token CPI scenario under
  solana-program-test 1.18.26: fee split, payment replay, atomic CPI failure,
  pause authorization, epoch reservation/overcommit, invalid proof amount,
  PDA-signed claim and anti-double-claim. No production instruction changes.
- GitHub Rust host/runtime run 35305393273 succeeded at d6ca9d0.
- Full local ci-local passed: backend 80/80 and onchain TS 32/32, plus existing
  assets/branding/secrets/menu/syntax/signer gates.
- Config/token state is seeded, so initialization remains untested in runtime.
  This is native bank execution, NOT an SBF binary or validator/deployment test.
  Public payment and admission flags remain disabled. Full BL-16 is incomplete.

### Part 9 — v2 initialization and two-mint runtime isolation (verified)

- Added a second native runtime scenario with actual initialize_v2 and
  Associated Token/System/SPL CPI creation of two market configs and vaults.
- Checked operator/treasury constraints, duplicate init, invalid rake/decimal
  overflow rollback, cross-mint account substitutions, independent payments,
  epoch reservations and claims, including unchanged other-market balances.
- Rust run 35305779544 and general CI 35305779545 passed at b5da216. Full local
  gates passed: backend 80/80, onchain TS 32/32, existing asset/native checks.
- Legacy bootstrap/mint/source state is still seeded. SBF/validator/deployment
  and game admission remain unverified; no payment/admission flags enabled.

### Part 10 — SBF build and execution (verified)

- CI builds an economy ELF with hash-checked Agave v3.1.8 and executes both
  runtime scenarios with the ELF; missing binary/native fallback is disallowed.
  SPL/ATA dependencies use their real native processors in the bank harness.
- Found SBF-only ProgramFailedToComplete failures missed by native testing.
  Boxed v2 decoded accounts to reduce stack pressure; ABI/seeds/constraints
  unchanged. Both native and SBF scenarios now pass.
- Rust/native/SBF run 35334434254 and general CI 35334434283 passed at fb85089.
  Full local gates passed: backend 80/80 and onchain TS 32/32 plus prior checks.
- Published CI artifacts: economy ELF + SHA-256 and separate resolved Cargo.lock;
  no keypair upload, no deploy, no wallet use. Standalone validator/RPC lifecycle,
  deployment verification and gameplay admission integration remain outstanding.
  Payments and admission stay disabled; complete BL-16 is not yet delivered.

### Part 11 — standalone local validator + backend RPC (verified)

- Added opt-in RPC lifecycle test against an ephemeral loopback validator with
  the economy SBF ELF loaded into genesis; no external network or operator keys.
- Real SPL mint creation/minting, treasury/source ATAs, legacy bootstrap, two v2
  markets, payments, publication and claims now execute through validator RPC.
  Replays must fail with transaction errors; balances/reserves are checked.
- Production backend v2 decoder then verifies both finalized market/ticket
  snapshots. Payment flags stay false. Temporary ledger/fixture are cleaned up.
- Boxed legacy initialization account wrappers without wire ABI changes.
- Verified at 8d01311: Rust/native/SBF/validator run 35335519276 and general CI
  35335519215 succeeded. Full local gates passed (backend 80, onchain TS 32).
- No devnet/mainnet deploy or upgrade-authority verification; HTTP/mobile/game
  admission and NFT purchase/ownership integration are still outstanding.

### Part 12 — server-attested game identity backend

- Added a separate game identity public-key configuration, migration 0006 and
  authenticated/rate-limited challenge, verification and status routes.
- Signed bytes bind purpose/domain, session, wallet, player and signer. Nonces
  are one-use with two-minute expiry; grants last five minutes without sliding.
- Atomic verification and SQL invalidation prevent self-link changes/relinking
  from preserving or resurrecting verification. No wallet token/hash is exposed
  in the challenge. Existing read-only economy routes are unchanged.
- Full local gates passed: backend 87/87 (7 new tests), onchain TS 32/32.
- Trusted game-server identity authentication/signing is NOT implemented yet;
  its required contract is documented in GAME_IDENTITY_V2.md. No payment, public
  intent creation, capacity reservation or game admission was enabled.

### Part 13 — guarded C++ identity signer boundary

- Added a C++ identity signer requiring trusted player/wallet/session context,
  explicit consent and fresh authentication; exact canonical-byte comparison
  before signing prevents payload/context substitutions.
- Added the adapter to the game-server build source list and extended the signer
  gate with a compiled C++ -> wallet-authenticated backend HTTP parity test,
  16 negative cases, Unicode/quote handling and one-use nonce verification.
- Found existing legacy finish events identify players by ClientName. That path
  is NOT an identity provider and was not wired into the new signing mechanism.
- Production account authentication/context adapter is still missing. There is
  deliberately no chat/RCON/network signing hook and no paid admission enabled.

### Part 14 — operator identity registry and backend connection pairing

- Added immutable operator-provisioned player/wallet registry, local provisioning
  command, and no automatic conversion of self-declared nickname/player links.
- Added session-authenticated, consent-required issuance of hashed one-use pairing
  tokens and server-signature-authenticated redemption bound to a connection nonce,
  domain, signer and live registered wallet/session. Returned context has no bearer.
- Tightened existing identity issue/verify/status to require the active registry;
  disabling an account invalidates pending proofs and existing grants.
- Backend 94/94 (7 new tests) and native C++/backend identity parity passed.
- The native connection transport/TLS client/nonce lifecycle adapter remains
  unimplemented; pairing context must not be fabricated from network input.
  Payments, public intent creation and race admission remain disabled.

### Part 15 — native per-connection identity lifetime

- Added game-thread identity state with pending serial/nonce binding, bounded
  deadlines, terminal disconnect, expiry and fail-closed clock rollback.
- Hooked fresh cryptographic nonces into OnClientConnected and invalidation into
  OnClientDrop/context destruction. State is not persisted across map reset.
- Added compiled lifecycle tests for stale replies, retries, client-slot reuse,
  weak-handle expiry and invalid/expired contexts to the existing signer gate.
- No HTTPS/pairing packet transport is implemented or enabled. Complete() remains
  a trusted response boundary, not an authentication parser. No paid admission.

### Part 16 — native pairing HTTPS adapter and strict protocol

- Added canonical C++ pairing-proof construction and strict bounded response
  parsing. Real backend HTTP redemption and reply parsing pass compiled parity
  tests, alongside unsafe-origin/schema rejection cases.
- Added queued engine-HTTP adapter with game-thread Poll(), original-connection
  weak handles, fixed path, deadlines, cancellation and request/response caps.
- Added opt-in Sensitive() HTTP policy: HTTPS-only, certificate/hostname checks,
  no redirect or wire logging even under global insecure/debug settings;
  Emscripten rejects this unsupported policy instead of silently weakening it.
- Adapter/engine syntax gates added. Actual native TLS execution, game packet
  transport/config/poll-loop wiring and full native linking remain unverified.
  No live wallet login or paid admission has been enabled.
