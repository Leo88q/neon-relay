# Миграция Anchor 0.30.1 → 0.31.1 (продакшн-патч)

**Зачем:** 0.30.1 (Jul 2024) имеет открытый `init_if_needed` race (перезапись критических state) и не аудитирован под Token-2022 confidential transfer (C4 Aug 2025). 0.31.1 фиксит + добавляет `anchor-spl` confidential-amount checks. Agave 3.0.14 требует перекомпиляции под новый syscall set.

**Что менять:**

```toml
# onchain/Anchor.toml
[toolchain]
anchor_version = "0.31.1"

# onchain/Cargo.toml workspace
[workspace.dependencies]
anchor-lang = "0.31.1"
anchor-spl = "0.31.1"

# onchain/programs/*/Cargo.toml
anchor-lang = { version = "0.31.1", features = ["init-if-needed"] } # если нужно, но мы не используем
```

**Команды:**

```bash
cargo update -p anchor-lang --precise 0.31.1
cargo update -p anchor-spl --precise 0.31.1
anchor build --verifiable  # в docker projectserum/build:v0.31.1
anchor test --provider.cluster devnet
```

**Breaking changes 0.31:**

- `Account<'info, T>` теперь требует `T: Owner` (наши уже).
- `#[account(init, payer = ..., space = 8 + T::INIT_SPACE)]` — без изменений (уже используем).
- `anchor_spl::token_interface` стабилизирован — можно мигрировать `Program<'info, Token>` → `Interface<'info, TokenInterface>` где нужен Token-2022.
- `idl-build` feature теперь требует `anchor-lang/idl-build` (уже в `idl-build` feature).

**Оффлайн sandbox:** остаётся 0.30.1 до появления toolchain в CI (BL-03). `npm test` не зависит от версии Anchor (только TS). `cargo test -p neonrelay-assets` на девелоп-машине должен уже использовать 0.31.1.

**Проверка после миграции:**

```bash
grep -r "0.31.1" onchain/*/Cargo.toml onchain/Cargo.toml
anchor --version  # 0.31.1
solana --version  # 3.0.14+
cargo audit       # 0 vulnerabilities
```
