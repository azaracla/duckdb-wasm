# DuckDB 2.0 alpha + concurrent HTTP Range in the browser

Status: **implementation in progress; no 2.0 COI/DuckLake/async-I/O performance claim yet**. This document is the integration contract for `feat/duckdb-2dev-async-http`, branched from `fix/pthread-filesystem-races` (commit `74abfa917247fb9228982cc8d0df41a547c46749`). Do not merge the entire AIS or Serverless Quack repositories into this fork.

## Goal / boundary

Produce a reproducible DuckDB-WASM build based on the **same DuckDB 2.0 alpha source revision as `azaracla/serverless-quack-ducklake` `dev`**, with a COI/pthread runtime, a matching **local DuckLake WASM extension**, correct independent positional reads, and actual overlapping HTTP Range requests. The AIS browser must continue to execute queries locally against its public read-only DuckLake and OVH S3 Parquet; **Quack/server-side query execution is not part of this target**. Keep the existing EH runtime as a fallback until acceptance tests pass. Do not claim that native DuckDB 2.0 async-I/O automatically makes browser filesystem requests concurrent.

## Source of truth: immutable pins

- Core DuckDB 2.0 alpha: `43f897e5f3446bde2b36cef5dc137eea14211fd9` (Serverless Quack `dev` `docker/duckdb/Dockerfile` and `tools/wasm/Dockerfile`, checked 2026-09-19). This supersedes its **historical** August spike pin `07194a2ca5b522aaf17ec1ca1a47b0e899a8e0a7`, which must not be silently reused.
- duckdb-wasm wrapper baseline: `def100b4be91a8ba27d441914e496231695ba0a8` (Serverless `tools/wasm/Dockerfile`); the fork's source changes and subsequent commits are applied on top. Investigate compatibility before changing this wrapper.
- Emscripten: `3.1.57`, matching the working AIS pthread build and the Serverless 2.0-dev EH build. Match generated JS glue and worker to the compiled binary.
- Core/extension source id: `43f897e5f3` **as currently pinned in Serverless**; pass the same explicit `GIT_COMMIT_HASH`/source-id override to all core and extension build paths and verify with `pragma_version()` and extension metadata. Do not rely on Git's variable-length abbreviated hashes.
- DuckLake: **TO PIN FOR 2.0**. AIS's old `8736cb23` explicitly checks DuckDB `v1.5.3`, so it is NOT a compatible version to reuse unmodified. Select and record an exact compatible DuckLake revision and its HTTPFS/dependency commits before implementing the extension build. `serverless-quack-ducklake/tools/wasm/extensions.cmake` contains Quack, HTTPFS and autocomplete, **not a browser DuckLake extension**.
- Record build inputs in `tools/async-io/pins.json`. Never track generated `.wasm` files as source commits; publish versioned, immutable artifacts only after passing smoke tests.

