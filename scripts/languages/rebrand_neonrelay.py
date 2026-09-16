#!/usr/bin/env python3
"""Rebrand the translated strings in `data/languages/*.txt`.

DDNet-style language files are flat key/value blocks:

    <original English string>
    == <translation>

The original English string *is* the lookup key, so rebranding a string in the C++
source invalidates the matching translation unless the language files are updated in
lockstep.

The script is deliberately **line oriented**: it never reformats a file, it only
rewrites the lines that need it, so the diff stays reviewable and the file structure
(blank lines, ordering, author headers) is preserved byte for byte.

  * `TOKENS` is applied to every line (keys and translations), which keeps keys in sync
    with the C++ sources that were rebranded the same way.
  * `DROP_BLOCKS` lists keys whose meaning changed so much that a mechanically patched
    translation would be wrong. Those blocks are removed and the client falls back to
    English.

The script is idempotent: running it twice changes nothing the second time.

Usage:
    python3 scripts/languages/rebrand_neonrelay.py [--check] [file ...]

`--check` exits non-zero if any file would still be modified (used by CI).
"""

from __future__ import annotations

import argparse
import pathlib
import sys

LANGUAGE_DIR = pathlib.Path("data/languages")

# Ordered: longer/more specific patterns first. Each replacement must match an edit
# that was applied to the C++ sources (see docs/REBRANDING.md), otherwise the
# translation key stops matching its source string.
TOKENS: list[tuple[str, str]] = [
	("https://wiki.ddnet.org/wiki/Touch_controls", "https://github.com/Leo88q/neon-relay/blob/main/docs/ANDROID_SEEKER.md"),
	("https://wiki.ddnet.org/wiki/Mapping", "https://github.com/Leo88q/neon-relay/tree/main/docs"),
	("https://ddnet.org/discord", "https://github.com/Leo88q/neon-relay"),
	("https://wiki.ddnet.org/", "https://github.com/Leo88q/neon-relay/tree/main/docs"),
	("https://ddnet.org/downloads/", "https://github.com/Leo88q/neon-relay/releases"),
	("https://ddnet.org/", "https://github.com/Leo88q/neon-relay"),
	("info.ddnet.org", "the configured info service"),
	("settings_ddnet.cfg", "settings_neonrelay.cfg"),
	("ddnet-serverlist-urls.cfg", "neonrelay-serverlist-urls.cfg"),
	("ddnet-server.sqlite", "neonrelay-server.sqlite"),
	("DDNet Wiki", "Neon Relay documentation"),
	("DDraceNetwork", "Neon Relay"),
	("DDNet-Client", "Neon Relay client"),
	("DDNet Client", "Neon Relay client"),
	("DDNet", "Neon Relay"),
	("DDRace HUD", "Race HUD"),
]

# Keys whose translation is dropped because the meaning changed (the client then shows
# the English string, which is correct but untranslated).
DROP_BLOCKS: set[str] = {
	# The button no longer opens Discord, it opens the project page.
	"Discord",
	# "Open DDNet Wiki" became a generic documentation link.
	"Open DDNet Wiki",
	# The Wiki reference at the end of the paragraph was rewritten.
	"You can manage your touch controls settings on this page. Only changes that are saved will be available after restarting the client. You can share your touch controls with others by exporting them to the clipboard.\\n\\nYou can find more detailed information about the touch controls on the DDNet Wiki.",
	# The sentence now talks about the server browser generally, not about DDNet maps.
	"Show DDNet map finishes in server browser",
	"transmits your player name to info.ddnet.org",
	# "DDRace HUD" is now "Race HUD"; existing translations say "DDRace-HUD".
	"DDRace HUD",
	"Show DDRace HUD",
	# Note: the first-launch paragraph and the restart warning keep their translations,
	# because token substitution produces a correct sentence in every language.
}

