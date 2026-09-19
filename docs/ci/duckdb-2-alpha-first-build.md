# DuckDB 2.0 alpha COI: first real compiler feedback

2026-09-19. Experimental branch `feat/duckdb-2dev-async-http` only; no AIS production changes.

## Build #1: failure diagnosed

- GitHub Actions run: https://github.com/azaracla/duckdb-wasm/actions/runs/35455183027
- The pinned DuckDB submodule `43f897e5f3446bde2b36cef5dc137eea14211fd9` and the four guarded wrapper API substitutions were checked successfully in the runner.
- Emscripten 3.1.57 built DuckDB until about 35%, then `submodules/duckdb/src/main/extension/extension_load.cpp:495` failed with `use of undeclared identifier 'config'` in the `WASM_LOADABLE_EXTENSIONS` code path.
- The pin's `ExtensionHelper::ExtensionUrlTemplate` API takes `(optional_ptr<const DatabaseInstance>, const ExtensionRepository &, const string &)`, not the older `(config, version)` invocation. The pin exposes `ExtensionRepository::GetDefaultRepository(optional_ptr<DBConfig>)`.
- This is a concrete *core API compile failure*, not evidence of HTTP Range serialization, runtime deadlock or DuckLake behavior.

## Narrow fix (build #2)

- `tools/async-io/patch_core_alpha.py` verifies the DuckDB git HEAD is the exact pinned commit and replaces only the obsolete `ExtensionUrlTemplate(&config, "")` call with the default repository from `db.config` and `ExtensionUrlTemplate(db, repository, "")`.
- The helper is strict and idempotent: missing, duplicate or mixed source fragments abort instead of silently editing unexpected revisions. `--check` fails if the patch has not been applied.
- The core remains at its immutable Git submodule commit; the fix is applied only to the disposable Actions checkout after `git submodule update` and before CMake.
- This patch does **not** import the Serverless EH-only/Quack workaround, replace the extension loader, bypass signature verification, turn off COI threads or change the HTTP filesystem.
- The COI workflow now uses `actions/cache@v4` with `save-always: true` to keep already compiled objects even when the first attempt fails; previous failed builds did not save ccache.
- Offline tests for the core patch are picked up by `.github/workflows/duckdb-2dev-fast.yml` via `test_*.py`.
- Second build run: https://github.com/azaracla/duckdb-wasm/actions/runs/35457036312. Its success and any subsequent diagnostics must be read from the Actions run; this note does not assert that the WASM runtime compiles or boots.

## Acceptance gates (unchanged)

1. Core + wrapper compile and link successfully; `duckdb-coi.js`, `.wasm`, `.pthread.js` exist and are nonempty.
2. A COI browser smoke test runs `SELECT 42`, checks the pinned runtime version and verifies query results at 1/2/4 threads without deadlocks.
3. Build and load DuckLake against the *same* DuckDB core, then test the public AIS catalogue read-only.
4. Prove concurrent, validated HTTP 206 Range reads within DuckDB (not merely within an independent four-worker test), followed by cold/warm AIS benchmarks.

The wrapper API changes in `tools/async-io/port_api.py` still run as a source-checked CI migration, not yet as committed wrapper C++ modifications; do not describe them as completed source integration.
