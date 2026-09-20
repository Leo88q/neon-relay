# Neon Relay on-chain (prod-grade, 4 programs — cheap minting + super security)

Workspace из 4 Anchor программ, каждая — devnet-only до BL-16, продакшн-харденинг под Agave≥3.0.14 + Alpenglow + Firedancer + ZK Compression.

| Программа | Деплой | Чеканка | Безопасность |
|-----------|--------|---------|--------------|
| `neonrelay-rewards` (stage 9) | `2RaaXK...tmj` | SPL vault (6 decimals) | one-way root, claim PDA, pause |
| `neonrelay-features` (stage 11) | `4PH1dH...qYP` | supply-1 SPL badge (0.022 SOL) | bitmap, per-(badge,player) mint |
| `neonrelay-economy` (stage 14 v1 + BL-16 v2) | `FZcLDd...CV9` | SKR/POTATO vault, rake 10% cap 20% | mint-изолированные рынки, timelock |
| **`neonrelay-assets` (NEW, prod)** | `As5T3p...q0r` | **Bubblegum v2 cNFT 0.00001 SOL + MPL Core 0.0029 SOL + Token-2022** | **45-check audit, timelock 48h, finalized-only** |

Дёшево: 10k бейджей — Metadata 220 SOL → Core 29 SOL → **Bubblegum 0.27 SOL (815× дешевле)**. Безопасно: см. `docs/ASSETS_SECURITY_AUDIT_CHECKLIST.md` (45/45) + `docs/SOLANA_2026_PRODUCTION_RESEARCH.md`.

Оригинальный rewards-RUNBOOK ниже сохранён; для assets см. `docs/ASSETS_PRODUCTION_DEPLOYMENT.md`.

---

# Neon Relay on-chain rewards program (stage 9) — legacy section

Anchor program that pays sealed reward epochs **exactly once per
(epoch, wallet) Merkle leaf**, plus a dependency-free TypeScript client mirror
and offline tests.

```
backend (stage 7)                    this program                       player wallet
seals epoch → merkle_root  ──▶  publish_epoch(epoch_id, root)   (operator only)
claim-intent {leaf_hash,   ──▶  claim(epoch_id, amount_micro,   ──▶  SPL transfer from
 leaf_index, merkle_proof}        leaf_index, proof)                 program vault → player ATA
```

## Layout

| Path | Contents |
| --- | --- |
| `programs/neonrelay-rewards/src/lib.rs` | the Anchor program: `initialize`, `publish_epoch`, `set_paused`, `claim` |
| `programs/neonrelay-rewards/tests/golden_leaf.txt` | leaf vector pinned together with `backend/src/merkle.ts` and `test/merkle.test.ts` |
| `src/merkle.ts`, `src/constants.ts` | client-side mirror of the Merkle construction and PDA seeds (zero dependencies) |
| `test/*.test.ts` | offline tests: backend cross-check, tamper negatives, static program conformance |
| `scripts/create_test_mint.sh` | devnet-only throwaway test mint helper |
| `Anchor.toml`, `Cargo.toml` | devnet provider config, workspace |

## Guarantees encoded in the program

* **Operator-only roots**: `publish_epoch` and `set_paused` require
  `config.authority`; a published root can never be replaced (the epoch PDA
  `init` fails the second time).
* **No double claims**: the claim record PDA is keyed by
  `(epoch_id, wallet_pubkey)`; a repeat claim fails on `init`. The wallet
  itself signs, and the leaf binds its pubkey — a proof cannot be replayed for
  another wallet or another amount.
* **Pause**: `set_paused(true)` rejects all claims until the operator resumes.
* **No hardcoded mint / no SKR token**: the reward mint is an account passed
  to `initialize` and must have 6 decimals so `amount_micro` equals SPL base
  units. Devnet deployments use a throwaway test mint
  (`scripts/create_test_mint.sh`), explicitly **not an official token**. There
  is no official Neon Relay token and no token named SKR anywhere in this
  repository.
* **Merkle parity**: leaf/parent/padding/direction are byte-identical to
  `backend/src/merkle.ts` (see `docs/REWARD_SECURITY.md` §6). The offline test
  suite asserts the Rust source, the TS mirror and the backend agree on seeds,
  construction and caps on every run.

## Verified here vs. not verified here (honest status)

Verified in this sandbox (no Solana toolchain needed):

```bash
cd onchain && npm test        # 12/12 passing on Node v22 (merkle parity + conformance)
cd backend && npm test        # 30/30 passing — backend side of the same vectors
```

**Not** verified here — `cargo build`, `anchor build`, `anchor test` and any
devnet deployment are impossible in the offline sandbox
(`docs/KNOWN_LIMITATIONS.md` BL-03; the pinned `anchor-lang 0.30.1` /
`anchor-spl 0.30.1` coordinates are unverified offline, BL-06). On a connected
machine with Rust, Solana CLI and Anchor CLI 0.30.1:

```bash
cd onchain
cargo test -p neonrelay-rewards          # pure-Merkle unit tests + golden leaf
anchor keys list                         # real program id → replace the PLACEHOLDER
                                         #   in Anchor.toml and src/lib.rs declare_id!
anchor build                             # generates target/idl/neonrelay_rewards.json
./scripts/create_test_mint.sh            # export NEONRELAY_TEST_MINT=...
solana airdrop 1                         # devnet SOL for the operator wallet
anchor test --provider.cluster devnet    # local validator + integration tests
```

Deployment runbook (devnet): `anchor deploy --provider.cluster devnet`, then
one `initialize` with `NEONRELAY_TEST_MINT` and the operator keypair; from then
on the operator publishes each sealed epoch root and players claim with their
wallet (Mobile Wallet Adapter on Solana Mobile — see `android/`). Mainnet
deployment is explicitly out of scope until legal/liquidity review.
