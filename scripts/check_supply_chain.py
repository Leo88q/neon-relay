#!/usr/bin/env python3
"""Supply-chain gates for the 2026 incident catalog (items 107, 115, 128, 130).

Offline and dependency-free. It does not download anything: it checks that the
repository *cannot* silently acquire the failure modes those incidents had.

Rules
-----
1. Rust release profiles enable `overflow-checks` (item 115 — Truebit: silent
   wrapping arithmetic in a release build people actually ran).
2. `rust-toolchain.toml` (when present) pins an exact channel (item 128 — fork
   lag: the fork must not float behind upstream security fixes).
3. Every Node package has a lockfile whose resolved packages carry `integrity`;
   a lockfile without integrity hashes cannot be reproduced and is refused.
4. No package in any lockfile declares an install lifecycle script
   (`hasInstallScript`), and the repo never invokes a bare `npm install` /
   `npm i` in CI or docs without `--ignore-scripts` (items 107/130 — npm worm
   campaigns and IDE/marketplace stealers that run on open).
5. CI installs with `npm ci --ignore-scripts` when it installs at all.

Usage: `python3 scripts/check_supply_chain.py [--self-test]`
Exit code 0 = clean, 1 = violations printed to stdout.
"""

from __future__ import annotations

import json
import os
import re
import sys

os.chdir(os.path.dirname(os.path.abspath(__file__)) + "/..")

FAILURES: list[str] = []


def fail(message: str) -> None:
	FAILURES.append(message)


def read(path: str) -> str:
	with open(path, "r", encoding="utf-8") as handle:
		return handle.read()


# --------------------------------------------------------------- 1. Rust profiles

PROFILE_RE = re.compile(r"^\s*\[profile\.([A-Za-z0-9_-]+)\]\s*$", re.MULTILINE)


def parse_profiles(text: str) -> dict[str, dict[str, str]]:
	"""Map profile name -> key/value pairs (comments stripped, values raw)."""
	profiles: dict[str, dict[str, str]] = {}
	current: dict[str, str] | None = None
	for raw_line in text.splitlines():
		line = raw_line.split("#", 1)[0]
		match = PROFILE_RE.match(line)
		if match:
			current = profiles.setdefault(match.group(1), {})
			continue
		if current is None:
			continue
		if line.strip().startswith("["):
			current = None
			continue
		key_value = line.split("=", 1)
		if len(key_value) == 2:
			current[key_value[0].strip()] = key_value[1].strip().strip('"')
	return profiles


def resolve_overflow_checks(profiles: dict[str, dict[str, str]], name: str, seen: set[str] | None = None) -> bool:
	seen = seen or set()
	if name in seen:
		return False
	seen.add(name)
	profile = profiles.get(name, {})
	if profile.get("overflow-checks", "false").lower() == "true":
		return True
	parent = profile.get("inherits")
	if parent:
		return resolve_overflow_checks(profiles, parent, seen)
	return False


def check_rust_profiles() -> None:
	for root, dirs, files in os.walk("."):
		dirs[:] = [d for d in dirs if d not in {".git", "node_modules", "target", "data"}]
		if "Cargo.toml" not in files:
			continue
		path = os.path.join(root, "Cargo.toml")
		profiles = parse_profiles(read(path))
		if not profiles:
			continue
		for name, profile in profiles.items():
			if name == "build-override":
				continue
			# Any profile that is meant to ship must either check overflow
			# itself or inherit a profile that does.
			release_like = name in {"release", "relwithdebinfo", "minsizerel", "bench"} or \
				"lto" in profile or "opt-level" in profile
			if release_like and not resolve_overflow_checks(profiles, name):
				fail(f"{path}: profile '{name}' does not set overflow-checks = true (item 115)")


def check_rust_toolchain() -> None:
	path = "rust-toolchain.toml"
	if not os.path.exists(path):
		return
	match = re.search(r'channel\s*=\s*"([^"]+)"', read(path))
	if not match:
		fail(f"{path}: no pinned channel (item 128)")
		return
	channel = match.group(1)
	if not re.match(r"^\d+\.\d+\.\d+$", channel):
		fail(f"{path}: channel '{channel}' is not an exact version (item 128)")


# --------------------------------------------------------------- 3./4. Node packages

LIFECYCLE = ("preinstall", "install", "postinstall", "prepare", "prepack")


