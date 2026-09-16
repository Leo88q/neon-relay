<!-- What is the motivation for the changes of this pull request? -->

## Checklist

- [ ] Tested the change in-game
- [ ] Provided screenshots if it is a visual change
- [ ] Tested in combination with possibly related configuration options
- [ ] Written a unit test (especially `src/base/`, `src/neonrelay/`, `backend/`) or added coverage to the integration test
- [ ] Considered possible null pointers and out of bounds array indexing
- [ ] Changed no physics that affect existing maps

### Neon Relay specific

- [ ] No user-facing DDNet / DDRaceNetwork / Teeworlds branding introduced (`scripts/check_branding.sh`)
- [ ] Upstream license and copyright notices are untouched (`license.txt`, `data/*/license.txt`)
- [ ] New or changed assets have an entry in `docs/ASSET_MANIFEST.csv` (`scripts/check_assets.sh`)
- [ ] No private key, seed phrase, treasury key or production mint address added (`scripts/check_secrets.sh`)
- [ ] Reward logic is server-authoritative — no reward decision derived from client input alone (`docs/REWARD_SECURITY.md`)
- [ ] Reward writes are idempotent (ledger key `hash(match_id + player_id + reward_epoch + event_type)`)
- [ ] Wallet flows handle cancel / no-wallet / wrong-network / session-expired states
- [ ] `docs/KNOWN_LIMITATIONS.md` updated if a limitation was added or removed

### Toolchain note

The full build needs Rust/Cargo, SQLite3, libcurl, OpenSSL, SDL2 and friends. If you only
have a plain C++ toolchain, run `scripts/local_syntax_probe.sh` — it regenerates the
protocol sources and syntax-checks the server-side translation units.

<!-- If you used AI assistance, describe it briefly (1–2 sentences) and confirm you reviewed every line. -->