References: [Serverless WASM Dockerfile](https://github.com/azaracla/serverless-quack-ducklake/blob/dev/tools/wasm/Dockerfile), [Serverless porting script](https://github.com/azaracla/serverless-quack-ducklake/blob/dev/tools/wasm/patch_duckdb_wasm_2dev.py), [AIS pthread extension build](https://github.com/azaracla/ais/blob/feat/duckdb-threads-v2/tools/ducklake-wasm/Dockerfile), [AIS investigation](https://github.com/azaracla/ais/blob/feat/duckdb-threads-v2/front/THREADS_PROGRES.md), [filesystem fixes PR #1](https://github.com/azaracla/duckdb-wasm/pull/1).

## What to import, and what NOT to import

| Origin | Portable pieces | Exclude / adapt |
| --- | --- | --- |
| This fork's `fix/pthread-filesystem-races` | Positional `ReadAt`, per-thread read-ahead, thread-local response buffers, strict Range checks, JS read-cache fallback, XHR instrumentation | Review remaining sequential same-handle behavior and validate real HTTP overlap; fixes alone do not prove concurrency. |
| `serverless-quack-ducklake` `dev` | 2.0 alpha core pin, API migrations, loader/metadata compatibility, source-id discipline, custom worker/bundling, pinned emsdk | Its `wasm_eh`/`maximum_threads=1` settings, scheduler-disabling workaround, remote Quack execution, and any unsigned-extension bypass must NOT be copied to the COI production configuration. Review its extension loader patch for security and deadlocks. |
| `ais` `feat/duckdb-threads-v2` | COOP/COEP headers, `SharedArrayBuffer` capability checks, extension `USE_WASM_THREADS=1` build/link pattern, browser E2E and actual DuckLake/Parquet benchmarks | AIS S3 account/URLs and business queries belong in the AIS consumer tests; v1.5.3 DuckLake source is not the 2.0 extension pin. |

## Work packages and acceptance gates

### Gate 0 — reproducible inputs and baseline [STARTED]

- [x] Create integration branch **from the filesystem-races fix branch**, preserving its five fixes and tests.
- [x] Identify Serverless' CURRENT pinned 2.0 alpha commit and distinguish it from the old August spike.
- [x] Add this plan and an explicit pins manifest.
- [ ] Record baseline of current fork (commit, version, 1/2/4 threads, failures and HTTP intervals); run tests in a real browser. A branch-only GitHub edit does not constitute a successful build.

### Gate 1 — 2.0 alpha port, independent of DuckLake

- [ ] Set DuckDB submodule to pinned `43f897e5f3446bde2b36cef5dc137eea14211fd9` (gitlink and checkout), retaining fork fixes. Build core and matching JS/worker from one checkout using Emscripten `3.1.57`.
- [ ] Port ONLY necessary API patches from Serverless' `patch_duckdb_wasm_2dev.py`/`duckdb-wasm-web-2dev.patch` as reviewable source patches. Pay special attention to the extension loader, HTTP APIs, Arrow/vector/Identifier changes and source ID. Remove hardcoded `maximum_threads=1` and retain the COI threading configuration.
- [ ] Build target `coi`/pthreads and run `SELECT 42`, `pragma_version()`, `duckdb_settings()` and `generate_series` with 1, 2, 4 threads; confirm `crossOriginIsolated`, a matching worker/glue, and no teardown deadlocks.
- [ ] Preserve a separate EH fallback; do not expose an untested COI bundle as production-ready.

### Gate 2 — local DuckLake extension

- [ ] Find an **exact DuckLake revision compatible with the pinned 2.0 alpha**; pin HTTPFS, extension-ci-tools and vcpkg as needed, and verify extension metadata/source ID.
- [ ] Compile runtime and DuckLake side module with shared-memory/thread flags; prohibit mixing EH and COI modules or differing Emscripten versions. Avoid globally enabling unsigned extensions: use a controlled artifact origin and explicit loading policy for development.
- [ ] In a browser: `LOAD ducklake`, attach the remote read-only AIS catalog, verify expected tables, read a Parquet row group and check deterministic query results. When `SET threads=1` is needed around `LOAD`, restore and verify the requested number before benchmarking.
- [ ] Ensure remote object URLs use HTTP Range/206, proper CORS and `Access-Control-Expose-Headers: Content-Range`.

### Gate 3 — determine exactly where Range requests serialize

- [ ] Keep a browser-only independent 4-worker synchronous-XHR baseline; ensure all workers use comparable timestamps (`performance.timeOrigin + performance.now()`) and validate 206/Content-Range/body length.
- [ ] Instrument `WebFileSystem::ReadAt` → `ReadAheadBuffer::Read` → `duckdb_web_fs_file_read` → JS `readFile` → XHR `send` → response. Include thread ID, worker ID, file ID, offset, length, wall-clock start/end, status and bytes.
- [ ] Determine whether DuckDB submits concurrent reads, whether Emscripten proxies imports onto one JS worker, whether read-ahead coalesces or serializes, and whether HTTP actually overlaps. A short `fs_mutex_` protecting lookup is NOT evidence that the network transfer is mutex-protected.
- [ ] Compare one direct positional-read diagnostic with readahead enabled/disabled; ensure C++ shared locks are not held across network unnecessarily; do not globally remove locks to improve a benchmark.
- [ ] Correct known response-validation gap: require status 206 and exact response length before copying into WASM heap; handle CORS/416/200/full-response scenarios explicitly.

### Gate 4 — minimal fix first, async broker only if required

- [ ] If independent pthread JS runtimes can issue XHRs concurrently, fix import routing/runtime state and read-ahead scheduling in `duckdb_web_fs_file_read` with minimal changes. Do not assume `__proxy: false` is safe without inspecting generated glue.
- [ ] If all imports necessarily funnel through one worker, prototype async dispatch: each request carries a unique ID, offset, length, owner and cancellation state; a nonblocked JS broker performs concurrent `fetch()`; completion reaches the original thread using a safe Emscripten proxy/async continuation or dedicated SharedArrayBuffer slot. Never call `Atomics.wait()` on the UI thread.
- [ ] Bound active requests, bytes in flight, retries, memory, cancellation and timeouts. Validate HTTP 206, Content-Range, exact bytes, buffer lifetime and source integrity. Avoid credentials or private URLs in logs.
- [ ] Prove 2 and 4 **actual overlapping** Range requests and byte-for-byte correct SQL results, not just more CPU workers.

### Gate 5 — tests, metrics and upstreamability

- [ ] Isolated tests for simultaneous distinct-offset reads on one file; same-handle sequential cursor semantics; per-worker info cache; EOF/short reads; wrong 200/206/416/Content-Range; cancellation; failure injection and teardown.
- [ ] End-to-end browser tests for DuckLake attach, `vessels_positions` and `map_snapshot` with 1/2/4 threads, cold/warm caches and same DuckDB/extension revisions; log wall time, median/p95, peak in-flight reads, transferred bytes, memory and correctness.
- [ ] No new 8-thread default while races remain; cap configuration at tested thread count. Compare against AIS stable EH and existing 1.5.3 COI; make no fixed speedup promise.
- [ ] Keep generic filesystem/async fixes in this fork; AIS fixtures and production deployment stay in AIS. Separate generic bugfix PR(s) from the 2.0 port if proposing upstream.

## Immediate diagnostic decision tree

1. **Only one C++ `ReadAt` active?** Examine DuckDB scan scheduling, Parquet files/row groups and read-ahead before changing JS.
2. **Several C++ reads but one `xhr.send` active?** Examine Emscripten import proxy routing and any JS serialization; capture worker thread IDs.
3. **Several XHRs start but no HTTP overlap?** Check browser/network timing, caching and S3 server behavior with the independent worker baseline.
4. **Requests overlap but no speedup?** Measure bytes, per-request overhead, row-group count, CPU and memory; improve file layout only in AIS.
5. **Wrong result / crashes?** Stop performance work and fix correctness (per-thread buffers, file-info cache, pointer/buffer lifetimes, cancellation).

## Repro / rollback rules

The branch is experimental. Do not change `main`, the existing fix PR or AIS production in this work package. Changes to submodules and generated build artifacts need explicit versions, independent browser smoke tests and a rollback to the current EH WASM build. Note real tests as PASS/FAIL with environment and commit; writing a test or documenting a command is not running it.
