#!/usr/bin/env python3
"""Targeted mutation testing for security-critical backend modules.

A mutation test answers the question a green suite cannot: *would this test
suite notice if the security check were quietly broken?* For each target
module the runner applies one small semantic break at a time (comparison flip,
boolean flip, dropped negation, dropped guard, off-by-one), re-runs the mapped
`node --test` files, and requires the mutant to be KILLED (suite goes red).
A mutant that survives means the mapped tests do not actually pin that line.

Scope is deliberately narrow and dependency-free (stdlib + the same Node the
backend already needs): no Stryker/PITest install, nothing to audit. The
target list is the reward/auth surface — the place where "the test was
decorative" is expensive.

Usage:
  python3 scripts/mutation_test.py                 # full run, gate at --threshold
  python3 scripts/mutation_test.py --smoke         # capped run for CI (~1-2 min)
  python3 scripts/mutation_test.py --module crypto.ts --list
  python3 scripts/mutation_test.py --module admin.ts --seed 3

Exit code: 0 when every module's kill rate is >= --threshold and the baseline
suite passed; 1 otherwise.
"""
from __future__ import annotations

import argparse
import random
import re
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BACKEND = ROOT / "backend"

# module -> mapped test files (run with node --test from backend/)
MODULES: dict[str, list[str]] = {
    "src/ai_guard.ts": ["test/agentic_guard.test.ts"],
    "src/crypto.ts": ["test/crypto.test.ts"],
    "src/sessions.ts": ["test/sessions.test.ts"],
    "src/admin.ts": ["test/admin.test.ts"],
    "src/tool_registry.ts": ["test/agentic_guard.test.ts"],
    "src/http.ts": ["test/http.test.ts", "test/ratelimit.test.ts"],
    "src/watchtower.ts": ["test/watchtower.test.ts", "test/agentic_guard.test.ts"],
}

CMP = re.compile(r"===|!==")
BOOL = re.compile(r"\b(true|false)\b")
DROP_NOT_IF = re.compile(r"if \(!")
DROP_NOT_RETURN = re.compile(r"return !")
AND_OR = re.compile(r"&&|\|\|")
GUARD_LINE = re.compile(r"^\s*if \([^;]+\)\s+(return\s+[^;]+|throw\s+[^;]+);\s*$")
BARE_INT = re.compile(r"(?<![\w.$\"'`])(\d+)(?![\w.])")
SKIP_LINE = re.compile(r"^\s*(//|\*|/\*|import |export type|export interface|interface |type )")


@dataclass
class Mutant:
    module: str
    line_no: int  # 1-based
    operator: str
    before: str
    after: str


def _first_sub(pattern: re.Pattern[str], repl, line: str) -> str | None:
    """Replace the first match on the line; None when the line has no match."""
    if SKIP_LINE.match(line):
        return None
    new, n = pattern.subn(repl, line, count=1)
    return new if n else None


def mutate_line(module: str, line_no: int, line: str) -> list[Mutant]:
    out: list[Mutant] = []

    def add(operator: str, after: str | None) -> None:
        if after is not None and after != line:
            out.append(Mutant(module, line_no, operator, line, after))

    # cmp-flip: === <-> !== (never touch => or ==)
    new = line
    m = CMP.search(line)
    if m and not SKIP_LINE.match(line):
        swapped = "!==" if m.group(0) == "===" else "==="
        new = line[: m.start()] + swapped + line[m.end() :]
        add("cmp-flip", new)

    # bool-flip: first true/false on an assignment/return/comparison line
    m = BOOL.search(line)
    if m and re.search(r"(return|=|===|!==|\?)", line) and not SKIP_LINE.match(line):
        flipped = "false" if m.group(0) == "true" else "true"
        add("bool-flip", line[: m.start()] + flipped + line[m.end() :])

    # drop-not: remove a leading negation in a condition or return
    add("drop-not", _first_sub(DROP_NOT_IF, "if (", line))
    add("drop-not", _first_sub(DROP_NOT_RETURN, "return ", line))

    # and-or: && <-> ||
    m = AND_OR.search(line)
    if m and not SKIP_LINE.match(line):
        swapped = "||" if m.group(0) == "&&" else "&&"
        add("and-or", line[: m.start()] + swapped + line[m.end() :])

    # guard-drop: comment out a complete single-line guard
    if GUARD_LINE.match(line):
        add("guard-drop", re.sub(r"if \(", "if (false && (", line))

    # num-nudge: first bare integer on a comparison line -> +1. Skips loop
    # headers (index noise) and contract doc examples (no behavior).
    if re.search(r"===|!==|<=|>=|<|>", line) and not SKIP_LINE.match(line):
        if "for (" not in line and not re.search(r"\b(example|sample)\s*:", line):
            m = BARE_INT.search(line)
            if m and not re.search(r"https?://|version|0x", line, re.I):
                bumped = str(int(m.group(1)) + 1)
                add("num-nudge", line[: m.start()] + bumped + line[m.end() :])

    return out


