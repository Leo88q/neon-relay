# Android / Solana Mobile (Seeker) client

This document describes the Android side of Neon Relay: the Gradle module, the
Mobile Wallet Adapter (MWA) layer, the JNI contract into the native game, and the
lifecycle guarantees. The reward protocol itself is specified in
[`WALLET_AUTH.md`](WALLET_AUTH.md) and [`REWARD_SECURITY.md`](REWARD_SECURITY.md);
the on-chain part in [`SOLANA_ARCHITECTURE.md`](SOLANA_ARCHITECTURE.md).

## 1. Architecture

```
 ┌─────────────────────────────── Android app (com.leo88q.neonrelay) ───────────────────────────────┐
 │                                                                                                  │
 │  native game code (libneonrelay.so)          Kotlin wallet layer (android/app/.../wallet/)        │
 │  ┌──────────────────────────────┐            ┌───────────────────────────────────────────────┐   │
 │  │ src/neonrelay/wallet_bridge  │◄── JNI ────│ NativeBridge / WalletEventJson (closed schema)│   │
 │  │  events: connected / label / │  sanitized │ WalletManager  ── MWA clientlib 2.2.0 ──┐     │   │
 │  │  pubkey (base64) / error     │  events    │ WalletSession  (StateFlow + store)      │     │   │
 │  └──────────────────────────────┘            │ WalletHolder / WalletBridgeActivity     │     │   │
 │                                              └───────────────────────────┬─────────────┘     │   │
 │   game is fully playable without any of this ◄── wallet is optional      │                   │   │
 └──────────────────────────────────────────────────────────────────────────┼───────────────────┘
                                                                            │ local association
                                                                     ┌──────▼──────┐      HTTPS (stage 6)
                                                                     │ wallet app  │   ┌──────────────┐
                                                                     │ (Seeker etc)│   │ reward backend│
                                                                     └─────────────┘   └──────────────┘
```

Rules enforced by construction:

* **Only Kotlin talks to wallets.** The native game never sees auth tokens,
  signatures, challenge payloads or keys.
* **The JNI channel has a closed schema** (`WalletEventJson`): `connected`,
  `account_label`, `public_key_base64`, `error_message`. There is no serializer
  parameter for anything else, and `WalletEventJsonTest` pins that.
* **A wallet is optional.** `WalletHolder` is inert until the user (or the
  in-game Wallet screen, stage 10) requests an operation; every failure path
  returns a typed [`WalletError`] and the game keeps running.
* **No private key material exists in this process, ever.** Signing happens
  inside the wallet app via MWA `signMessages`; we only receive signatures over
  challenges *we* generated for the reward backend.

## 2. Components

| File | Responsibility |
| --- | --- |
| `wallet/WalletManager.kt` | the only MWA client: associate, (re)authorize, `signMessages`, disconnect; maps `TransactionResult` to `WalletResult`; pushes sanitized events |
| `wallet/WalletSession.kt` | observable session state (`StateFlow`) + persistence (`WalletSessionStore`: EncryptedSharedPreferences, degrading to *no token persistence*) |
| `wallet/WalletResult.kt`, `wallet/WalletError.kt` | closed result/error algebra consumed by UI and tests |
| `wallet/WalletHolder.kt` | application-scoped owner of session+manager; request queue; survives activity recreation |
| `wallet/WalletBridgeActivity.kt` | invisible `ComponentActivity` hosting the MWA activity-result launcher (the SDL activity is not a `ComponentActivity`) |
| `wallet/WalletViewModel.kt`, `wallet/WalletBridgeIntents.kt` | lifecycle-aware façade for the Wallet UI |
| `wallet/NativeBridge.kt`, `wallet/WalletEventJson.kt` | JNI surface + closed-schema serializer |
| `src/neonrelay/wallet_bridge.{h,cpp}` | native event sink: listener registration, sanitized state, tiny JSON field extractor |
| `android/app/src/main/cpp/neonrelay_wallet_jni.cpp` | JNI implementations (push event; native→Kotlin connect/disconnect requests) |
| `scripts/android/files/java/com/leo88q/neonrelay/{ClientActivity,ServerService}.java` | rebranded upstream SDL activity / local server service |

## 3. Mobile Wallet Adapter pin

| Field | Value |
| --- | --- |
| Artifact | `com.solana:mobile-wallet-adapter-clientlib` |
| Version | `2.2.0` (`android/gradle/libs.versions.toml`) |
| Verified against | tag `v2.2.0`, commit `25296e124c5fdc30dc89f1ac0622b8cffefc5c8e` of https://github.com/solana-mobile/mobile-wallet-adapter |
| API used | `MobileWalletAdapter(ConnectionIdentity)`, `blockchain = Solana.Devnet`, `transact(ActivityResultSender) { authResult -> … }`, `AdapterOperations.signMessages(messages, addresses)`, `disconnect(sender)`, `ActivityResultSender(ComponentActivity)` |
| Cluster policy | devnet by default (`BuildConfig.REWARD_CLUSTER`); `mainnet` is set only by an explicit release configuration, never in source |
| Identity | `BuildConfig.WALLET_IDENTITY_URI` placeholder on the reserved `.example` TLD; replace with the production domain before release |

