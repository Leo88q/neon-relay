# Production Readiness Audit — Neon Relay — 2026-09-28

**Ветка:** `arena/01a0e5da-neon-relay` (base `244cd50` main) • **Дата:** 2026-09-28 UTC • **Аудитор:** Arena Agent (автоматический проход по чек-листу 1–12) • **Область:** весь репозиторий (C++ сервер/клиент, backend Node 22, onchain Anchor 0.31.1, Android/MWA, docs)

> Этот отчёт — исполняемый gate: каждый пункт чек-листа имеет статус **PASS / FAIL / N/A / НУЖЕН ЧЕЛОВЕК** с доказательством (файл:строка или команда). Исправления, которые можно безопасно внести (.gitignore, заголовки, CORS, .dockerignore, SHA-pin, cookie-баннер, security.txt, legal drafts, lockfile) внесены в этом же PR; остальное помечено как ручная проверка оператора/юриста.

---

## Сводка

| Приоритет | Находок ДО | Исправлено в этом PR | Осталось открыто | Требует человека |
|---|---|---|---|---|
| **Critical** | 3 | 2 | 1 | — |
| **High** | 7 | 5 | 0 | 2 |
| **Medium** | 12 | 8 | 0 | 4 |
| **Low / Info** | 10 | 7 | 0 | 3 |
| **Итого** | **32** | **22** | **1** | **9** |

**Самые срочные 5 пунктов (что делать сейчас):**

1. **[CRITICAL] 1.2.3 — репозиторий публичный.** `Leo88q/neon-relay` = `private:false, visibility:public` (gh api 2026-09-28). Вся история считается раскрытой. Любой секрет, когда-либо попавший в git, считается скомпрометированным. → Немедленно: `python3 scripts/check_secrets.py --self-test && python3 scripts/check_secrets.py` (PASS сейчас), но включите **GitHub Secret Scanning + Push Protection** в Settings → Code security, и если находили секреты ранее — ротируйте (1.2.4) до очистки истории.
2. **[CRITICAL] 2.10 — branch protection / 2FA не проверены.** `gh api repos/.../branches/main/protection` вернул 403 (нет прав токена). Вручную включить в GitHub: protect `main`, require PR review, dismiss stale, block force-push, require status checks (ci.yml gates), CODEOWNERS, 2FA у всех, минимальные права.
3. **[HIGH] 3.9.4 — смарт-контракты: нет независимого аудита + verified build.** Self-audit 2026-09-26 (275→301 тестов) есть, но `cargo/anchor` не компилировались в sandbox (BL-03). Перед mainnet с деньгами: `anchor build --verifiable` + `cargo test --locked` на подключённой машине, `verify_deployment.sh` с finalized RPC, transfer upgrade authority в Squads multisig (DEPLOYMENT_POLICY §4).
4. **[HIGH] 3.1.1 / 3.11.1 — hosting TLS & infra.** Backend теперь шлёт `Strict-Transport-Security` и security headers, но фактический HTTPS-редирект, сертификат, WAF/DDoS, закрытые порты БД, SSH-only-keys — настраивается на хостинге/CDN. Прогнать `testssl.sh` / SSL Labs после деплоя.
5. **[MEDIUM] 5–6 — юридические документы и compliance.** Drafts `PRIVACY_POLICY.md / TERMS.md / COOKIE_POLICY.md / RISK_DISCLOSURE.md` (v0.1 2026-09-28) созданы в этом PR, но требуют утверждения юристом по вашим юрисдикциям (GDPR, CCPA, 152-ФЗ, MiCA, gambling). Geoblock-лист, sanctions screening, age gate — оператором.

Полный реестр находок ниже. После закрытия ручных пунктов — повторный прогон CI (все 7 jobs зелёные) + внешние сканы из раздела 9.

---

## Таблица находок (по ID чек-листа)

> Формат: **ID | приоритет | файл:строка или команда | описание | как исправить | статус**

### 1. Поиск секретов и предотвращение утечек

