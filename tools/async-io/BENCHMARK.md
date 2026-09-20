# DuckDB 2 browser remote-I/O benchmark

This benchmark measures the performance effect of the experimental async HTTP Range broker against the pre-existing synchronous XHR transport. It is deliberately an A/B transport benchmark: both sides use the same DuckDB 2 alpha WASM artifact, Chromium, Parquet fixture, SQL, `threads=2`, `async_threads=2`, and `read_ahead_depth=4`.

## Compared paths

- `broker`: DuckDB pthread reads delegate HTTP Range transfers to the dedicated async-`fetch` broker and sleep on SharedArrayBuffer/Atomics until completion.
- `sync-xhr`: the broker port is intentionally not installed. The exact same DuckDB runtime falls back to the original synchronous XHR Range path.

The synthetic async-fetch and sync-XHR controls are disabled during timed benchmark runs. They remain useful diagnostics but are not benchmark samples.

## Method

Run each transport in a fresh headless Chrome process so a DuckDB query result cache cannot contaminate the other transport. Use a deterministic 20-row-group Parquet fixture and verify `SUM(id)=19999900000` on every sample.

The CI benchmark runs two network conditions:

1. `delay=150 ms`: deterministic latency-injected Range server. This isolates the benefit of overlapping independent remote reads.
2. `delay=0 ms`: loopback/no injected latency. This catches broker overhead and prevents a latency-only win from being reported as a universal speedup.

Each cell uses 5 SQL executions. Report all samples, median query latency, speedup `median(sync-xhr) / median(broker)`, completed HTTP 206 Range GETs, maximum overlap, and transferred Range bytes. The overlap acceptance remains strict: broker must reach at least 2 overlapping Range GETs, while sync-XHR is expected to remain serialized.

The benchmark is a regression/performance signal, not a claim that browser WASM equals native DuckDB. Native DuckDB 2 is a methodological reference: same-revision A/B comparisons, repeated runs, external cache control, and remote Parquet workloads. A separate native-vs-WASM benchmark requires a native executable built from the exact pinned DuckDB commit and the same dataset/query/server.

## Run locally

After building the COI site and creating the fixture:

```sh
ALPHA_PARQUET_FIXTURE=/tmp/fixture.parquet \
ALPHA_RANGE_DELAY_MS=150 \
ALPHA_RANGE_TRANSPORT=sync-xhr \
ALPHA_RANGE_REPEAT=5 \
node tools/async-io/coi-smoke/run.cjs build/dev/coi-smoke

ALPHA_PARQUET_FIXTURE=/tmp/fixture.parquet \
ALPHA_RANGE_DELAY_MS=150 \
ALPHA_RANGE_TRANSPORT=broker \
ALPHA_RANGE_REPEAT=5 \
node tools/async-io/coi-smoke/run.cjs build/dev/coi-smoke
```

Read the `parquet.samplesMs`, `parquet.medianMs`, and `rangeTrace` fields from `COI BROWSER SMOKE`. CI stores the complete logs as benchmark artifacts.


## Validated CI result

Browser run `35528519665` passed both latency models on DuckDB `v2.0.0-dev1`.

With 150 ms injected per ranged GET, the sync-XHR median was **6520.505 ms** and the async broker median **2850.850 ms**, a **2.287x** median speedup. P95 improved from **6523.935 ms** to **2884.710 ms** (**2.262x**). Stable trials issued 42 ranged GETs / 1,647,224 transferred bytes; maximum overlap rose from 1 to 3.

At zero injected latency, raw trial medians are not meaningful because DuckDB emitted different request cohorts across trials. For the shared stable cohort of 42 ranged GETs / 1,647,224 bytes, both transports were approximately **480 ms**, so the broker showed no material overhead in that matched workload.

The benchmark runner selects comparable cohorts by request signature and requires at least two **paired** observations per transport before applying a performance gate. The latency-bound matched median must improve by at least 1.5x; the zero-latency matched median may regress by at most 10%.
