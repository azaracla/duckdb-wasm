#!/usr/bin/env python3
"""Apply the next small, source-checked DuckDB 2.0 alpha wrapper API fixes.

Run from the fork root: python3 tools/async-io/port_api.py --apply
Then: python3 tools/async-io/port_api.py --check
No build/extension compatibility is implied by this source migration.
"""

import argparse
from pathlib import Path

# Each old fragment has been checked against feat/duckdb-2dev-async-http;
# each new fragment is based on the serverless-quack-ducklake 2.0 port, except
# OPTIONS: return a real failure response rather than the old nullptr stub.
CHANGES = {
    "lib/include/duckdb/web/io/buffered_filesystem.h": [
        (
            "void RegisterSubSystem(FileCompressionType compression_type, unique_ptr<FileSystem> sub_fs) override;",
            "void RegisterSubSystem(FileCompressionType compression_type, unique_ptr<FileSystem> sub_fs);",
        )
    ],
    "lib/src/http_wasm.cc": [
        (
            "    string host_port;\n\n    unique_ptr<HTTPResponse> Get",
            "    // DuckDB 2.0 adds OPTIONS to the HTTPClient interface. Return an explicit\n"
            "    // unsupported response instead of a null pointer on this path.\n"
            "    unique_ptr<HTTPResponse> Options(OptionsRequestInfo &) override {\n"
            "        auto response = make_uniq<HTTPResponse>(HTTPStatusCode::NotImplemented_501);\n"
            "        response->success = false;\n"
            "        response->reason = \"HTTP OPTIONS is unsupported by the browser HTTP client\";\n"
            "        return response;\n"
            "    }\n    string host_port;\n\n    unique_ptr<HTTPResponse> Get",
        )
    ],
    "lib/src/json_typedef.cc": [
        (
            "WriteSQLField(doc, child.first, child.second, true)",
            "WriteSQLField(doc, child.first.GetIdentifierName(), child.second, true)",
        ),
        (
            "LogicalTypeId::AGGREGATE_STATE",
            "LogicalTypeId::LEGACY_AGGREGATE_STATE",
        ),
    ],
}


def stage(root: Path) -> tuple[dict[Path, str], list[str]]:
    staged = {}
    statuses = []
    for relative, replacements in CHANGES.items():
        path = root / relative
        original = path.read_text(encoding="utf-8")
        text = original
        for old, new in replacements:
            old_count = text.count(old)
            new_count = text.count(new)
            if new_count == 1 and text.replace(new, "", 1).count(old) == 0:
                # The new C++ method contains the old host_port/Get fragment;
                # account for that nested marker when checking idempotence.
                statuses.append(f"APPLIED {relative}: {old[:54]}")
            elif old_count == 1 and new_count == 0:
                text = text.replace(old, new, 1)
                statuses.append(f"PENDING {relative}: {old[:54]}")
            else:
                raise ValueError(
                    f"Unexpected source in {relative}: old_count={old_count}, "
                    f"new_count={new_count}, marker={old[:54]!r}; nothing written"
                )
        staged[path] = text
    return staged, statuses


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--apply", action="store_true")
    mode.add_argument("--check", action="store_true")
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[2])
    args = parser.parse_args(argv)
    staged, statuses = stage(args.root)
    for line in statuses:
        print(line)
    if args.check:
        if any(line.startswith("PENDING") for line in statuses):
            parser.exit(1, "Port incomplete: run --apply first.\n")
        print("PASS: all targeted API fixes present")
        return
    # Verify every replacement in every file before touching any file.
    for path, content in staged.items():
        if path.read_text(encoding="utf-8") != content:
            path.write_text(content, encoding="utf-8")
    print("PASS: source-checked port applied; build/browser tests still required")


if __name__ == "__main__":
    main()
