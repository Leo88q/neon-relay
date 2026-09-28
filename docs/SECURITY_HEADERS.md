# Security headers (checklist 3.1–3.2)

Backend `src/http.ts` emits the following on every JSON response (including errors):

| Header | Value | Purpose |
|---|---|---|
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` | HSTS — HTTPS only for 1y. Also set at CDN/edge; preload after verification. |
| `Content-Security-Policy` | `default-src 'none'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'none'; connect-src 'self' https://api.{devnet,testnet,mainnet-beta}.solana.com; script-src 'none'; …` | Locks down API responses; no active content, no framing (clickjacking guard for future wallet-confirm screens — checklist 3.2.1). |
| `X-Frame-Options` | `DENY` | Clickjacking fallback for old clients. |
| `X-Content-Type-Options` | `nosniff` | MIME sniffing protection. |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | Limits referrer leakage. |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=(), payment=()` | Disables unused capabilities. |
| `Cross-Origin-Opener-Policy` | `same-origin` | Isolates browsing context. |
| `Cross-Origin-Resource-Policy` | `same-site` | CORP. |
| `Cache-Control` | `no-store` | No caching of authenticated/ledger responses. |
| `Server` | `NeonRelay` (no version) | Hides version disclosure (checklist 3.2.3). |
| `X-Powered-By` | absent | Never emitted. |

## TLS (3.1)

- All traffic must be HTTPS; HTTP must 301 to HTTPS at the edge (not in the app — the app always sends HSTS).
- Deployment must provide a valid certificate, TLS 1.2+, auto-renew.
- Verify with `testssl.sh` / SSL Labs: `curl -sI https://YOUR_DOMAIN | grep -iE "strict-transport|content-security"` should show the headers above.

## CORS (3.4.1)

- Controlled by `NEONRELAY_CORS_ORIGINS` (comma-separated allowlist). Empty = no `Access-Control-Allow-Origin` (same-origin only).
- `*` is treated as wildcard without credentials (no `Allow-Credentials`).
- Preflight `OPTIONS` is handled centrally in `server.ts`; per-route handlers need no CORS logic.
- `Vary: Origin` is set when a CORS header is emitted.

## Verification

```bash
# Headers
curl -sI https://YOUR_DOMAIN/v1/health | grep -iE "strict-transport|content-security|x-frame|x-content-type|referrer|permissions|server|x-powered"

# CORS preflight
curl -sI -X OPTIONS -H "Origin: https://example.com" https://YOUR_DOMAIN/v1/auth/challenge

# CSP should block framing — checklist 3.2.1 frame-ancestors 'none'
```

External checks: https://securityheaders.com — expect A, Mozilla Observatory.
