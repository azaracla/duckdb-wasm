#!/usr/bin/env python3
"""Guarded port of the two remaining WebDB::Open config APIs in DuckDB 2 alpha.

Never silently ignore use_direct_io: DuckDB 2 removed the database-wide
DBConfigOptions member. Per-file direct I/O remains available via WebDB's
BufferedFileSystem; a requested database-wide setting requires a separately
reviewed migration and is rejected explicitly in this experimental build.
The HTTP provider is installed through DBConfig's new transport-manager API.
"""

import argparse
from pathlib import Path

PATH = Path("lib/src/webdb.cc")
CHANGES = (
    (
        "        db_config.options.use_direct_io = config_->use_direct_io;",
        """        // DuckDB 2 alpha removed the database-wide direct-I/O option. Do not
        // silently turn an explicitly requested direct-I/O configuration off.
        if (config_->use_direct_io) {
            throw InvalidInputException(
                "DuckDB 2 alpha no longer supports database-wide use_direct_io; per-file direct I/O remains available");
        }""",
    ),
    (
        """        if (!config.http_util || config.http_util->GetName() != string("WasmHTTPUtils")) {
            config.http_util = make_shared_ptr<HTTPWasmUtil>();
        }""",
        """        // DBConfig now owns an HTTPTransportManager. Publish the browser
        // provider through its API so the manager's sessions see the update.
        if (config.GetHTTPUtil().GetName() != string("WasmHTTPUtils")) {
            config.SetHTTPUtil(make_shared_ptr<HTTPWasmUtil>());
        }""",
    ),
)


def stage(source: str) -> tuple[str, int]:
    """Stage every edit first; refuse missing, duplicated and mixed markers."""
    updated = source
    pending = 0
    for old, new in CHANGES:
        old_count = updated.count(old)
        new_count = updated.count(new)
        if old_count == 1 and new_count == 0:
            updated = updated.replace(old, new, 1)
            pending += 1
        elif old_count == 0 and new_count == 1:
            pass
        else:
            raise ValueError(f"Unexpected WebDB config marker: old={old_count}, new={new_count}; nothing written")
    return updated, pending


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--apply", action="store_true")
    mode.add_argument("--check", action="store_true")
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[2])
    args = parser.parse_args()
    path = args.root / PATH
    original = path.read_text(encoding="utf-8")
    updated, pending = stage(original)
    if args.check:
        if pending:
            parser.error(f"{pending} WebDB config changes pending: run --apply")
        print("PASS: DuckDB 2 alpha WebDB config API fixes present")
        return
    if pending:
        path.write_text(updated, encoding="utf-8")
    verified, remaining = stage(path.read_text(encoding="utf-8"))
    if remaining or verified != updated:
        raise RuntimeError("WebDB config patch verification failed")
    print(f"PASS: WebDB config port applied ({pending} changes); compilation is not yet proven")


if __name__ == "__main__":
    main()
