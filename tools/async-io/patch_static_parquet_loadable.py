#!/usr/bin/env python3
"""Restore Parquet registration in the experimental loadable WASM runtime.

The loadable COI build already links duckdb_web_parquet and duckdb_parquet,
but WebDB::Open() excludes duckdb_web_parquet_init under WASM_LOADABLE_EXTENSIONS.
Consequently DuckLake ATTACH/CREATE succeed while INSERT tries to autoinstall
Parquet from extensions.duckdb.org. Only the explicit static-Parquet loadable
configuration gets the compile definition; ordinary builds are unchanged.
"""
import argparse
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
WEBDB = ROOT / 'lib/src/webdb.cc'
CMAKE = ROOT / 'lib/CMakeLists.txt'
OLD_WEBDB = '''#ifndef WASM_LOADABLE_EXTENSIONS
        duckdb_web_parquet_init(db.get());
#if defined(DUCKDB_JSON_EXTENSION)
        duckdb_web_json_init(db.get());
#endif
#endif  // WASM_LOADABLE_EXTENSIONS'''
NEW_WEBDB = '''#if !defined(WASM_LOADABLE_EXTENSIONS) || defined(DUCKDB_WASM_STATIC_PARQUET_WITH_LOADABLE)
        duckdb_web_parquet_init(db.get());
#endif
#if !defined(WASM_LOADABLE_EXTENSIONS) && defined(DUCKDB_JSON_EXTENSION)
        duckdb_web_json_init(db.get());
#endif'''
OLD_CMAKE = '''  if (DUCKDB_WASM_STATIC_PARQUET_WITH_LOADABLE)
    add_library(
      duckdb_web_parquet'''
NEW_CMAKE = '''  if (DUCKDB_WASM_STATIC_PARQUET_WITH_LOADABLE)
    # The linker alone does not register Parquet: call its static initializer.
    target_compile_definitions(duckdb_web PRIVATE DUCKDB_WASM_STATIC_PARQUET_WITH_LOADABLE=1)
    add_library(
      duckdb_web_parquet'''


def patch(path: Path, old: str, new: str, check: bool) -> None:
    source = path.read_text(encoding='utf-8')
    original, updated = source.count(old), source.count(new)
    if original == 1 and updated == 0:
        if check:
            raise ValueError(f'{path}: patch pending; run --apply first')
        path.write_text(source.replace(old, new, 1), encoding='utf-8')
    elif original != 0 or updated != 1:
        raise ValueError(f'{path}: unexpected source: original={original}, patched={updated}')
    if path.read_text(encoding='utf-8').count(new) != 1:
        raise ValueError(f'{path}: patch verification failed')


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--apply', action='store_true')
    mode.add_argument('--check', action='store_true')
    args = parser.parse_args()
    patch(WEBDB, OLD_WEBDB, NEW_WEBDB, args.check)
    patch(CMAKE, OLD_CMAKE, NEW_CMAKE, args.check)
    print('PASS: loadable COI statically linked Parquet is initialized on WebDB::Open')


if __name__ == '__main__':
    main()
