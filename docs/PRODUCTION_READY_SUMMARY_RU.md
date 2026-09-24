# Neon Relay — текущий production-gate статус

**Ветка:** `arena/01a0d009-neon-relay`
**Дата статуса:** 24 сентября 2026
**Статус:** source-level remediation выполнена; production deploy не подтверждён.

Этот документ не является внешним audit report, live deployment evidence или
custody approval. В репозитории нет production keys, transaction IDs и live
RPC evidence.

## Что исправлено в исходниках

- bootstrap authority всех четырёх Anchor-программ проверяется через
  upgradeable-loader `ProgramData`; конфигурации стартуют paused;
- rewards/economy защищены от mint substitution, PermanentDelegate/freeze
  рисков, повторной публикации и double claim; rewards `publish_epoch` теперь
  резервирует объявленный `total_micro` агрегированно, а claims уменьшают
  epoch/config ceiling атомарно;
- prize publication резервирует средства агрегированно; claim уменьшает
  reservation; добавлены authority-only time-gated sweep для истёкших эпох и
  атомарный `refund_entry_v2` для отменённых билетов с точным возвратом
  rake/prize из проверенных vault/treasury;
- v2 economy изолирует рынки по mint, ограничивает paid intents на
  player/epoch и делает операции idempotent;
- assets проверяет features achievement registry PDA и bitmap proof;
  classic SPL badge fallback остаётся bounded; Bubblegum/MPL Core CPI
  compile-time disabled до отдельного ABI/account-meta review;
- deployment/source-ID drift проверяется между Anchor, Rust, TS, env и
  manifest;
- Watchtower ingestion получает constant-time bearer authentication при
  настроенном токене, а production без credential блокируется;
- `/watchtower/readyz`, paid admission и production claim confirmation
  требуют strict manifest/RPC/program/mint/authority verification;
- claim confirmation в production принимает только finalized успешный
  transaction с правильной rewards instruction, intent, PDA, wallet и mint;
- добавлены production mint boot gates, HTTPS RPC/cluster requirements и
  monetization gate;
- backup restore выполняет checksum/integrity verification, atomic same-dir
  replacement, fsync, sidecar retention и rollback; API restore только
  проверяет snapshot и не заменяет работающую БД;
- добавлен anti-sybil partial unique index для одного активного wallet на
  player identity;
- release/deploy gates проверяют type/build/audit evidence и не позволяют
  считать `SOURCE_ONLY=1` production approval.

## Что проверено локально

Последний локальный прогон должен заново фиксировать актуальный digest после
каждой правки:

```bash
cd backend && npm test
cd ../onchain && npm test
cd .. && SOURCE_ONLY=1 onchain/scripts/release_validate.sh
```

`npm test` backend и on-chain TypeScript suite выполняются в sandbox; настоящий
`tsc` и Rust/Anchor build требуют внешнего toolchain. Static audit создаётся во
временный каталог, а внешний report обязан находиться вне checkout.

## Оставшиеся обязательные gates

1. В подключённом CI/операционной среде завершить locked Anchor/Rust migration:
   source manifests уже на 0.31.1, но нужно обновить `Cargo.lock` и выполнить
   `cargo test --workspace --locked`.
2. Выполнить `cargo test --workspace --locked`, `cargo audit`, `clippy`,
   `anchor build --verifiable`, `anchor test` и validator integration tests.
3. Для Bubblegum/MPL Core отдельно зафиксировать upstream ABI/account metas и
   провести validator/CPI tests; до этого внешний asset CPI не включать.
4. Заполнить внешний deployment manifest реальными program IDs, genesis hash,
   reward/payment mints и concrete Squads authority либо согласованной
   immutable policy.
5. Выполнить finalized read-only RPC verification программ, ProgramData,
   upgrade authority, mint owner/layout/decimals, treasury и vault.
6. Провести authority bootstrap, funding, pause/unpause и custody approval с
   production key management вне этого checkout.
7. Передать внешний audit report через `AUDIT_REPORT_PATH`; drift check
   сравнивает его `source_digest` и scope с текущими исходниками.
8. Только после этого запускать live deploy с явным
   `ALLOW_LIVE_DEPLOY=1` и отдельными operator/mainnet confirmations.

Пока пункты выше не выполнены, проект нельзя называть подтверждённым
production-deployed или production-ready в смысле live/custody verification.