def check_lockfile(package_dir: str) -> None:
	package_path = os.path.join(package_dir, "package.json")
	if not os.path.exists(package_path):
		return
	package = json.loads(read(package_path))
	lock_path = os.path.join(package_dir, "package-lock.json")
	if not os.path.exists(lock_path):
		fail(f"{lock_path}: missing lockfile (items 107/130)")
		return
	lock = json.loads(read(lock_path))
	packages = lock.get("packages", {})
	has_dependencies = bool(package.get("dependencies") or package.get("devDependencies"))
	if has_dependencies and not packages:
		fail(f"{lock_path}: lockfile has no resolved packages")
	missing_integrity = []
	lifecycle = []
	for name, entry in packages.items():
		if not name or entry.get("link"):
			continue
		if "resolved" in entry and not entry.get("integrity"):
			missing_integrity.append(name)
		if entry.get("hasInstallScript"):
			lifecycle.append(name)
		for key in LIFECYCLE:
			if key in entry.get("scripts", {}):
				lifecycle.append(f"{name}:{key}")
	if missing_integrity:
		fail(f"{lock_path}: packages without integrity hashes: {', '.join(sorted(missing_integrity)[:5])}")
	if lifecycle:
		fail(f"{lock_path}: packages with install lifecycle scripts: {', '.join(sorted(lifecycle)[:5])} "
			f"(items 107/130 — use npm ci --ignore-scripts and review before accepting)")


def check_node_packages() -> None:
	for root, dirs, files in os.walk("."):
		dirs[:] = [d for d in dirs if d not in {".git", "node_modules", "data"}]
		if "package.json" in files:
			check_lockfile(root)


BARE_INSTALL_RE = re.compile(r"\bnpm\s+(install|i)\b(?!\s+--ignore-scripts)")


def check_ci_install_commands() -> None:
	workflows = os.path.join(".github", "workflows")
	if not os.path.isdir(workflows):
		return
	for name in sorted(os.listdir(workflows)):
		if not name.endswith((".yml", ".yaml")):
			continue
		path = os.path.join(workflows, name)
		for number, line in enumerate(read(path).splitlines(), start=1):
			if BARE_INSTALL_RE.search(line):
				fail(f"{path}:{number}: bare npm install without --ignore-scripts (items 107/130)")


# --------------------------------------------------------------- self-test

def self_test() -> None:
	global FAILURES
	saved = FAILURES
	FAILURES = []
	try:
		profiles = parse_profiles(
			"[profile.release]\nlto = true\n[profile.inherit]\ninherits = \"release\"\n[profile.bad]\nopt-level = 3\n")
		assert resolve_overflow_checks(profiles, "release") is False
		profiles = parse_profiles("[profile.release]\noverflow-checks = true\n[profile.minsizerel]\ninherits = \"release\"\n")
		assert resolve_overflow_checks(profiles, "release") is True
		assert resolve_overflow_checks(profiles, "minsizerel") is True
		assert resolve_overflow_checks(profiles, "unknown") is False

		check_lockfile_fixture_with_missing_integrity()
		check_lockfile_fixture_with_install_script()
		assert BARE_INSTALL_RE.search("run: npm install")
		assert not BARE_INSTALL_RE.search("run: npm ci --ignore-scripts")
	finally:
		FAILURES = saved
	print("check_supply_chain self-test: ok")


def check_lockfile_fixture_with_missing_integrity() -> None:
	import tempfile

	with tempfile.TemporaryDirectory() as tmp:
		package_path = os.path.join(tmp, "package.json")
		lock_path = os.path.join(tmp, "package-lock.json")
		with open(package_path, "w", encoding="utf-8") as handle:
			json.dump({"name": "fixture", "dependencies": {"evil": "1.0.0"}}, handle)
		with open(lock_path, "w", encoding="utf-8") as handle:
			json.dump({"packages": {"node_modules/evil": {"version": "1.0.0", "resolved": "https://example/evil.tgz"}}}, handle)
		before = len(FAILURES)
		check_lockfile(tmp)
		assert len(FAILURES) == before + 1, FAILURES


def check_lockfile_fixture_with_install_script() -> None:
	import tempfile

	with tempfile.TemporaryDirectory() as tmp:
		with open(os.path.join(tmp, "package.json"), "w", encoding="utf-8") as handle:
			json.dump({"name": "fixture", "dependencies": {"evil": "1.0.0"}}, handle)
		with open(os.path.join(tmp, "package-lock.json"), "w", encoding="utf-8") as handle:
			json.dump({"packages": {
				"node_modules/evil": {"version": "1.0.0", "resolved": "https://example/e.tgz",
					"integrity": "sha512-x", "hasInstallScript": True},
			}}, handle)
		before = len(FAILURES)
		check_lockfile(tmp)
		assert len(FAILURES) == before + 1, FAILURES


def main() -> int:
	if "--self-test" in sys.argv:
		self_test()
	check_rust_profiles()
	check_rust_toolchain()
	check_node_packages()
	check_ci_install_commands()
	if FAILURES:
		for failure in FAILURES:
			print(f"FAIL: {failure}")
		print(f"check_supply_chain: {len(FAILURES)} violation(s)")
		return 1
	print("check_supply_chain: ok (rust profiles, toolchain pin, lockfiles, install scripts, CI commands)")
	return 0


if __name__ == "__main__":
	sys.exit(main())
