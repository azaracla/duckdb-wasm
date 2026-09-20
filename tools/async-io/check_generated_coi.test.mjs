import test from 'node:test';
import assert from 'node:assert/strict';
import { checkGeneratedCOI } from './check_generated_coi.mjs';

const good = `
function createExportWrapper(name, nargs) {
  return (...args) => {
    var f = wasmExports[name];
    assert(f);
    return f(...args);
  };
}
var wasmBinaryFile = './duckdb-coi.wasm';
var ___trap = Module['___trap'] = createExportWrapper('__trap', 0);
var version = createExportWrapper("duckdb_web_get_version", 1);
var query = createExportWrapper("duckdb_web_query_run_buffer", 4);
var threads = createExportWrapper("_emscripten_thread_init", 6);
`;

test('intact Emscripten glue has all required bindings', () => {
  assert.equal(checkGeneratedCOI(good), true);
});

test('legacy awk stripping of local f is rejected', () => {
  const bad = good.replace('    var f = wasmExports[name];\n', '');
  assert.throws(() => checkGeneratedCOI(bad), /lost its local f/);
});

test('legacy awk stripping of ___trap is rejected', () => {
  const bad = good.replace(/^var ___trap.*\n/m, '');
  assert.throws(() => checkGeneratedCOI(bad), /___trap export binding/);
});

test('missing SQL entry point is rejected', () => {
  const bad = good.replace('createExportWrapper("duckdb_web_query_run_buffer", 4)', 'undefined');
  assert.throws(() => checkGeneratedCOI(bad), /duckdb_web_query_run_buffer/);
});
