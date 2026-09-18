#!/usr/bin/env python3
"""Classify every occurrence of the upstream brand names in the repository.

The rebranding policy (docs/REBRANDING.md) is:

  * **user-facing branding** must be gone (menus, app label, manifest, store
    metadata, icons, screenshots, server browser, default server names,
    user-facing logs, notifications, package id, marketing text);
  * **legal attribution** must stay (upstream license and copyright notices,
    third-party notices, font licenses);
  * **code / API identifiers** stay when renaming them would break the network
    protocol, demo compatibility, saved data or the Rust crate layout;
  * **historical documentation**, **test fixtures** and **false positives** are
    reported but tolerated.

Every match in the tree is assigned exactly one of those categories, in the order
the rules are declared below. Anything that no rule matches is reported as
`user-facing` and makes `--release` fail.

Usage:
    scripts/branding_scan.py [--csv docs/branding-scan.csv] [--release] [--quiet]

Exit codes: 0 = clean, 1 = user-facing branding found (in --release mode),
2 = the tool itself failed.
"""

from __future__ import annotations

import argparse
import csv
import pathlib
import re
import sys
from collections import Counter

BRAND_RE = re.compile(r"ddnet|ddracenetwork|ddrace|teeworlds", re.IGNORECASE)

# A brand token that is *not* a standalone word is part of an identifier
# (CNetObj_DDNetCharacter, m_DDRaceState, ddnet_base, GetDDRaceTeam, ...).
STANDALONE_RE = re.compile(
	r"(?<![A-Za-z0-9_])(ddnet|ddrace(?:network)?|teeworlds)(?![A-Za-z0-9_])",
	re.IGNORECASE,
)

# Directories/files that are not scanned at all.
EXCLUDE_PATHS = (
	".git/",
	"node_modules/",
	"build/",
	"dist/",
	".gradle/",
	"docs/branding-scan.csv",  # this tool's own output
	"scripts/branding_scan.py",  # this tool
	"scripts/check_branding.sh",
	"scripts/languages/rebrand_neonrelay.py",
)

# ---------------------------------------------------------------------------
# Path based rules (checked first, most specific wins)
# ---------------------------------------------------------------------------
LEGAL_PATH_RES = [
	# Explicit attribution/license review for optional, unshipped reference maps.
	re.compile(r"^docs/reference_maps/(README_RU\.md|catalog\.json)$"),
	re.compile(r"^license\.txt$"),
	re.compile(r"^\.mailmap$"),
	re.compile(r"^licenses/"),
	re.compile(r"^data/[^/]+/license\.txt$"),
	re.compile(r"^data/languages/(license|README)\.txt$"),
	re.compile(r"^data/maps7/readme\.txt$"),
	re.compile(r"^data/languages/(license|README)\.txt$"),
	re.compile(r"^other/icons/license\.txt$"),
	re.compile(r"^src/engine/external/"),
	re.compile(r"^src/README\.md$"),
	re.compile(r"^docs/THIRD_PARTY_NOTICES\.md$"),
	re.compile(r"^docs/ASSET_MANIFEST\.csv$"),
	re.compile(r"^Cargo\.lock$"),
]

