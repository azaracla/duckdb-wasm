#!/usr/bin/env python3
"""Diagnostic-only, source-signature-checked probes before DuckLakeInitializer."""
from pathlib import Path

path = Path('/src/ducklake/src/storage/ducklake_catalog.cpp')
src = path.read_text()
probes = [
    (
        '      instance_id(UUID::ToString(UUID::GenerateRandomUUID())) {\n\t// figure out the metadata server type',
        '      instance_id(UUID::ToString(UUID::GenerateRandomUUID())) {\n\tfprintf(stderr, "[ducklake-catalog] constructor enter\\n");\n\tfflush(stderr);\n\t// figure out the metadata server type',
    ),
    (
        'void DuckLakeCatalog::FinalizeLoad(optional_ptr<ClientContext> context) {\n\t// initialize the metadata database',
        'void DuckLakeCatalog::FinalizeLoad(optional_ptr<ClientContext> context) {\n\tfprintf(stderr, "[ducklake-catalog] FinalizeLoad enter context=%d\\n", context ? 1 : 0);\n\tfflush(stderr);\n\t// initialize the metadata database',
    ),
    (
        '\tDuckLakeInitializer initializer(*context, *this, options);\n\tinitializer.Initialize();',
        '\tfprintf(stderr, "[ducklake-catalog] initializer constructor start\\n");\n\tfflush(stderr);\n\tDuckLakeInitializer initializer(*context, *this, options);\n\tfprintf(stderr, "[ducklake-catalog] initializer constructor finished\\n");\n\tfflush(stderr);\n\tinitializer.Initialize();\n\tfprintf(stderr, "[ducklake-catalog] initializer Initialize finished\\n");\n\tfflush(stderr);',
    ),
    (
        '\tdb.tags["data_path"] = DataPath();\n\tif (con) {',
        '\tdb.tags["data_path"] = DataPath();\n\tfprintf(stderr, "[ducklake-catalog] data path tagged\\n");\n\tfflush(stderr);\n\tif (con) {',
    ),
    (
        '\tinitialized = true;\n}\n\nstatic bool CanGeneratePathFromName',
        '\tinitialized = true;\n\tfprintf(stderr, "[ducklake-catalog] FinalizeLoad finished\\n");\n\tfflush(stderr);\n}\n\nstatic bool CanGeneratePathFromName',
    ),
]
for original, replacement in probes:
    occurrences = src.count(original)
    if occurrences != 1:
        raise SystemExit(f'Expected one catalog anchor, found {occurrences}: {original[:100]!r}')
    src = src.replace(original, replacement, 1)
if '#include <cstdio>' not in src:
    original = '#include "storage/ducklake_catalog.hpp"'
    if src.count(original) != 1:
        raise SystemExit('Cannot add catalog diagnostic stdio header')
    src = src.replace(original, '#include <cstdio>\n' + original, 1)
path.write_text(src)
print('PASS: DuckLake catalog constructor and FinalizeLoad probes installed')
