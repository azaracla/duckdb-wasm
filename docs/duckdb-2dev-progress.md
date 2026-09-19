# Integration log — DuckDB 2.0 alpha / browser concurrent HTTP

Updated 2026-09-19. Branch: `feat/duckdb-2dev-async-http`. This is a working branch, NOT a functional DuckDB 2.0-WASM release.

## Completed in this first iteration

1. Created the branch from `fix/pthread-filesystem-races` (`74abfa917247fb9228982cc8d0df41a547c46749`), retaining the positional-read, per-thread read-ahead, response-buffer, HTTP-validation and file-info-cache fixes plus the existing tests.
2. Documented the integration plan and acceptance gates in `docs/duckdb-2dev-async-http.md`.
3. Pinned the fork's actual **`submodules/duckdb` gitlink** to Serverless Quack's current alpha commit `43f897e5f3446bde2b36cef5dc137eea14211fd9`. Verified the GitHub submodule entry resolves to this SHA. The old August spike SHA `07194a2ca5...` is not the target.
4. Added `tools/async-io/pins.json`; candidate browser DuckLake revision from the Serverless **native** build is `eb7b95df82fc3ba0ace777e34ef1c81280477042`, not validated for WASM. Its `.github/duckdb-version` is `c97bd8b96e0481b9e58d491f4fcd8599fccd65fb`, different from the selected core; the native build uses `APPLY_PATCHES`. Align the complete build and source ID before loading.
5. Started source-level core port using Serverless' proven API migration: `TableFunctionRelation::GetAlias()` now returns `Identifier`, its subquery uses `SubqueryMutable()` and `GetSubqueryTypeMutable()`, and its column/function expressions accept `Identifier`.
6. Added `tools/async-io/overlap.mjs` and `overlap.test.mjs`: shared-time-origin interval analysis rejects HTTP errors, incomplete Range bodies, incorrect `Content-Range` and false concurrency positives. Four Node tests passed when run against a local copy of these same files. These tests cover only the analyzer, **not DuckDB compilation nor browser network concurrency**.
7. Added a local-only deterministic 206 fixture (`range-server.py`) and a browser harness (`range-concurrency.html`) based on AIS's independent four-worker XHR experiment. The page uses epoch-equivalent worker timestamps and rejects HTTP 403 as evidence of parallel, unlike the old AIS experiment. The fixture and browser page have been committed, but have not yet been smoke-tested in a real browser.

## Commands for next checkout

```bash
git fetch origin
git switch feat/duckdb-2dev-async-http
git submodule update --init --recursive
node --test tools/async-io/overlap.test.mjs
python3 tools/async-io/range-server.py
# In a browser: http://127.0.0.1:8765/range-concurrency.html
```

Note: submodule update requires network and the alpha core is a major API change; **do not assume the old build compiles**. No Docker/WASM build, extension load, COI benchmark or actual S3 test has been performed for this branch. A separate execution environment used for the analyzer tests could not resolve github.com for cloning.

## Next code work, in dependency order

1. Port the remaining Serverless 2.0 changes to **this fork** in small reviewable commits; start with `HTTPWasmClient::Options`, `buffered_filesystem`, `json_dataview`, runtime/extension loader and relevant CMake settings. Discard Serverless' `maximum_threads=1`/EH-only workarounds, which would defeat this project. Keep non-default extension signature exceptions strictly scoped to reviewed development artifacts.
2. Compile and browser-smoke a pure 2.0 COI runtime (`pragma_version()`, `SELECT 42`, 1/2/4 threads), with matching pthread-generated worker/JS glue, using Emscripten 3.1.57 and exact source ID. Debug compile/teardown before adding DuckLake.
3. Rebuild the candidate DuckLake source against the pinned core with its necessary patch/dependency set; inspect the metadata/version and test real `LOAD`, read-only AIS catalog `ATTACH` and Parquet queries. AIS's existing DuckLake `8736cb23` is strictly v1.5.3 and cannot be copied blindly.
4. Instrument C++ `ReadAt`, readahead, import dispatch and the browser XHR path with **comparable timestamps and thread/worker IDs**. Run the new independent baseline, then an actual DuckDB 2.0 Parquet scan and compare simultaneous 206 reads. Do not attribute serialization to `fs_mutex_` without a trace: the existing lock is released before the reader callback.
5. Prefer a small direct-per-pthread fix if possible; build an async HTTP broker only if proxy routing requires it. Prove correct results, cancellation, bounded memory, 206/Content-Range integrity and real overlapping requests before claiming the CPU/I/O pools work in the browser.
6. Compare AIS queries on stable EH, old COI 1.5.3 and new COI 2.0 under equal conditions; integrate into AIS only after accuracy/stability and cold/warm benchmarks pass.

## Consumer and provenance separation

- **Generic engine code, HTTP transport and race regression tests:** `azaracla/duckdb-wasm`.
- **AIS COI configuration, DuckLake browser data and Parquet performance benchmarks:** `azaracla/ais`, branch `feat/duckdb-threads-v2`.
- **2.0 source/API port reference, not remote-query architecture:** `azaracla/serverless-quack-ducklake`, branch `dev`.

No commits made to AIS, Serverless Quack or this fork's `main` by this iteration; no PR opened yet because the port has not been compiled.
