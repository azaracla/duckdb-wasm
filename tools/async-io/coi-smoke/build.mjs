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
