# DuckDB 2 asynchronous I/O: pinned-code audit and first implementation gate

Date: 2026-09-20. Scope: `feat/duckdb-2dev-async-http` in `azaracla/duckdb-wasm`. This is an engineering audit, **not** a claim that async I/O or DuckLake performance already works in WASM. Product acceptance contract: [DUCKLAKE_PERFORMANCE_GOAL.md](DUCKLAKE_PERFORMANCE_GOAL.md).

## Exact source and observed implementation

- DuckDB core: `duckdb/duckdb@43f897e5f3446bde2b36cef5dc137eea14211fd9` (`pins.json`). Do not silently use floating `main`/`next` or a 1.x binary. DuckLake `eb7b95df82fc3ba0ace777e34ef1c81280477042` is only a candidate, not yet browser-validated.
- At that exact DuckDB revision, `src/include/duckdb/parallel/task_scheduler.hpp` declares `NumberOfAsyncThreads()`, `SetAsyncThreads(idx_t)`, and `ScheduleTask(s) (..., TaskSchedulerType pool_type)` with distinct scheduler pools/queues. This confirms native scheduler API presence, **not** whether WASM instantiates working background workers or calls those APIs.
- DuckDB's July 31, 2026 architecture description (https://duckdb.org/2026/07/31/asynchronous-io) describes separate REGULAR and ASYNC thread pools, Parquet read-ahead that schedules independent fetch tasks, `SET async_threads`, `SET read_ahead_depth`, and async memory governance. It states that the native ASYNC pool runs blocking I/O on worker threads, and DuckLake can benefit through Parquet scans. This is upstream design evidence, not fork runtime evidence. The article's native/S3 speedups cannot be attributed to our WASM build.
- `lib/CMakeLists.txt` sets `-DDUCKDB_NO_THREADS=1 -sUSE_PTHREADS=0` for non-COI variants. Therefore merely switching to EH without changing this configuration cannot be asserted to execute DuckDB's **native** multithreaded ASYNC pool. EH is still an option for a separately implemented browser-side asynchronous bridge, but that must be explicitly described as a different mechanism.
- `lib/src/http_wasm.cc` implements `HTTPWasmClient::Get` and `Head` using `EM_ASM_PTR`, `XMLHttpRequest`, and **`xhr.open(method, url, false)`** followed by `xhr.send(null)`. `false` is synchronous XHR. There is a C++ synchronous `HTTPClient` contract around these calls. Inspect other HTTP methods, range reads, and file-handle ownership before changing this file. Changing only `false` to `true`, or substituting an unawaited `fetch`, would break response lifetime and return before bytes are available; it is **not** a fix.
- The 32-preloaded-pthread COI artifact compiled on run https://github.com/azaracla/duckdb-wasm/actions/runs/35500879338; browser initialization still stalled at `loading-workers` in https://github.com/azaracla/duckdb-wasm/actions/runs/35502437614. Neither `SELECT 42` nor Range overlap nor DuckLake speedup is proven. Do not equate an HTTP 200 for a worker file with a ready pthread.

## Design decision and open proof obligations

**First candidate for actual upstream ASYNC-pool behavior:** restore a minimal, bounded COI pthread configuration and fix the worker initialization protocol; verify `SELECT 42` and `SET async_threads` in the browser, then trace reads made by an actual Parquet query. This retains upstream's blocking-I/O-on-ASYNC-threads architecture, but requires proving that synchronous XHR is supported in its actual worker execution environment (not on a window's main thread), cross-origin isolation, memory use, and the pool's behavior under the Emscripten thread scheduler. A 32-worker preload is an experimental diagnostic, not the desired operational configuration.

**Alternative candidate:** an EH/non-threaded build with JS `fetch` + async suspension (if viable with this exact Emscripten version) or worker message passing. Such a bridge can provide overlapping Range requests but does **not** automatically implement DuckDB's native ASYNC pool because `DUCKDB_NO_THREADS=1` is set. Identify how scan tasks issue requests concurrently before claiming equivalence.

**Do not choose between these candidates by intuition alone.** The next code inspection must trace pinned DuckDB's Parquet read-ahead task creation -> `TaskSchedulerType::ASYNC` -> filesystem/HTTP `Read` -> WASM client, including existing compile-time `DUCKDB_NO_THREADS` branches. Record a specific source path and a reproducible browser probe for each link. Then implement the smallest safe bridge or scheduler fix.

## Mandatory measurement gate

1. Same pinned core, browser and reproducible Parquet fixture with multiple row groups/column chunks, served from an instrumented HTTP Range server with CORS and proper `206 Content-Range` semantics.
2. Confirm real browser SQL and query result; record `SET threads`, `SET async_threads`, `SET read_ahead_depth` where available (unsupported settings must be reported, not treated as successes).
3. Server logs must include request ID, URL, Range, monotonic start/finish, status, bytes, and max in-flight requests; assert >=2 **overlapping Range reads issued by one query**. Prefetch started in JS independently of DuckDB must not pass the test.
4. Query DuckLake metadata and actual Parquet files end to end; measure cold/warm repeated latency versus a controlled no-read-ahead baseline at equal DuckDB revision/data/network/browser, including memory, bytes and failures. Report null or negative gains honestly.
5. Compile C++ only when C++/WASM-affecting code changes. Browser worker, instrumentation and benchmark changes must reuse a pinned successful artifact; do not use a stale artifact to claim that newly edited C++ is validated.

## Next actionable development slice

Trace `duckdb/duckdb@43f897e5f3` Parquet ASYNC scheduling and read-ahead sources and our `lib/src/http_wasm.cc` GET/HEAD/Range callsites; introduce a small browser-compatible Range timing fixture, first as a non-gating diagnostic, then gate on SQL-generated overlaps once SQL actually runs. Keep COI initialization debugging separate from DuckLake performance metrics. No source edits to `main` or the AIS repository.
