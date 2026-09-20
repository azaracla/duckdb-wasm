#!/usr/bin/env python3
from pathlib import Path

path = Path("/src/ducklake/src/storage/ducklake_initializer.cpp")
src = path.read_text()

replacements = [
(
'''void DuckLakeInitializer::Initialize() {
	auto &transaction = DuckLakeTransaction::Get(context, catalog);
	auto &metadata_manager = transaction.GetMetadataManager();''',
'''void DuckLakeInitializer::Initialize() {
	fprintf(stderr, "[ducklake-init] Initialize enter\\n");
	fflush(stderr);
	auto &transaction = DuckLakeTransaction::Get(context, catalog);
	fprintf(stderr, "[ducklake-init] transaction ready\\n");
	fflush(stderr);
	auto &metadata_manager = transaction.GetMetadataManager();
	fprintf(stderr, "[ducklake-init] metadata manager ready\\n");
	fflush(stderr);'''
),
(
'''auto result = metadata_manager.AttachMetadata(attach_query);
	if (result->HasError()) {''',
'''fprintf(stderr, "[ducklake-init] AttachMetadata start\\n");
	fflush(stderr);
	auto result = metadata_manager.AttachMetadata(attach_query);
	fprintf(stderr, "[ducklake-init] AttachMetadata finished\\n");
	fflush(stderr);
	if (result->HasError()) {'''
),
(
'''// explicitly load all secrets - work-around to secret initialization bug
	transaction.Query("FROM duckdb_secrets()");''',
'''// explicitly load all secrets - work-around to secret initialization bug
	fprintf(stderr, "[ducklake-init] duckdb_secrets start\\n");
	fflush(stderr);
	transaction.Query("FROM duckdb_secrets()");
	fprintf(stderr, "[ducklake-init] duckdb_secrets finished\\n");
	fflush(stderr);'''
),
(
'''if (transaction.GetMetadataManager().MetadataExists()) {
		LoadExistingDuckLake(transaction);
	} else {''',
'''fprintf(stderr, "[ducklake-init] MetadataExists start\\n");
	fflush(stderr);
	auto metadata_exists = transaction.GetMetadataManager().MetadataExists();
	fprintf(stderr, "[ducklake-init] MetadataExists finished=%d\\n", metadata_exists ? 1 : 0);
	fflush(stderr);
	if (metadata_exists) {
		fprintf(stderr, "[ducklake-init] LoadExistingDuckLake start\\n");
		fflush(stderr);
		LoadExistingDuckLake(transaction);
		fprintf(stderr, "[ducklake-init] LoadExistingDuckLake finished\\n");
		fflush(stderr);
	} else {'''
),
(
'''InitializeNewDuckLake(transaction, has_explicit_schema);
	}''',
'''fprintf(stderr, "[ducklake-init] InitializeNewDuckLake start\\n");
		fflush(stderr);
		InitializeNewDuckLake(transaction, has_explicit_schema);
		fprintf(stderr, "[ducklake-init] InitializeNewDuckLake finished\\n");
		fflush(stderr);
	}'''
),
(
'''current_metadata_manager.ProbeServerCapabilities();
	current_metadata_manager.ClearCache();''',
'''fprintf(stderr, "[ducklake-init] ProbeServerCapabilities start\\n");
	fflush(stderr);
	current_metadata_manager.ProbeServerCapabilities();
	fprintf(stderr, "[ducklake-init] ProbeServerCapabilities finished\\n");
	fflush(stderr);
	current_metadata_manager.ClearCache();
	fprintf(stderr, "[ducklake-init] Initialize finished\\n");
	fflush(stderr);'''
)
]

for old, new in replacements:
    count = src.count(old)
    if count != 1:
        raise SystemExit(f"expected exactly one match, got {count}: {old[:80]!r}")
    src = src.replace(old, new, 1)

if '#include <cstdio>' not in src:
    src = src.replace('#include "duckdb/main/attached_database.hpp"', '#include <cstdio>\n#include "duckdb/main/attached_database.hpp"', 1)

path.write_text(src)
print("PASS: DuckLake initializer diagnostics installed")