def generate(module: str, source: str) -> list[Mutant]:
    mutants: list[Mutant] = []
    for i, line in enumerate(source.splitlines(), start=1):
        mutants.extend(mutate_line(module, i, line))
    return mutants


def run_suite(test_files: list[str], timeout: int) -> tuple[bool, str]:
    proc = subprocess.run(
        ["node", "--experimental-strip-types", "--test", *test_files],
        cwd=BACKEND,
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    return proc.returncode == 0, (proc.stdout + proc.stderr)[-2000:]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--module", help="run only one target module (suffix match, e.g. crypto.ts)")
    ap.add_argument("--smoke", action="store_true", help="capped run for CI: 4 mutants per module, cheapest operators")
    ap.add_argument("--max-mutants", type=int, help="cap mutants per module (default: smoke 4, full 25)")
    ap.add_argument("--seed", type=int, default=20260928, help="mutant sampling seed")
    ap.add_argument("--threshold", type=float, default=0.90,
                    help="minimum total kill rate to exit 0 (default 0.90; ratchet upward as survivors get pinned)")
    ap.add_argument("--timeout", type=int, default=120, help="seconds per test-suite run")
    ap.add_argument("--list", action="store_true", help="list planned mutants without running tests")
    args = ap.parse_args()

    modules = {k: v for k, v in MODULES.items() if args.module is None or k.endswith(args.module)}
    if not modules:
        print(f"no module matches {args.module!r}; known: {', '.join(MODULES)}")
        return 2

    cap = args.max_mutants or (4 if args.smoke else 25)
    cheapest = {"cmp-flip", "bool-flip", "drop-not", "guard-drop"}
    rng = random.Random(args.seed)

    print(f"mutation_test: {len(modules)} module(s), cap {cap} mutants/module, threshold {args.threshold:.2f}")

    # Baseline: the mapped suites must be green before we mutate anything.
    if not args.list:
        for module, tests in modules.items():
            ok, tail = run_suite(tests, args.timeout)
            if not ok:
                print(f"BASELINE FAILED for {module} ({' '.join(tests)}); fix the suite first.")
                print(tail)
                return 1
        print("baseline: all mapped suites green\n")

    total_killed = total = 0
    for module, tests in modules.items():
        source = (BACKEND / module).read_text(encoding="utf-8")
        mutants = generate(module, source)
        if args.smoke:
            pool = [m for m in mutants if m.operator in cheapest] or mutants
            rng.shuffle(pool)
            chosen = pool[:cap]
        else:
            rng.shuffle(mutants)
            chosen = mutants[:cap]

        if args.list:
            for m in chosen:
                print(f"  {module}:{m.line_no} [{m.operator}] {m.before.strip()[:70]}")
            continue

        killed = survived = 0
        survivors: list[Mutant] = []
        path = BACKEND / module
        original = source
        started = time.time()
        for m in chosen:
            mutated_lines = original.splitlines()
            mutated_lines[m.line_no - 1] = m.after
            path.write_text("\n".join(mutated_lines) + "\n", encoding="utf-8")
            try:
                ok, _ = run_suite(tests, args.timeout)
            except subprocess.TimeoutExpired:
                ok = False  # hung suite counts as killed: it did not pass
            finally:
                path.write_text(original, encoding="utf-8")
            if ok:
                survived += 1
                survivors.append(m)
            else:
                killed += 1
        total += killed + survived
        total_killed += killed
        rate = killed / (killed + survived) if (killed + survived) else 1.0
        status = "PASS" if rate >= args.threshold else "LOW"
        print(f"[{status}] {module}: {killed}/{killed + survived} killed ({rate:.0%}) in {time.time() - started:.0f}s")
        for m in survivors:
            print(f"    SURVIVED {module}:{m.line_no} [{m.operator}] {m.before.strip()[:90]}")

    if args.list:
        return 0
    total_rate = total_killed / total if total else 1.0
    print(f"\ntotal: {total_killed}/{total} mutants killed ({total_rate:.0%})")
    if total_rate < args.threshold:
        print(f"mutation_test: FAIL — total kill rate {total_rate:.0%} < threshold {args.threshold:.0%}")
        return 1
    print("mutation_test: PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
