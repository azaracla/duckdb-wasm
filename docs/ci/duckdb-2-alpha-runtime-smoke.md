# DuckDB 2 alpha: COI runtime and browser acceptance status

Branch `feat/duckdb-2dev-async-http`; only the fork is changed. Pinned core: `43f897e5f3446bde2b36cef5dc137eea14211fd9`; toolchain Emscripten `3.1.57`. Do not merge into AIS or `main` on the strength of build success alone.

## Proven compiler milestone (historical)

GitHub Actions run [35491247365](https://github.com/azaracla/duckdb-wasm/actions/runs/35491247365) built the C++ DuckDB 2 alpha COI target, checked the three nonempty artifacts `duckdb-coi.js`, `duckdb-coi.wasm`, `duckdb-coi.pthread.js`, and uploaded them. This did **not** run DuckDB SQL in a browser.

## Critical JS postprocessing bug

The build script's old `awk` remove-all-exports-except-allowlist pass deleted Emscripten's local `var f = wasmExports[name]` in `createExportWrapper` and the `___trap` binding. The resulting published JS failed at runtime despite the green C++ build. **Never consume the artifacts from run 35491247365 as a functional release.** The compile-only CI lacked a JS semantic sanity check.

Commit `91f40a9d7c9c2903008a0f793641cd638767c32e` removed the destructive pass, retaining the generated exports; `tools/async-io/check_generated_coi.mjs` checks wrapper-local `f`, `___trap`, SQL and pthread symbols and fails before upload. Four dedicated regression tests reject stripped glue. The COI workflow now requires `node --check` and this export guard in addition to three nonempty artifacts.

The correction is rebuilding in [35497425528](https://github.com/azaracla/duckdb-wasm/actions/runs/35497425528). Its compile/glue/runtime publication result must be checked independently; the earlier compiler success cannot be transferred to a changed JS artifact. Subsequent docs-only and browser-tool changes do not trigger more COI builds.

## Separate, inexpensive browser gate

The workflow `.github/workflows/duckdb-2dev-browser-smoke.yml` does **not** rebuild C++ or run MVP/EH, Rust, TPC-H, the shell or the complete JS test matrix. It only downloads a successful COI artifact from a build whose Git SHA descends from the export fix, verifies it, installs a minimal isolated npm dependency set, bundles the actual browser API + COI worker + pthread worker, and runs headless Chrome on a COOP/COEP localhost site. It checks `crossOriginIsolated`, the DuckDB 2 version, `SELECT 42`, and SQL behavior at thread settings 1/2/4. Scripts and reproduction commands: `tools/async-io/coi-smoke/README.md`.

Smoke run [35497842299](https://github.com/azaracla/duckdb-wasm/actions/runs/35497842299) failed workflow validation due to an unsupported `runner.temp` job-level expression. Fixed in `bc1de8901b8b6c3dce2d96b6d913e0ab5465b9ee`. The next smoke [35497945213](https://github.com/azaracla/duckdb-wasm/actions/runs/35497945213) correctly failed *before downloading* because the corrected COI build had not yet succeeded; this is an intentional fail-closed dependency check, not a browser SQL failure. Re-execute only the failed smoke job or trigger this isolated workflow after corrected COI artifact publication. Keep the corrected source SHA ancestry requirement.

Additional smoke hardening: the completion poll begins **after** navigation (avoids invalidated about:blank execution contexts); the two Node-only dynamic requires are patched exactly as the existing project bundler does, only in a disposable checkout. Fast checks independently verify 16 Python tests, 8 Node tests, and smoke-harness syntax.

## Not yet proven by a green compiler or fast checks

- Full browser initialization, SQL results and thread scheduling after the JS fix.
- DuckLake alpha extension compatibility and signed loading.
- Correct, overlapping HTTP 206 Range reads at 2 and 4 threads, cancellation, short-response handling, and exact AIS Parquet results.
- Stable teardown and performance against the 1.5.3 baseline.

Do not turn a CI build success or a static JS check into a claim that these browser/performance gates passed.