HISTORICAL_PATH_RES = [
	re.compile(r"^UPSTREAM_BASE\.md$"),
	re.compile(r"^docs/UPSTREAM_AUDIT\.md$"),
	re.compile(r"^docs/KNOWN_LIMITATIONS\.md$"),
	re.compile(r"^docs/baseline/"),
	re.compile(r"^man/"),
	re.compile(r"^README\.md$"),
	re.compile(r"^scripts/(check_assets|check_branding|check_secrets|local_syntax_probe)\.sh$"),
	re.compile(r"^scripts/(gen_asset_manifest|asset_check|build_brand_assets)\.py$"),
	re.compile(r"^docs/(SOLANA_ARCHITECTURE|ANDROID_SEEKER|WALLET_AUTH|REWARD_SECURITY|API|DEVNET_RUNBOOK)\.md$"),
	re.compile(r"^\.github/pull_request_template\.md$"),
	re.compile(r"^scripts/languages/README\.md$"),
	re.compile(r"^src/mastersrv/"),
	re.compile(r"^src/masterping/"),
	re.compile(r"^other/config_directory\.(sh|bat)$"),
	re.compile(r"^docs/REBRANDING\.md$"),
	# the credits screen keeps upstream attribution on purpose (allowed by the
	# rebranding policy: legal/credits documentation may name the upstream project)
	re.compile(r"^src/game/client/components/menus_settings_credits\.cpp$"),
	# gameplay overlay names shipped in data/game_entities/entities_clear
	re.compile(r"^src/game/client/components/mapimages\.h$"),
	re.compile(r"^docs/THREAT_MODEL\.md$"),
	re.compile(r"^docs/RELEASE_CHECKLIST\.md$"),
	# the final audit report describes the derivation and blockers by name
	re.compile(r"^docs/FINAL_REPORT\.md$"),
	re.compile(r"^ci/upstream-reference/"),
	re.compile(r"^docs/upstream/"),
	# upstream developer documentation, kept as reference until rewritten
	re.compile(r"^docs/(BUILDING|BUILDING-android|BUILDING-ios|BUILDING-emscripten|DEBUGGING|CONTRIBUTING|DATABASE|BENCHMARKING)\.md$"),
	re.compile(r"^\.clang-tidy$|^\.typos\.toml$|^codecov\.yml$|^deny\.toml$|^Doxyfile$"),
	re.compile(r"^formatting-revs\.txt$"),
]

TEST_PATH_RES = [
	re.compile(r"^scripts/test_menu_contract\.py$"),
	re.compile(r"^src/test/"),
	re.compile(r"^src/rust-bridge/test/"),
	re.compile(r"^scripts/integration_test\.py$"),
	re.compile(r"^backend/.*/tests?/"),
	re.compile(r"^backend/tests/"),
	re.compile(r"^onchain/tests/"),
	re.compile(r"_test\.(cpp|py|ts|rs)$"),
	re.compile(r"\.test\.ts$"),
]

# Path based rules for files whose *content* is identifiers, protocol definitions or
# generated/asset data rather than user-facing text.
CODE_PATH_RES = [
	# protocol definitions: netobject/netmessage names and their name-based UUIDs
	re.compile(r"^datasrc/"),
	# content of shipped data assets (automap rule sections, map metadata, entity
	# names) - read by the engine, not shown as branding
	re.compile(r"^data/(editor|mapres|maps7?|themes|assets|skins7?|audio|countryflags|menuimages|shader|communityicons)/"),
	# build artefact names in .gitignore follow the executable names
	re.compile(r"^\.gitignore$"),
	# Rust crate names
	re.compile(r"Cargo\.toml$"),
	# captured tool output kept as build evidence
	re.compile(r"^docs/baseline/"),
]

