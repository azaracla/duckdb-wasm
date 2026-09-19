# DuckDB 2.0 alpha — branch-specific CI

Scope: `feat/duckdb-2dev-async-http` only. `main` and the existing filesystem-races PR are not modified.

## Automatic jobs

| Workflow | Trigger on this branch | Does | Deliberately excludes |
| --- | --- | --- | --- |
| `duckdb-2dev-fast.yml` | Push touching tools/async-io, lib, the COI build script, DuckDB gitlink, or the fast workflow | Pin/gitlink check, `unittest` for the API-porting script, Node HTTP Range overlap tests | Submodules, Emscripten, npm/yarn install, any C++ compilation |
| `duckdb-2dev-coi.yml` | Push touching lib, the COI build script, port script, pins, gitlink, .gitmodules, or build workflow | One pinned COI/pthread compilation; bounded ccache; compiler log on failure; WASM/JS/pthread files on success | MVP, EH, native, Rust/dataprep, TPC-H generator, shell, benchmarks, DuckLake build |

Both cancel their own superseded runs, use `contents: read`, and have short artifact retention. Documentation-only commits do not launch a build. The COI build uses Emscripten 3.1.57 and the exact pinned `43f897e5f3446bde2b36cef5dc137eea14211fd9` source. The API port script is applied in the CI workspace only: its source edits must subsequently be committed; a build is not proof of that migration being committed.

The legacy upstream matrix formerly in `.github/workflows/main.yml` is intentionally replaced **on this experimental branch only** by a manual, skipped placeholder. Its complete original bytes are preserved as the identical Git blob at `docs/ci/legacy-main.yml`. Existing legacy jobs triggered by commits before this isolation may still need cancellation through the Actions UI. Other workflow files (e.g. issue mirrors and npm-tag workflow) have no automatic branch-push trigger and are unchanged.

## Inspect jobs

- [Fast checks](https://github.com/azaracla/duckdb-wasm/actions/workflows/duckdb-2dev-fast.yml)
- [COI compilation](https://github.com/azaracla/duckdb-wasm/actions/workflows/duckdb-2dev-coi.yml)

No compiled binary, browser `SELECT 42`, or parallel HTTP result is established until the COI job and later browser tests pass. The first fast-check run passed: https://github.com/azaracla/duckdb-wasm/actions/runs/35455169840 . First COI build: https://github.com/azaracla/duckdb-wasm/actions/runs/35455183027 (do not assume its result without checking the job).

## IMPORTANT: restore before merging / PR to main

The workflow isolation is only for this experimental branch, **not a proposed change to upstream CI**. Restore the original matrix before opening a mergeable PR, and remove the temporary backup/workflows if they are no longer wanted:

```bash
git show HEAD:docs/ci/legacy-main.yml > .github/workflows/main.yml
git rm docs/ci/legacy-main.yml
# Optionally also remove the two branch-specific workflows and this note.
git add .github/workflows/main.yml
git commit -m 'ci: restore original main workflow before merge'
```

The `pull_request` workflow for a PR targeting `main` can still execute the legacy matrix from the base branch; editing this feature branch does not change the base branch's policy. Do not claim that PR CI is suppressed merely because feature-branch push CI is isolated.
