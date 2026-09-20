# DuckDB 2 asynchronous I/O: pinned-code audit and implementation gates

Date: 2026-09-20. Scope: `feat/duckdb-2dev-async-http` in `azaracla/duckdb-wasm`. This is an engineering audit, **not** a claim that async I/O or DuckLake performance already works in WASM. Product acceptance contract: [DUCKLAKE_PERFORMANCE_GOAL.md](DUCKLAKE_PERFORMANCE_GOAL.md).

## Exact source and observed implementation

- DuckDB core: `duckdb/duckdb@43f897e5f3446bde2b36cef5dc137eea14211fd9` (`pins.json`). Do not silently use floating `main`/`next` or a 1.x binary. DuckLake `eb7b95df82fc3ba0ace777e34ef1c81280477042` is only a candidate, not yet browser-validated.
- At that exact DuckDB revision, `src/include/duckdb/common/enums/task_scheduler_type.hpp` declares two distinct pool types, `REGULAR` and `ASYNC`.
- `src/include/duckdb/parallel/task_scheduler.hpp` declares `NumberOfAsyncThreads()`, `SetAsyncThreads(idx_t)` and `ScheduleTask(s)(..., TaskSchedulerType pool_type)` with distinct scheduler pools/queues. `src/parallel/task_scheduler.cpp` constructs both queues/pools and dispatches ASYNC tasks to them; REGULAR workers may also process queues across pools.
- **Confirmed source-level obstruction for EH:** `src/parallel/task_scheduler.cpp::SetAsyncThreads` explicitly raises `NotImplementedException("DuckDB was compiled without threads! Setting async threads != 0 is not allowed.")` when `DUCKDB_NO_THREADS` is defined. `ExecuteForever` also rejects its background thread loop under that define. Our `lib/CMakeLists.txt` sets `-DDUCKDB_NO_THREADS=1 -sUSE_PTHREADS=0` for non-COI variants. Consequently, the *actual upstream ASYNC thread pool* cannot be enabled in our unmodified EH build; it requires a supported pthread build or a different explicitly implemented browser scheduler/bridge. Do **not** claim EH automatically inherits DuckDB 2's async pool.
- DuckDB's July 31, 2026 architecture description (https://duckdb.org/2026/07/31/asynchronous-io) describes separate REGULAR and ASYNC thread pools, Parquet read-ahead that schedules independent fetch tasks, `SET async_threads`, `SET read_ahead_depth`, and async memory governance. It states that the native ASYNC pool runs blocking I/O on worker threads, and DuckLake can benefit through Parquet scans. This is upstream design evidence, not fork runtime evidence; native/S3 speedups cannot be attributed to our WASM build.
- `lib/src/http_wasm.cc` implements `HTTPWasmClient::Get` and `Head` using `EM_ASM_PTR`, `XMLHttpRequest`, and **`xhr.open(method, url, false)`** followed by `xhr.send(null)`. `false` is synchronous XHR. There is a C++ synchronous `HTTPClient` contract around these calls. Inspect the remaining HTTP methods, Range call sites, and file-handle ownership before changing this file. Changing only `false` to `true`, or substituting an unawaited `fetch`, would break response lifetime and return before bytes are available; it is **not** a fix.
- The 32-preloaded-pthread COI artifact compiled on run https://github.com/azaracla/duckdb-wasm/actions/runs/35500879338; browser initialization still stalled at `loading-workers` in https://github.com/azaracla/duckdb-wasm/actions/runs/35502437614. Neither `SELECT 42` nor Range overlap nor DuckLake speedup is proven. Do not equate an HTTP 200 for a worker file with a ready pthread.

## Design decision and open proof obligations

**First candidate for actual upstream ASYNC-pool behavior:** restore a minimal, bounded COI pthread configuration and fix the worker initialization protocol; verify `SELECT 42` and `SET async_threads` in the browser, then trace reads made by an actual Parquet query. This retains upstream's blocking-I/O-on-ASYNC-threads architecture, but requires proving that synchronous XHR is supported in its actual worker execution environment (not on a window's main thread), cross-origin isolation, memory use, and the pool's behavior under the Emscripten thread scheduler. A 32-worker preload is an experimental diagnostic, not the desired operational configuration.

