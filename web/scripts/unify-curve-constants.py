#!/usr/bin/env python3
"""
ARCH-002 cleanup: replace every local CURVE_SUPPLY / GRADUATION_USDC variant
with the single source of truth in @/lib/constants.

Idempotent. Run once; the local consts get deleted and replaced by an
import. Subsequent runs are no-ops because the imports are already there.
"""

import re
import sys
from pathlib import Path

# (file path relative to web/, list of (local_name, canonical_name))
TARGETS = [
    ("app/launchpad/page.tsx", [
        ("CURVE_SUPPLY", "LAUNCHPAD_CURVE_SUPPLY"),
        ("ARC_HOOK_CURVE_SUPPLY", "LAUNCHPAD_CURVE_SUPPLY"),
        ("ARC_HOOK_GRAD_USDC", "LAUNCHPAD_GRADUATION_USDC"),
    ]),
    ("app/launchpad/v4hook/list/page.tsx", [
        ("CURVE_SUPPLY", "LAUNCHPAD_CURVE_SUPPLY"),
        ("GRAD_USDC", "LAUNCHPAD_GRADUATION_USDC"),
    ]),
    ("app/launchpad/v4hook/[address]/page.tsx", [
        ("CURVE_SUPPLY", "LAUNCHPAD_CURVE_SUPPLY"),
        ("GRADUATION_USDC", "LAUNCHPAD_GRADUATION_USDC"),
    ]),
    ("app/launchpad/[address]/page.tsx", [
        ("CURVE_SUPPLY", "LAUNCHPAD_CURVE_SUPPLY"),
        ("MIGRATION_TARGET_FALLBACK", "LAUNCHPAD_GRADUATION_USDC"),
    ]),
    ("app/my-tokens/page.tsx", [
        ("CURVE_SUPPLY", "LAUNCHPAD_CURVE_SUPPLY"),
        ("V4_GRAD_USDC", "LAUNCHPAD_GRADUATION_USDC"),
    ]),
]


def patch(path: Path, renames: list[tuple[str, str]]):
    text = path.read_text(encoding="utf-8")
    original = text

    # 1. Strip every local const declaration (CURVE_SUPPLY|... = NNN * 10n ** XX)
    for local, _ in renames:
        text = re.sub(
            rf"^const {re.escape(local)}\s*=.*?;\s*\n",
            "",
            text,
            flags=re.MULTILINE,
        )

    # 2. Rewrite every reference of the local name to the canonical one
    for local, canon in renames:
        # Word-boundary so e.g. ARC_HOOK_CURVE_SUPPLY doesn't get touched by
        # the CURVE_SUPPLY rename in files where both exist.
        text = re.sub(rf"\b{re.escape(local)}\b", canon, text)

    if text == original:
        return False

    # 3. Make sure the imports are present. We only need the canonical
    #    names that were used; collect them and merge into the existing
    #    @/lib/constants import line.
    needed = sorted(
        {canon for _, canon in renames if re.search(rf"\b{re.escape(canon)}\b", text)}
    )
    if needed:
        import_re = re.compile(
            r"import\s+\{([^}]*)\}\s+from\s+\"@/lib/constants\";",
            re.DOTALL,
        )
        m = import_re.search(text)
        if m:
            existing = {s.strip() for s in m.group(1).split(",") if s.strip()}
            existing.update(needed)
            new_import = (
                "import { " + ", ".join(sorted(existing)) + " } from \"@/lib/constants\";"
            )
            text = import_re.sub(new_import, text, count=1)
        else:
            # No existing constants import - add a new line after the first
            # `"use client";` or at the top.
            insertion = (
                f"import {{ {', '.join(needed)} }} from \"@/lib/constants\";\n"
            )
            text = re.sub(
                r'(^"use client";\s*\n)',
                rf"\1{insertion}",
                text,
                count=1,
                flags=re.MULTILINE,
            )

    path.write_text(text, encoding="utf-8")
    return True


def main():
    root = Path(__file__).resolve().parents[1]
    touched = 0
    for rel, renames in TARGETS:
        p = root / rel
        if not p.exists():
            print(f"Skip (not found): {rel}")
            continue
        if patch(p, renames):
            print(f"Updated {rel}")
            touched += 1
    print(f"Done. {touched} file(s) updated.")


if __name__ == "__main__":
    sys.exit(main())
