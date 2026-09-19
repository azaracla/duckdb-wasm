#!/usr/bin/env python3
"""Port the pinned DuckDB 2 alpha WebDB wrapper without modifying the core gitlink.

Usage: python3 tools/async-io/port_webdb_alpha.py --apply [--root PATH]
       python3 tools/async-io/port_webdb_alpha.py --check [--root PATH]

All source fragments must be unique. Stage ALL edits before writing ANY of them;
fail closed on unexpected sources. This is an intermediate migration aid until
all changes can be committed directly to lib/src/webdb.cc.
"""

import argparse
from pathlib import Path

PATH = "lib/src/webdb.cc"
CHANGES = [
    (
        "#include <cstddef>\n#include <cstdio>",
        "#include <cstddef>\n#include <cstdio>\n#include <cstring>",
    ),
    (
        "namespace {\nstruct PreloadedHttpfsInit {\n    PreloadedHttpfsInit() { preloaded_httpfs = true; }\n} _preloaded_httpfs_init;\n}  // namespace\n\n",
        "// The DuckDB 2 alpha core removed the preloaded_httpfs process-global flag.\n// HTTP handling is configured explicitly in WebDB::Open below.\n",
    ),
    (
        "static constexpr int64_t DEFAULT_QUERY_POLLING_INTERVAL = 100;",
        """static constexpr int64_t DEFAULT_QUERY_POLLING_INTERVAL = 100;

// DuckDB 2 alpha uses Identifier for result-column names, whereas Arrow's
// converter still takes vector<string>. Preserve casing via GetIdentifierName.
static vector<string> ResultColumnNames(const QueryResult& result) {
    vector<string> names;
    names.reserve(result.GetNames().size());
    for (const auto& name : result.GetNames()) {
        names.push_back(name.GetIdentifierName());
    }
    return names;
}

static Identifier SchemaIdentifier(const string& name) {
    return name.empty() ? Identifier::DefaultSchema() : Identifier(name);
}""",
    ),
    (
        "ArrowTypeExtensionData::GetExtensionTypes(*connection_.context, result->types)",
        "ArrowTypeExtensionData::GetExtensionTypes(*connection_.context, result->GetTypes())",
    ),
    (
        "ArrowConverter::ToArrowSchema(&raw_schema, result->types, result->names, options);",
        "ArrowConverter::ToArrowSchema(&raw_schema, result->GetTypes(), ResultColumnNames(*result), options);",
    ),
    (
        "ArrowConverter::ToArrowSchema(&raw_schema, current_query_result_->types, current_query_result_->names, options);",
        "ArrowConverter::ToArrowSchema(&raw_schema, current_query_result_->GetTypes(),\n                                  ResultColumnNames(*current_query_result_), options);",
    ),
    (
        "current_query_result_->type == QueryResultType::STREAM_RESULT",
        "current_query_result_->GetResultType() == QueryResultType::STREAM_RESULT",
    ),
    (
        "#include \"duckdb/common/virtual_file_system.hpp\"",
        "#include \"duckdb/common/virtual_file_system.hpp\"\n#include \"duckdb/catalog/catalog.hpp\"\n#include \"duckdb/function/scalar_function.hpp\"\n#include \"duckdb/parser/parsed_data/create_scalar_function_info.hpp\"",
    ),
    (
        """    // Register the vectorized function
    connection_.CreateVectorizedFunction(name, vector<LogicalType>{}, ret_type, udf, LogicalType::ANY);
    return arrow::Status::OK();""",
        """    // Connection::CreateVectorizedFunction was removed. Use DuckDB 2's
    // transactional catalog registration, as its C API v2 implementation does.
    ScalarFunction function(Identifier(name), vector<LogicalType>{}, ret_type, udf, nullptr, nullptr, nullptr,
                            LogicalType::ANY);
    function.SetFallible();  // JavaScript UDF errors must remain query errors.
    function.SetVolatile();  // JavaScript closures must not be constant-folded.
    auto& context = *connection_.context;
    context.RunFunctionInTransaction([&]() {
        CreateScalarFunctionInfo info(std::move(function));
        info.on_conflict = OnCreateConflict::ALTER_ON_CONFLICT;
        Catalog::GetSystemCatalog(context).CreateFunction(context, info);
    });
    return arrow::Status::OK();""",
    ),
    (
        """namespace {

class SharedVectorBuffer : public VectorBuffer {
   protected:
    std::unique_ptr<char[]> data;

   public:
    explicit SharedVectorBuffer(std::unique_ptr<char[]> data)
        : VectorBuffer(VectorBufferType::STANDARD_BUFFER), data(std::move(data)) {}
};

}  // namespace
""",
        """// DuckDB 2 owns its flat-vector buffer. Copy JS results into that buffer
// instead of replacing its storage with an external, differently allocated buffer.
""",
    ),
    (
        "    out.Flatten(chunk.size());",
        "    out.Flatten();",
    ),
    (
        "auto out_string_ptr = FlatVector::GetData<string_t>(out);",
        "auto out_string_ptr = FlatVector::GetDataMutable<string_t>(out);",
    ),
    (
        """        auto shared_buffer = duckdb::make_shared_ptr<SharedVectorBuffer>(std::unique_ptr<char[]>{res_buf});
        out.SetAuxiliary(shared_buffer);
        duckdb::FlatVector::SetData(out, (data_ptr_t)res_buf);""",
        """        const auto byte_count = data_size * GetTypeIdSize(out.GetType().InternalType());
        std::memcpy(FlatVector::GetDataMutable(out), res_buf, byte_count);
        free(res_buf);  // udf_runtime.ts allocates this buffer with mod._malloc.""",
    ),
    (
        "func->Create(arrow_insert_options_->schema_name, arrow_insert_options_->table_name);",
        "func->Create(SchemaIdentifier(arrow_insert_options_->schema_name), Identifier(arrow_insert_options_->table_name));",
    ),
    (
        "func->Insert(arrow_insert_options_->schema_name, arrow_insert_options_->table_name);",
        "func->Insert(SchemaIdentifier(arrow_insert_options_->schema_name), Identifier(arrow_insert_options_->table_name));",
    ),
    (
        "columns.push_back(make_pair(col->name(), Value(type.ToString())));",
        "columns.push_back(make_pair(Identifier(col->name()), Value(type.ToString())));",
    ),
    (
        "func->Create(options.schema_name, options.table_name);",
        "func->Create(SchemaIdentifier(options.schema_name), Identifier(options.table_name));",
    ),
    (
        "func->Insert(options.schema_name, options.table_name);",
        "func->Insert(SchemaIdentifier(options.schema_name), Identifier(options.table_name));",
    ),
    (
        "func->Create(schema_name, options.table_name);",
        "func->Create(SchemaIdentifier(schema_name), Identifier(options.table_name));",
    ),
    (
        "func->Insert(schema_name, options.table_name);",
        "func->Insert(SchemaIdentifier(schema_name), Identifier(options.table_name));",
    ),
    (
        "preloaded_httpfs = BooleanValue::Get(parameter);",
        """if (BooleanValue::Get(parameter)) {
                throw InvalidInputException("builtin_httpfs is no longer supported in DuckDB 2 alpha WASM; use the browser HTTP filesystem");
            }""",
    ),
]


