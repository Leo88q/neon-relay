# Production/deploy gate

Этот файл описывает исполняемый gate, а не подтверждает выполненный deploy.
В checkout не хранятся production keys, transaction ids или актуальный audit
artifact.

## Offline/release gate

```bash
SOURCE_ONLY=1 onchain/scripts/release_validate.sh  # только sandbox/source gate
# release/CI: без SOURCE_ONLY и с внешним AUDIT_REPORT_PATH
```

Gate выполняет:

- `node onchain/scripts/verify_source_ids.mjs` — сверяет `Anchor.toml`, все
  `declare_id!`, клиентские константы, `.env.example` и, если передан,
  deployment manifest;
- `verify_toolchain_pin.mjs` — перед production release проверяет, что
  `Anchor.toml` и все on-chain crates согласованы с требуемым Anchor 0.31.1;
- backend tests, on-chain TypeScript tests/syntax gate и backend type gate;
- static audit generator только во временный каталог;
- drift check внешнего отчёта по `source_digest` и `audit_scope`;
- при обычном release-режиме требует настоящий `tsc`, `cargo`, `rustc` и
  `anchor`, после чего запускает locked Rust tests/build.

`SOURCE_ONLY=1` разрешает локально продолжить с маркировкой
`UNVERIFIABLE`; он не является production approval.

## Live read-only verification

Manifest должен содержать:

```json
{
  "cluster": "devnet|testnet|mainnet-beta",
  "genesis_hash": "<finalized genesis hash>",
  "upgrade_authority": "<Squads vault> | none",
  "programs": {
    "neonrelay_rewards": "<canonical program id>",
    "neonrelay_features": "<canonical program id>",
    "neonrelay_economy": "<canonical program id>",
    "neonrelay_assets": "<canonical program id>"
  },
  "mints": {
    "reward": "<reward mint>",
    "skr": "<payment mint>"
  }
}
```

После deploy `onchain/scripts/verify_deployment.sh` с таким manifest только
читает RPC и проверяет наличие bytecode, cluster, canonical source IDs и
upgrade authority. Само наличие manifest не является доказательством live
deployment.

## Live deploy

`onchain/scripts/deploy_prod.sh` по умолчанию завершается до любого RPC write.
Намеренный запуск требует одновременно `ALLOW_LIVE_DEPLOY=1`, concrete
manifest/authority, согласованный production toolchain pin, verifiable Docker
build и соответствующие operator gates. В текущем checkout `Anchor.toml` и program manifests pinned на 0.31.1, но
`Cargo.lock` ещё содержит 0.30.1 и Rust/crates toolchain недоступен в sandbox.
Поэтому `verify_toolchain_pin.mjs` намеренно блокирует live deploy до
перегенерации lockfile и успешных `cargo test`/`anchor build` в release-среде.
Исходное изменение manifests не считается выполненным locked build.

Для mainnet дополнительно требуется `CONFIRM_MAINNET=YES`. В текущей
sandbox-сессии этот режим не запускался.

Обе on-chain реализации assets CPI (`core` и `bubblegum`) остаются compile-time
запрещёнными до pinning upstream ABI/account metas и validator coverage. В
verified default build они возвращают `AssetPathNotConfigured`; это fail-closed
поведение, а не заявка на готовый Bubblegum/MPL deployment.

## Runtime safety additions in this checkout

- rewards `publish_epoch` takes `total_micro`, reserves it against the
  rewards-vault balance, and claims decrement `EpochState.remaining_micro` plus
  `Config.reserved`; reconciliation expects the new 77-byte epoch and 131-byte
  config layouts;
- the database-only V2 seal helper requires an explicit test capability and is
  not a production route; production sealing must use the finalized-RPC ceiling
  method with an operator-owned RPC snapshot/audit record;
- `/watchtower/readyz` returns HTTP 503 while blocked and 200 only after the
  strict gate passes.

## Boot/unpause order

1. Deploy and verify all four program IDs and upgrade authority.
2. Initialize with the verified program-data authority; on-chain configs start
   paused and reward/payment mints reject non-revoked authorities.
3. Verify finalized RPC, manifest, classic SPL mint layout/decimals, treasury
   and vault state; configure authenticated Watchtower ingestion.
4. Only then explicitly unpause the required program and set
   `NEONRELAY_MONETIZATION_ENABLED=1` in the production environment.
5. Keep the external audit artifact and finalized verification output in release
   storage, not in the audited source tree.
