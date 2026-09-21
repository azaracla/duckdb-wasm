# DuckLake browser / DuckDB 2 alpha integration status

Updated 2026-09-21. Branch `feat/duckdb-2dev-async-http`. Experimental, not production-ready.

## Exact builds and isolated controls

- DuckDB core `43f897e5f3446bde2b36cef5dc137eea14211fd9`, `v2.0.0-dev1`; Emscripten `3.1.57`, `wasm_threads`, COI. Core run `35534038014` has pre-open async thread cap and statically registers linked Parquet in loadable-extension mode.
- DuckLake `eb7b95df82fc3ba0ace777e34ef1c81280477042`. Instrumented original side module run `35540897926`; **diagnostic-only** side module run `35565276788` skips an internal `FROM duckdb_secrets()` preload and has manifest `diagnostic_skip_duckdb_secrets=true`. Never distribute this bypass as a general fix.
- Chromium CI `.github/workflows/duckdb-2dev-ducklake-browser.yml` pins exact artifacts, asserts source manifests, uses 16 experimental pthread workers (generated-JS instrumentation only), SQL `threads=2`/`async_threads=1`, and requires three independent browser runs.

## Observed results, with runs

- `35540292217` attempt 2: real Chrome completed `LOAD`, `ATTACH 'ducklake:duckdb::memory:'`, `CREATE`, `INSERT`, and `SELECT` (count=2, ID sum=3). Its first attempt had blocked on `LOAD`; a single CRUD success is not stability.
- `35540763440`: three-run stability gate failed immediately on `ATTACH` with the original instrumented extension; no initializer logs appeared in this attempt.
- `35565137552`: added catalog entry probes, revealing a different failing schedule. Catalogue constructor, `FinalizeLoad`, initializer, `AttachMetadata` completed; **`FROM duckdb_secrets()` began but did not complete**, and `ATTACH` timed out. This is a directly observed stalled subcall, not proof that secrets are the only issue.
- `35568478423`: diagnostic module explicitly bypassed that call. Independent attempt 1 completed full `LOAD`/`ATTACH`/`CREATE`/`INSERT`/`SELECT` with correct count=2, sum=3. Attempt 2 instead hung in `LOAD`: logged `Loading extension ducklake`, then no `[ducklake-linker] getExports start` message, before browser timeout. Attempt 3 was not reached due fail-fast CI. **Skipping secrets helps one observed ATTACH path but does not fix the independent loader hang.**

## Diagnosis boundaries

Two distinct failure surfaces: (A) intermittent dynamic extension loading before first JS linker `getExports` probe, requiring instrumentation *before* that call, in the extension loader/pre-linker; (B) a demonstrated `duckdb_secrets()` preload hang within initialization, requiring safe initialization/deadlock analysis rather than permanently deleting the call. The original instrumentation probes the body of `getExports`, which cannot distinguish waits before entry from earlier extension-init work.

The in-memory DuckLake test keeps two rows inlined via `DATA_INLINING_ROW_LIMIT 100`; it proves SQL integration only. It neither creates remote Parquet files nor demonstrates HTTP Range overlap. The earlier on-disk `ducklake:metadata.ducklake` test hit a browser-filesystem missing-file buffering issue and is still unresolved. Unsigned extension loading (`allowUnsignedExtensions: true`) is for exact pinned CI artifacts only, not production.

## Remaining acceptance gates

1. Diagnose and stabilize **both** cold `LOAD` and the `duckdb_secrets()` path; prove repeated cold loads/CRUD with original semantics and a bounded production pthread pool (16 is diagnostic only).
2. Repair browser filesystem creation/persistence for an actual DuckLake metadata catalog; build a representative read-only remote catalog and Parquet fixture.
3. In one genuine DuckLake SQL query, verify results, >=2 overlapping HTTP Range 206 responses, timestamps, bytes, and errors.
4. Five-sample matched sync-XHR/broker A/B at 150 ms and 0 ms simulated latency, report median/p95 and regressions; compare with native DuckDB 2 + DuckLake pinned to matching versions and fixture.

The previously observed 2.287x speedup under simulated 150 ms latency is for a **synthetic Parquet query**, not DuckLake, and is not a native-baseline comparison.
