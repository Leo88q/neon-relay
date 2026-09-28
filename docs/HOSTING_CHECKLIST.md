# Hosting / TLS / DNS Checklist — operator steps after code is green (audit §3.1, §3.9, §9)

Use this before first prod deploy. All commands assume `YOUR_DOMAIN=neonrelay.example`.

## 1. TLS & HTTPS

- [ ] Terminate TLS at edge (Caddy/nginx/Cloudflare). `auto_https` or `certbot --nginx`, auto-renew via `systemd`/`acme.sh`.
- [ ] Redirect `http://` → `https://` 301: `curl -sI http://YOUR_DOMAIN | head` → `Location: https://...`
- [ ] TLS 1.2+ only, strong ciphers: `testssl.sh https://YOUR_DOMAIN` → no TLS 1.0/1.1, no weak ciphers.
- [ ] Certificate transparency, OCSP stapling on.
- [ ] Verify headers live (backend already sends them, edge must not strip):

```bash
curl -sI https://YOUR_DOMAIN/v1/health | grep -iE "strict-transport|content-security|x-frame|x-content-type|referrer|permissions|server|x-powered|cross-origin|cache-control"
# Expect: Strict-Transport-Security max-age=31536000; includeSubDomains, Content-Security-Policy default-src 'none', X-Frame DENY, nosniff, Referrer, Permissions-Policy, Server: NeonRelay, no X-Powered-By, no-store
curl -s https://YOUR_DOMAIN/.well-known/security.txt | head
curl -s https://YOUR_DOMAIN/robots.txt | cat
curl -sI https://YOUR_DOMAIN/design/landing/en.html | grep -i "content-security"
```

- [ ] `securityheaders.com` ≥ **A**, `observatory.mozilla.org` ≥ **A**, `SSL Labs` ≥ **A**.

## 2. Edge / WAF / DDoS

- [ ] WAF (Cloudflare / AWS Shield / Fastly) + DDoS protection.
- [ ] Rate limit at edge for `/v1/auth/challenge`, `/v1/rewards/claim` (backend also limits 10/5min).
- [ ] `autoindex off;` (nginx), no directory listing, 404 JSON `{code:"not-found"}` not `index.html` for `/v1/*`.

## 3. Server

- [ ] `TRUST_PROXY=1` only if behind trusted reverse proxy, plus `TRUSTED_PROXIES` (CIDR). Otherwise `0`.
- [ ] `NEONRELAY_CORS_ORIGINS=https://neonrelay.example,https://www.neonrelay.example` (no `*` with credentials), restart.
- [ ] Secrets only via env injection (hosting secret store), never in files. Separate `dev/staging/prod`.
- [ ] `NEONRELAY_RPC_URL` + `NEONRELAY_RPC_FALLBACK_URL` (distinct providers), `NEONRELAY_EXPECTED_GENESIS_HASH`.
- [ ] DB `var/neonrelay.db` mode `600`, `var/backups` off-site ≤90d, drill `POST /v1/admin/backup` + `scripts/restore_backup.ts`.
- [ ] Services not as `root`, SSH keys only, Firewall: only 80/443 (+ 8303/8304 for game server (Neon Relay)) open.
- [ ] `public/_headers` / `design/landing/_headers` deployed (Netlify/Cloudflare Pages) OR include `docs/NGINX_SECURITY_HEADERS.conf` in nginx `server {}`.

## 4. DNS / Registrar / Brand

- [ ] DNSSEC: `dig YOUR_DOMAIN DNSKEY` + `https://dnssec-analyzer.verisignlabs.com/YOUR_DOMAIN`
- [ ] CAA: `dig YOUR_DOMAIN CAA` → `0 issue "letsencrypt.org"` (or chosen CA)
- [ ] Registrar lock, 2FA, CAA, DNS 2FA.
- [ ] Check subdomain takeover: `nuclei -target YOUR_DOMAIN -t dns/subdomain-takeover.yaml`, `amass`/`subfinder`.
- [ ] Official links pinned in socials/bio to prevent phishing (audit §3.9.3).

## 5. Contracts & RPC

- [ ] Transfer upgrade authority for all 4 programs to Squads vault: `solana program set-upgrade-authority <program> --new-upgrade-authority <SQUADS_VAULT> --url <cluster> --keypair <old>`
- [ ] `onchain/scripts/verify_deployment.sh --manifest deployment.mainnet-beta.json` on finalized RPC.
- [ ] `anchor build --verifiable` + `cargo test --locked`.

## 6. Monitoring

- [ ] `GET /v1/health`, `/watchtower/health`, `/watchtower/readyz`, `/v1/admin/metrics`, `/v1/admin/stuck`.
- [ ] Webhook/Telegram: `POST /v1/admin/alerts/test` → deliver.
- [ ] Cron: `GET /v1/admin/stuck&alert=1` every 5min.

## 7. External scans (run after deploy, paste outputs into release notes)

```bash
# headers, well-known, CORS, TLS, performance — see audit §9 for full list
nuclei -target https://YOUR_DOMAIN -severity high,critical
zaproxy: zap-baseline.py -t https://YOUR_DOMAIN
lighthouse --preset=desktop https://YOUR_DOMAIN
```

## 8. Rollback

`docs/DEPLOYMENT_POLICY.md:5` — fix-forward preferred, `git revert` + redeploy, DB migrations reversible.
