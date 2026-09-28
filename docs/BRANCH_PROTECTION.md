# Branch Protection & Repository Hardening — Operator Steps (checklist 2.10, 3.8.6)

This repository already ships ` .github/CODEOWNERS` (`* @Leo88q` + reward-critical paths) and `.github/SECURITY.md`.
The remaining steps require **Settings** access on GitHub (admin). The automation cannot set them via `gh api` (403 — token lacks `admin` scope).

## 1. Code security

GitHub → Settings → Code security → Code security and analysis

- [ ] **Secret scanning** → Enable (alerts)
- [ ] **Push protection** → Enable (blocks commits containing secrets)
- [ ] **Dependabot alerts** → Enable (already `.github/dependabot.yml` weekly)
- [ ] **Dependabot security updates** → Enable

## 2. Branch protection (`main`)

GitHub → Settings → Branches → Add classic branch protection rule (Branch name pattern: `main`)

- [ ] **Require a pull request before merging** → Required approvals: `1`, Dismiss stale PR approvals: ✅, Require review from CODEOWNERS: ✅
- [ ] **Require status checks before merging** → Require branches to be up to date: ✅, checks:
  - `gates` (branding / assets / secrets / hygiene)
  - `supply-chain (audit / osv / hadolint / trivy fs)`
  - `CodeQL (js)` (advisory, can be non-required initially)
  - `C++ syntax probe`
  - `Linux server build and isolated boot`
  - `Linux client build and desktop/portrait boot`
  - `match-event signer (C++ <-> node:crypto)`
  - `reward backend (node 22)`
  - `anchor program offline checks (node 22)` (onchain)
  - `host-tests` (Economy Rust and SBF)
- [ ] **Require conversation resolution before merging** → ✅
- [ ] **Require signed commits** → optional (recommended for `backend/onchain` paths)
- [ ] **Require linear history** → optional
- [ ] **Do not allow bypassing the above settings** → ✅
- [ ] **Restrict who can push to matching branches** → nobody (PR only)
- [ ] **Block force pushes** → ✅, **Allow deletions** → ⛔

## 3. Ruleset (new GitHub UI alternative)

Settings → Rules → New ruleset → `protect-main`

- Target: `main`, `arena/*` (optional)
- Bypass: none
- Rules: same as above + **Require PR**, **Require CODEOWNERS**, **Block force pushes**, **Require 2FA for the org** (if org)

## 4. Access

- [ ] Enable **2FA requirement** for the organization (Settings → Authentication)
- [ ] Review collaborators: minimal `Write`/`Maintain`, least privilege, remove stale invites
- [ ] Restrict `GITHUB_TOKEN` permissions (already `permissions: contents: read` in `ci.yml` + `economy-rust.yml`)
- [ ] Disable forking / restrict visibility if `private` is intended (note: this repo is currently `public` per `gh api repos/... visibility:public` — see audit §1.2.3)

## 5. Verification

```bash
gh api repos/Leo88q/neon-relay/branches/main/protection --jq .required_status_checks.contexts
gh api repos/Leo88q/neon-relay --jq '{private, visibility, security_and_analysis}'
```

Expected: `protection` object with `required_status_checks`, `enforce_admins: true`, `allow_force_pushes: false`.

## 6. Related files

- `.github/CODEOWNERS` — code ownership (already `@Leo88q`)
- `SECURITY.md` + `.github/SECURITY.md` + `.well-known/security.txt` — disclosure policy
- `.github/dependabot.yml` — weekly npm/pip/github-actions
- `.github/workflows/ci.yml` — all `uses:` pinned by SHA, `permissions: contents: read`