# ---------------------------------------------------------------------------
# Line based rules: code / API identifiers that must not be renamed
# ---------------------------------------------------------------------------
CODE_IDENTIFIER_RES = [
	# Pinned public asset-download endpoints are identifiers, not UI branding.
	re.compile(r"https://raw\.githubusercontent\.com/ddnet/ddnet-maps/|repos/ddnet/ddnet-maps/contents/"),
	# the crash-log tool still accepts the upstream executable names so that crash
	# logs produced by an older DDNet installation stay diagnosable
	re.compile(r'^\s*if parsed_filename\.executable not in \["neonrelay"'),
	# name-based UUIDs (protocol, teehistorian, mapbugs) — renaming changes the UUID
	re.compile(r"@ddnet\.(org|tw)"),
	re.compile(r"\bUUID\("),
	re.compile(r"\b(TEEHISTORIAN|NETMSG)_[A-Z0-9_]+"),
	# protocol/version constants
	re.compile(r"\bGAME_NETVERSION7?\b"),
	re.compile(r"\bCLIENT_VERSION7\b"),
	re.compile(r"\bVERSION_DDNET_[A-Z0-9_]+"),
	re.compile(r"\bSERVERCAPFLAG_DDNET\b"),
	re.compile(r"\bVERSION_VANILLA\b"),
	# internal C++ symbols inherited from upstream
	re.compile(r"\bm_(p)?DDNet[A-Za-z]*\b"),
	re.compile(r"\bDDNetVersion(Str)?\b"),
	re.compile(r"\b(Load|Reset|Request)DDNetInfo[A-Za-z]*\b"),
	re.compile(r"\bDDNetInfo[A-Za-z]*\b"),
	re.compile(r"\bCOMMUNITY_DDNET\b"),
	re.compile(r"\bCDDNet[A-Za-z]*\b"),
	re.compile(r"\bGotDDNet[A-Za-z]*\b"),
	re.compile(r"\bSetClientDDNetVersion\b"),
	re.compile(r"\bRELAY_INFO_FILE\b"),
	# config variables whose *name* is part of the saved-settings file format
	re.compile(r"\bm_(Cl|Sv|Br|Ui|Gfx|Snd|Dbg|Inp|Dbg|Ed|Player|Show)[A-Za-z]*DDRace[A-Za-z]*\b"),
	re.compile(r"\b(sv|cl|br|ui|gfx|snd|ed)_[a-z0-9_]*ddrace[a-z0-9_]*\b", re.IGNORECASE),
	# gametype / community wire values
	re.compile(r'"ddnet"'),
	re.compile(r'"ddracenet"'),
	re.compile(r'"0xf"'),
	# Rust crate names and cargo env vars
	re.compile(r"\bddnet_(base|engine|engine_shared|game|test|mastersrv|masterping)\b"),
	re.compile(r"\bDDNET_TEST_[A-Z_]+"),
	re.compile(r"\bDDNET_GTEST_VERSION\b"),
	re.compile(r"rust_target"),
	# the ddnet-libs submodule and its layout
	re.compile(r"ddnet-libs"),
	# data asset file names referenced by maps, the editor and the asset index
	re.compile(r"(ddnet|ddrace|teeworlds)[-_][a-z0-9_\-]*\.(png|rules|map|json|ogg|wv|ttf|otf|ttc)", re.IGNORECASE),
	re.compile(r"(game_entities|mapres|assets|skins7?|maps7?|themes|audio)/[A-Za-z0-9_\-./]*(ddnet|ddrace|teeworlds)", re.IGNORECASE),
	re.compile(r"\b(F-DDRace|DDNet)\.png\b"),
	# source file names of upstream modules
	re.compile(r"(ddracechat|ddracecommands|menus_settings_ddnet|gamemodes/ddnet)\.(cpp|h)"),
	re.compile(r"#include\s+[\"<].*(ddnet|ddrace|teeworlds)", re.IGNORECASE),
	# upstream issue/PR references in comments
	re.compile(r"github\.com/ddnet/ddnet/(issues|pull|blob|compare)"),
	re.compile(r"^\s*(//|\*|#|;|--).*\bhttps?://[a-z0-9.\-]*ddnet\.org", re.IGNORECASE),
	# upstream file headers (Teeworlds copyright line)
	re.compile(r"acquire a complete release at teeworlds\.com"),
	re.compile(r"\(c\) Magnus Auvinen"),
	# attribution lines (translator credits, upstream author names)
	re.compile(r"překlad od|translation by|Translated by|TeeWorlds-org", re.IGNORECASE),
	# the 0.6/0.7 protocol generations are named after the original game
	re.compile(r"\b(Teeworlds|Teeworlds 0\.7|0\.6|0\.7)\b.*(format|protocol|version|compat)", re.IGNORECASE),
	# legacy compatibility paths/URLs we intentionally still accept
	re.compile(r"CONNECTLINK_LEGACY"),
	re.compile(r'"(DDNet|Teeworlds)"\s*,?\s*(//.*)?$'),
	re.compile(r"apLegacyAppdirs"),
	re.compile(r"/usr/(share|local/share|pkg/share)/(games/)?ddnet"),
	re.compile(r"/opt/ddnet"),
	re.compile(r"APPDATA.*DDNet|Application Support/DDNet|\.local/share/ddnet|\$DATA_HOME/ddnet"),
	re.compile(r"\.teeworlds/|APPDATA.*Teeworlds|Application Support/Teeworlds"),
	re.compile(r"str_comp\(appname, \"Teeworlds\"\)"),
	# gametype strings received from servers (wire values)
	re.compile(r"str_find_nocase\(pGame[Tt]ype"),
	# editor entities image selection (matches data/editor/entities/DDNet.png)
	re.compile(r"m_SelectEntitiesImage"),
	re.compile(r"POS_SETTINGS_DDNET"),
	# the web client still accepts legacy connect links
	re.compile(r"startsWith\('ddnet://'\)"),
	# crash log parser also accepts upstream release file names
	re.compile(r"CRASH_FILENAME_PATTERN"),
	re.compile(r"update\.neonrelay\.example"),
]

