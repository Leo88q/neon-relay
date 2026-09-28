# Cookie Policy — Neon Relay (draft v0.1, 2026-09-28)

> Checklist 4.x. Backend API (beta) sets **no cookies**; this policy covers the future web frontend. Update before any non-essential script is added.

## 1. Inventory (4.1)

| Name | Provider | Purpose | Duration | Category | Consent needed |
|---|---|---|---|---|---|
| `neonrelay_session` (planned if moving to HttpOnly cookie) | Neon Relay | Auth session (HttpOnly, Secure, SameSite=Lax, 12h sliding) | Session + 12h | Strictly necessary | No |
| `_pk_*` / `plausible` (if using Plausible/Matomo anonymous) | Self-hosted | Anonymous analytics, no cookies if possible | Session | Analytics (cookieless) | No (if truly anonymous) |
| `klaro` / `cookieconsent` | Neon Relay | Store consent categories + version | 6–12 months | Necessary | No |
| *Any future marketing pixel* | Third party | Marketing | — | Marketing | **Yes — prior consent** |

Current beta: **zero cookies**, zero localStorage/IndexedDB beyond wallet adapter transient state; no fingerprinting, no third-party SDKs. Verification: DevTools → Application → Cookies/LocalStorage must be empty on `/v1/health` and docs pages.

## 2. Classification & consent (4.2–4.3)

- Necessary: session/security/load-balancing — no consent.
- Functional / Analytics / Marketing: consent **before** loading (`prior consent`).
- Banner: equal “Accept” / “Reject”, no pre-ticked boxes, category toggles, “Settings” link persistent in footer, withdraw as easy as give, no cookie wall, no dark patterns.
- Consent logged (date, policy version, categories, pseudonymous id — hashed IP or wallet id). Re-prompt on policy change or every 6–12 months.

## 3. Banner implementation

- Ready CMPs: Klaro!, CookieConsent (orestbida), Cookiebot, Osano. Or cookieless analytics path: Plausible / Umami / Matomo anonymous (no consent needed if truly anonymous — confirm with counsel).
- Self-host fonts/icons/scripts (no Google Fonts CDN — otherwise IP leaks to third party without consent — 4.6).
- Embedded video/maps: click-to-load facade after consent (4.7).

## 4. Your choices

- Use footer link “Cookie settings” to change consent. Delete cookies via browser. GPC signal honoured (4.8) — if enabled, treat as reject for non-essential.

## 5. Changes

- Table kept current with every new cookie/SDK. Policy version + date in footer.

*Before web launch:* implement CMP, verify no non-essential request fires before consent (Network tab, clean profile), list actual cookies in the table above, and ensure `Consent Mode v2` if using Google services.
