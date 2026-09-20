# DuckDB 2 alpha COI: WebDB configuration API port

2026-09-20. Experimental branch `feat/duckdb-2dev-async-http` only. The DuckDB core pin remains `43f897e5f3446bde2b36cef5dc137eea14211fd9` and Emscripten remains `3.1.57`.

## Compiler evidence: targeted COI build #6

https://github.com/azaracla/duckdb-wasm/actions/runs/35473388717

DuckDB's core static libraries built and were installed. The wrapper reached 94% before exactly four reported compiler diagnostics, all in `lib/src/webdb.cc`:

- `DBConfigOptions` no longer exposes `use_direct_io` (one error).
- `DBConfig` no longer exposes its former `http_util` member (three diagnostics for one conditional).

The previous result metadata, function registration, vector ownership and table `Identifier` errors are no longer present in the compiler output. This does NOT prove runtime correctness. GitHub Actions restored the previous ~57 MB compiler cache and saved the new cache after this failed build.

## Focused implementation

`tools/async-io/patch_webdb_config_alpha.py` applies two exact, fail-closed replacements after the existing WebDB port in the disposable CI checkout. Offline tests in `test_patch_webdb_config_alpha.py` cover idempotence, missing and duplicated markers, rejection of mixed source states, and preservation of COI and extension policy.

1. The pinned `DBConfig` declares `GetHTTPUtil()` / `SetHTTPUtil(shared_ptr<HTTPUtil>)` and implements these via its `HTTPTransportManager`. `WebDB::Open` now checks the current provider and publishes the existing `HTTPWasmUtil` via those methods, *after* database construction, matching the old installation point. It does not swap to the native HTTP provider or disable threads.
2. The pinned `DBConfigOptions` has no database-wide `use_direct_io` flag. An explicit `use_direct_io=true` now fails with an explanatory `InvalidInputException` instead of quietly dropping the user's request. Default `false` takes the normal path. The existing per-file `BufferedFileSystem::FileConfig::force_direct_io` remains supported; equivalent global direct-I/O behavior needs a separate compatibility design and test before production use.

## CI

- Fast migration + Python/Node tests: https://github.com/azaracla/duckdb-wasm/actions/runs/35491233877 — **success**. No core clone or Emscripten download.
- COI build #7: https://github.com/azaracla/duckdb-wasm/actions/runs/35491247365 — started with the new script and the same single COI target. Check its final result; this note does NOT assert it compiled or linked.
- Source migration is still applied as a guarded CI patch, not integrated into checked-in `lib/src/webdb.cc` yet. Before release, integrate the validated changes, remove throwaway scripts, and rerun the same gates.

## Next acceptance checks

1. COI compilation and linking; verify all three nonempty `duckdb-coi.js`, `.wasm`, `.pthread.js` artifacts. If the linker or post-processing fails, diagnose the specific error without disabling COI or signature checks.
2. Browser bootstrap under COOP/COEP with `SELECT 42`, version pin, 1/2/4 threads, and teardown/restart. Validate JS UDF return values and HTTP provider registration at runtime.
3. Only after that: compatible DuckLake WASM extension, AIS read-only query, and correct overlapping 206 Range reads.

No changes to AIS, fork `main`, or Serverless Quack. Do not present this branch as a functional release while its browser smoke tests remain missing.