**Alternative candidate:** an EH/non-threaded build with JS `fetch` + async suspension (if viable with this exact Emscripten version) or worker message passing. Such a bridge can provide overlapping Range requests but does **not** automatically implement DuckDB's native ASYNC pool because `DUCKDB_NO_THREADS=1` is set. Identify how scan tasks issue requests concurrently before claiming equivalence. Do **not** change `DUCKDB_NO_THREADS` on EH while leaving pthreads off and expect a working scheduler.

**Not yet traced:** the exact pinned Parquet read-ahead task creation -> `TaskSchedulerType::ASYNC` -> filesystem/HTTP `Read` -> WASM client and all relevant `DUCKDB_NO_THREADS` branches. This must be established with precise paths/callsites before modifying core scheduling or declaring an integrated pool.

## Range tracing tool added (instrument only, not a green DuckDB test)

`tools/async-io/range_trace_server.py` serves a local, real Parquet file with `GET`/`HEAD`, byte/suffix HTTP Range responses, correct `206`/`416` and `Content-Range`, CORS and exposed headers. Its `/__trace` endpoint records monotonic start/end timestamps, path, method, Range header, status, bytes, max in-flight requests and max overlap **of completed ranged GETs**. `/__reset` resets tracing only while no file requests are in progress. `--delay-ms` enables reproducible overlap under local networking. It binds to `127.0.0.1`; do not expose production AIS data or authentication secrets.

Example with a generated, non-sensitive Parquet fixture containing multiple row groups/column chunks:

```sh
python3 tools/async-io/range_trace_server.py --file /path/to/test.parquet --port 8767 --delay-ms 100
# Reset before the query and read trace AFTER it finishes:
curl -s http://127.0.0.1:8767/__reset
# In the browser, execute exactly ONE real DuckDB query against:
# http://127.0.0.1:8767/fixture.parquet
curl -s http://127.0.0.1:8767/__trace
```

Only assert `max_overlapping_ranges >= 2` if the SQL query ran successfully, the trace was reset directly before this one query, no extraneous clients made ranged GETs, and requests genuinely originated from DuckDB. A separate unit test intentionally sends synthetic concurrent requests to validate that the *server* detects overlaps; its green result is **not** proof of DuckDB concurrency. `python3 -m unittest discover -s tools/async-io -p 'test_*.py' -v` runs this test with the rest of the lightweight CI checks and without recompiling DuckDB.

## Browser runtime progress log

- **2026-09-20 — COI runtime milestone reached.** Commit `722ce810cfd7b43523e654195b227b2f9de4e521` reduced the eager Emscripten pthread pool from 32 to 8. Workflow run `35517024549` then compiled the pinned DuckDB 2 COI runtime and passed the real Chromium smoke: cross-origin isolation, DuckDB `v2.0.0-dev1`, `SELECT 42`, and `SET threads=1/2/4`.
- **Parquet extension path fixed.** The first real `read_parquet()` acceptance attempt failed before any file I/O because the loadable-extension build tried to autoload `parquet.duckdb_extension.wasm`. The experimental COI build was changed to statically link Parquet; the C++/WASM compile itself subsequently passed.
- **Browser filesystem path identified.** DuckDB 2 alpha WASM rejects the legacy `builtin_httpfs` switch. The acceptance harness now uses `AsyncDuckDB.registerFileURL(..., DuckDBDataProtocol.HTTP, false)` and queries the registered logical path, exercising duckdb-wasm's browser filesystem rather than native `httpfs`.
- **First successful remote Parquet SQL, but negative Range result.** Run `35523765282` returned the correct `COUNT(*) = 200000` from the HTTP-hosted 20-row-group Parquet fixture. The server trace showed exactly one non-ranged `GET /fixture.parquet`, HTTP 200, 1,077,564 bytes, `max_overlapping_ranges=0`. This is a valid negative result: the query succeeded, but no Range I/O or concurrency occurred.
- **Root cause of the full-file GET found.** `WebFileSystem::WebFile::WriteInfo` serializes `forceFullHttpReads=true` whenever `filesystem.force_full_http_reads` is unset because it uses `.value_or(true)`. The browser runtime then bypasses its Range probing and performs a whole-file GET. The acceptance harness now explicitly opens DuckDB with `forceFullHTTPReads=false`, `allowFullHTTPReads=false`, and `reliableHeadRequests=true` so failure to use Range cannot silently fall back to a full download.
- **Range path proven, concurrency still negative.** Run `35524900131` with full-read fallback disabled produced a Range-capable HEAD (`206`) and two ranged GETs (`bytes=1048576-1064959`, 16,384 bytes; `bytes=1064960-1077563`, 12,604 bytes), both HTTP `206`. They were strictly serial: `completed_range_gets=2`, `max_overlapping_ranges=1`. Chromium also logged `Tried to spawn a new thread, but the thread pool is exhausted.`
- **Workload correction.** That run used `COUNT(*)`, which can be answered largely from Parquet metadata; both observed ranges were at the file tail. This is insufficient to exercise row-group read-ahead. The next gate uses a real column scan (`SUM(id)`) over all 20 row groups and explicitly configures `async_threads=2` plus `read_ahead_depth=4` so the DuckDB 2 ASYNC pool demand is bounded inside the 8-worker Emscripten pool.
- **Next proof obligation.** Re-run the same single-query Parquet gate with the real column scan and bounded async settings. A green result still requires >=2 overlapping HTTP Range GETs from that one DuckDB query. Ranged-but-serial remains a failure.

