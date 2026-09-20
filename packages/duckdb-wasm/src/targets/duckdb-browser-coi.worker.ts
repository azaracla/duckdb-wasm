import { AsyncDuckDBDispatcher, WorkerResponseVariant, WorkerRequestVariant } from '../parallel';
import { DuckDB } from '../bindings/bindings_browser_coi';
import { DuckDBBindings } from '../bindings';
import { BROWSER_RUNTIME } from '../bindings/runtime_browser';
import { InstantiationProgress } from '../bindings/progress';

const RANGE_BROKER_WORKERS = new WeakSet<Worker>();

function finishRangeRequest(control: Int32Array, state: number, status: number, responseBytes: number, errorCode: number): void {
    Atomics.store(control, 1, status);
    Atomics.store(control, 2, responseBytes);
    Atomics.store(control, 3, errorCode);
    Atomics.store(control, 0, state);
    Atomics.notify(control, 0, 1);
}

async function handleCentralRangeRequest(data: any): Promise<void> {
    const control = new Int32Array(data.control as SharedArrayBuffer);
    const started = performance.now();
    console.log(
        `[range-central:start] parent=${data.parentWorkerId} location=${data.location} bytes=${data.bytes} t0=${started.toFixed(3)}`,
    );
    try {
        const last = data.location + data.bytes - 1;
        const expected = `bytes ${data.location}-${last}/`;
        const response = await fetch(data.url, {
            headers: { Range: `bytes=${data.location}-${last}` },
            cache: 'no-store',
        });
        const contentRange = response.headers.get('Content-Range');
        if (response.status !== 206) {
            finishRangeRequest(control, -1, response.status, 0, 2);
            return;
        }
        if (!contentRange) {
            finishRangeRequest(control, -1, response.status, 0, 3);
            return;
        }
        if (!contentRange.startsWith(expected)) {
            finishRangeRequest(control, -1, response.status, 0, 4);
            return;
        }
        const body = new Uint8Array(await response.arrayBuffer());
        if (body.byteLength !== data.bytes) {
            finishRangeRequest(control, -1, response.status, body.byteLength, 5);
            return;
        }
        new Uint8Array(data.heap as SharedArrayBuffer, data.buf, data.bytes).set(body);
        const ended = performance.now();
        console.log(
            `[range-central:end] parent=${data.parentWorkerId} location=${data.location} bytes=${data.bytes} status=${response.status} t0=${started.toFixed(3)} t1=${ended.toFixed(3)} duration=${(ended - started).toFixed(3)}`,
        );
        finishRangeRequest(control, 1, response.status, body.byteLength, 0);
    } catch (error) {
        console.error('[range-central] fetch failed', error);
        finishRangeRequest(control, -1, 0, 0, 1);
    }
}

function installCentralRangeBroker(bindings: DuckDB): void {
    const pthread = bindings.pthread;
    if (!pthread) return;
    const workers = [...pthread.unusedWorkers, ...pthread.runningWorkers];
    for (const worker of workers) {
        if (RANGE_BROKER_WORKERS.has(worker)) continue;
        RANGE_BROKER_WORKERS.add(worker);
        worker.addEventListener('message', event => {
            const data = event.data;
            if (data?.cmd !== 'duckdb-http-range-request') return;
            void handleCentralRangeRequest(data);
        });
        worker.postMessage({ cmd: 'duckdb-http-range-broker-ready' });
    }
    console.log(`[range-central] attached to ${workers.length} Emscripten pthread workers`);
}

/** The duckdb worker API for web workers */
class WebWorker extends AsyncDuckDBDispatcher {
    /** Post a response back to the main thread */
    protected postMessage(response: WorkerResponseVariant, transfer: ArrayBuffer[]) {
        globalThis.postMessage(response, transfer);
    }

    /** Instantiate the wasm module */
    protected async instantiate(
        mainModuleURL: string,
        pthreadWorkerURL: string | null,
        progress: (p: InstantiationProgress) => void,
    ): Promise<DuckDBBindings> {
        const bindings = new DuckDB(this, BROWSER_RUNTIME, mainModuleURL, pthreadWorkerURL);
        await bindings.instantiate(progress);
        installCentralRangeBroker(bindings);
        return bindings;
    }
}

/** Register the worker */
export function registerWorker(): void {
    const api = new WebWorker();
    globalThis.onmessage = async (event: MessageEvent<WorkerRequestVariant>) => {
        await api.onMessage(event.data);
    };
}

registerWorker();
