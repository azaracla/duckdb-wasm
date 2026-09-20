#!/usr/bin/env node
// Guard against build post-processing that drops Emscripten's WASM bindings.
// Non-empty .js/.wasm/.pthread.js artifacts alone do NOT prove a usable runtime.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function checkGeneratedCOI(js) {
  const marker = 'function createExportWrapper(name, nargs) {';
  const start = js.indexOf(marker);
  if (start < 0 || js.indexOf(marker, start + marker.length) !== -1) {
    throw new Error('Missing or duplicate createExportWrapper');
  }
  const next = js.indexOf('var wasmBinaryFile', start + marker.length);
  if (next < 0 || next - start > 5000) {
    throw new Error('Cannot identify createExportWrapper body');
  }
  const wrapper = js.slice(start, next);
  if (!/\b(?:var|let|const)\s+f\s*=\s*wasmExports\[name\]/.test(wrapper)) {
    throw new Error('createExportWrapper lost its local f = wasmExports[name] binding');
  }
  if (!/\b(?:var|let|const)\s+___trap\s*=/.test(js)) {
    throw new Error('Emscripten abort lost its ___trap export binding');
  }
  for (const symbol of ['duckdb_web_get_version', 'duckdb_web_query_run_buffer', '_emscripten_thread_init']) {
    if (!js.includes(`createExportWrapper("${symbol}"`)) {
      throw new Error(`Missing required WASM export: ${symbol}`);
    }
  }
  return true;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fileURLToPath(new URL(`file://${process.argv[1]}`))) {
  const file = process.argv[2];
  if (!file) {
    console.error('Usage: node check_generated_coi.mjs <generated duckdb-coi.js>');
    process.exitCode = 2;
  } else {
    try {
      checkGeneratedCOI(readFileSync(file, 'utf8'));
      console.log('PASS: generated COI JS retains required Emscripten WASM bindings');
    } catch (error) {
      console.error(`FAIL: ${error.message}`);
      process.exitCode = 1;
    }
  }
}
