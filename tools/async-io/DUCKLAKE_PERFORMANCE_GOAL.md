# Project objective: DuckDB 2 WASM async I/O for faster DuckLake queries

Recorded 2026-09-20. This is the product objective and acceptance contract, independent of implementation path.

## North star (non-negotiable)

Ship a browser-compatible build targeting the pinned DuckDB 2 development/alpha revision that **actually takes advantage of DuckDB 2's relevant asynchronous I/O scheduling/pool capabilities** to run independent remote reads concurrently and speed up representative DuckLake queries. Do not mistake a successful compilation, `SELECT 42`, a higher configured thread count, or multiple initiated `fetch` calls for proof that DuckLake is faster. Verify the exact upstream APIs, behavior, constraints and revision before claiming that the DuckDB 2 I/O pool is integrated; do not assume native asynchronous filesystem behavior automatically survives Emscripten/WASM.

This goal takes priority over any one mechanism: EH/single-WASM-thread, JSPI/Asyncify where supported, COI/pthreads, filesystem bridges, dedicated I/O workers, and hybrids are candidate implementations, not requirements in themselves. CPU parallelism and concurrent/asynchronous HTTP I/O are different features. COI/pthreads may help but are **not automatically a prerequisite for concurrent fetch**. Conversely, concurrent JS fetches alone do not demonstrate that DuckDB's scan scheduler issues independent read requests in parallel or that its I/O pool is functioning.

## Required milestones, in order

1. Pin and document the exact DuckDB 2 alpha source and inspect the new native async I/O scheduler/pool APIs and how its filesystem, Parquet reader, and DuckLake extension invoke them. Identify the concrete gap in WASM and the planned bridge; distinguish upstream support from fork modifications.
2. Compile a minimal WASM runtime and run browser SQL (`SELECT 42`) with the actual browser worker/glue. This is an infrastructure gate only, not the performance goal. Avoid rebuilding C++ for TypeScript, browser harness, or workflow-only changes; reuse verified artifacts and report cache statistics.
3. Demonstrate at least two independent HTTP Range requests overlapping in flight **originating from one real DuckDB query** against remote Parquet data. Collect request URLs, `Range` headers, start/end timestamps, overlaps, bytes, errors and response codes in a local test server or browser instrumentation; do not infer concurrency from total request count. Keep COOP/COEP, CORS, Accept-Ranges, error handling and any DuckLake metadata access explicit in the test setup.
4. Execute an end-to-end representative DuckLake query using the same browser WASM path and realistic remote files/metadata. Test cold and warm cache conditions separately; compare against a controlled baseline (same DuckDB revision, dataset, query, network and browser, but without concurrent I/O) and record median/p95 latency, transferred bytes, ranges in flight and memory use. Repeat runs. Set a numerical speedup threshold only after baseline measurements; report regressions transparently.
5. Only if the previous gates are green, add CPU multithreading/COI and verify incremental benefit independently (SQL threads=1/2/4 and subsequent DuckLake benchmarks). Never use a green COI compilation to substitute for browser execution or concurrent-I/O evidence.

## Engineering constraints and open questions

- Preserve correct filesystem behavior, thread safety, file-handle lifetime, cancellation, HTTP error propagation, range semantics and metadata consistency under concurrent reads. Browser workers cannot block the event loop waiting for a JS Promise; investigate proper async suspension or message-passing behavior at the C++/WASM boundary rather than relying on native blocking primitives.
- Determine if DuckDB 2's native I/O pool supports the browser target as compiled, requires an Emscripten compatibility layer, or must be represented by an equivalent browser-side scheduler. State clearly which path is implemented and whether the *actual* native pool is used.
- Keep the pinned DuckDB 2 source and signatures; do not silently revert to DuckDB 1 or disable threading in a claimed COI build. Avoid large 32-pthread preloads merely to mask initialization failures; diagnose workers and resource usage separately.
- Keep the expensive COI compiler workflow scoped to C++/WASM-affecting files. Browser smoke tests should reuse a compiler-success artifact and run on JS/TS/harness changes without another C++ build. Keep tests that do not prove the final performance objective labelled as preliminary.

## Current status

As of 2026-09-20, the bounded 8-pthread COI runtime has passed real Chromium initialization with the pinned DuckDB 2 alpha, `SELECT 42`, and `threads=1/2/4`. Parquet is statically linked for the experimental acceptance build, and a real remote Parquet query through the browser filesystem has returned the correct result.

The first instrumented remote Parquet run is a **negative concurrency result**: run `35523765282` completed `COUNT(*) = 200000` but downloaded the 1,077,564-byte file in one HTTP 200 GET with no Range header, so `completed_range_gets=0` and `max_overlapping_ranges=0`. Investigation found that an unset browser filesystem setting is serialized as `forceFullHttpReads=true`; the acceptance harness now explicitly disables full reads and full-read fallback. This has not yet proven Range overlap and does not yet satisfy milestone 3.

The immediate next gate is unchanged: the same single DuckDB SQL query must produce at least two overlapping HTTP 206 Range GETs. If Range requests appear but remain serial, the next work is to trace and configure DuckDB 2 `async_threads`, `read_ahead_depth`, and Parquet read-ahead task routing in the pinned build. No DuckLake performance claim is valid before that evidence.

**Definition of done:** a reproducible DuckDB 2 browser-WASM build, trace-backed proof of overlapping Range reads made by DuckDB, a real successful DuckLake query, and benchmark evidence of the latency benefit or a documented negative result. Keep this objective through any future branch or architecture change.
