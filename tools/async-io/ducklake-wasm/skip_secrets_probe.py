#!/usr/bin/env python3
"""EXPERIMENT ONLY: test whether DuckLake's secrets preload causes the WASM hang.

This deliberately changes DuckLake behavior and is not a production fix.
Run only after instrument_initializer.py, on the disposable CI source checkout.
"""
from pathlib import Path

path = Path('/src/ducklake/src/storage/ducklake_initializer.cpp')
source = path.read_text()
needle = '\ttransaction.Query("FROM duckdb_secrets()");'
if source.count(needle) != 1:
    raise SystemExit(f'Expected exactly one duckdb_secrets preload, got {source.count(needle)}')
replacement = ('\tfprintf(stderr, "[ducklake-init] duckdb_secrets BYPASSED diagnostic-only\\n");\n'
               '\tfflush(stderr);')
path.write_text(source.replace(needle, replacement, 1))
print('PASS: skipped duckdb_secrets preload in diagnostic DuckLake build ONLY')
