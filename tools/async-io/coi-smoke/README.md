# DuckDB 2 alpha COI browser smoke

This smoke exercises **the real browser TypeScript API and COI/pthread worker bundles**. It does not run the broad upstream Karma test matrix or compile DuckDB itself. It must consume the artifacts of a *successful* COI build that passed `check_generated_coi.mjs`; never reuse the earlier artifact from run `35491247365`, whose JS export bindings were stripped.

From a checkout containing the three generated files in `packages/duckdb-wasm/src/bindings`:

```bash
export ALPHA_SMOKE_DEPS="$(mktemp -d)"
npm install --prefix "$ALPHA_SMOKE_DEPS" --no-save --no-package-lock --ignore-scripts --no-audit --no-fund \
  esbuild@0.20.2 apache-arrow@17.0.0 qs@6.14.1 puppeteer-core@22.8.0
node tools/async-io/check_generated_coi.mjs packages/duckdb-wasm/src/bindings/duckdb-coi.js
node tools/async-io/coi-smoke/build.mjs build/dev/coi-smoke
CHROME_BIN="$(command -v google-chrome || command -v chromium)" \
  node tools/async-io/coi-smoke/run.cjs build/dev/coi-smoke
```

The Python server sets COOP and COEP headers and serves WebAssembly with the correct MIME type. Chrome must report `crossOriginIsolated`; the test then loads the actual COI worker and pthread bundle, opens an in-memory DuckDB 2 database, checks `SELECT 42` through Arrow and verifies SQL results at 1, 2, and 4 configured threads. Missing browser support, JS runtime errors, invalid query results, or timeouts fail the run. The isolated npm directory prevents installation of the project's full monorepo dependencies.

**Separate pending gates:** signed DuckLake extension loading, real AIS queries, byte-exact concurrent HTTP Range, UDF lifetime, and browser teardown/race stress. A green build or this smoke alone proves none of those.
