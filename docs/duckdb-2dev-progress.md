# Integration log — DuckDB 2.0 alpha / browser concurrent HTTP

Updated 2026-09-19. Branch: `feat/duckdb-2dev-async-http`. This is a working branch, NOT a functional DuckDB 2.0-WASM release.

## Completed in the first iteration

1. Created the branch from `fix/pthread-filesystem-races` (`74abfa917247fb9228982cc8d0df41a547c46749`), retaining the positional-read, per-thread read-ahead, response-buffer, HTTP-validation and file-info-cache fixes plus the existing tests.
2. Documented the integration plan and acceptance gates in `docs/duckdb-2dev-async-http.md`.
3. Pinned the fork's actual `submodules/duckdb` gitlink to Serverless Quack's current alpha commit `43f897e5f3446bde2b36cef5dc137eea14211fd9`. The old August spike SHA `07194a2ca5...` is not the target.
4. Added `tools/async-io/pins.json`; candidate browser DuckLake revision from the Serverless native build is `eb7b95df82fc3ba0ace777e34ef1c81280477042`, not validated for WASM. Its `.github/duckdb-version` is `c97bd8b96e0481b9e58d491f4fcd8599fccd65fb`, different from the selected core; the native build uses `APPLY_PATCHES`.
5. Started source-level core port using Serverless' API migration: `TableFunctionRelation::GetAlias()` returns `Identifier`, its subquery uses `SubqueryMutable()` and `GetSubqueryTypeMutable()`, and its column/function expressions accept `Identifier`.
6. Added `tools/async-io/overlap.mjs` and `overlap.test.mjs`: shared-time-origin interval analysis rejects HTTP errors, incomplete Range bodies, incorrect Content-Range and false concurrency positives. Four Node tests passed against a local copy. This tests only the analyzer.
7. Added a local-only deterministic 206 fixture (`range-server.py`) and browser harness (`range-concurrency.html`) based on AIS's independent four-worker XHR experiment. The page uses epoch-equivalent worker timestamps and rejects HTTP 403 as evidence of parallel.

## Second iteration — concrete work and verification

1. `8f35c37`: ported `lib/src/json_dataview.cc` for DuckDB 2.0 `FlatVector::GetData<T>` and `Identifier::GetIdentifierName`; integer and double descriptors now use the correct typed pointers rather than an untyped `GetData()` call.
2. `c04f209`: ported `lib/src/arrow_type_mapping.cc` for `Identifier`, `Reference(value, count)`, `FlatVector::SetData(vector, data, count)` and mutable vector access. String values now use `StringVector::AddString` so the DuckDB vector owns the strings. Corrected an existing boolean conversion problem: the destination-type check was inverted and the BOOL switch arm fell through to the numeric SetData path.
3. `b0c975c`: added a configure-time guard in `lib/cmake/duckdb.cmake` that rejects the wrong DuckDB checkout in Emscripten builds and passes the explicit `43f897e5f3` Git source ID to DuckDB's CMake ExternalProject. This does not itself prove a working linker, extension ABI or `pragma_version()`.
4. `b461458` + `13780e`: added a source-checked, idempotent migration helper `tools/async-io/port_api.py` and four offline tests. It prepares the remaining known API changes (obsolete `BufferedFileSystem` override, new HTTP `Options` method, JSON typedef `Identifier` and legacy aggregate state). Unlike the older Serverless `nullptr` OPTIONS stub, the helper creates an explicit unsuccessful HTTP 501 response. **The helper's transformations have NOT yet been applied to the checked-in C++ files**; run `--apply`, review the diff and commit the resulting source changes before attempting a full build.
5. On a local copy of the helper and tests, `python3 -m unittest discover -s tools/async-io -p 'test_port_api.py' -v` passed **4/4** after correcting an idempotence issue where the replacement for `host_port/Get` contained the original marker. `py_compile` passed too. These are source-migration tests only.
6. On a faithful local recreation of the committed HTTP fixture, four simultaneous Python HTTP requests returned valid HTTP 206, 65,536 bytes each, in ~0.223 s total with the fixture's intentional 0.2 s delay; a malformed Range returned 416. This verifies the **local fixture server**, not DuckDB or browser XHR concurrency.
7. Chromium and Playwright are available in the execution container, but the attempted real-browser smoke test failed at navigation with `net::ERR_BLOCKED_BY_ADMINISTRATOR` for the loopback URL. Browser concurrency remains **NOT TESTED** here. GitHub cloning also failed because `github.com` could not be resolved; Docker is unavailable. No DuckDB 2.0 core compilation, COI smoke test, extension loading, S3 test or async I/O benchmark has run.
8. GitHub Actions `main.yml` has a `push` trigger, but the repository's API returned zero workflow runs for this experimental branch when checked. No CI result is claimed.

## Commands for the next actual checkout

```bash
git fetch origin
git switch feat/duckdb-2dev-async-http
git submodule update --init --recursive
node --test tools/async-io/overlap.test.mjs
python3 -m unittest discover -s tools/async-io -p 'test_port_api.py' -v
python3 tools/async-io/port_api.py --apply
python3 tools/async-io/port_api.py --check
git diff -- lib/include/duckdb/web/io/buffered_filesystem.h lib/src/http_wasm.cc lib/src/json_typedef.cc
# Inspect, test and commit the ported C++ source; DO NOT deploy it before a real build.
python3 tools/async-io/range-server.py
# Browser: http://127.0.0.1:8765/range-concurrency.html
```

## Remaining work, in dependency order

1. Apply and review the guarded remaining API migrations; port `webdb.cc`, the extension loader, HTTPFS/Arrow interfaces and any additional errors revealed by an actual COI compile. Import only the required Serverless 2.0 migrations, not its `maximum_threads=1`, EH-only scheduler workaround or remote Quack architecture.
2. Build and browser-smoke a pure DuckDB 2.0 COI runtime (`pragma_version()`, `SELECT 42`, 1/2/4 threads), generating matching JS worker/glue with Emscripten 3.1.57 and the pinned source ID; fix compile, link and teardown failures before adding DuckLake.
3. Rebuild DuckLake against this exact core. Inspect the candidate native revision's `APPLY_PATCHES`, version metadata, dependencies and matching source id; do not assume native DuckLake builds in shared-memory WASM. Load, attach the public AIS catalogue read-only and query Parquet in the browser.
4. Instrument `ReadAt`, read-ahead, imported `duckdb_web_fs_file_read` and JS XHR with comparable timestamps and thread IDs. The old JS Range implementation also needs an explicit HTTP 206 and exact response-size check before copying bytes into the WASM heap. Do not assume a short `fs_mutex_` protects the whole network call.
5. Prove genuine overlapping, correct 206 reads at 2 and 4 threads; attempt a minimal per-worker fix first and consider an async broker only if import proxying requires it. Check cancellations, 416, short responses, wrong offsets, bounded memory and byte-for-byte query results.
6. Compare cold/warm AIS `vessels_positions` and `map_snapshot` against the 1.5.3 EH/COI baselines, then merge into AIS only after correctness, stability and performance gates.

## Consumer separation and guardrails

- Generic engine code, HTTP transport and race tests: `azaracla/duckdb-wasm`.
- AIS browser configuration, DuckLake production data and performance benchmarks: `azaracla/ais`, branch `feat/duckdb-threads-v2`.
- Source/API migration reference only: `azaracla/serverless-quack-ducklake`, branch `dev`.

No commits were made to AIS, Serverless Quack, or this fork's `main` in these iterations. No PR has been opened for an uncompiled port. The working branch is experimental and must not be published as a runtime release or deployed to AIS production.