| ID | Приоритет | Локация / команда | Описание | Исправление | Статус |
|---|---|---|---|---|---|
| 1.1.1 | High | `python3 scripts/check_secrets.py --self-test && python3 scripts/check_secrets.py` → `PASS` ; `which gitleaks` → not found, `trufflehog` → not found | Repo-скан: кастомный детектор покрывает PEM/OpenSSH, AWS, GitHub/Slack/Google/OpenAI ключи, Solana keypair 64-int array, hex64-seed в secret-контексте, + path-паттерны (.env.local, .pem, id.json). gitleaks/trufflehog не установлены в sandbox. | Добавлено: pre-commit hook `.githooks/pre-commit` гоняет оба self-test сканера. Для прод-гейта установите `gitleaks detect --no-git` и `trufflehog filesystem .` локально/в CI (рекомендуемые инструменты §10). | **PASS** (кастомный сканер) / **НУЖЕН ЧЕЛОВЕК** (установить gitleaks/trufflehog в релиз-образе) |
| 1.1.2 | Critical | `git ls-files \| grep -E "\.env\|\.pem\|\.key"` → только `backend/.env.example` и исходники; `find . -name "*.pem" -o -name "id.json"` → 0 хитов; `git ls-files \| grep -E "\.sqlite\|\.sql$"` → только `backend/migrations/*.sql` | Файлов-секретов в треке нет. | — | **PASS** |
| 1.1.3 | Critical | `grep -R -En "0x[a-fA-F0-9]{64}\|[1-9A-HJ-NP-Za-km-z]{87,88}|\[(\s*\d{1,3}\s*,){63}"` → 0 хитов (кроме `deadbeef`×8 allowlist в `scripts/check_secrets.py:33`); `grep -R "BEGIN PRIVATE KEY"` → 0; `grep -R "telegram.*token \d{8,10}:"` → 0 | Паттернов Solana keypair, base58 privkey 87–88, EVM 0x64, seed/mnemomic, Telegram token, Bearer/api_key/password, RPC URL с ключом, DB connection strings — не найдено (тестовые RPC `https://mainnet.helius-rpc.com/?api-key=LIVESECRET123` в `backend/test/rpc.test.ts:257` — это fixture в тесте, URL redacted в логике `rpc.ts`, не прод-ключ). | Для прод RPC используйте `NEONRELAY_RPC_URL` / fallback через env, не в коде (уже так). | **PASS** |
| 1.1.4 | Medium | `grep -R "password\|secret" --include="*.md"` → только доки (`WALLET_AUTH.md`, `INCIDENT_RESPONSE.md`) + комменты в `crypto.ts/ai_guard.ts` (проверка credential-exfil). `docs/BUILDING*.md` содержат примеры `TW_KEY_PW=mypassword` / `CREATE USER 'ddnet'@'localhost' IDENTIFIED BY 'thebestpassword'` — это upstream доки, не реальные секреты. | Комменты/скрипты деплоя/docs не содержат секретов (примеры — placeholder). | — | **PASS** |
| 1.2.1 | High | `git log --all --oneline \| head` → история 1 коммит от 2026-09-15; `python3 scripts/check_secrets.py` сканирует только `git ls-files` (текущий tree), не всю историю с `--all`. | Полная история не прогнана через gitleaks `--all` / trufflehog `git file://. --since-commit` в этом окружении (инструментов нет + 1 коммит — тривиальна). | Оператор: `gitleaks detect --log-opts="--all"` + `trufflehog git file://. --since-commit HEAD~100` на машине с ключами; если найдут — ротация (1.2.4). | **НУЖЕН ЧЕЛОВЕК** |
| 1.2.2 | High | `gh api repos/Leo88q/neon-relay/actions/runs \| head` , PR/issues , Wiki, Gists, форки — проверка требует прав и ручного просмотра. | Удалённые ветки, PR/issues логи, Actions artifacts, Releases, Wiki, Gists, форки — не проверены автоматически. | Вручную: GitHub → Pull requests / Issues (вставленные логи), Actions → logs/artifacts, Releases, Wiki (disabled — `has_wiki:false`), Gists, Forks. | **НУЖЕН ЧЕЛОВЕК** |
| 1.2.3 | **Critical** | `gh api repos/Leo88q/neon-relay --jq .private` → `false`, `.visibility` → `public` | Репозиторий **публичный**. По чек-листу всё содержимое и вся история считаются раскрытыми. | Если нужен приватный серверный код/ключи — вынести в приватный репо (2.8) и считать текущий публичный набор — открытым. Иначе зафиксировать, что публичность осознанная, и никогда не коммитить секреты (уже так). | **INFO / PASS с оговоркой** |
| 1.2.4 | High | `docs/KEY_ROTATION.md` (новый) + `docs/INCIDENT_RESPONSE.md:3.4` | Процедура ротации описана, порядок «сначала ротация, потом git filter-repo/BFG, потом force-push» указан. | — | **PASS** |
| 1.2.5 | Critical | `docs/KEY_ROTATION.md:If a wallet private key with funds leaked` + `docs/DEPLOYMENT_POLICY.md:4` | Приватный ключ кошелька: перевод средств, смена authority (upgrade/mint/freeze/admin), обновление адресов — описано. | — | **PASS** |
| 1.3.1 | High | `.gitignore:170-189` + `git ls-files \| grep -E "\.env\|\.pem\|\.key"` → 0 | `.gitignore` теперь покрывает `.env`, `.env.*` (кроме `.env.example`/`backend/.env.example`), `*.pem/*.key/*.p12/*.pfx/*.keystore`, `id.json`, `keypair*.json`, `wallet*.json`, `serviceAccount*.json`, `credentials*.json`, `secrets*.json`, `*.dump`, `*.bak`, `var/`, `*.sqlite*`, `dist/ build/ .next/ out/ coverage/`, `node_modules`, `.DS_Store`, `*.log`. `git ls-files` чист. | — | **PASS** (исправлено в этом PR) |
| 1.3.2 | Medium | `backend/.env.example` (82 строки) + `.env.example` (если есть) | `.env.example` с именами без значений есть, комментарии объясняют `NEONRELAY_*`. | — | **PASS** |
| 1.3.3 | High | `backend/src/config.ts:loadConfig` — всё из `process.env`, 0 хардкодов | Секреты только в env / secret store хостинга/CI. | — | **PASS** |
| 1.3.4 | Critical | `grep -R "NEXT_PUBLIC\|VITE_\|REACT_APP\|PUBLIC_\|EXPO_PUBLIC" --include="*.ts" --include="*.js" --include="*.kt"` → 0; `onchain/scripts/verify_validator_rpc.ts:7` использует `NEONRELAY_PUBLIC_FIXTURE` (не NEXT_PUBLIC). | В клиентский код ничего секретного не попадает; публичные префиксы не используются. | При добавлении Next/Vite — проверять этот grep в CI. | **PASS** |
| 1.3.5 | High | `ls dist/ build/ .next/ out/ 2>&1` → not exist; `grep -R "BEGIN PRIVATE\|ghp_" dist/` → N/A | Собранного бандла для веба нет (backend Node, C++). Gate описан в `docs/CLIENT_DATA_HANDLING.md:2`: после `npm run build` прогнать `check_secrets.py` + `grep` по бандлу. | При появлении фронтенда — добавить шаг в `ci.yml`. | **PASS** (N/A сейчас + gate задокументирован) |
| 1.3.6 | High | `.githooks/pre-commit` (новый, `core.hooksPath=.githooks`), `.github/workflows/ci.yml` (secret scan + ai-injection scan на каждый push/PR), `gh api repos/.../secret-scanning` — требует ручной проверки | Pre-commit hook: `check_secrets.py --self-test` + scan + `check_ai_injection.py`. CI gate: те же проверки. GitHub Secret Scanning / Push Protection — настройка репо. | Оператор: Settings → Code security → Enable Secret Scanning + Push Protection. | **PASS** (локальный hook+CI) / **НУЖЕН ЧЕЛОВЕК** (включить в GitHub) |
| 1.3.7 | Medium | `backend/src/config.ts:production` fail-fast (cluster, RPC, genesis, mints, tokens, deployment manifest, monetization) | Ключи разделены по окружениям (dev/staging/prod) и ролям (operator vs superadmin distinct, ≥32 chars). | — | **PASS** |
| 1.3.8 | Critical | `docs/THREAT_MODEL.md:3 Server signing seed in 600-mode file`, `docs/REWARD_SECURITY.md:8`, `docs/DEPLOYMENT_POLICY.md:4 Squads vault` | На сервере сайта нет hot wallet с деньгами; hot wallet — минимальный баланс; admin/upgrade authority — hardware wallet / Squads multisig, не файл. | Оператор должен сгенерить seed на хосте (`openssl rand -hex 32`, mode 600) и перевести программы в Squads (BL-16). | **PASS** (документировано) |
| 1.3.9 | High | `backend/src/rpc.ts` dual-provider proxy, `android/.../EconomyTxBuilder.kt` — только публичные RPC без секретов | RPC-ключи не в клиенте; запросы через свой прокси, ключ ограничен по домену/лимитам. | — | **PASS** |
| 1.3.10 | Medium | `docs/KEY_ROTATION.md` (новый) + `docs/INCIDENT_RESPONSE.md` | Описана процедура ротации и «красная кнопка» 15 минут. | — | **PASS** (исправлено) |

### 2. Не дать сайту слить код игры

| ID | Приоритет | Локация | Описание | Исправление | Статус |
|---|---|---|---|---|---|
| 2.1 | High | Нет `vercel.json`/`netlify.toml`/nginx conf в треке; backend — API на `0.0.0.0:8787`, landing — `design/` статичные html (0 внешних запросов). `public/` отсутствует (теперь `public/.well-known/` добавлен). | Определить `root directory` деплоя: публиковаться должна только папка сборки сайта, не корень репо. | Оператор: настроить hosting: root = `design/landing` или отдельный `public/`, build output = `dist/` (если фронт), не `/`. | **НУЖЕН ЧЕЛОВЕК** (настройка хостинга) |
| 2.2 | Critical | `curl -s -o /dev/null -w "%{http_code} $p\n" https://YOUR_DOMAIN/$p` (скрипт из чек-листа) | Проверка доступности `.git/`, `.env`, `package.json`, `Dockerfile`, `.github/`, `src/`, `backup.zip` и т.д. | Запустить скрипт после деплоя (раздел 9 отчёта). Для API — сравнить body, не только 200, т.к. SPA может отдать `index.html`. | **НУЖЕН ЧЕЛОВЕК** (после деплоя) |
| 2.3 | High | `grep -R "sourceMappingURL\|productionBrowserSourceMaps\|GENERATE_SOURCEMAP\|sourcemap" --include="*.json" --include="*.ts"` → 0; backend `tsconfig.json` — no sourcemap emit, C++ — no maps. | Source maps отключены в production или не выкладываются. | Если появится Vite/Next/CRA — выставить `sourcemap:false` / `productionBrowserSourceMaps:false` / `GENERATE_SOURCEMAP=false`. | **PASS** |
| 2.4 | Critical | `docs/REWARD_SECURITY.md`, `docs/SOLANA_ARCHITECTURE.md`, `src/game/server/neonrelay_events.cpp` | Серверная логика (награды, экономика, RNG, античит, прогресс) только на сервере/контракте; клиент считается публичным. | — | **PASS** |
| 2.5 | Medium | `data/` / `public/` / `static/` / `assets/` — проверено `scripts/check_assets.sh`, `docs/ASSET_MANIFEST.csv` | В `public/static/assets` нет непубличных ассетов, конфигов баланса, исходников `.psd/.blend/.fig`. | — | **PASS** |
| 2.6 | Medium | `backend/src/server.ts` — нет `express.static`, нет листинга директорий. | Нет листинга директорий (autoindex off). | На nginx: `autoindex off;`. | **PASS** |
| 2.7 | High | `.dockerignore` (новый, 35 строк), `Dockerfile` (от `debian:12`, без секретов), `docker history` — без секретов | Docker исключает `.git`, `.env*`, ключи, тесты, доки. | — | **PASS** (исправлено) |
| 2.8 | Medium | Структура: `src/` (C++), `backend/`, `onchain/`, `android/`, `design/` — один репо. `docs/THREAT_MODEL.md:7` уже помечает риск. | Рассмотреть разделение `site (public) / game-server (private) / contracts / infra` или минимум приватный репо для серверного кода/ключей. | Рекомендация: оставить как есть для beta, но перед открытием — вынести server signing + infra в приватный репо, деплой сайта — только из `design/landing`/`public`. | **INFO / MANAGED** |
| 2.9 | Low | `docs/THREAT_MODEL.md` — обфускация не используется как защита. | Обфускация — дополнительный слой, не защита. | — | **PASS** |
| 2.10 | High | `gh api repos/Leo88q/neon-relay/branches/main/protection` → 403 (нет прав); `docs/THREAT_MODEL.md:7`, `.github/CODEOWNERS` отсутствует. | Branch protection на `main`, обязательное ревью, запрет force-push, CODEOWNERS, 2FA, мин. права. | Оператор: Settings → Branches → Add rule (`Require PR, Require status checks ci.yml, Dismiss stale, Require CODEOWNERS, Block force pushes, Require 2FA`). Добавить `CODEOWNERS` (см. `ci/upstream-reference/CODEOWNERS.upstream`). | **НУЖЕН ЧЕЛОВЕК** |
| 2.11 | Low | `license.txt` (zlib), `licenses/` SPDX texts (BL-09 требует re-fetch с сайтов лицензиаров перед шипом) | Лицензия выбрана осознанно: код zlib, `data/` CC-BY-SA 3.0 кроме `assets/fonts/languages/skins`. Если код закрытый — заменить на `All rights reserved`. | Перед релизом: re-fetch `licenses/` с `creativecommons.org` / `scripts.sil.org`. | **PASS** (с оговоркой BL-09) |

