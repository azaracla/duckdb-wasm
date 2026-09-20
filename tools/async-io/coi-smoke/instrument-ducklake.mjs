#!/usr/bin/env node
// CI-only diagnostics on the downloaded generated COI JavaScript. This modifies
// the disposable checkout, never the pinned DuckDB source or production bundle.
import fs from 'node:fs';
const target = process.argv[2];
if (!target) throw new Error('Usage: node instrument-ducklake.mjs <generated duckdb-coi.js>');
let js = fs.readFileSync(target, 'utf8');
const replaceOne = (needle, replacement, label) => {
  const count = js.split(needle).length - 1;
  if (count !== 1) throw new Error(`DuckLake instrumentation ${label}: expected 1 match; found ${count}`);
  js = js.replace(needle, replacement);
};
// The ordinary eight-worker pool is already exhausted during db.open(), well
// before LOAD, despite the SQL threads=2 / async_threads=1 limits. Isolate
// resource starvation from dynamic-linker failures without recompiling WASM:
// Emscripten's generated JS sets the preallocated pool size at runtime. The
// pthread worker and shared-memory binary are unchanged. This is an explicit
// DuckLake-only experiment, NOT a validated production pool-size decision.
replaceOne('var pthreadPoolSize = 8;', 'var pthreadPoolSize = 16;', 'DuckLake-only pthread pool');
const probe = stage => `console.log('[ducklake-linker] ${stage}');`;
replaceOne('var metadata = getDylinkMetadata(binary);',
  `${probe('read dylink metadata')} var metadata = getDylinkMetadata(binary); ${probe('dylink metadata ready')}`, 'metadata');
replaceOne('var module = binary instanceof WebAssembly.Module ? binary : new WebAssembly.Module(binary);',
  `${probe('compile start')} var module = binary instanceof WebAssembly.Module ? binary : new WebAssembly.Module(binary); ${probe('compile finished')}`, 'compile');
replaceOne('var instance = new WebAssembly.Instance(module, info);',
  `${probe('instantiate start')} var instance = new WebAssembly.Instance(module, info); ${probe('instantiate finished')}`, 'instantiate');
replaceOne('registerTLSInit(moduleExports["_emscripten_tls_init"], instance.exports, metadata);',
  `${probe('tls register start')} registerTLSInit(moduleExports["_emscripten_tls_init"], instance.exports, metadata); ${probe('tls register finished')}`, 'tls');
replaceOne('if (runtimeInitialized) {\n                                    applyRelocs();',
  `if (runtimeInitialized) {\n                                    ${probe('relocs start')} applyRelocs(); ${probe('relocs finished')}`, 'relocs');
replaceOne('if (runtimeInitialized) {\n                                    init();',
  `if (runtimeInitialized) {\n                                    ${probe('constructors start')} init(); ${probe('constructors finished')}`, 'constructors');
replaceOne('moduleLoaded(getExports());',
  `${probe('getExports start')} moduleLoaded(getExports()); ${probe('getExports finished')}`, 'getExports');
fs.writeFileSync(target, js);
console.log('DuckLake generated-JS probes installed with 16-worker experimental pool (CI only)');
