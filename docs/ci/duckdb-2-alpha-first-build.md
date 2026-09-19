# DuckDB 2.0 alpha COI: compiler feedback and corrective iterations

2026-09-19. Experimental branch `feat/duckdb-2dev-async-http` only; no AIS production changes.

## Build #1: pinned core compile failure

- Run: https://github.com/azaracla/duckdb-wasm/actions/runs/35455183027
- The DuckDB gitlink `43f897e5f3446bde2b36cef5dc137eea14211fd9` and guarded wrapper API substitutions passed.
- With Emscripten 3.1.57, the pinned core reached approximately 35%, then `src/main/extension/extension_load.cpp:495` failed because `config` no longer exists in the WASM-loadable-extension path.
- `tools/async-io/patch_core_alpha.py` performs one guarded, idempotent replacement using `ExtensionRepository::GetDefaultRepository(&db.config)` and the new `ExtensionUrlTemplate(db, repository, "")` API. It runs in the disposable checkout without advancing the pinned DuckDB submodule or changing signature policy.
- Its four Python regression tests passed in the fast CI. This does not demonstrate extension compatibility or a functioning browser runtime.

## Build #2: core succeeded, wrapper compile failure

- Run: https://github.com/azaracla/duckdb-wasm/actions/runs/35457036312
- The pinned core passed its build and install step, including the static libraries and installed headers. This is a **core-only compilation success**, not a linked WASM runtime.
- The wrapper then failed at `lib/src/json_dataview.cc:144` with `no member named 'get' in 'duckdb::Vector` because DuckDB 2 alpha's struct children are direct `Vector` objects.
- Source fix `b6ca5a00d6f385927ee506bc655b463ca12c4e72`: use `&entry` instead of `entry.get()` in the post-order traversal, and replace deprecated `vec->Flatten(chunk.size())` with `vec->Flatten()`.
- The fast check workflow passed for that change. C++ compilation is validated only by a subsequent COI build.

## Build throughput and reproducibility

- `40ab6b02dd333c6e3bda74b4d3f1e13302517926` propagates C and C++ compiler launchers into DuckDB's **separate ExternalProject CMake cache**. Previously, `ccache` was configured only on the wrapper, which did not cover core C++ compilation.
- GitHub Actions warns that `actions/cache@v4` with `save-always: true` does not save on a failed job. `7d6eb11fef1ae45caa8dce33b8d544aa12a7308f` instead uses `actions/cache/restore@v4` and an explicit `actions/cache/save@v4` step guarded by `always()` and `cache-hit != 'true'`. The actual cache upload and hit rate still require verification from run logs.
- The CI still builds only the `wasm_threads`/COI runtime, with the same pinned DuckDB alpha and Emscripten 3.1.57. Its compile log is uploaded on failures and outputs are uploaded only on success.
- The latest COI run for the cache changes is https://github.com/azaracla/duckdb-wasm/actions/runs/35470141243. Inspect its **actual result**; this document makes no claim of build or runtime success for it.

## Next acceptance gates

1. Compile and link the wrapper. Check all three non-empty `duckdb-coi.js`, `duckdb-coi.wasm`, `duckdb-coi.pthread.js` outputs; inspect log artifacts on failure.
2. Commit the guarded wrapper API migration as actual C++ source changes, then switch CI from `port_api.py --apply` to `--check` only. Keep the upstream core patch separate from the pinned gitlink.
3. Browser smoke tests: `SELECT 42`, version identification, 1/2/4 threads without deadlock.
4. Rebuild DuckLake against this exact alpha, load it and attach the AIS public catalogue read-only.
5. Measure genuine overlapping HTTP 206 Range reads from **DuckDB itself**, then cold/warm AIS performance and output equivalence.

The experimental branch is not deployable to AIS. Neither a successfully compiled core nor passing source-regression tests should be presented as a linked or booted browser runtime.
