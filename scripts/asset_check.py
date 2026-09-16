#!/usr/bin/env python3
"""Verify the shipped assets against docs/ASSET_MANIFEST.csv.

Checks (always):

* every file under the release asset roots (``data/``, ``other/icons/``,
  ``other/dmgbackground*.png``, ``other/emscripten/background.png``,
  ``assets-src/brand/``) has exactly one manifest row  → *unknown asset* otherwise;
* every manifest row points at an existing file       → *stale row* otherwise;
* every sha256 in the manifest matches the file on disk.

``--release`` additionally fails when any row is marked ``action=block-release``:
those assets are vendored for development but must not ship in a commercial
release before the rights review in docs/THIRD_PARTY_NOTICES.md is complete.

``--licenses`` additionally fails when a license referenced by the manifest has
no verbatim text under ``licenses/``.

Exit codes: 0 = clean, 1 = violations found, 2 = tool error.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
MANIFEST = ROOT / "docs/ASSET_MANIFEST.csv"
LICENSES = ROOT / "licenses"

WATCHED_ROOTS = ("data", "other/icons", "other/emscripten", "assets-src")
LICENSE_TEXT_ALIASES = {
    "public-domain": None,          # no license text required
    "see file": None,
    "UNKNOWN": "MISSING",            # must be resolved before release
}


def sha256(path: pathlib.Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def disk_files() -> set[str]:
    out: set[str] = set()
    for base in WATCHED_ROOTS:
        for p in (ROOT / base).rglob("*"):
            if p.is_file():
                out.add(p.relative_to(ROOT).as_posix())
    for p in ROOT.glob("other/dmgbackground*.png"):
        out.add(p.relative_to(ROOT).as_posix())
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--release", action="store_true",
                    help="fail on any block-release asset")
    ap.add_argument("--licenses", action="store_true",
                    help="fail on any referenced license without a text in licenses/")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()

    if not MANIFEST.exists():
        print(f"asset check: missing {MANIFEST.relative_to(ROOT)} "
              f"(run scripts/gen_asset_manifest.py)", file=sys.stderr)
        return 2
    with MANIFEST.open(encoding="utf-8") as fh:
        rows = list(csv.DictReader(fh))
    by_path = {r["path"]: r for r in rows}
    if len(by_path) != len(rows):
        print("asset check: manifest contains duplicate paths", file=sys.stderr)
        return 2

    problems: list[str] = []
    on_disk = disk_files()

    for rel in sorted(on_disk - set(by_path)):
        problems.append(f"unknown asset (not in manifest): {rel}")
    for rel in sorted(set(by_path) - on_disk):
        problems.append(f"stale manifest row (file missing): {rel}")
    for rel in sorted(on_disk & set(by_path)):
        want = by_path[rel]["sha256"]
        got = sha256(ROOT / rel)
        if want != got:
            problems.append(f"sha256 mismatch: {rel}\n    manifest {want}\n    disk     {got}")

    if args.release:
        blocked = [r for r in rows if r["action"] == "block-release"]
        if blocked:
            problems.append(
                f"{len(blocked)} asset(s) are marked block-release and may not ship; "
                f"first few: " + ", ".join(r["path"] for r in blocked[:5]))
        unknown_license = [r for r in rows
                           if r["action"] == "ship" and r["license"] == "UNKNOWN"]
        for r in unknown_license:
            problems.append(f"ship asset with unknown license: {r['path']}")

    if args.licenses:
        ids: set[str] = set()
        for r in rows:
            if r["action"] != "ship":
                # gated assets are handled by --release; their license questions
                # are part of the rights review, not of the license-text check
                continue
            for part in r["license"].split(" AND "):
                part = part.strip()
                alias = LICENSE_TEXT_ALIASES.get(part, part)
                if alias == "MISSING":
                    problems.append(f"license not identified for {r['path']} ({part})")
                elif alias:
                    ids.add(alias)
        for lid in sorted(ids):
            if not (LICENSES / f"{lid}.txt").exists():
                problems.append(f"missing license text: licenses/{lid}.txt")

    if problems:
        for p in problems:
            print(f"  FAIL {p}")
        print(f"\nasset check: {len(problems)} problem(s)")
        return 1
    if not args.quiet:
        ship = sum(1 for r in rows if r["action"] == "ship")
        print(f"asset check: {len(rows)} manifest row(s) verified "
              f"({ship} ship, {len(rows) - ship} block-release)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
