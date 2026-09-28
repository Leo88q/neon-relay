# Terms of Service — Neon Relay (draft v0.1, 2026-09-28)

> Template for legal review. Checklist 5.2.2. Link from footer and wallet-connect screen. Version + date required.

## 1. Acceptance & age

- By connecting a wallet and/or playing, you agree to these Terms + Privacy + Cookie + Risk Disclosure.
- **18+ only** where token/NFT value or chance-based mechanics apply; otherwise as per store policy. No knowing collection of children's data.

## 2. Wallet & identity

- You control your wallet; never share seed phrases. Site never asks for them (UI warning — checklist 3.9.1).
- Binding a `player_id` requires the wallet signature challenge (domain-bound, nonce single-use, ED25519). In production via `register_game_account.ts` the operator must have provisioned `(player_id, wallet)` (checklist F-11).
- Misuse: bots, multi-account farming, exploits, modified clients to fake rewards may lead to suspension. Gameplay is server-authoritative.

## 3. Virtual items, tokens, NFTs

- No token is offered in this repository checkout. Any future mint (SKR/POTATO/reward) is per-environment, devnet test mints labelled valueless. Nothing promises income, yield, or appreciation.
- Chance-based elements (if any: tournaments, loot) comply with local gambling rules; geo-blocking list applied per counsel.
- All balances/rewards are computed server-side; client values are display only.

## 4. Conduct

- Prohibited: cheating, reverse-engineering for reward fraud, rate abuse, injection, harassment, infringing content.
- Admin actions are two-person (operator propose + superadmin approve), append-only audit; misuse investigated per `docs/INCIDENT_RESPONSE.md`.

## 5. IP & licences

- Code: `license.txt` (zlib). Assets: see `docs/THIRD_PARTY_NOTICES.md`, `docs/ASSET_MANIFEST.csv`. Verbatim CC/OFL texts in `licenses/` from SPDX (re-fetch from licensor before shipping — BL-09).
- If you upload content (future), you warrant rights and grant a licence; DMCA contact: `abuse@neonrelay.example`.

## 6. Availability, changes, termination

- Service “as is”, no uptime guarantees; maintenance, pauses (`set_paused`) possible. We may suspend accounts violating Terms.
- We may update Terms with notice; continued use after change = acceptance. Archive old versions.

## 7. Liability & law

- To fullest extent allowed, exclude liability for indirect loss, loss of tokens due to user wallet compromise, or on-chain finality.
- Governing law / forum: [Jurisdiction — fill].
- Dispute resolution: [informal → mediation → courts/arbitration].

## 8. Compliance

- Sanctions/AML: blocked jurisdictions list [fill], filtration of sanctioned addresses if counsel requires.
- Tax: you are responsible for reporting.

*Before mainnet:* fill Jurisdiction, geo-block list, sanctions screening decision, store policy check (BL-16), and have counsel sign off. Publish at `https://neonrelay.example/terms`.
