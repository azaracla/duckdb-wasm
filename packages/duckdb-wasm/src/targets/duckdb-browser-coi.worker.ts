import { AsyncDuckDBDispatcher, WorkerResponseVariant, WorkerRequestVariant } from '../parallel';
import { DuckDB } from '../bindings/bindings_browser_coi';
import { DuckDBBindings } from '../bindings';
import { BROWSER_RUNTIME } from '../bindings/runtime_browser';
import { InstantiationProgress } from '../bindings/progress';

const RANGE_BROKER_WORKERS = new WeakSet<Worker>();
let RANGE_NETWORK_BROKER: Worker | null = null;
let RANGE_NETWORK_BROKER_READY: Promise<Worker> | null = null;

const RANGE_NETWORK_BROKER_SOURCE = `
const ports = [];

function finishRangeRequest(control, state, status, responseBytes, errorCode) {
    Atomics.store(control, 1, status);
    Atomics.store(control, 2, responseBytes);
    Atomics.store(control, 3, errorCode);
    Atomics.store(control, 0, state);
    Atomics.notify(control, 0, 1);
}

async function handleRangeRequest(data) {
    const control = new Int32Array(data.control);
    const started = performance.now();
    console.log('[range-network:start] parent=' + data.parentWorkerId + ' location=' + data.location + ' bytes=' + data.bytes + ' t0=' + started.toFixed(3));
    try {
        const last = data.location + data.bytes - 1;
        const expected = 'bytes ' + data.location + '-' + last + '/';
        const response = await fetch(data.url, {
            headers: { Range: 'bytes=' + data.location + '-' + last },
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
        new Uint8Array(data.heap, data.buf, data.bytes).set(body);
        const ended = performance.now();
        console.log('[range-network:end] parent=' + data.parentWorkerId + ' location=' + data.location + ' bytes=' + data.bytes + ' status=' + response.status + ' t0=' + started.toFixed(3) + ' t1=' + ended.toFixed(3) + ' duration=' + (ended - started).toFixed(3));
        finishRangeRequest(control, 1, response.status, body.byteLength, 0);
    } catch (error) {
        console.error('[range-network] fetch failed', error);
        finishRangeRequest(control, -1, 0, 0, 1);
    }
}

self.onmessage = ({ data }) => {
    if (data?.cmd !== 'attach-port') return;
    const port = data.port;
    ports.push(port);
    port.onmessage = event => {
        void handleRangeRequest(event.data);
    };
    port.start();
};

self.postMessage({ cmd: 'ready' });
`;

function getRangeNetworkBroker(): Promise<Worker> {
    if (RANGE_NETWORK_BROKER_READY) return RANGE_NETWORK_BROKER_READY;
    RANGE_NETWORK_BROKER_READY = new Promise<Worker>((resolve, reject) => {
        const objectUrl = URL.createObjectURL(new Blob([RANGE_NETWORK_BROKER_SOURCE], { type: 'text/javascript' }));
        const worker = new Worker(objectUrl);
        RANGE_NETWORK_BROKER = worker;
        const timeout = setTimeout(() => reject(new Error('Dedicated HTTP Range broker startup timed out')), 10_000);
        worker.addEventListener('message', event => {
            if (event.data?.cmd !== 'ready') return;
            clearTimeout(timeout);
            URL.revokeObjectURL(objectUrl);
            resolve(worker);
        }, { once: true });
        worker.addEventListener('error', event => {
            clearTimeout(timeout);
            reject(new Error(`Dedicated HTTP Range broker startup failed: ${event.message}`));
        }, { once: true });
    });
    return RANGE_NETWORK_BROKER_READY;
}

async function installCentralRangeBroker(bindings: DuckDB): Promise<void> {
    const pthread = bindings.pthread;
    if (!pthread) return;
    const broker = await getRangeNetworkBroker();
    const workers = [...pthread.unusedWorkers, ...pthread.runningWorkers];
    let attached = 0;
    for (const worker of workers) {
        if (RANGE_BROKER_WORKERS.has(worker)) continue;
        RANGE_BROKER_WORKERS.add(worker);
        const channel = new MessageChannel();
        broker.postMessage({ cmd: 'attach-port', port: channel.port1 }, [channel.port1]);
        worker.postMessage({ cmd: 'duckdb-http-range-broker-port', port: channel.port2 }, [channel.port2]);
        attached++;
    }
    console.log(`[range-network] connected ${attached} pthreads to one dedicated fetch broker`);
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
        const brokerDisabled =
            pthreadWorkerURL != null &&
            new URL(pthreadWorkerURL, globalThis.location?.href || undefined).searchParams.get('rangeBroker') === '0';
        if (brokerDisabled) {
            console.log('[range-network] benchmark baseline: central fetch broker disabled; using synchronous XHR transport');
        } else {
            await installCentralRangeBroker(bindings);
        }
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