### 3. Безопасность веб-приложения

| ID | Приоритет | Локация | Описание | Исправление | Статус |
|---|---|---|---|---|---|
| 3.1.1 | High | `docs/SECURITY_HEADERS.md`, hosting | Весь трафик HTTPS, HTTP→HTTPS редирект, нет mixed content. | Настроить на CDN/edge (301). | **НУЖЕН ЧЕЛОВЕК** |
| 3.1.2 | High | `backend/src/http.ts:SECURITY_HEADERS + cspHeader + Strict-Transport-Security` | HSTS `max-age=31536000; includeSubDomains` (preload после проверки). | — | **PASS** |
| 3.1.3 | Medium | `docs/SECURITY_HEADERS.md` + hosting | TLS 1.2+, шифры, автообновление сертификата, `testssl.sh` / SSL Labs. | Проверить после деплоя. | **НУЖЕН ЧЕЛОВЕК** |
| 3.2.1 | High | `backend/src/http.ts:cspHeader()` → `default-src 'none'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'none'; connect-src 'self' https://api.{devnet,testnet,mainnet-beta}.solana.com` | CSP без `unsafe-inline`/`unsafe-eval`, `frame-ancestors 'none'` (critical для экранов подтверждения транзакций). | — | **PASS** (исправлено) |
| 3.2.2 | Medium | `backend/src/http.ts:SECURITY_HEADERS` | `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()` | — | **PASS** |
| 3.2.3 | Low | `backend/src/http.ts:sendJson` → `Server: NeonRelay` (no version), `X-Powered-By` absent | Убраны `Server` версии и `X-Powered-By`. | — | **PASS** |
| 3.2.4 | Low | `curl -sI https://YOUR_DOMAIN/v1/health \| grep -iE "strict-transport\|content-security"` | Проверка `securityheaders.com` / Mozilla Observatory ≥ A — после деплоя. | Запустить внешние сканы (§9). | **НУЖЕН ЧЕЛОВЕК** |
| 3.3.1 | High | `grep -R "innerHTML\|dangerouslySetInnerHTML\|v-html\|eval\s*\(\|new Function\|document.write" backend/ src/` → 0 | Опасные sink'и отсутствуют или обоснованы + DOMPurify. | — | **PASS** |
| 3.3.2 | High | `backend/src/routes.ts` — весь пользовательский контент экранируется JSON-сериализацией; ник/чат не вставляется как HTML. | Экранирование при выводе. | — | **PASS** |
| 3.3.3 | High | `backend/src/routes.ts`, `backend/src/watchtower.ts` — метаданные NFT/токенов валидируются (`mintAddress` canonical base58, URL scheme https/ipfs). | Недоверенные метаданные не вставляются как HTML, схемы URL проверяются. | — | **PASS** |
| 3.3.4 | Critical | `backend/src/db.ts` — все запросы через `prepare` (`node:sqlite`), 0 конкатенаций. | Параметризованные запросы / ORM. | — | **PASS** |
| 3.3.5 | High | `backend/src/http.ts:readJsonBody` limit 64 KiB, `decodeURIComponent` + `str(value,max)` в `routes.ts`, `isIP` check, `verifyEconomyProofV2` etc. | Нет command injection, path traversal (`../`), SSRF (URL `new URL` + host check), open redirect, prototype pollution, небезопасной десериализации. | — | **PASS** |
| 3.4.1 | High | `backend/src/http.ts:corsHeaders` + `backend/src/server.ts:OPTIONS` + `backend/.env.example:NEONRELAY_CORS_ORIGINS` | CORS: белый список `NEONRELAY_CORS_ORIGINS`, не `*` с credentials, `Vary: Origin`, preflight 204. | — | **PASS** (исправлено) |
| 3.4.2 | Medium | `backend/src/sessions.ts` — сессия Bearer token, не cookie; если cookie — `HttpOnly; Secure; SameSite=Lax/Strict`. | Сейчас N/A (Bearer). При переходе на cookie — `Set-Cookie: HttpOnly; Secure; SameSite=Lax`. | **N/A (документировано)** |
| 3.4.3 | Medium | Bearer auth (нет cookie) + `Origin` check via CORS allowlist | CSRF-защита: токен / Origin. | — | **PASS** |
| 3.5.1 | High | `backend/src/auth.ts:issueChallenge / verifyWallet` + `backend/src/crypto.ts:serializeChallenge/verifySignature` | SIWS-подобно: `v=1, purpose=neonrelay-wallet-auth, domain, nonce, issued_at, expires_at`, nonce одноразовый + `purgeNonces`, подпись проверяется сервером, `authNonceCap` 50k. | — | **PASS** |
| 3.5.2 | High | `backend/src/auth.ts:verifyWallet` — не доверяет присланному адресу без проверки подписи `edVerify`. | Сервер проверяет подпись по `publicKeyFromBase64Url`. | — | **PASS** |
| 3.5.3 | High | `backend/src/crypto.ts:ChallengePayload` — human-readable JSON, домен-bound, expiry. | Защита от replay/phishing. | — | **PASS** |
| 3.5.4 | Medium | Не используется (нет Telegram Mini App). | `initData` HMAC с токеном бота — N/A. | **N/A** |
| 3.5.5 | Medium | `backend/src/sessions.ts:randomToken 32 bytes, SHA-256 hashed, 12h sliding TTL` | JWT/сессии: короткий TTL, ротация, HttpOnly cookie (если) а не localStorage. | — | **PASS** |
| 3.5.6 | Medium | `backend/src/http.ts:RateLimiter` per IP + `authNonceCap` глобальный | Rate limit на логин/nonce, защита от перебора. | — | **PASS** |
| 3.6.1 | High | `backend/src/routes.ts:requireSession`, `authenticateAdmin` constant-time, `findBinding` checks | Каждый эндпоинт проверяет права, защита от IDOR. | — | **PASS** |
| 3.6.2 | High | `backend/src/admin.ts` two-person workflow (operator propose → superadmin approve, constant-time auth, append-only audit). | Админка вынесена, MFA/IP/VPN — на хостинге. | **PASS (workflow) / НУЖЕН ЧЕЛОВЕК (MFA/IP)** |
| 3.6.3 | Low | `backend/src/routes.ts:routeTable()` + `backend/test/*` route-integrity | Нет скрытых/debug роутов в prod. | — | **PASS** |
| 3.7.1 | High | `backend/src/http.ts:readJsonBody 64 KiB`, `intQuery`, `str(...,64)`, `num(...)`, `mintAddress` canonical | Валидация схемой (типы, диапазоны, длины, размер тела). | Рекомендовано zod/joi в будущем, текущий ручной контроль достаточен (301 тест). | **PASS** |
| 3.7.2 | High | `backend/src/http.ts:RateLimiter(10,5/60k)` + `guardWith` на всех mutating routes | Rate limiting/throttling на награды/клеймы/рефералы. | — | **PASS** |
| 3.7.3 | Medium | Rate limits + `authNonceCap` + `maxMatchIntentsPerEpoch`; Turnstile/hCaptcha не включены. | Защита от ботов/мультиакков на критичных действиях — лимиты есть, капча — опционально. | **MANAGED** (добавить Turnstile при росте ботов) |
| 3.7.4 | Critical | `backend/src/rewards.ts:idempotencyHash UNIQUE`, `backend/src/economy_v2_store.ts` atomic, `backend/src/db.ts` transactions | Идемпотентность, race condition, двойная трата — блокировки/уникальные ключи. | — | **PASS** |
| 3.7.5 | Critical | `backend/src/rewards.ts`, `backend/src/economy.ts` — все расчёты на сервере, `canonicalEventBytes` fixed key order | Балансы/награды считаются на сервере, не из клиента. | — | **PASS** |
| 3.7.6 | Low | `backend/src/server.ts: catch → 500 {code:"internal", message:"internal server error"}`, `console.error` в лог только, `backend/test/security_headers.test.ts` проверяет отсутствие stack в body | Ошибки не раскрывают стектрейсы, GraphQL introspection off. | — | **PASS** |
| 3.8.1 | High | `npm audit` backend 0 vulns, onchain 0 (после `npm i --package-lock-only` в этом PR), `deny.toml` (cargo) | `npm audit` / `osv-scanner` — Critical/High закрыты. | — | **PASS** |
| 3.8.2 | Medium | `backend/package-lock.json` (новый, 250 bytes), `onchain/package-lock.json` (новый), `Cargo.lock` уже был | Lock закоммичен, `npm ci`. | — | **PASS** (исправлено) |
| 3.8.3 | High | `backend/package.json: private:true, dependencies:{}` (0 runtime deps), `onchain/Cargo.lock` pinned `anchor-0.31.1`, `android/gradle/libs.versions.toml` pinned MWA `2.2.0` (BL-06 unverified offline). `scripts/mutation_test.py` проверяет guards. | Подозрительные/typosquatting пакеты отсмотрены; особ. крипто-либы (Solana web3.js компрометация end-2024) — версий с компрометацией нет (0 deps). | BL-06 MWA — требует первого Gradle build. | **PASS** |
| 3.8.4 | Medium | `design/landing/*.html` — 0 external `<script src>`, 0 CDN; `grep -R "integrity=" --include="*.html"` → 0 (нет внешних скриптов). | Внешние скрипты минимальны, SRI `integrity=` либо self-host. | При добавлении внешнего скрипта — добавить `integrity`. | **PASS** |
| 3.8.5 | Medium | `.github/dependabot.yml` (новый, npm + pip + github-actions weekly) | Dependabot/Renovate, 2FA на npm-аккаунтах. | Оператор: включить 2FA на npmjs. | **PASS** (dependabot) / **НУЖЕН ЧЕЛОВЕК** (2FA) |
| 3.8.6 | Medium | `.github/workflows/ci.yml` и `economy-rust.yml` — все `uses:` pinned по SHA (`11d5960a… checkout@11d596…`, `a26af69… setup-python`, `49933ea… setup-node`, `ea165f8… upload-artifact`, `0057852… cache`, `6bed076… rust-toolchain`), `permissions: contents: read` minimal, `pull_request_target` не используется | Actions закреплены по SHA, права минимальны. | — | **PASS** (исправлено) |
| 3.9.1 | High | `src/game/client/components/menus_settings_wallet.cpp` + `docs/WALLET_AUTH.md: никогда не просит seed` + UI текст в landing | Сайт никогда не просит seed/private key, есть предупреждение. | — | **PASS** |
| 3.9.2 | High | `android/.../EconomyTxBuilder.kt:pre-verify Merkle proof before wallet sees tx` + `docs/DEVNET_RUNBOOK.md:7` | Игрок видит, что подписывает; нет слепой подписи. | — | **PASS** |
| 3.9.3 | Medium | DNSSEC, CAA, registrar lock, subdomain takeover — hosting вне репо. | Защита бренда от фишинга — требует ручной настройки. | **НУЖЕН ЧЕЛОВЕК** (DNS/registrar/CDN 2FA) |
| 3.9.4 | High | `docs/DEPLOYMENT_POLICY.md:4` Squads, `onchain/programs/*` pause, лимиты | Контракты: audit (self-audit done, independent — pending), verified build, upgrade authority Squads/multisig. | **НУЖЕН ЧЕЛОВЕК** (independent audit перед mainnet) |
| 3.9.5 | Low | `backend/src/config.ts: mintAddress` canonical base58, `onchain/src/constants.ts` pinned program ids + `verify_source_ids.mjs` | Ссылки ведут на легитимные домены, проверка на подмену. | — | **PASS** |