# Comment-only lines (no user-visible text) that mention the upstream project.
COMMENT_RES = [
	re.compile(r"^\s*//"),
	re.compile(r"^\s*/\*"),
	re.compile(r"^\s*\*"),
	re.compile(r"^\s*#(?!!)"),
	re.compile(r"^\s*;"),
	re.compile(r"^\s*\.\\\""),  # roff comment
	re.compile(r"^\s*rem\b", re.IGNORECASE),
]

SOURCE_SUFFIXES = (".cpp", ".h", ".hpp", ".c", ".cc", ".rs", ".mm", ".m", ".java", ".kt", ".ts", ".py", ".js")


def token_contexts(line: str) -> list[tuple[int, int, str]]:
	"""Return (start, end, kind) spans for a source line.

	kind is one of `string`, `comment` or `code`. This is a deliberately small
	lexer: it is only used to decide whether a brand name is inside a string
	literal (user-facing), inside a comment, or part of an identifier.
	"""
	spans: list[tuple[int, int, str]] = []
	i = 0
	n = len(line)
	while i < n:
		ch = line[i]
		if ch == "/" and i + 1 < n and line[i + 1] == "/":
			spans.append((i, n, "comment"))
			break
		if ch == "/" and i + 1 < n and line[i + 1] == "*":
			end = line.find("*/", i + 2)
			end = n if end == -1 else end + 2
			spans.append((i, end, "comment"))
			i = end
			continue
		if ch in "\"'":
			quote = ch
			j = i + 1
			while j < n:
				if line[j] == "\\":
					j += 2
					continue
				if line[j] == quote:
					j += 1
					break
				j += 1
			spans.append((i, j, "string"))
			i = j
			continue
		if ch == "#":
			# preprocessor directive or shell/python comment: only a comment when it
			# is not a preprocessor keyword line
			rest = line[i + 1:].lstrip()
			if not rest[:7].split(" ")[0] in {"include", "define", "ifdef", "ifndef", "endif", "pragma", "if", "else", "elif"}:
				spans.append((i, n, "comment"))
				break
		i += 1
	return spans


def context_at(spans: list[tuple[int, int, str]], pos: int) -> str:
	for start, end, kind in spans:
		if start <= pos < end:
			return kind
	return "code"


CATEGORIES = ("legal-attribution", "historical-documentation", "test-fixture", "code/api-identifier", "comment", "user-facing")


