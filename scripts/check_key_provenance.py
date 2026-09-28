#!/usr/bin/env python3
"""Key-provenance gate (catalog 2026, items 99, 120, 121, 125, 126).

Every authority, treasury and signing key must have a written provenance
record — device, firmware, entropy source, generation date, custody scheme,
location — and that record must *pass rules*, not just exist:

* 99/126 — entropy: only hardware/CS PRNG or externally mixed entropy is
  allowed for real keys; a weak `software-prng` is refused outside dev/test
  roles. A firmware rollback to a software RNG (Coldcard, 2026) is exactly
  what this catches when the vendor's affected range is listed.
* 120/121 — custody: authority and treasury keys cannot be single-signature
  members; a multisig must not be breakable by one compromising factor
  (all signers on the same device model, vendor or location).
* 125 — physical coercion: duress resistance is a property of the *layout*
  (signers in distinct locations, threshold > 1), checked here.
* 126 — rotation: keys past `rotation_due`, or from affected firmware, or
  marked compromised without a rotation record, fail the gate.

Usage:
  python3 scripts/check_key_provenance.py [--file ops/key_provenance.example.json]
                                          [--now YYYY-MM-DD] [--self-test]
Exit 0 = clean; 1 = violations. Never reads, derives or stores key material:
fingerprints are operator-recorded identifiers, not secrets.
"""

from __future__ import annotations

import json
import os
import re
import sys
from datetime import date

os.chdir(os.path.dirname(os.path.abspath(__file__)) + "/..")

DEFAULT_FILE = "ops/key_provenance.example.json"
ALLOWED_ENTROPY = {"hardware-csprng", "csprng", "csprng+external-dice", "hardware-csprng+external-dice"}
PRIVILEGED_ROLES = {"authority", "treasury-signer", "program-upgrade-authority", "backend-signing-seed"}
DEV_ROLES = {"devnet-test", "local-only"}

FAILURES: list[str] = []


def fail(message: str) -> None:
	FAILURES.append(message)


def parse_date(value: str) -> date | None:
	if not isinstance(value, str):
		return None
	parts = value[:10].split("-")
	if len(parts) != 3 or not all(p.isdigit() for p in parts):
		return None
	try:
		return date(int(parts[0]), int(parts[1]), int(parts[2]))
	except ValueError:
		return None


def version_tuple(value: str) -> tuple[int, ...] | None:
	if not isinstance(value, str):
		return None
	numbers = re.findall(r"\d+", value)
	if not numbers:
		return None
	return tuple(int(number) for number in numbers[:4])


def firmware_affected(device: dict, rules: list[dict]) -> str | None:
	vendor = str(device.get("vendor", ""))
	model = str(device.get("model", ""))
	firmware = str(device.get("firmware", ""))
	for rule in rules:
		if rule.get("vendor") and rule["vendor"].lower() != vendor.lower():
			continue
		if rule.get("model_regex") and not re.search(rule["model_regex"], model):
			continue
		threshold = version_tuple(str(rule.get("firmware_below", "")))
		current = version_tuple(firmware)
		if threshold is None or current is None:
			continue
		# Equal-length comparison: pad the shorter tuple with zeros.
		length = max(len(threshold), len(current))
		threshold += (0,) * (length - len(threshold))
		current += (0,) * (length - len(current))
		if current < threshold:
			return f"{rule.get('id', rule.get('vendor', 'firmware'))}: {rule.get('reason', 'affected firmware range')}"
	return None