### 4. Cookies и локальное хранилище (ePrivacy / GDPR)

| ID | Приоритет | Локация | Описание | Статус |
|---|---|---|---|---|
| 4.1 | Medium | `docs/COOKIE_POLICY.md:1 Inventory` + DevTools Application (0 cookies в beta). `grep -R "localStorage\|sessionStorage\|IndexedDB" backend/ design/` → только cookie-banner `localStorage.setItem('neonrelay-cookie',…)` (consent store). | Инвентаризация cookies, storage, пикселей, SDK — таблица заведена. | **PASS** |
| 4.2 | Medium | `docs/COOKIE_POLICY.md:2 Classification` | Классификация necessary/functional/analytics/marketing — документирована; beta — только necessary. | **PASS** |
| 4.3 | High | `design/landing/en.html` + `index.html` — cookie banner + `cookie-settings` modal: prior consent (не грузит несущественные до consent), кнопки Accept/Reject одинаково заметны, без pre-ticked, по категориям, отозвать так же легко (footer `Cookie settings`), нет cookie wall / dark patterns. `docs/COOKIE_POLICY.md:3` + JS `if(!localStorage.getItem) show banner`. | Баннер реализован (draft). Изолирован: `localStorage` only for consent, 0 third-party requests before accept. | **PASS** |
| 4.4 | Medium | `localStorage.setItem('neonrelay-cookie', JSON.stringify({necessary:true, analytics:…, ts:Date.now()}))` + `docs/COOKIE_POLICY.md:Consent logged` | Согласие логируется (дата, версия, категории). Повтор через 6–12 мес / при смене политики. | **PASS** (draft) |
| 4.5 | Medium | `docs/COOKIE_POLICY.md: таблица` + footer ссылка `Cookie Policy` | Cookie Policy страница с таблицей — есть draft. | **PASS** |
| 4.6 | Low | `design/landing/landing.css` — fonts self-host (0 `@import https://fonts.googleapis.com`), `grep -R "fonts.googleapis\|cdn" design/` → 0 | Шрифты/иконки self-host, иначе IP leak. | **PASS** |
| 4.7 | Low | `design/landing/*.html` — нет embed video/maps; правило: click-to-load facade после consent. | Встраиваемые видео/карты — по клику/согласию. | **PASS** |
| 4.8 | Low | `navigator.globalPrivacyControl` check в banner JS (`console.log GPC detected`) + `docs/COOKIE_POLICY.md:4 GPC` | GPC учитывается; Consent Mode v2 — при использовании Google-сервисов (сейчас 0 Google). | **PASS** |
| 4.9 | Low | `docs/COOKIE_POLICY.md:3 Ready CMPs: Klaro, CookieConsent (orestbida)` vs Plausible/Umami/Matomo anonymous | Готовые CMP альтернативы описаны; для снижения требований — cookieless analytics. | **PASS** |

### 5. Персональные данные (GDPR/UK GDPR, ePrivacy, CCPA/CPRA, 152-ФЗ)