def classify(rel_path: str, line: str, spans: list[tuple[int, int, str]] | None = None) -> tuple[str, str]:
	for res in LEGAL_PATH_RES:
		if res.search(rel_path):
			return "legal-attribution", "upstream/third-party license notice (must stay)"
	for res in TEST_PATH_RES:
		if res.search(rel_path):
			return "test-fixture", "test data or test assertion"
	for res in HISTORICAL_PATH_RES:
		if res.search(rel_path):
			return "historical-documentation", "document that describes the upstream derivation"
	for res in CODE_PATH_RES:
		if res.search(rel_path):
			return "code/api-identifier", "file contains protocol/asset/crate identifiers, not user-facing text"
	for res in CODE_IDENTIFIER_RES:
		if res.search(line):
			return "code/api-identifier", f"identifier kept for protocol/build compatibility ({res.pattern[:48]})"
	if not STANDALONE_RE.search(line):
		return "code/api-identifier", "brand appears only inside code identifiers"
	if spans is not None:
		contexts = {context_at(spans, m.start()) for m in STANDALONE_RE.finditer(line)}
		if contexts == {"code"}:
			return "code/api-identifier", "brand appears only as a variable/type name, not in a string literal"
		if "string" not in contexts:
			return "comment", "brand appears only in a source comment"
	if any(res.search(line) for res in COMMENT_RES):
		return "comment", "source comment, not shown to users"
	return "user-facing", "NOT CLASSIFIED — must be rebranded or explicitly allowed"


def iter_files(root: pathlib.Path):
	for path in sorted(root.rglob("*")):
		if not path.is_file():
			continue
		rel = path.relative_to(root).as_posix()
		if any(exc in rel for exc in EXCLUDE_PATHS):
			continue
		if any(part.startswith("build") and part not in ("build.gradle", "build.sh", "build.yml") for part in rel.split("/")[:-1]):
			continue
		try:
			text = path.read_text(encoding="utf-8")
		except (UnicodeDecodeError, PermissionError):
			# binary assets are covered by docs/ASSET_MANIFEST.csv, not by this scan
			continue
		yield rel, text


def main() -> int:
	parser = argparse.ArgumentParser(description=__doc__)
	parser.add_argument("--root", default=".", help="repository root (default: cwd)")
	parser.add_argument("--csv", default=None, help="write the full report to this CSV file")
	parser.add_argument("--release", action="store_true", help="fail on any user-facing occurrence")
	parser.add_argument("--quiet", action="store_true", help="only print the summary")
	args = parser.parse_args()

	root = pathlib.Path(args.root).resolve()
	rows: list[dict[str, str]] = []
	counter: Counter[str] = Counter()
	per_file: Counter[str] = Counter()

	for rel, text in iter_files(root):
		for lineno, line in enumerate(text.split("\n"), start=1):
			if not BRAND_RE.search(line):
				continue
			spans = token_contexts(line) if rel.endswith(SOURCE_SUFFIXES) else None
			category, reason = classify(rel, line, spans)
			counter[category] += 1
			per_file[rel] += 1
			rows.append({
				"path": rel,
				"line": str(lineno),
				"category": category,
				"reason": reason,
				"text": line.strip()[:240],
			})

	total = sum(counter.values())
	print(f"branding scan: {total} occurrence(s) in {len(per_file)} file(s)")
	for category in CATEGORIES:
		print(f"  {category:26s} {counter.get(category, 0)}")

	user_facing = [r for r in rows if r["category"] == "user-facing"]
	if user_facing:
		print(f"\nuser-facing occurrences ({len(user_facing)}), first 60:")
		for row in user_facing[:60]:
			print(f"  {row['path']}:{row['line']}: {row['text'][:150]}")

	if args.csv:
		out = pathlib.Path(args.csv)
		out.parent.mkdir(parents=True, exist_ok=True)
		with out.open("w", newline="", encoding="utf-8") as handle:
			writer = csv.DictWriter(handle, fieldnames=["path", "line", "category", "reason", "text"])
			writer.writeheader()
			writer.writerows(rows)
		if not args.quiet:
			print(f"\nreport written to {out}")

	if args.release and user_facing:
		print("\nRESULT: FAIL (user-facing upstream branding present)")
		return 1
	print("\nRESULT: PASS" if not (args.release and user_facing) else "")
	return 0


if __name__ == "__main__":
	try:
		sys.exit(main())
	except KeyboardInterrupt:
		sys.exit(2)
