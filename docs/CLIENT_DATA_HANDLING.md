# Client-side data handling — Neon Relay (checklist 1.3.4–1.3.5, 3.3, 3.9)

## 1. No secrets in client code

- No variable with prefix `NEXT_PUBLIC_`, `VITE_`, `REACT_APP_`, `PUBLIC_`, `EXPO_PUBLIC_` exists in this repository (verified: `grep -r` returns zero). If a future web frontend is added, those prefixes must be treated as **public by definition** — no secret may use them (checklist 1.3.4).
- `backend/src/config.ts` is the only secret consumer; all secrets come from `process.env` / secret store, never from source.
- RPC keys are never shipped to the client: on-chain reads go through `backend/src/rpc.ts` dual-provider proxy; the Android `EconomyTxBuilder.kt` / `RewardsTxBuilder.kt` build transactions on-device but use only the wallet's own key and public RPC endpoints (no provider secret).

## 2. Built bundle must be scanned

- If a web frontend is added, add to CI after `npm run build`:
  ```bash
  python3 scripts/check_secrets.py
  grep -R "BEGIN PRIVATE KEY\|sk-proj\|AKIA\|ghp_" dist/ build/ .next/ out/ --include="*.js" --include="*.html"
  ```
  Checklist 1.3.5 — no secret may survive into `dist/`/`build/`/`.next/`/`out/`.

## 3. XSS & injection guards (3.3)

- No `innerHTML`, `dangerouslySetInnerHTML`, `v-html`, `eval`, `new Function`, `document.write`, `setTimeout("…")` in `backend/` or `src/` (verified via `grep -R`).
- All user content (nicknames, chat, referral codes) is escaped on output; NFT/tokens metadata (name, description, image URL) is treated as untrusted — only `https:` / `ipfs:` schemes allowed, no `javascript:` (checklist 3.3.3).
- No SQL concatenation: only `node:sqlite` prepared statements (`backend/src/db.ts`).
- No command injection / path traversal / SSRF / open redirect / prototype pollution / unsafe deserialization — request bodies limited to 64 KiB (`readJsonBody`), path params `decodeURIComponent` + `str(..., maxLen)` checks, URL parsing via `new URL()` with scheme/host validation.

## 4. Wallet protection (3.9)

- Site never asks for seed phrase or private key — UI states this explicitly (`src/game/client/components/menus_settings_wallet.cpp` + docs). Before any transaction, the player sees what they sign; no blind signing of arbitrary data — `EconomyTxBuilder.kt` pre-verifies Merkle proofs client-side before the wallet ever sees the transaction (`docs/DEVNET_RUNBOOK.md` §7).