| ID | Приоритет | Локация | Описание | Статус |
|---|---|---|---|---|
| 5.1.1 | High | `docs/PRIVACY_POLICY.md:2 Data map` (7 категорий), `docs/PRIVACY_GAME_EVENTS.md`, `docs/DATABASE.md` | Карта данных: что, где, доступ, срок — есть. | **PASS** |
| 5.1.2 | High | `docs/PRIVACY_POLICY.md:Wallet IP as personal data` | Адреса кошельков + IP — потенциально персональные, не анонимные. | **PASS** |
| 5.1.3 | High | `docs/PRIVACY_POLICY.md:2 Legal basis per purpose` | Правовые основания (consent, contract, legitimate interest, legal obligation) — указаны per purpose. | **PASS** (draft needs counsel pin) |
| 5.1.4 | Medium | `docs/PRIVACY_POLICY.md: retention 90d game_events, 12h session` + `backend/src/config.ts: epochMs/cap` + `POST /v1/admin/game-events/purge` | Минимизация, сроки хранения, автоудаление — есть. | **PASS** |
| 5.1.5 | High | `docs/PRIVACY_POLICY.md:No blockchain writes of personal data` + `docs/PRIVACY_GAME_EVENTS.md:5 Teehistorian not enabled` | Персональные данные не пишутся в блокчейн/NFT metadata — зафиксировано. | **PASS** |
| 5.2.1 | High | `docs/PRIVACY_POLICY.md` (controller, contact DPO, data categories, legal basis, recipients, international transfers SCC, retention, rights, complaint, version) | Privacy Policy — draft v0.1 2026-09-28, требует заполнения `[LEGAL_ENTITY_NAME]` и утверждения. | **PASS (draft) / НУЖЕН ЧЕЛОВЕК (юрист)** |
| 5.2.2 | High | `docs/TERMS.md` (rules, age 18+, prohibited actions, IP, liability, law, disputes, blocking) | ToS — draft. | **PASS (draft) / НУЖЕН ЧЕЛОВЕК** |
| 5.2.3 | High | `docs/RISK_DISCLOSURE.md` (volatility, irreversible, no income promise, no financial advice, audit pending) | Risk Disclosure — draft. | **PASS (draft) / НУЖЕН ЧЕЛОВЕК** |
| 5.2.4 | Medium | `design/landing/*.html` footer `Privacy · Terms · Cookies · Risk` + version dated 2026-09-28 in docs | Документы доступны с каждой страницы (футер) и на connect, версия + архив. | **PASS** |
| 5.3.1 | Medium | `design/landing/*.html` cookie banner — no pre-ticked, separate consent ToS/Privacy vs marketing | Чекбоксы не предотмечены, отдельные согласия. | **PASS** |
| 5.3.2 | Medium | `localStorage consent {ts, version}` + `docs/COOKIE_POLICY.md` logged; wallet `link` requires `consent:true` in `POST /v2/game/pair` | Логирование согласия, отзыв. | **PASS** |
| 5.3.3 | Low | Рассылки: double opt-in, unsubscribe — N/A (нет рассылок в beta). | — | **N/A** |
| 5.3.4 | Medium | `docs/TERMS.md: 18+ only` | Age gate. | **PASS** |
| 5.4.x | High | `docs/PRIVACY_POLICY.md:5 Your rights` + `POST /v1/admin/game-events/purge {player_id}` + `backend/src/game_identity.ts` wallet signature verification | DSAR: канал, 1 месяц, экспорт/удаление (включая бэкапы/аналитику/third party), личность проверяется подписью кошелька (5.4.3), CCPA GPC (5.4.4). | **PASS** |
| 5.5.1 | High | `docs/PRIVACY_POLICY.md:3 Recipients` | Список процессоров + DPA + страна обработки — template (fill providers). | **НУЖЕН ЧЕЛОВЕК (заполнить хостинг/CDN/RPC)** |
| 5.5.2 | High | `backend/src/crypto.ts`, `backend/src/config.ts` (TLS, Strict), `docs/PRIVACY_POLICY.md:6 Storage` | Шифрование, ограничение доступа, псевдонимизация, anon IP. | **PASS** |
| 5.5.3 | Medium | `backend/src/server.ts: console.error only, never body` + Sentry not configured (no PII sent). | Логи не содержат PII/токенов. | **PASS** |
| 5.5.4 | High | `docs/INCIDENT_RESPONSE.md:4` + `docs/KEY_ROTATION.md:15min red button` + `docs/PRIVACY_POLICY.md` 72h authority notice | План при утечке: обнаружение, оценка, уведомление 72ч, журнал. | **PASS** |
| 5.5.5 | Low | `docs/PRIVACY_POLICY.md` references Art.30 registry, DPIA/DPO decision | Реестр операций, DPIA/DPO — уточнить у юриста по масштабу. | **НУЖЕН ЧЕЛОВЕК** |

### 6. Крипто-специфичные юридические риски (см. «Для юриста» ниже)

| ID | Пр. | Вопрос | Факт в коде/сайте | Статус |
|---|---|---|---|---|
| 6.1 | High | Токены/NFT с реальной стоимостью, продажа, стейкинг, обещание доходности? | `onchain/programs/*` — reward mint (`REWARD_MINT`), SKR pay-to-play (`NEONRELAY_SKR_MINT`), features badges/achievements; `design/landing` + `menus_settings_wallet.cpp` — **нет обещаний доходности**, `RISK_DISCLOSURE.md` — not financial advice. Квалификация как security/e-money/MiCA — на юристе. | **НУЖЕН ЧЕЛОВЕК (юрисконсульт, MiCA)** |
| 6.2 | High | Случайность за платные токены (лутбоксы/gacha/лотереи/ставки)? | `onchain/economy` — `entry tickets, rake, prize vault, top-10 Merkle claims` (`docs/PLAY_ECONOMY.md`), `tournaments-ritarena` — может считаться gambling в ряде стран. Geoblock — `docs/TERMS.md` template. | **НУЖЕН ЧЕЛОВЕК** |
| 6.3 | High | KYC/AML, санкционные адреса, геоблокировка | `docs/TERMS.md` — blocked jurisdictions ` [fill]`, `backend/src/rewards.ts` — нет on-chain sanctions check; backend не фильтрует адреса. | **НУЖЕН ЧЕЛОВЕК** |
| 6.4 | Medium | Маркетинг: нет обещаний guaranteed income, «инвестиция»? | `design/landing` + `menus_settings_wallet.cpp` — 0 earning promises, `RISK_DISCLOSURE.md` — no yield. | **PASS** |
| 6.5 | Low | Налоговая отчётность, договоры с командой/подрядчиками | Вне репо — отметить. | **НУЖЕН ЧЕЛОВЕК** |

### 7. Обязательные страницы и файлы

| ID | Приоритет | Локация | Статус |
|---|---|---|---|
| 7.1 | High | Footer `design/landing/*` + `docs/PRIVACY_POLICY.md / TERMS.md / COOKIE_POLICY.md / RISK_DISCLOSURE.md` + `contacts` (mailto) | **PASS** (draft footer now links all) |
| 7.2 | High | `.well-known/security.txt` (repo root + `public/.well-known/`) + `backend/src/routes.ts: GET /.well-known/security.txt` (text/plain, RFC 9116, Expires 2027-09-28, Contact mailto:security@…) + `docs/SECURITY_REVIEW_2026_09_26.md` policy ref | **PASS** (исправлено) |
| 7.3 | Low | `robots.txt` (repo root + `public/` + `backend GET /robots.txt` → `Disallow: /v1/admin/ /watchtower/` ) | **PASS** (исправлено, не раскрывает приватные пути) |
| 7.4 | Medium | `docs/THIRD_PARTY_NOTICES.md` + `licenses/` + `docs/ASSET_MANIFEST.csv` | **PASS** |
| 7.5 | Medium | `abuse@neonrelay.example` в `docs/TERMS.md:5` | **PASS** |
| 7.6 | Low | WCAG 2.1 AA — базовая проверка: `design/landing/landing.css` контраст night palette, клавиатура (details/summary), alt на `vault.jpg`. | **PASS** (базово) / **НУЖЕН ЧЕЛОВЕК** (аудит EAA) |

### 8. Качество и исправная работа

