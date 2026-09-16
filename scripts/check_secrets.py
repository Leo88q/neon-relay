#!/usr/bin/env python3
"""Neon Relay secret scanner (CI gate).

Scans tracked text files for credential-shaped material that must never be
committed: private keys, wallet keypairs, provider tokens, cloud keys and
Ed25519 signing seeds in a secret context.

Design notes:
  * stdlib only, deterministic, no network;
  * scans `git ls-files` (falls back to a filtered os.walk outside a repo);
  * documented TEST-ONLY vectors are allowlisted by exact value — currently
    the stage-8 harness seed `deadbeef`×8 (a public fixture, see
    scripts/neonrelay_signer_test.sh and docs/REWARD_SECURITY.md §9);
  * a line carrying the token NEONRELAY-SECRET-SCAN-ALLOW is skipped (used by
    this file's own self-test fixtures);
  * `--self-test` verifies the detector catches every pattern and honours the
    allowlist, so a broken scanner cannot silently pass CI.

Exit code: 0 = clean, 1 = findings, 2 = tool/self-test error.
"""
from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys

ALLOW_LINE_TOKEN = "NEONRELAY-SECRET-SCAN-ALLOW"

# Documented public test fixtures (never production secrets).
ALLOWED_VALUES = {
	"deadbeef" * 8,  # stage-8 signer harness TEST-ONLY seed
}

# name -> (regex, description)
PATTERNS: dict[str, tuple[re.Pattern, str]] = {
	"pem-private-key": (
		re.compile(r"-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----"),
		"PEM private key block"),
	"openssh-private-key": (
		re.compile(r"-----BEGIN OPENSSH PRIVATE KEY-----"),
		"OpenSSH private key"),
	"aws-access-key": (
		re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b"),
		"AWS access key id"),
	"github-token": (
		re.compile(r"\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{22,}\b"),
		"GitHub token"),
	"slack-token": (
		re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,}\b"),
		"Slack token"),
	"google-api-key": (
		re.compile(r"\bAIza[0-9A-Za-z\-_]{35}\b"),
		"Google API key"),
	"openai-key": (
		re.compile(r"\bsk-(?:proj-|ant-)?[A-Za-z0-9\-_]{24,}\b"),
		"OpenAI/Anthropic-style secret key"),
	"solana-keypair-json": (
		re.compile(r"\[\s*\d{1,3}(?:\s*,\s*\d{1,3}){31,}\s*\]"),
		"Solana keypair-shaped byte array (32/64 numbers)"),
	"hex64-seed-context": (
		re.compile(
			r"(?i)\b(?:seed(?:[_ \-]?hex|[_ \-]?phrase)?|private[_ \-]?key|secret[_ \-]?key|signing[_ \-]?key)\b"
			r"[^\n]{0,60}\b([0-9a-fA-F]{64})\b"),
		"64-hex-char key/seed material in a secret context"),
}

# Tracked paths that look like credential files regardless of content.
BAD_PATH_PATTERNS = [
	re.compile(r"(?:^|/)id\.json$"),                      # solana-cli wallet
	re.compile(r"\.(?:pem|p12|pfx|keystore|keypair)$"),    # key stores
	re.compile(r"(?:^|)(?:\.?env\.(?:local|prod|production|secret))$"),
]

MAX_LINE_LEN = 20000


def tracked_files(root: str) -> list[str]:
	try:
		out = subprocess.run(["git", "ls-files", "-z"], cwd=root, capture_output=True,
			check=True).stdout
		files = [p for p in out.decode("utf-8", "replace").split("\0") if p]
		if files:
			return files
	except (OSError, subprocess.CalledProcessError):
		pass
	# fallback: walk, skipping VCS/dependency/build dirs
	skip_dirs = {".git", "node_modules", ".gradle", "build", "target", "__pycache__"}
	files = []
	for dirpath, dirnames, filenames in os.walk(root):
		dirnames[:] = [d for d in dirnames if d not in skip_dirs]
		for name in filenames:
			full = os.path.join(dirpath, name)
			files.append(os.path.relpath(full, root))
	return files


def is_binary(path: str) -> bool:
	try:
		with open(path, "rb") as f:
			chunk = f.read(8192)
		return b"\0" in chunk
	except OSError:
		return True