## Harness regression note

Run `35525493151` did not exercise the Range gate: the harness referenced `rangeBase` before declaring it, causing `ReferenceError: rangeBase is not defined` immediately after `SELECT 42`. This is a test-harness regression, not a DuckDB/runtime result. Commit `77deba819833479c66133c8b8f5e9fd537f4c1a5` fixes the variable scope and also applies the intended `maximum_threads=2` for Range-mode runs. The acceptance criteria remain unchanged.

## 2026-09-20 serial Range deep-dive

Run `35525300369` exercised a real column scan with `threads=4`, `async_threads=2`, `read_ahead_depth=4` and returned the correct `SUM(id)=19999900000`. DuckDB issued 42 HTTP Range GETs, all HTTP 206, across the full file rather than only the footer. Despite multiple near-simultaneous browser-side `[range:start]` logs, the threaded fixture server observed `max_inflight=1` and `max_overlapping_ranges=1`; the requests were actually serialized on the wire. Query latency was about 6.53 s with the fixture's intentional 150 ms/request delay.

The same run repeatedly logged `Tried to spawn a new thread, but the thread pool is exhausted.` before the scan. The acceptance harness had previously exercised `SET threads=1/2/4` in the same database before enabling the async pool, which can create misleading Emscripten pool pressure. The next run removes that churn for the Range gate, opens with `maximumThreads=2`, keeps `threads=2`, `async_threads=2`, `read_ahead_depth=4`, and prints explicit worker IDs for every Range request.

A separate C++ concern is now identified: `WebFileSystem::OnDiskFile(FileHandle&)` currently returns `true` unconditionally, including HTTP/S3-backed files. If the no-churn run remains serialized, inspect the pinned Parquet read-ahead decision path for `OnDiskFile`/remote-file behavior and correct this classification rather than increasing the Emscripten worker pool blindly.

## Mandatory end-to-end measurement gate

1. Same pinned core, browser and reproducible Parquet fixture with multiple row groups/column chunks, served from the instrumented HTTP Range server above.
2. Confirm real browser SQL and correct query result; record `SET threads`, `SET async_threads`, `SET read_ahead_depth` where available (unsupported settings must be reported, not treated as successes).
3. Server logs must include request ID, URL, Range, monotonic start/finish, status, bytes, and max in-flight requests; assert >=2 **overlapping Range reads issued by one query**. Prefetch started in JS independently of DuckDB must not pass the test.
4. Query DuckLake metadata and actual Parquet files end to end; measure cold/warm repeated latency versus a controlled no-read-ahead baseline at equal DuckDB revision/data/network/browser, including memory, bytes and failures. Report null or negative gains honestly.
5. Compile C++ only when C++/WASM-affecting code changes. Browser worker, instrumentation and benchmark changes must reuse a pinned successful artifact; do not use a stale artifact to claim that newly edited C++ is validated.

## Next actionable development slice

Trace the pinned Parquet read-ahead implementation through the scheduler and filesystem (currently an open proof obligation); run real SQL with a browser-compatible DuckDB 2 runtime, connect it to this trace server and only then use overlaps as a gate. Diagnose COI worker initialization independently rather than masking it with a 32-pthread preload. No edits to `main` or the AIS repository.