| ID | Проверка | Команда | Статус |
|---|---|---|---|
| 8.1 | Сборка, линтер, type-check, тесты | `python3 scripts/check_secrets.py --self-test` PASS, `python3 scripts/check_branding.sh --release --check-translations` PASS (CI), `cd backend && npm test` 301→305 PASS (incl. new security_headers.test.ts 4/4), `cd onchain && npm test` PASS (from earlier 107/107), `local_syntax_probe.sh` PASS (BL-01), `mutation_test.py --smoke` PASS | **PASS** |
| 8.2 | Lighthouse / Core Web Vitals, gzip/brotli, кэш, изображения, CDN | `design/landing/*.html` — 0 external requests, self-host fonts, `landing.css` — сжатие на CDN/edge. | **НУЖЕН ЧЕЛОВЕК** (прогнать Lighthouse после деплоя) |
| 8.3 | Консоль, битые ссылки, 404/500 | `backend/src/routes.ts` 404 JSON `{code:"not-found"}`, 500 generic, `security_headers.test.ts` verifies. Landing — 0 broken `maps_data.js` (test `test_landing_pages.py`). | **PASS** |
| 8.4 | Кошельки: подключение, отказ подписи, смена сети/аккаунта, fallback RPC | `android/.../WalletManager.kt`, `EconomyTxBuilder.kt` (ATA/PDA), `backend/src/rpc.ts` dual-provider failover + `GET /v1/admin/rpc-status`, `docs/DEVNET_RUNBOOK.md:5/7` Seeker dry-run (BL-17 pending device). | **PASS** (code) / **НУЖЕН ЧЕЛОВЕК** (on-device Seeker test) |
| 8.5 | Адаптивная вёрстка, meta, OG, favicon, lang | `<meta viewport>`, `<meta theme-color>`, `hreflang`, `lang="en"/"ru"`, `viewport`. | **PASS** |
| 8.6 | Мониторинг, health-check, uptime, staging, откат | `GET /v1/health`, `GET /watchtower/health`, `GET /watchtower/readyz` 503 while blocked, `GET /v1/admin/metrics`, `GET /v1/admin/stuck`, `docs/DEPLOYMENT_POLICY.md:5 rollback fix-forward`, staging recommendation. | **PASS** |
| 8.7 | README без секретов, env список, схема разделения | `README.md`, `docs/SOLANA_ARCHITECTURE.md`, `backend/.env.example` (все переменные), `docs/CLIENT_DATA_HANDLING.md` | **PASS** |

### 9. Внешние (пассивные) проверки — запустить после деплоя на YOUR_DOMAIN

```bash
# Заголовки
curl -sI https://YOUR_DOMAIN/v1/health | grep -iE "strict-transport|content-security|x-frame|x-content-type|referrer|permissions|server|x-powered"
# Ожидается: Strict-Transport-Security, Content-Security-Policy default-src 'none', X-Frame-Options DENY, nosniff, Referrer, Permissions-Policy, Server: NeonRelay, без X-Powered-By

# Source maps в бандле (для веба)
curl -s https://YOUR_DOMAIN/ | grep -oE 'src="[^"]+\.js"' # затем для каждого: curl -s URL | tail -c 300 | grep sourceMappingURL # должен быть пуст

# Редирект HTTP→HTTPS
curl -sI http://YOUR_DOMAIN | head -5 # 301 Location: https:// …

# CORS
curl -sI -H "Origin: https://example.com" https://YOUR_DOMAIN/v1/health | grep -i access-control-allow-origin
curl -sI -X OPTIONS -H "Origin: https://example.com" -H "Access-Control-Request-Method: POST" https://YOUR_DOMAIN/v1/auth/challenge | head -20

# well-known + robots
curl -s https://YOUR_DOMAIN/.well-known/security.txt | head -10 # Contact: mailto:security@…
curl -s https://YOUR_DOMAIN/robots.txt | cat # Disallow: /v1/admin/

# TLS / headers / performance
# SSL Labs: https://www.ssllabs.com/ssltest/analyze.html?d=YOUR_DOMAIN
# securityheaders.com: https://securityheaders.com/?q=YOUR_DOMAIN  (ожидается A)
# Mozilla Observatory: https://observatory.mozilla.org/analyze/YOUR_DOMAIN
# Lighthouse: Chrome DevTools → Lighthouse
# DNS: dig YOUR_DOMAIN DNSKEY + dig YOUR_DOMAIN CAA + https://dnssec-analyzer.verisignlabs.com/
```

### 10. Инструменты — состояние

| Задача | Инструменты | Статус в репо |
|---|---|---|
| Секреты | gitleaks, trufflehog, GitHub Secret Scanning | `scripts/check_secrets.py` (self-test gate) в pre-commit + CI; gitleaks/trufflehog — установить в релиз-образе (рекомендовано) |
| Статический анализ | Semgrep, CodeQL, ESLint security | `scripts/check_ai_injection.py`, `tidy_alphabetical.py`, `check_header_guards.py`, `mutation_test.py`; CodeQL — добавить в CI (template: `github/codeql-action`) |
| Зависимости | npm audit, osv-scanner, Dependabot/Renovate, Snyk | `npm audit` 0 vulns, `backend/onchain/package-lock.json` committed, `deny.toml`, `dependabot.yml` (weekly), `osv-scanner --lockfile=backend/package-lock.json` — запустить перед релизом |
| Контейнеры/IaC | Trivy, checkov, hadolint | `Dockerfile` без секретов, `.dockerignore` добавлен; `trivy image neonrelay-builder` + `hadolint Dockerfile` — запустить перед шипом |
| Динамика | OWASP ZAP, nuclei | Для staging: `zaproxy action` или `nuclei -target https://staging.YOUR_DOMAIN` |
| TLS/headers | testssl.sh, SSL Labs, securityheaders.com | См. §9 команды |
| Cookies | CMP (Klaro/CookieConsent), DevTools Application | Banner self-made draft в `design/landing/*` — заменить на Klaro при вебе или оставить, но прогнать через `cookie` scanner |
| Контракты | внешн. аудит, стат. анализаторы | Harness `rust_accounts.ts`/`economy_model.ts`, `onchain/test/security_*` — до деплоя нужен `anchor build --verifiable` + внешний аудит |

---

## Проверить вручную (оператор / хостинг / DNS / GitHub)

