#!/usr/bin/env node
/** Bundle only the real COI browser API, dispatcher and pthread wrapper.
 * No MVP/EH, Node bundle, Jasmine, TPC-H, Rust, or shell. Requires an isolated
 * ALPHA_SMOKE_DEPS directory containing esbuild and apache-arrow/qs packages.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const deps = process.env.ALPHA_SMOKE_DEPS;
if (!deps) throw new Error('ALPHA_SMOKE_DEPS must point at the isolated npm install directory');
const nodeModules = path.resolve(deps, 'node_modules');
const require = createRequire(import.meta.url);
const esbuild = require(path.join(nodeModules, 'esbuild'));
const arrowPackage = path.join(nodeModules, 'apache-arrow', 'package.json');
const arrow = JSON.parse(fs.readFileSync(arrowPackage, 'utf8'));
// Match the existing package bundler's Apache Arrow v17 exports workaround.
arrow.exports = {
  node: { import: './Arrow.node.mjs', require: './Arrow.node.js' },
  import: './Arrow.dom.mjs',
  default: './Arrow.dom.js',
};
fs.writeFileSync(arrowPackage, JSON.stringify(arrow));

const packageDir = path.join(repo, 'packages/duckdb-wasm');
const bindings = path.join(packageDir, 'src/bindings');
const outDir = path.resolve(process.argv[2] || path.join(repo, 'build/dev/coi-smoke'));
fs.mkdirSync(outDir, { recursive: true });
for (const name of ['duckdb-coi.js', 'duckdb-coi.wasm', 'duckdb-coi.pthread.js']) {
  if (!fs.statSync(path.join(bindings, name)).size) throw new Error(`Empty ${name}`);
}

// Mirror only the two relevant dynamic-require guards from the project's
// existing bundle.mjs. Otherwise esbuild tries to resolve Node-only modules
// (child_process or vm) while packaging a browser-only IIFE. These changes
// affect only the disposable generated build checkout, never checked-in code.
function guardNodeOnlyRequire(filename, moduleName) {
  const file = path.join(bindings, filename);
  const text = fs.readFileSync(file, 'utf8');
  const marker = new RegExp(`require\\(["']${moduleName}["']\\)`, 'g');
  const matches = [...text.matchAll(marker)];
  if (matches.length !== 1) {
    throw new Error(`${filename}: expected exactly one require(${moduleName}), found ${matches.length}`);
  }
  fs.writeFileSync(file, text.replace(marker, `["${moduleName}"].map(require)`));
}
guardNodeOnlyRequire('duckdb-coi.js', 'child_process');
guardNodeOnlyRequire('duckdb-coi.pthread.js', 'vm');

// The previous browser run proved that worker 1 enters DuckDB(Module), but it
// never returned or reached instantiateWasm. Probe only this worker at stable
// checkpoints inside the *downloaded generated JS*, before esbuild bundles it.
// These are smoke-only changes, not patches to the WASM or production runtime.
const generatedJS = path.join(bindings, 'duckdb-coi.js');
let generated = fs.readFileSync(generatedJS, 'utf8');
const checkpoint = (stage) => `if (ENVIRONMENT_IS_PTHREAD && Module["workerID"] === 1) postMessage({ cmd: "coi-startup-worker-1:${stage}" });`;
for (const [needle, replacement] of [
  ['var Module = moduleArg;', `var Module = moduleArg;\n            ${checkpoint('generated-factory-start')}`],
  ['var wasmExports = createWasm();', `${checkpoint('generated-before-createWasm')}\n            var wasmExports = createWasm();\n            ${checkpoint('generated-after-createWasm')}`],
  ['var shouldRunNow = true;', `${checkpoint('generated-before-run-setup')}\n            var shouldRunNow = true;`],
]) {
  const occurrences = generated.split(needle).length - 1;
  if (occurrences !== 1) throw new Error(`Generated COI checkpoint ${needle}: expected 1 occurrence, found ${occurrences}`);
  generated = generated.replace(needle, replacement);
}
fs.writeFileSync(generatedJS, generated);

const common = {
  platform: 'browser',
  bundle: true,
  target: ['chrome110'],
  minify: false,
  sourcemap: false,
  nodePaths: [nodeModules],
  external: ['module'],
  define: { 'process.release.name': '"browser"' },
  logLevel: 'warning',
};
for (const [entry, output, format] of [
  ['duckdb.ts', 'duckdb-browser.mjs', 'esm'],
  ['duckdb-browser-coi.worker.ts', 'duckdb-browser-coi.worker.js', 'iife'],
  ['duckdb-browser-coi.pthread.worker.ts', 'duckdb-browser-coi.pthread.worker.js', 'iife'],
]) {
  await esbuild.build({
    ...common,
    entryPoints: [path.join(packageDir, 'src/targets', entry)],
    outfile: path.join(outDir, output),
    format,
  });
  console.log(`Built only ${output}`);
}
fs.copyFileSync(path.join(bindings, 'duckdb-coi.wasm'), path.join(outDir, 'duckdb-coi.wasm'));
fs.copyFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'smoke.html'), path.join(outDir, 'smoke.html'));
console.log(`COI smoke site ready: ${outDir}`);