def stage(root: Path):
    target = root / PATH
    source = target.read_text(encoding="utf-8")
    staged = source
    statuses = []
    for old, new in CHANGES:
        old_count = staged.count(old)
        new_count = staged.count(new)
        # Some replacements intentionally retain their old fragment as a prefix.
        if new_count == 1 and staged.replace(new, "", 1).count(old) == 0:
            statuses.append("APPLIED: " + old.splitlines()[0][:85])
        elif old_count == 1 and new_count == 0:
            staged = staged.replace(old, new, 1)
            statuses.append("PENDING: " + old.splitlines()[0][:85])
        else:
            raise ValueError(f"Unexpected or ambiguous {PATH} marker {old[:80]!r}: old={old_count}, new={new_count}; no changes written")
    return target, staged, statuses


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--apply", action="store_true")
    mode.add_argument("--check", action="store_true")
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[2])
    args = parser.parse_args(argv)
    target, staged, statuses = stage(args.root)
    for status in statuses:
        print(status)
    pending = sum(status.startswith("PENDING") for status in statuses)
    if args.check:
        if pending:
            parser.exit(1, f"{pending} WebDB patches missing: run --apply\n")
        print(f"PASS: all {len(CHANGES)} pinned WebDB API patches present")
        return
    if pending:
        target.write_text(staged, encoding="utf-8")
    print(f"PASS: WebDB patches applied ({pending} new); this is not proof of compilation")


if __name__ == "__main__":
    main()
