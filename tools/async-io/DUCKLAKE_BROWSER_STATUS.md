# DuckLake browser / DuckDB 2 alpha integration status

Recorded 2026-09-20. Work branch `feat/duckdb-2dev-async-http`. Not production-ready.

## Exact reproducible artifacts

- DuckDB core: `43f897e5f3446bde2b36cef5dc137eea14211fd9`, reports `v2.0.0-dev1`.
- DuckLake side module: `eb7b95df82fc3ba0ace777e34ef1c81280477042`.
- Emscripten `3.1.57` and shared-memory `wasm_threads`.
- The loadable COI runtime compiled successfully in workflow run `35528908281`, artifact `alpha-coi-loadable-runtime`.
- The pinned DuckLake side module compiled successfully in workflow run `35528049778`, artifact `alpha-ducklake-wasm-threads`.
- The browser workflow is `.github/workflows/duckdb-2dev-ducklake-browser.yml`. It downloads those artifacts, checks the pin manifest, bundles real browser workers and tests under COOP/COEP in Chromium. It does *not* recompile C++.

## Observed and fixed hurdles

1. DuckDB's pinned extension path parser requires `.duckdb_extension`, not the build artifact's `.duckdb_extension.wasm`: stage an extension alias with the expected suffix.
2. The pinned `WASM_LOADABLE_EXTENSIONS` loader also performs a synchronous XHR on that suffix-validated URL before `dlopen`: serve the same bytes at both URLs. A browser FS registration alone is insufficient.
3. Browser `DuckDBConfig` expects `maximumThreads` (camelCase); `maximum_threads` silently has no effect. Set `maximumThreads: 2`, SQL `threads=2`, `async_threads=1`, and assert SQL settings. The eight preallocated Emscripten pthreads still report some exhaustion warnings during initialization, so consider resource/thread lifecycle separately rather than simply increasing the pool.
4. The locally compiled extension is unsigned. Only the isolated CI test opts into `allowUnsignedExtensions: true` after checking exact build references; this is deliberately **not** a production configuration or a recommendation to load untrusted modules.

## Current blocker and debugging

Workflow run `35531321281` passed the extension's HTTP download and printed `Loading extension ducklake`, then timed out after 120 s with no SQL result. This places the observed hang after the pinned loader's XHR and before `LOAD` returned, plausibly in `dlopen` or module constructor/initialization; it is not yet proven which. Its logs still contain Emscripten pool-exhaustion warnings, which require investigation, not an assumed fix.

The browser test now records its current stage, validates the side module with `WebAssembly.validate`, and has a gated end-to-end `ATTACH`/`CREATE TABLE`/`INSERT`/`SELECT` acceptance query. The runner captures a snapshot on timeout. The CI-only `instrument-ducklake.mjs` injects source-checked logs at dynamic-linker phases (metadata, compilation, instantiation, TLS, relocations and constructors) in a downloaded disposable JS artifact. This instrumentation does not modify production JS, pinned DuckDB source, or the Parquet benchmark artifact.

**No successful `LOAD`, `ATTACH`, DuckLake browser query, DuckLake browser performance speedup, or native-vs-WASM benchmark is claimed until its corresponding CI/query/benchmark actually passes.** Do not conflate the already validated 2.287x Parquet Range broker speedup at injected 150 ms latency with DuckLake performance.

## After LOAD is green

1. Require the new actual DuckLake `ATTACH`/table create/insert/SELECT test to pass and inspect metadata-file/Parquet-file behavior in browser FS.
2. Exercise a representative read-only remote DuckLake fixture, measuring both catalog and Parquet I/O. Reuse the verified HTTP Range trace server and validate query result/206/overlap.
3. Run controlled five-sample sync-XHR vs broker tests with identical dataset, core revision, DuckLake revision, SQL, cache policy and network latency at both 150 ms and 0 ms. Report median, p95, Range signature, overlap and bytes. Also record cold/warm cases separately.
4. For native DuckDB comparison, build native from the *same exact* core revision with the compatible pinned extension, against the same fixture/query/HTTP server. Do not compare unrelated published numbers as direct benchmark results.
