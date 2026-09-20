# Project objective: DuckDB 2 WASM async I/O for faster DuckLake queries

Recorded 2026-09-20. This is the product objective and acceptance contract, independent of implementation path.

## North star

Ship browser-compatible DuckDB 2 alpha at exact core commit `43f897e5f3446bde2b36cef5dc137eea14211fd9` with demonstrably concurrent remote reads and faster representative DuckLake queries. Compilation, `SELECT 42`, higher thread settings and synthetic fetch overlap are infrastructure checks, not proof of DuckLake performance. The current browser transport is a central async-fetch broker plus shared-memory/Atomics handoff to pthread callers; do not call it the unmodified native DuckDB I/O pool.

## Verified milestones

1. DuckDB `v2.0.0-dev1` core is pinned in `tools/async-io/pins.json`.
2. Browser COI/pthread runtime runs SQL and accepts threads=1/2/4.
3. Browser run `35526669568` proved 42 real HTTP 206 Range GETs and maximum overlap 3 from one correct Parquet `SUM(id)` query.
4. Controlled transport A/B run `35528519665` passed both latency conditions. At 150 ms per GET, median sync-XHR 6520.505 ms versus broker 2850.850 ms (2.287x), p95 6523.935 versus 2884.710 ms (2.262x). At zero injected latency, compare only matched request-count/byte cohorts; the stable 42 GET / 1,647,224-byte cohort is about 480 ms for both paths. These results concern Parquet, **not DuckLake**.
5. DuckLake side-module build run `35528049778` succeeded and uploaded `alpha-ducklake-wasm-threads` (artifact `10610810945`), built from DuckLake `eb7b95df82fc3ba0ace777e34ef1c81280477042` against the exact pinned core. The loadable COI main-module run `35528908281` succeeded and uploaded `alpha-coi-loadable-runtime` (artifact `10610638046`). Both artifacts expire on 2026-09-23; preserve/rebuild them for integration. **Neither successful build proves browser `LOAD ducklake` or a DuckLake query.**

## Immediate DuckLake integration gate — highest priority

- Download the two successful artifacts into the same browser smoke site. Do not mix the earlier static/non-loadable COI runtime with the DuckLake side module. Verify core source ID and Emscripten 3.1.57 compatibility against the manifest.
- First run browser `SELECT 42` with the loadable runtime; then explicitly register/resolve the DuckLake extension binary and execute `LOAD ducklake`. Capture the full loader error, worker console and network trace if loading fails. Never count a successful extension compilation as successful loading.
- Create a deterministic, small DuckLake catalog and data fixture using the pinned native core + pinned DuckLake extension, with a documented metadata backend accessible in the browser. Test browser `ATTACH ... (TYPE DUCKLAKE)`, table discovery, row count and deterministic aggregate before measuring speed. Identify whether the catalog is SQLite, PostgreSQL or another supported backend and ensure browser filesystem/extension compatibility; do not assume native-only metadata access works in WASM.
- Run the same DuckLake query with broker enabled and disabled, alternating trial order. Use cold and warm conditions separately, verify result equality and request/byte comparability, and report median/p95, Range GETs, overlap, transferred bytes and peak memory. Keep DuckLake metadata requests distinct from Parquet data requests.

## Native reference gate — in parallel, never a substitute for DuckLake

Build a native DuckDB CLI/library from **the same exact core commit** `43f897e5f3446bde2b36cef5dc137eea14211fd9`, applying the same required source compatibility patches. Assert `SELECT version()` and source ID before measuring. Use the identical deterministic fixture, SQL, local Range server, latency models (0 and 150 ms), cache policy and thread/async/read-ahead settings where the native build supports them. Native HTTP access requires an explicitly pinned/verified httpfs extension. Run repeated fresh-process trials and report native timings separately from the browser transport A/B. Browser/native absolute ratios include platform/runtime differences; never attribute their entire gap to the HTTP broker. Once DuckLake loads in the browser, use the same catalog/data snapshot and query for the native DuckLake reference too.

## Acceptance

A successful DuckLake `LOAD` alone is not sufficient. Definition of done is a reproducible pinned build, trace-backed concurrent Range I/O from real DuckDB SQL, a correct real browser DuckLake query, and a controlled DuckLake A/B performance result (including negative results). CPU parallelism is a separate dimension; do not infer CPU scaling from HTTP overlap.
