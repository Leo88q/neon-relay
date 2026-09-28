# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| `main` (latest) | ✅ |
| `< 0.1.0` | ❌ |

Pre-release / devnet builds are not production-hardened.

## Reporting a Vulnerability

**Do not open a public issue for security reports.**

- **Primary contact:** `security@neonrelay.example` (monitored, PGP available on request)
- **Alternative:** GitHub Security Advisories — `Security → Report a vulnerability` on this repository
- **Response SLA:** acknowledgement within **48h**, triage within **5 business days**, fix or mitigation plan within **14 days** for Critical/High

Please include:
- affected component (`backend`, `onchain`, `android`, `landing`), version/commit, environment
- steps to reproduce, impact, suggested fix if any
- whether data was accessed

### Safe Harbor

We will not pursue legal action for good-faith research that:
- avoids privacy violations, data destruction, and service disruption
- does not access, modify, or exfiltrate other users' data
- stops after confirming the issue and reports promptly
- gives us reasonable time to fix before public disclosure

### Coordinated Disclosure

- We follow **90-day coordinated disclosure** (or mutually agreed timeline).
- Credit is given in `docs/SECURITY_REVIEW_*.md` and `.well-known/security.txt` `Acknowledgments` if you wish.
- Bounty: none yet — acknowledgment and hall-of-fame. See `.well-known/security.txt` for canonical contact/policies.

## Scope

In-scope: `backend/` (reward/economy API, auth), `onchain/programs/*` (reward/economy/assets/features), `android/app` (MWA wallet integration), `design/landing` (CSP/cookies), supply chain (`Dockerfile`, `package-lock.json`, Actions).

Out-of-scope at present: upstream engine (tracked separately), `data/maps` art (see `docs/ASSET_MANIFEST.csv` / `THIRD_PARTY_NOTICES.md`).

## Security Headers & Contacts

- Canonical contact: `mailto:security@neonrelay.example`
- Policy: `https://neonrelay.example/.well-known/security.txt` (RFC 9116, `Expires: 2027-09-28`)
- See `docs/SECURITY_HEADERS.md` for live header expectations and `docs/THREAT_MODEL.md` for trust boundaries.