Maven Central and docs.solanamobile.com are unreachable from this sandbox, so the
artifact coordinates were verified against the upstream Git tag only; the first
real Gradle build confirms availability (blocker BL-06 in
[`KNOWN_LIMITATIONS.md`](KNOWN_LIMITATIONS.md)).

## 4. Lifecycle matrix

| Situation | Behaviour |
| --- | --- |
| screen rotation during a wallet flow | `ActivityResultSender` re-delivers the pending activity result after recreation; `WalletHolder.inFlight` prevents starting the operation twice |
| process death | auth token + account restored from `WalletSessionStore`; the next operation reauthorizes transparently (`adapter.authToken` pre-seeded in `attach`) |
| user closes the wallet UI | `WalletError.UserCancelled`; bridge activity finishes; game unaffected |
| wallet denies the request | `WalletError.UserDenied(detail)` surfaced in UI state and as a sanitized error event |
| no MWA wallet installed | `TransactionResult.NoWalletFound` → `WalletError.NoWalletAvailable`; the Wallet screen explains that a wallet is only needed for claims |
| wallet app crashes mid-flow | MWA association times out → `WalletError.OperationFailed`; session state returns to `ERROR` with a user-safe message |
| background/foreground | no association is held open; every operation re-associates, so there is nothing to leak across lifecycle stops |
| explicit disconnect | `disconnect()` → MWA `deauthorize`, store cleared, `EVENT_DISCONNECTED` pushed |

## 5. JNI contract

`NativeBridge.nativePushWalletEvent(type, json)` →
`neonrelay_wallet_push_event(type, json)` in `src/neonrelay/wallet_bridge.cpp`.

| type | constant | meaning |
| --- | --- | --- |
| 0 | `EVENT_DISCONNECTED` | no wallet bound (also after disconnect/forget) |
| 1 | `EVENT_CONNECTED` | account authorized; label + public key available |
| 2 | `EVENT_ERROR` | last operation failed; `error_message` is user-safe |

JSON schema (closed): `{"connected":bool,"account_label":string|null,
"public_key_base64":string|null,"error_message":string|null}`.

Native→Kotlin requests (in-game Wallet screen): `nativeRequestWalletConnect`,
`nativeRequestWalletDisconnect` → `NativeBridge.requestWalletConnect/…`.

The public key is *public* information (it is what the backend binds rewards to);
it is shown in the UI as a fingerprint and never used for crypto in native code.

## 6. Building

Requirements: JDK 21, Android SDK 36 + build-tools 36.1.0, NDK r28+, CMake,
the `ddnet-libs` submodule (SDL Java bindings), and Gradle 8.13+ (`gradle wrapper`
once; the wrapper jar is not committed).

```sh
git submodule update --init ddnet-libs          # SDL java + prebuilt deps
./scripts/android/cmake_android.sh arm64        # libneonrelay.so, libneonrelay-server.so
                                                #   -> android/app/src/main/jniLibs/arm64-v8a/
cd android && gradle :app:assembleDebug
```

Unit tests (`WalletSessionTest`, `WalletEventJsonTest`) are plain JVM tests:
`gradle :app:testDebugUnitTest`. **They have not been executed in this sandbox**
(no JDK/Android SDK, no Maven Central) — see BL-06; the native side of the bridge
is covered by the compile probe (`scripts/local_syntax_probe.sh`, 124 TUs).

## 7. Status

Implemented here: module skeleton, wallet layer (including `signChallenge` for
the backend's wallet-auth flow, `docs/WALLET_AUTH.md`), JNI bridge, native event
sink, tests, rebranded template (`applicationId com.leo88q.neonrelay`,
`libneonrelay.so`). The in-game Wallet UI now exists
(`src/game/client/components/menus_settings_wallet.cpp`, Settings → Wallet): it
shows the sanitized bridge state (not connected / waiting / connected /
error), offers connect/disconnect, and states plainly that the wallet is
optional and that no earnings are guaranteed. Native → Kotlin requests go
through `neonrelay_wallet_platform_request` (JNI shim, cached `JavaVM` via
`JNI_OnLoad`) into `NativeBridge.requestWalletConnect/requestWalletDisconnect`.
Still ahead: wiring the HTTP transport for the challenge/verify round-trip into
the app (the backend side is live, stage 6) and a CI job that builds the APK
(blocked by BL-02/BL-12 — no Gradle/Android SDK in the sandbox and GitHub
Actions billing).