# Keys that are rewritten verbatim (instead of by token substitution) because the C++
# source string changed in a way tokens cannot express.
KEY_REWRITES: dict[str, str] = {
	"Welcome to DDNet": "Welcome to Neon Relay",
	"Loading DDNet Client": "Loading Neon Relay",
	"DDNet": "Neon Relay",
	"DDNet %s is available:": "Neon Relay %s is available:",
	"DDNet %s is out!": "Neon Relay %s is out!",
	"DDNet Client updated!": "Neon Relay client updated!",
	"DDNet Client needs to be restarted to complete update!": "Neon Relay needs to be restarted to complete the update!",
	"Show DDNet map finishes in server browser": "Show map finishes in server browser",
	"transmits your player name to info.ddnet.org": "transmits your player name to the configured info service",
	"DDraceNetwork is a cooperative online game where the goal is for you and your group of tees to reach the finish line of the map. As a newcomer you should start on Novice servers, which host the easiest maps. Consider the ping to choose a server close to you.": "Neon Relay is a cooperative online game where the goal is for you and your group of tees to reach the finish line of the map. As a newcomer you should start on Novice servers, which host the easiest maps. Consider the ping to choose a server close to you.",
	"DDRace HUD": "Race HUD",
	"Show DDRace HUD": "Show race HUD",
	"Open DDNet Wiki": "Open documentation",
	"Discord": "Community",
}


def apply_tokens(text: str) -> str:
	for old, new in TOKENS:
		text = text.replace(old, new)
	return text


def rebrand(content: str) -> tuple[str, int, int]:
	lines = content.split("\n")
	out: list[str] = []
	changed_blocks = 0
	dropped_blocks = 0
	i = 0
	while i < len(lines):
		line = lines[i]
		is_key = bool(line.strip()) and not line.startswith("== ") and not line.startswith("#")
		if is_key and i + 1 < len(lines) and lines[i + 1].startswith("== "):
			j = i + 1
			translations: list[str] = []
			while j < len(lines) and lines[j].startswith("== "):
				translations.append(lines[j])
				j += 1
			if line in DROP_BLOCKS:
				dropped_blocks += 1
				i = j
				# also drop one following blank separator line
				if i < len(lines) and not lines[i].strip():
					i += 1
				continue
			new_key = KEY_REWRITES.get(line, apply_tokens(line))
			new_translations = [apply_tokens(t) for t in translations]
			if new_key != line or new_translations != translations:
				changed_blocks += 1
			out.append(new_key)
			out.extend(new_translations)
			i = j
			continue
		out.append(apply_tokens(line))
		i += 1
	return "\n".join(out), changed_blocks, dropped_blocks


def main() -> int:
	parser = argparse.ArgumentParser(description=__doc__)
	parser.add_argument("--check", action="store_true", help="exit non-zero if files would change")
	parser.add_argument("paths", nargs="*", help="language files (default: all of data/languages/*.txt)")
	args = parser.parse_args()

	paths = [pathlib.Path(p) for p in args.paths] if args.paths else sorted(LANGUAGE_DIR.glob("*.txt"))
	paths = [p for p in paths if p.name not in {"license.txt", "README.txt"}]

	total_changed = 0
	total_dropped = 0
	dirty: list[str] = []
	for path in paths:
		old_content = path.read_text(encoding="utf-8")
		new_content, changed, dropped = rebrand(old_content)
		if new_content != old_content:
			dirty.append(str(path))
			total_changed += changed
			total_dropped += dropped
			if not args.check:
				path.write_text(new_content, encoding="utf-8")

	if args.check:
		if dirty:
			print(f"FAIL: {len(dirty)} language file(s) still contain upstream branding:")
			for path in dirty:
				print(f"  {path}")
			return 1
		print(f"OK: {len(paths)} language files are rebranded")
		return 0

	print(f"rebranded {len(dirty)}/{len(paths)} language files "
		f"({total_changed} blocks changed, {total_dropped} blocks dropped)")
	return 0


if __name__ == "__main__":
	sys.exit(main())