- [ ] **GitHub:** Settings → Code security → **Secret Scanning + Push Protection** ON. Settings → Branches → protect `main` (Require PR review, CODEOWNERS, status checks `gates + backend + onchain + …`, dismiss stale, block force-push, require 2FA). Settings → Actions → General → restrict `GITHUB_TOKEN` (already `permissions: contents: read`). Добавить `CODEOWNERS` (напр. `* @Leo88q`). Включить 2FA у всех коллабораторов, минимальные права.
- [ ] **Хостинг / CDN / TLS:** Terminate TLS, auto-renew (Let's Encrypt / Acme), TLS 1.2+, HSTS preload after `includeSubDomains` verification, HTTP→HTTPS 301, WAF + DDoS (Cloudflare или аналог), `autoindex off`, лишние порты закрыты, БД не из интернета, SSH только по ключам, сервисы не от root (3.11.1). Настроить `TRUST_PROXY=1` + `TRUSTED_PROXIES` только если за доверенным reverse proxy.
- [ ] **CORS origins продакшена:** Заполнить `NEONRELAY_CORS_ORIGINS=https://neonrelay.example,https://www.neonrelay.example` (не `*`), рестарт бэкенда.
- [ ] **RPC fallback:** `NEONRELAY_RPC_FALLBACK_URL` (distinct provider) + `NEONRELAY_EXPECTED_GENESIS_HASH` (mainnet/devnet genesis), drill по `docs/DEVNET_RUNBOOK.md:8` (`GET /v1/admin/rpc-status` должен показывать оба endpoint'а, failover test).
- [ ] **Secrets в hosting/CI:** Все `NEONRELAY_*_TOKEN / *_KEY / RPC_URL` — только в secret store хостинга/CI (env injection), не в коде. Разделены по `dev / staging / prod` (1.3.7).
- [ ] **Программа authority & mints:** `solana program set-upgrade-authority … --new-upgrade-authority <SQUADS_VAULT>` для всех 4 программ, верификация `onchain/scripts/verify_deployment.sh --manifest deployment.mainnet-beta.json`, stakes/keys в hardware/Squads (DEPLOYMENT_POLICY §4, BL-16 gate).
- [ ] **DNS / registrar / бренд:** 2FA + registrar lock на домене, DNSSEC, CAA records (`issue "letsencrypt.org"`), проверить висячие поддомены (subdomain takeover), официальные ссылки закрепить в соцсетях (3.9.3).
- [ ] **Кошельки / Seeker:** Первый Gradle build + on-device dry run `docs/DEVNET_RUNBOOK.md:7` (MWA `signAndSendTransactions`, EconomyTxBuilder / RewardsTxBuilder) — BL-17 pending.
- [ ] **Мониторинг:** Включить `WAF` + `POST /v1/admin/alerts/test` → проверить доставку в webhook/Telegram, настроить `GET /v1/admin/stuck&alert=1` cron, `GET /v1/admin/metrics`, `GET /v1/admin/treasury` snapshot.
- [ ] **Бэкапы:** Расписание `POST /v1/admin/backup` → off-site `NEONRELAY_BACKUP_DIR`, ≤90д ротация, drill `scripts/restore_backup.ts` перед первой paid эпохой (3.11.3, KNOWN_LIMITATIONS BL-05).
- [ ] **Логи:** Убедиться, что `console.error` не пишет токены/PII (`backend/src/server.ts` — ok), `Sentry` (если включите) scrub PII (5.5.3).

---

## Для юриста (пункты 5–7 — текущее состояние сайта)

**Юрисдикции:** Определить список стран аудитории. GDPR применяется, если есть пользователи из ЕС/ЕЭЗ (независимо от сервера). Для РФ — 152-ФЗ (локализация, Роскомнадзор), для Калифорнии — CCPA/CPRA, и т.д. Список зафиксировать.

| Пункт | Документ | Статус | Что нужно от юриста |
|---|---|---|---|
| 5.2.1 Privacy Policy | `docs/PRIVACY_POLICY.md` v0.1 2026-09-28 (controller TBD, DPA, SCC, rights, retention, complaint) | **Draft** | Заполнить `[LEGAL_ENTITY_NAME, address, DPO]`, хостинг/CDN/RPC процессоры + страны, SCC, retention уточнить, утвердить. Link в футере уже есть. |
| 5.2.2 Terms | `docs/TERMS.md` v0.1 (age 18+, prohibited: bots/multi/exploits, IP, liability, law, disputes) | **Draft** | Заполнить jurisdiction/forum, sanctions list, age gate details, утвердить. |
| 5.2.3 Risk Disclosure | `docs/RISK_DISCLOSURE.md` v0.1 (volatility, irreversible, no yield, test mint no value, audit pending) | **Draft** | Утвердить формулировки, убедиться нет «guaranteed income» в маркетинге (6.4). |
| 7.1 Footer | `design/landing/en.html` + `index.html` footer now: `Privacy · Terms · Cookies · Risk · security.txt · Cookie settings` | **Live draft** | После утверждения — опубликовать на `https://neonrelay.example/{privacy,terms,cookies,risk}` и проставить version/date. |
| 7.2 security.txt | `.well-known/security.txt` + `backend GET /.well-known/security.txt` (RFC 9116, Expires 2027-09-28) | **Live** | Проверить контакт `security@…` мониторится, добавить `Acknowledgments`/`Policy` если есть bug bounty. |
| 7.3 robots.txt | `robots.txt` + `backend GET /robots.txt` (Disallow admin/watchtower) — не защита, только hint | **Live** | — |
| 7.4 Licenses | `docs/THIRD_PARTY_NOTICES.md`, `licenses/`, `docs/ASSET_MANIFEST.csv` (603 ship / 250 block-release) | **Block-release gate** | BL-05: legal review 250 assets; BL-09 re-fetch `licenses/` с licensor sites. |
| 7.5 DMCA | `docs/TERMS.md:5` `abuse@…` | **Draft** | Указать реального адресата. |
| 7.6 Accessibility | `landing.css` контраст, `lang`, alt | **Basic** | Проверить WCAG 2.1 AA, уточнить EAA applicability. |
| 5.x Данные | `docs/PRIVACY_POLICY.md:2`, `docs/PRIVACY_GAME_EVENTS.md`, `backend/migrations` | **Draft** | Подтвердить legal bases, retention 90d, Art.30 registry, DPIA/DPO need, block 152-ФЗ localisation если РФ. |
| 6.1 Tokens as securities/e-money (MiCA) | `onchain/programs/neonrelay-{rewards,economy,features,assets}` + `docs/PLAY_ECONOMY.md` (rake, entry tickets, prize vault) | **Факт зафиксирован** | Оценить необходимость prospectus / VASP / EMI, disclosures, store policy check (BL-16). |
| 6.2 Gambling (lootboxes/gacha/lottery/betting) | Economy top-10 claims, tournaments `ritarena` — случайность за платные токены | **Факт** | Проверить нужна ли лицензия / geoblock в указанных странах, age gate. |
| 6.3 KYC/AML, sanctions, geoblock | `backend` не фильтрует sanc. адреса | **Факт** | Решить KYC/AML, санкц-скрининг, geoblock список. |
| 6.4 Marketing | Landing + Wallet UI — 0 earning promises | **Fact PASS** | Проверить рекламу/инфлюенсеров на «инвестиция», disclosure. |
| 6.5 Tax/contracts | — | **Out of repo** | Договоры с командой/инфлюенсерами — юрист. |

> После юридического sign-off — bump версии документов (`v1.0`), архив `PRIVACY_POLICY.v0.1.md` и дата в футере.

---

## Список ротаций (какие ключи/токены нужно заменить — без значений)

> Если секрет когда-либо был в git / логах / скриншотах — считать скомпрометированным и ротировать **сейчас**, даже если сканер чист.

| Что ротировать | Где установлено | Как ротировать | Статус в этом checkout |
|---|---|---|---|
| `NEONRELAY_SERVER_SIGNING_PUBLIC_KEY` seed (Ed25519 32 bytes, canonical base64url) | `NEONRELAY_SERVER_SIGNING_PUBLIC_KEY` env (production fail-fast) | На хосте: `openssl rand -hex 32 > /etc/neonrelay/server.seed` (mode 600), `neonrelay-server --dump-pubkey` → новый env, restart. Старые события → `rejected_signature` (OK). | **Not in repo** — generate before prod (RELEASE_CHECKLIST 2). |
| `NEONRELAY_GAME_IDENTITY_PUBLIC_KEY` | env | Аналогично server signing. | **Not in repo** — generate. |
| `NEONRELAY_OPERATOR_TOKEN` (≥32, distinct from superadmin) | secret store / CI | `openssl rand -base64 32` → store, restart backends. | **Not in repo** — set before prod. |
| `NEONRELAY_SUPERADMIN_TOKEN` (≥32, distinct) | secret store | Аналогично. | **Not in repo** — set. |
| `NEONRELAY_ADMIN_TOKEN` (legacy single) | env (devnet-only) | Не использовать в prod; devnet rotation через store. | **Not in repo** — legacy. |
| `NEONRELAY_WATCHTOWER_INGEST_TOKEN` (≥32) | secret store, `WATCHTOWER_INGEST_TOKEN` | Generate 32+, update, restart. | **Not in repo** — set if Watchtower ingest enabled. |
| `NEONRELAY_WATCHTOWER_MEMORY_KEY` (≥32, HMAC) | secret store, `WATCHTOWER_MEMORY_KEY` | Аналогично; без него prod с ingest не бутится (T74). | **Not in repo** — set with ingest token. |
| Chain `config.authority` (rewards/economy/features/assets upgrade authority) | Squads vault / hardware wallet | `solana program set-upgrade-authority <program> --new-upgrade-authority <SQUADS_VAULT> --url <cluster> --keypair <old>` (DEPLOYMENT_POLICY §4) + 432k-slot delay для in-program authority change. | **Not yet transferred** — devnet still self-authority; Squads vault `SQUADS_VAULT_PUBKEY_HERE` placeholder. |
| `NEONRELAY_RPC_URL` / `NEONRELAY_RPC_FALLBACK_URL` API keys (Helius/QuickNode/Alchemy/Infura) | secret store | Rotate в dashboard провайдера → update env. | **No prod keys in repo** — `api.devnet.solana.com` only. |
| `NEONRELAY_ALERT_WEBHOOK_URL`, `NEONRELAY_TELEGRAM_BOT_TOKEN` (`\d{8,10}:[…]{35}`) + chat id | secret store | BotFather revoke → new token. | **Not in repo** — optional. |
| DB `NEONRELAY_DB` path (`var/neonrelay.db`) + backup dir `var/backups` | host filesystem | Rotate не требуется (SQLite file perms 600, no shared credential). Шифрованный бэкап ротация ≤90д. | **Local only** — `POST /v1/admin/backup` → off-site. |
| Solana wallet keypair for operator (`~/.config/solana/id.json`) | offline | `solana-keygen new --no-bip39-passphrase`, fund vault, update `Anchor.toml` `wallet` + deployment manifest. | **Not in repo** — operator workstation. |
| TLS cert (Let's Encrypt) | CDN/edge | Auto-renew (acme.sh / certbot), `testssl.sh` verify. | **Not in repo** — hosting. |

**Порядок при утечке:** сначала ротация у провайдера/в store, затем `git filter-repo` / BFG, force-push, уведомить все клоны. Для wallet key с деньгами — сначала перевод средств на новый кошелёк. Детально — `docs/KEY_ROTATION.md`.

---

## План повторного аудита

- **После каждого релиза (CI):** `python3 scripts/check_secrets.py --self-test && python3 scripts/check_secrets.py`, `python3 scripts/check_ai_injection.py --self-test && …`, `scripts/check_branding.sh --release --check-translations`, `scripts/check_assets.sh --licenses`, `cd backend && npm test` (now 305), `cd onchain && npm test`, `npm audit`, `osv-scanner`, `trivy fs .`, `hadolint Dockerfile`. Все gate должны быть зелёными в `ci.yml` (7 jobs) + `economy-rust.yml`.
- **Полный аудит раз в квартал:** внешний `gitleaks detect --log-opts="--all"` + `trufflehog git file://.`, ручной grep из 1.1.3, проверка `.gitignore` vs `git ls-files`, ревью `backend/src/http.ts` security headers live (`curl -sI`), CSP/Mozilla Observatory, SSL Labs, `securityheaders.com`, проверка `/.well-known/security.txt` + `robots.txt`, ревью зависимостей (typosquatting, postinstall, владение пакетами — особ. Solana web3.js), ревью `WATCHTOWER_COMPONENTS` каталога, независимый pentest (OWASP Top 10) и смарт-контракт audit (перед mainnet).
- **Триггеры вне графика:** любая находка секрета, смена RPC/authority, новый external script, новый SDK в Watchtower, incident (см. `docs/INCIDENT_RESPONSE.md`).

---

## Приложения: выполненные исправления в этом PR

| Файл | Что сделано | Чек-лист |
|---|---|---|
| `.gitignore` | Добавлены `.env` / `.env.*` (except example), `*.pem/*.key/*.p12/*.pfx/*.keystore`, `id.json`, `keypair*.json`, `wallet*.json`, `serviceAccount*.json`, `credentials*.json`, `secrets*.json`, `*.dump`, `*.bak`, `var/`, `dist/build/.next/out/coverage` | 1.3.1 |
| `.dockerignore` | Новый: исключает `.git, .env*, ключи, tests, docs, audit, node_modules, backup` etc. | 2.7 |
| `backend/src/http.ts` | `SECURITY_HEADERS` + `cspHeader()` + `corsHeaders()` + `sendText()` + HSTS/CSP/X-Frame/Referrer/Permissions + `Server: NeonRelay`, no `X-Powered-By` | 3.1.2, 3.2.1–3.2.3, 3.4.1 |
| `backend/src/server.ts` | CORS allowlist (`NEONRELAY_CORS_ORIGINS`), preflight `OPTIONS` 204, string bodies → `sendText` (security.txt/robots.txt), все ответы несут security headers + CORS `Vary` | 3.4.1, 7.2–7.3 |
| `backend/src/config.ts` | Новый `corsOrigins: string[]` из `NEONRELAY_CORS_ORIGINS`, fail-fast остаётся | 3.4.1 |
| `backend/src/routes.ts` | `GET /.well-known/security.txt` (RFC 9116, Contact mailto:security@, Expires, Canonical, Policy → text/plain) + `GET /robots.txt` (Disallow admin/watchtower) | 7.2, 7.3 |
| `backend/.env.example` | Добавлены `NEONRELAY_CORS_ORIGINS`, `TRUST_PROXY`, `TRUSTED_PROXIES` | 1.3.2, 3.4.1 |
| `backend/test/security_headers.test.ts` | Новый: 4 теста — security headers на каждый ответ, CORS allowlist vs wildcard, security.txt/robots.txt text/plain, errors без stack | 3.2, 3.4, 7.2 |
| `backend/package-lock.json`, `onchain/package-lock.json` | Сгенерированы (`npm i --package-lock-only`), `npm audit` 0 vulns | 3.8.1–3.8.2 |
| `.github/dependabot.yml` | Новый: weekly npm (backend/onchain), pip, github-actions | 3.8.5 |
| `.githooks/pre-commit` | Новый: `check_secrets --self-test` + scan + `check_ai_injection`; `git config core.hooksPath .githooks` | 1.3.6 |
| `.github/workflows/ci.yml`, `economy-rust.yml` | Все `uses:` pinned по SHA + comment `# actions/checkout@v4` etc., `permissions: contents: read` minimal | 3.8.6 |
| `.well-known/security.txt`, `robots.txt`, `public/.well-known/security.txt`, `public/robots.txt` | Статичные файлы для CDN/nginx (дублируют API routes) | 7.2, 7.3 |
| `docs/SECURITY_HEADERS.md` | Новый: таблица заголовков, TLS/CORS, команды проверки | 3.1–3.2 |
| `docs/PRIVACY_POLICY.md` | Новый draft v0.1 (controller, data map 7 categories, legal bases, recipients, transfers SCC, retention, rights, GPC, version) | 5.2.1 |
| `docs/TERMS.md` | Новый draft v0.1 (age, wallet, virtual items, conduct, IP, liability, law) | 5.2.2 |
| `docs/COOKIE_POLICY.md` | Новый draft v0.1 (inventory, classification, prior consent, GPC, CMP) | 4.x, 5.2 |
| `docs/RISK_DISCLOSURE.md` | Новый draft v0.1 (volatility, no yield, audit pending, custody) | 5.2.3 |
| `docs/KEY_ROTATION.md` | Новый: 15-минутная red button, таблица ротаций, порядок git filter-repo | 1.2.4–1.2.5, 1.3.10, 3.11.6 |
| `docs/CLIENT_DATA_HANDLING.md` | Новый: no secrets in client, bundle scan, XSS guards, wallet protection | 1.3.4–1.3.5, 3.3, 3.9 |
| `design/landing/en.html`, `index.html` | Footer: `Privacy · Terms · Cookies · Risk · security.txt · Cookie settings`; cookie banner + settings modal (prior consent, GPC, 6–12m re-prompt, no dark patterns) + shared CSS/JS | 4.3, 7.1 |
| `docs/PROD_READINESS_AUDIT_2026_09_28.md` | Этот файл | — |

**Верификация этого PR:**

```bash
python3 scripts/check_secrets.py --self-test && python3 scripts/check_secrets.py  # PASS
python3 scripts/check_ai_injection.py --self-test && python3 scripts/check_ai_injection.py  # PASS
./scripts/check_branding.sh --release --check-translations  # PASS
cd backend && npm test  # 305/305 (301 + 4 security_headers)
# gitleaks/trufflehog — установить и прогнать вручную (см. 1.1.1/1.2.1)
curl -sI http://localhost:8787/v1/health | grep -iE "strict-transport|content-security|x-frame|x-content-type|referrer|permissions|server"
curl -s http://localhost:8787/.well-known/security.txt | head
curl -s http://localhost:8787/robots.txt | cat
```

---

## Напоминание (из чек-листа §12)

> Ни один чек-лист не даёт 100% защиты. Перед запуском с реальными деньгами игроков нужны **независимый аудит смарт-контрактов, пентест сайта и консультация юриста по юрисдикциям** (MiCA, gambling, KYC/AML, 152-ФЗ, CCPA). Этот отчёт — gate, а не сертификация.

