# DuckDB 2 alpha COI: WebDB compatibility iteration

2026-09-20 (Europe/Paris); experimental branch `feat/duckdb-2dev-async-http` only. No change to AIS production, the fork's `main`, or the pinned core gitlink (`43f897e5f3446bde2b36cef5dc137eea14211fd9`).

## Evidence from completed builds

- Run #35457036312 compiled and installed the pinned DuckDB core, then stopped in `lib/src/json_dataview.cc:144` (`entry.get()` on a direct DuckDB 2 `Vector`). The committed fix `b6ca5a0` uses `&entry` and replaces the deprecated `Flatten(chunk.size())` with `Flatten()`.
- Run #35470141243 went past `json_dataview.cc` and reached `lib/src/webdb.cc`. The compiler reports DuckDB 2 changes in `BaseQueryResult` accessors, `vector<Identifier>` column names, removed `Connection::CreateVectorizedFunction`, vector-buffer construction and ownership, mutable flat vector access, and `Relation::Create`/`Insert` identifier arguments. See the run log for the complete diagnostics. **It does not produce a linked runtime.**
- That run successfully saved its `.ccache` after the failed compilation. The core CMake ExternalProject now receives the compiler-launcher flags as well as the wrapper.

## Source-checked WebDB migration

`tools/async-io/port_webdb_alpha.py` stages all substitutions, rejects absent/duplicate/mixed fragments without writing, and is idempotent. Its companion offline tests are in `test_port_webdb_alpha.py`. It restores the following API contracts:

- Obtain query result metadata through `GetTypes`, `GetNames`, `GetResultType`, converting `Identifier` to string only for Arrow schema names.
- Register vectorized JS UDFs transactionally in DuckDB's system catalog via `ScalarFunction` and `CreateScalarFunctionInfo`, following the pinned core's C API v2 registration approach. Mark JS callbacks volatile and fallible; this **still requires an end-to-end UDF regression test**.
- Copy numeric UDF output out of the JS-allocated buffer into DuckDB's owned mutable flat-vector storage, then `free` the temporary result; do not attach the retired `SharedVectorBuffer` type or use a mismatched C++ allocator.
- Pass explicit `Identifier` arguments to relation insert/create, defaulting an empty schema to `Identifier::DefaultSchema`.
- Remove the retired `preloaded_httpfs` process-global toggle; reject `builtin_httpfs=true` with an explicit error rather than silently ignoring an obsolete setting. The browser HTTP filesystem remains configured in `WebDB::Open`.

The fast workflow applies the script to the actual checked-in WebDB source without fetching Emscripten or submodules, checks that a second application is a no-op, and verifies `git diff --check`. **GitHub Actions fast run #35473357455 passed all checks including this migration:** https://github.com/azaracla/duckdb-wasm/actions/runs/35473357455

The targeted COI workflow now runs this script after the existing core/HTTP/JSON migration and before compiling, and includes it in the ccache key. First build run with the WebDB migration: https://github.com/azaracla/duckdb-wasm/actions/runs/35473388717 . Read its actual outcome before claiming compilation or linking success.

## Follow-up gates

1. Correct any new compiler or linker diagnostics from run #35473388717. The WebDB port is currently applied in the disposable Actions checkout, not yet integrated directly into the checked-in C++ file; review and commit native source changes once the port stabilizes.
2. Assert `duckdb-coi.js`, `.wasm`, and `.pthread.js` are nonempty, then run a COI browser `SELECT 42` smoke test, version assertion, and 1/2/4 thread test.
3. Independently test UDF numeric/null/string return values, Arrow import, and CSV/JSON insertion. In particular, the legacy JS VARCHAR UDF buffer format and ownership need runtime verification.
4. Only after core runtime and browser tests pass, build DuckLake against this exact core and test the read-only AIS catalog; then measure concurrent DuckDB HTTP 206 Range operations and benchmarks.

Do not deploy, claim UDF/runtime correctness based on source guards, turn off threads, or change DuckDB/DuckLake revision merely to make the compiler pass.
