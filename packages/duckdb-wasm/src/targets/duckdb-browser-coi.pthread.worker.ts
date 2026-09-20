import * as pthread_api from '../bindings/duckdb-coi.pthread';
import DuckDB from '../bindings/duckdb-coi';
import { BROWSER_RUNTIME } from '../bindings/runtime_browser';

// Register the global DuckDB runtime.
globalThis.DUCKDB_RUNTIME = {};
for (const func of Object.getOwnPropertyNames(BROWSER_RUNTIME)) {
    if (func === 'constructor') continue;
    globalThis.DUCKDB_RUNTIME[func] = Object.getOwnPropertyDescriptor(BROWSER_RUNTIME, func)!.value;
}

// The generated Emscripten 3.1.57 pthread worker queues messages during the
// asynchronous module load, copies sharedModules/handlers/workerID, and only
// acknowledges `loaded` once startWorker is called. We bundle DuckDB instead
// of using importScripts, but must preserve the rest of that protocol.
const generatedOnMessage = pthread_api.onmessage;
const handleMessage = (event: MessageEvent<any>): void => {
    const data = event.data;
    if (data.cmd === 'load') {
        const queued: MessageEvent<any>[] = [];
        globalThis.onmessage = (next: MessageEvent<any>) => queued.push(next);
        const module = pthread_api.getModule();
        module['wasmModule'] = data.wasmModule;
        module['sharedModules'] = data.sharedModules;
        module['wasmMemory'] = data.wasmMemory;
        module['buffer'] = data.wasmMemory.buffer;
        module['workerID'] = data.workerID;
        module['ENVIRONMENT_IS_PTHREAD'] = true;
        for (const handler of data.handlers || []) {
            module[handler] = (...args: any[]) => postMessage({ cmd: 'callHandler', handler, args });
        }
        (globalThis as any).startWorker = (instance: any) => {
            pthread_api.setModule(instance);
            postMessage({ cmd: 'loaded' });
            globalThis.onmessage = handleMessage;
            for (const pending of queued) handleMessage(pending);
        };
        try {
            DuckDB(module).catch((error: unknown) => {
                console.error('[coi pthread] module initialization failed', data.workerID, error);
                throw error;
            });
        } catch (error) {
            console.error('[coi pthread] module initialization threw', data.workerID, error);
            throw error;
        }
    } else if (data.cmd === 'registerFileHandle') {
        globalThis.DUCKDB_RUNTIME._files = globalThis.DUCKDB_RUNTIME._files || new Map();
        globalThis.DUCKDB_RUNTIME._files.set(data.fileName, data.fileHandle);
    } else if (data.cmd === 'dropFileHandle') {
        globalThis.DUCKDB_RUNTIME._files = globalThis.DUCKDB_RUNTIME._files || new Map();
        globalThis.DUCKDB_RUNTIME._files.delete(data.fileName);
    } else if (data.cmd === 'registerUDFFunction') {
        globalThis.DUCKDB_RUNTIME._udfFunctions = globalThis.DUCKDB_RUNTIME._udfFunctions || new Map();
        globalThis.DUCKDB_RUNTIME._udfFunctions.set(data.udf.name, data.udf);
    } else if (data.cmd === 'dropUDFFunctions') {
        globalThis.DUCKDB_RUNTIME._udfFunctions = globalThis.DUCKDB_RUNTIME._udfFunctions || new Map();
        for (const key of globalThis.DUCKDB_RUNTIME._udfFunctions.keys()) {
            if (globalThis.DUCKDB_RUNTIME._udfFunctions.get(key).connection_id === data.connectionId) {
                globalThis.DUCKDB_RUNTIME._udfFunctions.delete(key);
            }
        }
    } else {
        generatedOnMessage(event);
    }
};
globalThis.onmessage = handleMessage;
