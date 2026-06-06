#!/usr/bin/env python3
"""
Adds type="button" to every <button> JSX tag that doesn't already declare a
type. Targets the react-doctor warning "Button missing explicit type" (~185
instances across the codebase).

Safe by default: a <button> inside a <form> defaults to type="submit", which
can cause accidental form submissions on Enter or wrapping element clicks.
Arcade has no <form> elements in its components, so type="button" is the
correct default everywhere here.

Brace-aware scan: counts {} depth so attribute values like
`onClick={() => f()}` aren't terminated at the arrow's `>`.

One-shot script; not part of the build. Re-runs are idempotent.
"""

import sys
from pathlib import Path


def fix_buttons(text: str) -> tuple[str, int]:
    out: list[str] = []
    i = 0
    fixed = 0
    n = len(text)
    while i < n:
        if text.startswith("<button", i) and (i + 7 == n or text[i + 7] in " \t\n>/"):
            j = i + 7
            depth = 0
            while j < n:
                c = text[j]
                if c == "{":
                    depth += 1
                elif c == "}":
                    depth -= 1
                elif c == ">" and depth == 0:
                    break
                j += 1
            if j < n:
                block = text[i : j + 1]
                if " type=" not in block and "\ttype=" not in block and "\ntype=" not in block:
                    block = '<button type="button"' + block[len("<button"):]
                    fixed += 1
                out.append(block)
                i = j + 1
                continue
        out.append(text[i])
        i += 1
    return "".join(out), fixed


def main() -> int:
    root = Path(__file__).resolve().parents[1]
    total_fixed = 0
    touched = 0
    for d in ("app", "components"):
        for path in sorted((root / d).rglob("*.tsx")):
            text = path.read_text(encoding="utf-8")
            new, fixed = fix_buttons(text)
            if new != text:
                path.write_text(new, encoding="utf-8")
                touched += 1
                total_fixed += fixed
                print(f"Updated {path.relative_to(root)} ({fixed} button(s))")
    print(f"Done. {total_fixed} button(s) updated across {touched} file(s).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
