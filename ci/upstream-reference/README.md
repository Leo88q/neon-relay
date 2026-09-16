# Upstream CI reference

These files are the CI configuration of the upstream project
(https://github.com/ddnet/ddnet @ `a853d333ac9e61ebfa2899b4641f8b0658ba60d5`).
They are kept **verbatim** for two reasons:

1. attribution — they document how upstream builds and tests the code we derive from;
2. reference — Neon Relay's own workflows in `.github/workflows/` reuse their job
   structure (dependency lists, cross-compilation matrix, sanitizer jobs).

They are deliberately **not** in `.github/workflows/`, so GitHub Actions never runs them
against Neon Relay infrastructure: they reference upstream caches, upstream release
buckets and upstream secrets that do not exist here.

| File | Upstream path |
| --- | --- |
| `github-workflows/*.yml` | `.github/workflows/*.yml` |
| `gitlab-ci.yml` | `.gitlab-ci.yml` |
| `gitlab/build.yml` | `.gitlab/build.yml` |
| `CODEOWNERS.upstream` | `.github/CODEOWNERS` |
| `pull_request_template.upstream.md` | `.github/pull_request_template.md` |
