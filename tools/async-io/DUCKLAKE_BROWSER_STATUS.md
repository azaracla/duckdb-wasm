# DuckLake browser / DuckDB 2 alpha integration status

Updated 2026-09-20. Branch `feat/duckdb-2dev-async-http`. Experimental, not production-ready.

## Exact build artifacts

- DuckDB core `43f897e5f3446bde2b36cef5dc137eea14211fd9`, `v2.0.0-dev1`; Emscripten `3.1.57`, `wasm_threads`, COI.
- DuckLake side module `eb7b95df82fc3ba0ace777e34ef1c81280477042`.
- Successful loadable COI build run `35528908281`, artifact `alpha-coi-loadable-runtime`; successful pinned DuckLake build run `35528049778`, artifact `alpha-ducklake-wasm-threads`.
- Chromium acceptance workflow `.github/workflows/duckdb-2dev-ducklake-browser.yml` reuses these artifacts without recompiling C++, asserts manifest pins, and serves them in an isolated COOP/COEP browser.

## Browser extension loader: demonstrated, NOT consistently reliable

Workflow **`35531657241`** successfully downloaded the extension, entered Emscripten `dlopen`, read dylink metadata, compiled and instantiated the WASM side module, registered TLS, applied relocations, ran constructors and completed module export wiring (including its second thread-side load). `LOAD 'ducklake.duckdb_extension'` **returned**, `duckdb_extensions()` reported `ducklake` with `loaded=true`, and `SELECT 42` worked afterward. This proves an actual pinned DuckLake load in Chromium, not just successful compilation.

However, workflow **`35531839462`** reused the identical binary artifacts and loader probes and **hung during `LOAD`**, directly after printing `Loading extension ducklake` and *before* the first linker probe. This demonstrates **nondeterministic loader/runtime behavior**, possibly related to initialization/thread scheduling; causality is not established. Both runs printed warnings that the preallocated eight-pthread pool was exhausted. Do not treat one successful load as stable integration or simply inflate the pool without investigation. The CI test must stay strict and may fail until stability is resolved.

## Known browser filesystem blocker

On the successful-load run `35531657241`, the subsequent `ATTACH 'ducklake:metadata.ducklake' AS lake (DATA_PATH 'lake-data/')` emitted `Buffering missing file: metadata.ducklake` from `runtime_browser.ts` and hung until the 45-second watchdog. The browser filesystem's fallback for an unregistered missing local file creates a dummy 1-byte buffered handle, which is insufficient evidence of correct creation of a new secondary DuckDB catalog. No local DuckLake catalog success or remote data query is claimed.

Test commit `ce6ae91cc40509294b06da4dec9391c029210cf5` switches the next isolation attempt to `ducklake:duckdb::memory:` with `DATA_INLINING_ROW_LIMIT 100`, followed by `CREATE TABLE`, `INSERT`, and `SELECT`. Its own CI run `35531839462` never reached ATTACH due the intermittent `LOAD` hang, so **the in-memory catalog attempt remains untested**. Even if it passes, two inlined rows would prove metadata/SQL integration, *not* Parquet or remote I/O.

## Fixes and diagnostics committed

1. Loader requires `.duckdb_extension` suffix and performs a synchronous XHR on this filename before `dlopen`; CI serves the exact same pinned bytes at the suffix-validated URL and original `.wasm` path.
2. Browser config uses `maximumThreads`, not `maximum_threads`. The test sets `maximumThreads=2`, SQL `threads=2` / `async_threads=1`, verifies settings, but startup pool-exhaustion warnings persist.
3. Only for isolated CI of the exact pinned locally compiled unsigned module, config sets `allowUnsignedExtensions: true`; **never propagate this to production or arbitrary extensions**.
4. The runner records precise browser stages and timeout snapshots. Source-guarded `instrument-ducklake.mjs` probes Emscripten's dynamic linker **only in the disposable downloaded generated JS**; it does not modify production or the Parquet benchmark.

## Remaining acceptance gates

1. Stabilize repeated cold `LOAD` cycles (not a single green run); isolate persistent pthread pool warnings / loader scheduling and extension init. Do not claim stable load prematurely.
2. Successfully `ATTACH` a DuckLake catalog and execute a verified SQL query; check metadata path and browser FS creation explicitly. In-memory metadata is an isolation control only.
3. Query a representative read-only remote DuckLake fixture with actual catalog and Parquet HTTP I/O, verify answers, 206 responses and observed overlap from a single DuckLake SQL query. Test cold and warm separately.
4. Run matched five-sample sync-XHR/broker A/B on *DuckLake* at 150 ms and 0 ms injected latency. Publish median/p95, Range signature, overlap, bytes, errors and regressions.
5. Native comparison requires native DuckDB built from exact pinned core + compatible DuckLake and identical fixture/query/server; not yet executed.

The separately validated **2.287x Parquet broker speedup under simulated 150 ms latency is not a DuckLake performance claim**.