def scan_line(line: str) -> list[str]:
	if ALLOW_LINE_TOKEN in line:
		return []
	findings = []
	for name, (pattern, description) in PATTERNS.items():
		for match in pattern.finditer(line):
			value = match.group(match.lastindex) if match.lastindex else match.group(0)
			if value in ALLOWED_VALUES:
				continue
			findings.append(f"{name}: {description}")
	return findings


def scan_tree(root: str) -> tuple[list[str], list[str]]:
	content_findings: list[str] = []
	path_findings: list[str] = []
	for rel in tracked_files(root):
		full = os.path.join(root, rel)
		if any(p.search(rel) for p in BAD_PATH_PATTERNS):
			path_findings.append(f"{rel}: credential-shaped file path must not be committed")
			continue
		if not os.path.isfile(full) or is_binary(full):
			continue
		try:
			with open(full, "r", encoding="utf-8", errors="replace") as f:
				for lineno, line in enumerate(f, start=1):
					if len(line) > MAX_LINE_LEN:
						continue
					for finding in scan_line(line):
						content_findings.append(f"{rel}:{lineno}: {finding}")
		except OSError:
			continue
	return content_findings, path_findings


SELF_TEST_FIXTURES = [
	("pem-private-key", "-----BEGIN EC PRIVATE KEY-----"),
	("openssh-private-key", "-----BEGIN OPENSSH PRIVATE KEY-----"),
	("aws-access-key", "aws_id = AKIAIOSFODNN7EXAMPLE"),
	("github-token", "token: ghp_" + "A" * 36),
	("slack-token", "xoxb-123456789012-abcdefghijklmnop"),
	("google-api-key", "AIza" + "a" * 35),
	("openai-key", "sk-proj-" + "b" * 30),
	("solana-keypair-json", "[" + ",".join(str(i % 256) for i in range(64)) + "]"),
	("hex64-seed-context", 'SEED_HEX="' + "0f" * 32 + '"'),
	("hex64-seed-context", 'signing seed = ' + "1a" * 32),
]


def self_test() -> int:
	failures = 0
	for name, fixture in SELF_TEST_FIXTURES:
		# fixtures must NOT carry the allow token — the detector has to fire
		found = scan_line(fixture)
		if not any(f.startswith(name) for f in found):
			print(f"SELF-TEST FAIL: pattern {name!r} not detected in {fixture[:48]!r}", file=sys.stderr)
			failures += 1
	# allowlist must neutralise the documented test vector
	allowed_line = 'SEED_HEX="' + "deadbeef" * 8 + '"  # TEST-ONLY signing seed'
	if scan_line(allowed_line):
		print("SELF-TEST FAIL: documented test-only seed was flagged", file=sys.stderr)
		failures += 1
	# allow-token lines must be skipped
	token_line = 'private_key = "' + "0f" * 32 + f'" {ALLOW_LINE_TOKEN}'
	if scan_line(token_line):
		print("SELF-TEST FAIL: allow-token line was flagged", file=sys.stderr)
		failures += 1
	# benign content must pass
	benign = [
		"sha256 of asset: " + "ab" * 32,
		"PDA seeds: neonrelay_config, neonrelay_epoch",
		"leaf = SHA256(pubkey || amount.to_be_bytes())",
	]
	for line in benign:
		if scan_line(line):
			print(f"SELF-TEST FAIL: benign line flagged: {line[:60]!r}", file=sys.stderr)
			failures += 1
	if failures:
		print(f"secret-scan self-test: {failures} failure(s)", file=sys.stderr)
		return 2
	print("secret-scan self-test: PASS (all patterns detected, allowlist honoured)")
	return 0


def main() -> int:
	parser = argparse.ArgumentParser(description="Neon Relay secret scanner")
	parser.add_argument("--self-test", action="store_true",
		help="verify the detector against synthetic fixtures and exit")
	parser.add_argument("--root", default=None, help="repository root (default: script's parent)")
	args = parser.parse_args()

	if args.self_test:
		return self_test()

	root = args.root or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
	content_findings, path_findings = scan_tree(root)
	findings = content_findings + path_findings
	if findings:
		print(f"secret scan: {len(findings)} finding(s):", file=sys.stderr)
		for finding in findings:
			print(f"  {finding}", file=sys.stderr)
		print("If a finding is a documented public test fixture, add its exact value to",
			file=sys.stderr)
		print("ALLOWED_VALUES in scripts/check_secrets.py with a comment explaining why.",
			file=sys.stderr)
		return 1
	print("secret scan: PASS (no credential-shaped material in tracked files)")
	return 0


if __name__ == "__main__":
	sys.exit(main())
