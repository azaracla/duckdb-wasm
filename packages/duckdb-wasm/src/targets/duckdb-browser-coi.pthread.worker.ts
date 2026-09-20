import * as pthread_api from '../bindings/duckdb-coi.pthread';
import DuckDB from '../bindings/duckdb-coi';
import { BROWSER_RUNTIME } from '../bindings/runtime_browser';

// Register the global DuckDB runtime.
globalThis.DUCKDB_RUNTIME = {};
for (const func of Object.getOwnPropertyNames(BROWSER_RUNTIME)) {
    if (func === 'constructor') continue;
    globalThis.DUCKDB_RUNTIME[func] = Object.getOwnPropertyDescriptor(BROWSER_RUNTIME, func)!.value;
}

// Temporary, bounded diagnostic: Emscripten's parent worker reports unknown
// commands to its existing printErr, which the browser smoke captures. This
// works even though Puppeteer's targetcreated omits nested workers. Only trace
// worker #1 so the 32-worker preload does not flood logs. This deliberately
// never sends a fake `loaded` acknowledgement or changes pool semantics.
const traceStartup = (workerID: number, stage: string): void => {
    if (workerID !== 1) return;
    postMessage({ cmd: `coi-startup-worker-1:${stage}` });
};

// The generated Emscripten 3.1.57 pthread worker queues messages during the
// asynchronous module load, copies sharedModules/handlers/workerID, and only
// acknowledges `loaded` once startWorker is called. We bundle DuckDB instead
// of using importScripts, but must preserve the rest of that protocol.
const generatedOnMessage = pthread_api.onmessage;
const handleMessage = (event: MessageEvent<any>): void => {
    const data = event.data;
    if (data.cmd === 'load') {
        traceStartup(data.workerID, 'load-received');
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
            traceStartup(data.workerID, 'startWorker-entered');
            pthread_api.setModule(instance);
            postMessage({ cmd: 'loaded' });
            traceStartup(data.workerID, 'loaded-posted');
            globalThis.onmessage = handleMessage;
            for (const pending of queued) handleMessage(pending);
        };
        try {
            traceStartup(data.workerID, 'duckdb-factory-enter');
            DuckDB(module).then(() => {
                traceStartup(data.workerID, 'duckdb-factory-resolved');
            }).catch((error: unknown) => {
                traceStartup(data.workerID, 'duckdb-factory-rejected');
                console.error('[coi pthread] module initialization failed', data.workerID, error);
                throw error;
            });
            traceStartup(data.workerID, 'duckdb-factory-returned');
        } catch (error) {
            traceStartup(data.workerID, 'duckdb-factory-threw');
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