def validate(manifest: dict, now: date) -> None:
	if manifest.get("schema_version") != 1:
		fail("manifest: schema_version must be 1")
	keys = manifest.get("keys")
	if not isinstance(keys, list) or not keys:
		fail("manifest: at least one key record is required")
		return
	bad_firmware = manifest.get("known_bad_firmware", [])
	seen_fingerprints: dict[str, str] = {}
	multisigs: dict[str, list[dict]] = {}

	for index, key in enumerate(keys):
		where = key.get("id") or f"keys[{index}]"
		role = key.get("role")
		status = key.get("status", "active")
		if role not in PRIVILEGED_ROLES | DEV_ROLES | {"devnet-test"}:
			fail(f"{where}: unknown role '{role}'")
		fingerprint = key.get("fingerprint")
		if not isinstance(fingerprint, str) or len(fingerprint) < 8:
			fail(f"{where}: fingerprint is required (an operator-recorded identifier, never a secret)")
		elif fingerprint in seen_fingerprints:
			fail(f"{where}: duplicate fingerprint, also used by {seen_fingerprints[fingerprint]} (item 99)")
		else:
			seen_fingerprints[fingerprint] = where

		device = key.get("device") or {}
		if not device.get("vendor") or not device.get("model"):
			fail(f"{where}: device vendor and model are required (item 126: provenance, not memory)")
		affected = firmware_affected(device, bad_firmware)
		if affected and status == "active":
			fail(f"{where}: active key on affected firmware — {affected} (item 126)")

		entropy = (key.get("entropy") or {}).get("source")
		if entropy not in ALLOWED_ENTROPY and role not in DEV_ROLES:
			fail(f"{where}: entropy source '{entropy}' is not acceptable for role '{role}' (items 99/126)")

		generated = parse_date(key.get("generated_at", ""))
		if generated is None:
			fail(f"{where}: generated_at must be an ISO date (item 126)")
		elif generated > now:
			fail(f"{where}: generated_at is in the future")

		rotation_due = parse_date(key.get("rotation_due", ""))
		if rotation_due is None:
			fail(f"{where}: rotation_due must be an ISO date")
		elif rotation_due < now and status == "active":
			fail(f"{where}: rotation_due {rotation_due.isoformat()} has passed (item 126)")

		if status == "compromised" and not key.get("rotated_at"):
			fail(f"{where}: compromised key without rotated_at — rotate before closing the incident (item 126)")
		if status not in {"active", "compromised", "migrated", "retired"}:
			fail(f"{where}: unknown status '{status}'")

		scheme = key.get("scheme")
		if scheme == "single" and role in PRIVILEGED_ROLES:
			fail(f"{where}: single-signature key for privileged role '{role}' (items 120/121/125)")
		if scheme == "multisig-member":
			multisig = key.get("multisig") or {}
			name = multisig.get("name")
			threshold = multisig.get("threshold")
			total = multisig.get("total")
			if not name or not isinstance(threshold, int) or not isinstance(total, int):
				fail(f"{where}: multisig name/threshold/total required")
			elif threshold < 2:
				fail(f"{where}: multisig threshold {threshold} < 2 — one compromised signer moves funds (item 121)")
			elif threshold > total:
				fail(f"{where}: threshold {threshold} exceeds total {total}")
			else:
				multisigs.setdefault(name, []).append(key)

	for name, members in multisigs.items():
		active = [member for member in members if member.get("status", "active") == "active"]
		threshold = int((active[0].get("multisig") or {}).get("threshold", 0)) if active else 0
		if threshold <= 1:
			continue
		devices = {(m.get("device") or {}).get("vendor") for m in active}
		models = {((m.get("device") or {}).get("vendor"), (m.get("device") or {}).get("model")) for m in active}
		locations = {m.get("location") for m in active}
		if len(devices) < 2:
			fail(f"multisig '{name}': all signers on one device vendor — a single vendor flaw reaches threshold (item 121)")
		if len(models) < min(threshold, len(active)):
			fail(f"multisig '{name}': signers share device models; one model compromise can reach the threshold (item 126)")
		if len(locations) < 2:
			fail(f"multisig '{name}': all signers in one location — one physical incident reaches threshold (item 125)")


def load(path: str) -> dict:
	with open(path, "r", encoding="utf-8") as handle:
		return json.load(handle)


# ------------------------------------------------------------------ self-test

def _run(manifest: dict, now: date) -> list[str]:
	global FAILURES
	saved = FAILURES
	FAILURES = []
	try:
		validate(manifest, now)
		return list(FAILURES)
	finally:
		FAILURES = saved


def _key(**overrides) -> dict:
	key = {
		"id": "treasury-signer-a",
		"role": "treasury-signer",
		"fingerprint": "sha256:aaaa1111",
		"scheme": "multisig-member",
		"multisig": {"name": "Squads treasury", "threshold": 3, "total": 5},
		"device": {"vendor": "Coldcard", "model": "Mk4", "firmware": "5.4.1", "os": "firmware"},
		"entropy": {"source": "hardware-csprng"},
		"generated_at": "2026-05-01",
		"rotation_due": "2027-05-01",
		"location": "safe-eu-1",
		"status": "active",
	}
	key.update(overrides)
	return key


