#!/usr/bin/env python3
"""Apply one guarded fix to the pinned DuckDB 2.0 alpha submodule.

The source gitlink remains exactly 43f897e5f3: this script edits only the
throwaway build checkout. It must run after git submodule update and before
CMake. The patch restores the new ExtensionUrlTemplate(db, repository, version)
API without bypassing extension signing or changing the WASM loader.
"""

import argparse
from pathlib import Path
import subprocess

PIN = "43f897e5f3446bde2b36cef5dc137eea14211fd9"
RELATIVE_PATH = Path("src/main/extension/extension_load.cpp")
OLD = 'string url_template = ExtensionUrlTemplate(&config, "");'
NEW = (
    'auto repository = ExtensionRepository::GetDefaultRepository(&db.config);\n'
    '\t\tstring url_template = ExtensionUrlTemplate(db, repository, "");'
)


def stage(source: str) -> tuple[str, bool]:
    """Return (patched source, was_changed); reject unknown and mixed states."""
    old_count = source.count(OLD)
    new_count = source.count(NEW)
    if old_count == 1 and new_count == 0:
        return source.replace(OLD, NEW, 1), True
    if old_count == 0 and new_count == 1:
        return source, False
    raise ValueError(f"Unexpected extension loader API: old={old_count}, new={new_count}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--apply", action="store_true")
    mode.add_argument("--check", action="store_true")
    parser.add_argument("--core-dir", type=Path, default=Path(__file__).resolve().parents[2] / "submodules/duckdb")
    args = parser.parse_args()
    core = args.core_dir.resolve()
    current = subprocess.check_output(["git", "-C", str(core), "rev-parse", "HEAD"], text=True).strip()
    if current != PIN:
        parser.error(f"DuckDB ref mismatch: expected {PIN}, got {current}")
    path = core / RELATIVE_PATH
    original = path.read_text(encoding="utf-8")
    updated, changed = stage(original)
    if args.check:
        if changed:
            parser.error("Core patch pending: invoke --apply first")
        print("PASS: pinned DuckDB core extension loader fix is present")
        return
    if changed:
        path.write_text(updated, encoding="utf-8")
    verified, pending = stage(path.read_text(encoding="utf-8"))
    if pending or verified != updated:
        raise RuntimeError("Core patch verification failed")
    print("PASS: pinned DuckDB core loader patch applied" if changed else "PASS: core patch already applied")


if __name__ == "__main__":
    main()