def self_test() -> None:
	now = date(2026, 9, 28)
	good = {"schema_version": 1, "known_bad_firmware": [], "keys": [
		_key(location="safe-eu-1", fingerprint="sha256:aaa"),
		_key(id="treasury-signer-b", fingerprint="sha256:bbb", location="safe-eu-2",
			device={"vendor": "Trezor", "model": "Safe 3", "firmware": "2.8.1", "os": "firmware"}),
		_key(id="treasury-signer-c", fingerprint="sha256:ccc", location="safe-us-1",
			device={"vendor": "Ledger", "model": "Stax", "firmware": "1.5.0", "os": "firmware"}),
	]}
	assert _run(good, now) == [], _run(good, now)

	duplicate = json.loads(json.dumps(good))
	duplicate["keys"][1]["fingerprint"] = "sha256:aaa"
	assert any("duplicate fingerprint" in message for message in _run(duplicate, now))

	single = json.loads(json.dumps(good))
	single["keys"][0]["scheme"] = "single"
	single["keys"][0].pop("multisig")
	assert any("single-signature" in message for message in _run(single, now))

	weak = json.loads(json.dumps(good))
	weak["keys"][0]["entropy"]["source"] = "software-prng"
	assert any("entropy source" in message for message in _run(weak, now))

	affected_manifest = {
		"schema_version": 1,
		"known_bad_firmware": [{
			"id": "CC-2026-01", "vendor": "Coldcard", "model_regex": "Mk[2345].*",
			"firmware_below": "5.0.0", "reason": "seed generator rolled back to a software PRNG",
		}],
		"keys": [_key(device={"vendor": "Coldcard", "model": "Mk3", "firmware": "4.1.9", "os": "firmware"})],
	}
	assert any("affected firmware" in message for message in _run(affected_manifest, now))

	overdue = json.loads(json.dumps(good))
	overdue["keys"][0]["rotation_due"] = "2026-01-01"
	assert any("has passed" in message for message in _run(overdue, now))

	same_location = json.loads(json.dumps(good))
	same_location["keys"][1]["location"] = "safe-eu-1"
	same_location["keys"][2]["location"] = "safe-eu-1"
	assert any("one location" in message for message in _run(same_location, now))

	same_vendor = json.loads(json.dumps(good))
	same_vendor["keys"][1]["device"] = {"vendor": "Coldcard", "model": "Mk5", "firmware": "5.4.1", "os": "firmware"}
	same_vendor["keys"][2]["device"] = {"vendor": "Coldcard", "model": "Q", "firmware": "5.4.1", "os": "firmware"}
	assert any("one device vendor" in message for message in _run(same_vendor, now))

	compromised = json.loads(json.dumps(good))
	compromised["keys"][0]["status"] = "compromised"
	assert any("without rotated_at" in message for message in _run(compromised, now))

	low_threshold = json.loads(json.dumps(good))
	low_threshold["keys"][0]["multisig"]["threshold"] = 1
	assert any("threshold 1 < 2" in message for message in _run(low_threshold, now))

	print("check_key_provenance self-test: ok")


def main() -> int:
	argv = sys.argv[1:]
	path = DEFAULT_FILE
	if "--file" in argv:
		path = argv[argv.index("--file") + 1]
	now = date.today()
	if "--now" in argv:
		parsed = parse_date(argv[argv.index("--now") + 1])
		if parsed is None:
			print("--now must be YYYY-MM-DD")
			return 1
		now = parsed
	if "--self-test" in argv:
		self_test()
	if not os.path.exists(path):
		print(f"FAIL: {path} is missing — key provenance must be recorded before mainnet (item 126)")
		return 1
	validate(load(path), now)
	if FAILURES:
		for message in FAILURES:
			print(f"FAIL: {message}")
		print(f"check_key_provenance: {len(FAILURES)} violation(s) in {path}")
		return 1
	print(f"check_key_provenance: ok ({path})")
	return 0


if __name__ == "__main__":
	sys.exit(main())
