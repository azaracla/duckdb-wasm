import { StatusCode } from '../status';
import { WorkerResponseType } from '../parallel/worker_request';
import { addS3Headers, getHTTPUrl } from '../utils';

import {
    callSRet,
    dropResponseBuffers,
    DuckDBDataProtocol,
    DuckDBFileInfo,
    DuckDBGlobalFileInfo,
    DuckDBRuntime,
    failWith,
    FileFlags,
    readString,
    PreparedDBFileHandle,
} from './runtime';
import { DuckDBModule } from './duckdb_module';
import * as udf from './udf_runtime';

const OPFS_PREFIX_LEN = 'opfs://'.length;
const PATH_SEP_REGEX = /\/|\\/;

const HTTP_RANGE_BROKER_TIMEOUT_MS = 30_000;
let HTTP_RANGE_BROKER: Worker | null = null;
let HTTP_RANGE_BROKER_URL: string | null = null;
let HTTP_RANGE_BROKER_READY = false;
let HTTP_RANGE_BROKER_READY_PROMISE: Promise<void> | null = null;

const HTTP_RANGE_BROKER_SOURCE = `
self.postMessage({ type: 'ready' });
self.onmessage = async ({ data }) => {
    const started = performance.now();
    console.log('[range-broker:start] parent=' + data.parentWorkerId + ' location=' + data.location + ' bytes=' + data.bytes + ' t0=' + started.toFixed(3));
    const control = new Int32Array(data.control);
    const finish = (state, status, responseBytes, errorCode) => {
        Atomics.store(control, 1, status);
        Atomics.store(control, 2, responseBytes);
        Atomics.store(control, 3, errorCode);
        Atomics.store(control, 0, state);
        Atomics.notify(control, 0, 1);
    };
    try {
        const last = data.location + data.bytes - 1;
        const expected = 'bytes ' + data.location + '-' + last + '/';
        const response = await fetch(data.url, {
            headers: { Range: 'bytes=' + data.location + '-' + last },
        });
        const contentRange = response.headers.get('Content-Range');
        if (response.status !== 206) {
            finish(-1, response.status, 0, 2);
            return;
        }
        if (!contentRange) {
            finish(-1, response.status, 0, 3);
            return;
        }
        if (!contentRange.startsWith(expected)) {
            finish(-1, response.status, 0, 4);
            return;
        }
        const body = new Uint8Array(await response.arrayBuffer());
        if (body.byteLength !== data.bytes) {
            finish(-1, response.status, body.byteLength, 5);
            return;
        }
        new Uint8Array(data.heap, data.buf, data.bytes).set(body);
        const ended = performance.now();
        console.log('[range-broker:end] parent=' + data.parentWorkerId + ' location=' + data.location + ' bytes=' + data.bytes + ' status=' + response.status + ' t0=' + started.toFixed(3) + ' t1=' + ended.toFixed(3) + ' duration=' + (ended - started).toFixed(3));
        finish(1, response.status, body.byteLength, 0);
    } catch (error) {
        console.error('[range-broker] fetch failed', error);
        finish(-1, 0, 0, 1);
    }
};
`;

function canUseHTTPRangeBroker(mod: DuckDBModule): boolean {
    return (
        typeof SharedArrayBuffer !== 'undefined' &&
        mod.HEAPU8.buffer instanceof SharedArrayBuffer &&
        typeof Worker !== 'undefined' &&
        typeof window === 'undefined' &&
        typeof Atomics.wait === 'function' &&
        HTTP_RANGE_BROKER_READY
    );
}

function getHTTPRangeBroker(): Worker {
    if (HTTP_RANGE_BROKER) return HTTP_RANGE_BROKER;
    HTTP_RANGE_BROKER_URL = URL.createObjectURL(new Blob([HTTP_RANGE_BROKER_SOURCE], { type: 'text/javascript' }));
    HTTP_RANGE_BROKER = new Worker(HTTP_RANGE_BROKER_URL);
    return HTTP_RANGE_BROKER;
}

export function prepareHTTPRangeBroker(): Promise<void> {
    if (HTTP_RANGE_BROKER_READY) return Promise.resolve();
    if (HTTP_RANGE_BROKER_READY_PROMISE) return HTTP_RANGE_BROKER_READY_PROMISE;
    if (
        typeof SharedArrayBuffer === 'undefined' ||
        typeof Worker === 'undefined' ||
        typeof window !== 'undefined'
    ) {
        return Promise.resolve();
    }
    const worker = getHTTPRangeBroker();
    HTTP_RANGE_BROKER_READY_PROMISE = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('HTTP Range broker startup timed out')), 10_000);
        const onMessage = (event: MessageEvent<any>) => {
            if (event.data?.type !== 'ready') return;
            clearTimeout(timeout);
            worker.removeEventListener('message', onMessage);
            HTTP_RANGE_BROKER_READY = true;
            resolve();
        };
        worker.addEventListener('message', onMessage);
        worker.addEventListener('error', (event: ErrorEvent) => {
            clearTimeout(timeout);
            reject(new Error(`HTTP Range broker startup failed: ${event.message}`));
        }, { once: true });
    });
    return HTTP_RANGE_BROKER_READY_PROMISE;
}

function readHTTPRangeViaBroker(
    mod: DuckDBModule,
    url: string,
    buf: number,
    bytes: number,
    location: number,
): number {
    const controlBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 4);
    const control = new Int32Array(controlBuffer);
    const g = globalThis as any;
    const parentWorkerId =
        g.__duckdbRangeWorkerId ??=
            Math.random().toString(36).slice(2, 8);
    const started = performance.now();
    console.log(
        `[range-broker:dispatch] parent=${parentWorkerId} location=${location} bytes=${bytes} t0=${started.toFixed(3)}`,
    );
    getHTTPRangeBroker().postMessage({
        url,
        buf,
        bytes,
        location,
        heap: mod.HEAPU8.buffer,
        control: controlBuffer,
        parentWorkerId,
    });

    const waitResult = Atomics.wait(control, 0, 0, HTTP_RANGE_BROKER_TIMEOUT_MS);
    if (waitResult === 'timed-out') {
        throw new Error(`HTTP Range broker timed out after ${HTTP_RANGE_BROKER_TIMEOUT_MS}ms`);
    }
    const state = Atomics.load(control, 0);
    const status = Atomics.load(control, 1);
    const responseBytes = Atomics.load(control, 2);
    const errorCode = Atomics.load(control, 3);
    if (state !== 1) {
        const reasons: Record<number, string> = {
            1: 'fetch failed',
            2: `expected HTTP 206, got ${status}`,
            3: 'missing Content-Range',
            4: 'Content-Range mismatch',
            5: `response length mismatch: expected ${bytes}, got ${responseBytes}`,
        };
        throw new Error(`HTTP Range broker failed: ${reasons[errorCode] || `error code ${errorCode}`}`);
    }
    const ended = performance.now();
    console.log(
        `[range-broker:return] parent=${parentWorkerId} location=${location} bytes=${bytes} t0=${started.toFixed(3)} t1=${ended.toFixed(3)} duration=${(ended - started).toFixed(3)}`,
    );
    return responseBytes;
}

export const BROWSER_RUNTIME: DuckDBRuntime & {
    _files: Map<string, any>;
    _fileInfoCache: Map<number, DuckDBFileInfo>;
    _globalFileInfo: DuckDBGlobalFileInfo | null;
    _preparedHandles: Record<string, FileSystemSyncAccessHandle>;
    _opfsRoot: FileSystemDirectoryHandle | null;

    getFileInfo(mod: DuckDBModule, fileId: number): DuckDBFileInfo | null;
    getGlobalFileInfo(mod: DuckDBModule): DuckDBGlobalFileInfo | null;
    assignOPFSRoot(): Promise<void>;
} = {
    _files: new Map<string, any>(),
    _fileInfoCache: new Map<number, DuckDBFileInfo>(),
    _udfFunctions: new Map(),
    _globalFileInfo: null,
    _preparedHandles: {} as any,
    _opfsRoot: null,

    getFileInfo(mod: DuckDBModule, fileId: number): DuckDBFileInfo | null {
        try {
            const cached = BROWSER_RUNTIME._fileInfoCache.get(fileId);
            const [s, d, n] = callSRet(
                mod,
                'duckdb_web_fs_get_file_info_by_id',
                ['number', 'number'],
                [fileId, cached?.cacheEpoch || 0],
            );
            if (s !== StatusCode.SUCCESS) {
                return null;
            } else if (n === 0) {
                // Epoch is up to date
                return cached!;
            }
            const infoStr = readString(mod, d, n);
            dropResponseBuffers(mod);
            try {
                const info = JSON.parse(infoStr);
                if (info == null) {
                    return null;
                }
                const file = { ...info, blob: null } as DuckDBFileInfo;
                BROWSER_RUNTIME._fileInfoCache.set(fileId, file);
                if (!BROWSER_RUNTIME._files.has(file.fileName) && BROWSER_RUNTIME._preparedHandles[file.fileName]) {
                    BROWSER_RUNTIME._files.set(file.fileName, BROWSER_RUNTIME._preparedHandles[file.fileName]);
                    delete BROWSER_RUNTIME._preparedHandles[file.fileName];
                }
                return file;
            } catch (error) {
                console.warn(error);
                return null;
            }
        } catch (e: any) {
            console.log(e);
            return null;
        }
    },

    getGlobalFileInfo(mod: DuckDBModule): DuckDBGlobalFileInfo | null {
        try {
            const [s, d, n] = callSRet(
                mod,
                'duckdb_web_get_global_file_info',
                ['number'],
                [BROWSER_RUNTIME._globalFileInfo?.cacheEpoch || 0],
            );
            if (s !== StatusCode.SUCCESS) {
                return null;
            } else if (n === 0) {
                // Epoch is up to date
                return BROWSER_RUNTIME._globalFileInfo!;
            }
            const infoStr = readString(mod, d, n);
            dropResponseBuffers(mod);
            const info = JSON.parse(infoStr);
            if (info == null) {
                return null;
            }
            BROWSER_RUNTIME._globalFileInfo = { ...info, blob: null } as DuckDBGlobalFileInfo;

            return BROWSER_RUNTIME._globalFileInfo;
        } catch (e: any) {
            console.log(e);
            return null;
        }
    },
    async assignOPFSRoot(): Promise<void> {
        if (!BROWSER_RUNTIME._opfsRoot) {
            BROWSER_RUNTIME._opfsRoot = await navigator.storage.getDirectory();
        }
    },
    /** Prepare a file handle that could only be acquired aschronously */
    async prepareFileHandles(filePaths: string[], protocol: DuckDBDataProtocol): Promise<PreparedDBFileHandle[]> {
        if (protocol === DuckDBDataProtocol.BROWSER_FSACCESS) {
            await BROWSER_RUNTIME.assignOPFSRoot();
            const prepare = async (path: string): Promise<PreparedDBFileHandle> => {
                const handle = BROWSER_RUNTIME._files.get(path) || BROWSER_RUNTIME._preparedHandles[path];
                if (handle) {
                    return {
                        path,
                        handle,
                        fromCached: true,
                    };
                }

                const opfsRoot = BROWSER_RUNTIME._opfsRoot!;
                let dirHandle: FileSystemDirectoryHandle = opfsRoot;
                // check if mkdir -p is needed
                const opfsPath = path.slice(OPFS_PREFIX_LEN);
                let fileName = opfsPath;
                if (PATH_SEP_REGEX.test(opfsPath)) {
                    const folders = opfsPath.split(PATH_SEP_REGEX);
                    if (folders.length === 0) {
                        throw new Error(`Invalid path ${opfsPath}`);
                    }
                    fileName = folders[folders.length - 1];
                    if (!fileName) {
                        throw new Error(`Invalid path ${opfsPath}. File Not Found.`);
                    }
                    folders.pop();
                    for (const folder of folders) {
                        dirHandle = await dirHandle.getDirectoryHandle(folder, { create: true });
                    }
                }
                const fileHandle = await dirHandle.getFileHandle(fileName, { create: false }).catch(e => {
                    if (e?.name === 'NotFoundError') {
                        console.debug(`File ${path} does not exists yet, creating...`);
                        return dirHandle.getFileHandle(fileName, { create: true });
                    }
                    throw e;
                });
                try {
                    const syncHandle = await fileHandle.createSyncAccessHandle();
                    BROWSER_RUNTIME._preparedHandles[path] = syncHandle;
                    return {
                        path,
                        handle: syncHandle,
                        fromCached: false,
                    };
                } catch (e: any) {
                    throw new Error(e.message + ':' + name);
                }
            };
            const result: PreparedDBFileHandle[] = [];
            for (const filePath of filePaths) {
                const res = await prepare(filePath);
                result.push(res);
            }
            return result;
        }
        throw new Error(`Unsupported protocol ${protocol} for paths ${filePaths} with protocol ${protocol}`);
    },
    /** Prepare a file handle that could only be acquired aschronously */
    async prepareDBFileHandle(dbPath: string, protocol: DuckDBDataProtocol): Promise<PreparedDBFileHandle[]> {
        if (protocol === DuckDBDataProtocol.BROWSER_FSACCESS && this.prepareFileHandles) {
            const filePaths = [dbPath, `${dbPath}.wal`, `${dbPath}.wal.checkpoint`, `${dbPath}.wal.recovery`];
            return this.prepareFileHandles(filePaths, protocol);
        }
        throw new Error(`Unsupported protocol ${protocol} for path ${dbPath} with protocol ${protocol}`);
    },

    testPlatformFeature: (_mod: DuckDBModule, feature: number): boolean => {
        switch (feature) {
            case 1:
                return typeof BigInt64Array !== 'undefined';
            default:
                console.warn(`test for unknown feature: ${feature}`);
                return false;
        }
    },

    getDefaultDataProtocol(mod: DuckDBModule): number {
        return DuckDBDataProtocol.BROWSER_FILEREADER;
    },

    openFile: (mod: DuckDBModule, fileId: number, flags: FileFlags): number => {
        try {
            BROWSER_RUNTIME._fileInfoCache.delete(fileId);
            const file = BROWSER_RUNTIME.getFileInfo(mod, fileId);
            switch (file?.dataProtocol) {
                case DuckDBDataProtocol.HTTP:
                case DuckDBDataProtocol.S3: {
                    if (flags & FileFlags.FILE_FLAGS_READ && flags & FileFlags.FILE_FLAGS_WRITE) {
                        throw new Error(
                            `Opening file ${file.fileName} failed: cannot open file with both read and write flags set`,
                        );
                    } else if (flags & FileFlags.FILE_FLAGS_APPEND) {
                        throw new Error(
                            `Opening file ${file.fileName} failed: appending to HTTP/S3 files is not supported`,
                        );
                    } else if (flags & FileFlags.FILE_FLAGS_WRITE) {
                        // We send a HEAD request to try to determine if we can write to data_url
                        const xhr = new XMLHttpRequest();
                        if (file.dataProtocol == DuckDBDataProtocol.S3) {
                            xhr.open('HEAD', getHTTPUrl(file.s3Config, file.dataUrl!), false);
                            addS3Headers(xhr, file.s3Config, file.dataUrl!, 'HEAD');
                        } else {
                            xhr.open('HEAD', file.dataUrl!, false);
                        }
                        xhr.send(null);

                        // Expect 200 for existing files that we will overwrite or 404 for non-existent files can be created
                        if (xhr.status != 200 && xhr.status != 404) {
                            throw new Error(
                                `Opening file ${file.fileName} failed: Unexpected return status from server (${xhr.status})`,
                            );
                        } else if (
                            xhr.status == 404 &&
                            !(flags & FileFlags.FILE_FLAGS_FILE_CREATE || flags & FileFlags.FILE_FLAGS_FILE_CREATE_NEW)
                        ) {
                            throw new Error(
                                `Opening file ${file.fileName} failed: Cannot write to non-existent file without FILE_FLAGS_FILE_CREATE or FILE_FLAGS_FILE_CREATE_NEW flag.`,
                            );
                        }
                        // Return an empty buffer that can be used to buffer the writes to this s3/http file
                        const data = mod._malloc(1);
                        const src = new Uint8Array();
                        mod.HEAPU8.set(src, data);
                        const result = mod._malloc(3 * 8);
                        mod.HEAPF64[(result >> 3) + 0] = 1;
                        mod.HEAPF64[(result >> 3) + 1] = data;
                        mod.HEAPF64[(result >> 3) + 2] = new Date().getTime() / 1000;
                        return result;
                    } else if ((flags & FileFlags.FILE_FLAGS_READ) == 0) {
                        throw new Error(`Opening file ${file.fileName} failed: unsupported file flags: ${flags}`);
                    }

                    // Supports ranges?
                    let contentLength = null;
                    let error: any | null = null;
                    if (!file.forceFullHttpReads && (file.reliableHeadRequests || !file.allowFullHttpReads)) {
                        try {
                            // Send a dummy HEAD request with range protocol
                            //          -> good IFF status is 206 and contentLenght is present
                            const xhr = new XMLHttpRequest();
                            if (file.dataProtocol == DuckDBDataProtocol.S3) {
                                xhr.open('HEAD', getHTTPUrl(file.s3Config, file.dataUrl!), false);
                                addS3Headers(xhr, file.s3Config, file.dataUrl!, 'HEAD');
                            } else {
                                xhr.open('HEAD', file.dataUrl!, false);
                            }
                            xhr.setRequestHeader('Range', `bytes=0-`);
                            xhr.send(null);

                            // Supports range requests
                            contentLength = null;
                            try { contentLength = xhr.getResponseHeader('Content-Length'); } catch (e: any) {console.warn(`Failed to get Content-Length on request`);}
                            if (contentLength !== null && xhr.status == 206) {
                                const result = mod._malloc(3 * 8);
                                mod.HEAPF64[(result >> 3) + 0] = +contentLength;
                                mod.HEAPF64[(result >> 3) + 1] = 0;
                                let modification_time = 0;
                                try { modification_time = new Date(xhr.getResponseHeader('Last-Modified')??"").getTime() / 1000; } catch (e: any) {console.warn(`Failed to get Last-Modified on request`);}
                                mod.HEAPF64[(result >> 3) + 2] = +modification_time;
                                return result;
                            }
                        } catch (e: any) {
                            error = e;
                            console.warn(`HEAD request with range header failed: ${e}`);
                        }
                    }

                    // Try to fallback to full read?
                    if (file.allowFullHttpReads) {
                        if (!file.forceFullHttpReads) {
                            // 2. Send a dummy GET range request querying the first byte of the file
                            //          -> good IFF status is 206 and contentLenght2 is 1
                            //          -> otherwise, iff 200 and contentLenght2 == contentLenght
                            //                 we just downloaded the file, save it and move further
                            const xhr = new XMLHttpRequest();
                            if (file.dataProtocol == DuckDBDataProtocol.S3) {
                                xhr.open('GET', getHTTPUrl(file.s3Config, file.dataUrl!), false);
                                addS3Headers(xhr, file.s3Config, file.dataUrl!, 'GET');
                            } else {
                                xhr.open('GET', file.dataUrl!, false);
                            }
                            xhr.responseType = 'arraybuffer';
                            xhr.setRequestHeader('Range', `bytes=0-0`);
                            xhr.send(null);
                            let actualContentLength = null;
                            try { actualContentLength = xhr.getResponseHeader('Content-Length'); } catch (e: any) {console.warn(`Failed to get Content-Length on request`);}
                            const contentRange = actualContentLength?.split('/')[1];
                            const contentLength2 = actualContentLength;

                            let presumedLength = null;
                            if (contentRange !== undefined) {
                                presumedLength = contentRange;
                            } else if (!file.reliableHeadRequests) {
                                // Send a dummy HEAD request with range protocol
                                //          -> good IFF status is 206 and contentLenght is present
                                const head = new XMLHttpRequest();
                                if (file.dataProtocol == DuckDBDataProtocol.S3) {
                                    head.open('HEAD', getHTTPUrl(file.s3Config, file.dataUrl!), false);
                                    addS3Headers(head, file.s3Config, file.dataUrl!, 'HEAD');
                                } else {
                                    head.open('HEAD', file.dataUrl!, false);
                                }
                                head.setRequestHeader('Range', `bytes=0-`);
                                head.send(null);

                                // Supports range requests
                                contentLength = null;
                                try { contentLength = head.getResponseHeader('Content-Length'); } catch (e: any) {console.warn(`Failed to get Content-Length on request`);}
                                if (contentLength !== null && +contentLength > 1) {
                                    presumedLength = contentLength;
                                }
                            }

                            if (
                                xhr.status == 206 &&
                                contentLength2 !== null &&
                                +contentLength2 == 1 &&
                                presumedLength !== null
                            ) {
                                const result = mod._malloc(3 * 8);
                                mod.HEAPF64[(result >> 3) + 0] = +presumedLength;
                                mod.HEAPF64[(result >> 3) + 1] = 0;
                                let modification_time = 0;
                                try { modification_time = new Date(xhr.getResponseHeader('Last-Modified')??"").getTime() / 1000; } catch (e: any) {console.warn(`Failed to get Last-Modified on request`);}
                                mod.HEAPF64[(result >> 3) + 2] = +modification_time;
                                return result;
                            }
                            if (
                                xhr.status == 200 &&
                                contentLength2 !== null &&
                                contentLength !== null &&
                                +contentLength2 == +contentLength
                            ) {
                                console.warn(`fall back to full HTTP read for: ${file.dataUrl}`);
                                const data = mod._malloc(xhr.response.byteLength);
                                const src = new Uint8Array(xhr.response, 0, xhr.response.byteLength);
                                mod.HEAPU8.set(src, data);
                                const result = mod._malloc(3 * 8);
                                mod.HEAPF64[(result >> 3) + 0] = xhr.response.byteLength;
                                mod.HEAPF64[(result >> 3) + 1] = data;
                                let modification_time = 0;
                                try { modification_time = new Date(xhr.getResponseHeader('Last-Modified')??"").getTime() / 1000; } catch (e: any) {console.warn(`Failed to get Last-Modified on request`);}
                                mod.HEAPF64[(result >> 3) + 2] = +modification_time;
                                return result;
                            }
                            console.warn(`falling back to full HTTP read for: ${file.dataUrl}`);
                        }
                        // 3. Send non-range request
                        const xhr = new XMLHttpRequest();
                        if (file.dataProtocol == DuckDBDataProtocol.S3) {
                            xhr.open('GET', getHTTPUrl(file.s3Config, file.dataUrl!), false);
                            addS3Headers(xhr, file.s3Config, file.dataUrl!, 'GET');
                        } else {
                            xhr.open('GET', file.dataUrl!, false);
                        }
                        xhr.responseType = 'arraybuffer';
                        xhr.send(null);

                        // Return buffer
                        if (xhr.status == 200) {
                            const data = mod._malloc(xhr.response.byteLength);
                            const src = new Uint8Array(xhr.response, 0, xhr.response.byteLength);
                            mod.HEAPU8.set(src, data);
                            const result = mod._malloc(3 * 8);
                            mod.HEAPF64[(result >> 3) + 0] = xhr.response.byteLength;
                            mod.HEAPF64[(result >> 3) + 1] = data;
                            let modification_time = 0;
                            try { modification_time = new Date(xhr.getResponseHeader('Last-Modified')??"").getTime() / 1000; } catch (e: any) {console.warn(`Failed to get Last-Modified on request`);}
                            mod.HEAPF64[(result >> 3) + 2] = +modification_time;
                            return result;
                        }
                    }

                    // Raise error?
                    if (error != null) {
                        throw new Error(`Reading file ${file.fileName} failed with error: ${error}`);
                    }
                    return 0;
                }
                // File reader File
                case DuckDBDataProtocol.BROWSER_FILEREADER: {
                    const handle = BROWSER_RUNTIME._files?.get(file.fileName);
                    if (handle) {
                        const result = mod._malloc(3 * 8);
                        mod.HEAPF64[(result >> 3) + 0] = handle.size;
                        mod.HEAPF64[(result >> 3) + 1] = 0;
                        mod.HEAPF64[(result >> 3) + 2] = 0;
                        return result;
                    }

                    // Depending on file flags, return nullptr
                    if (flags & FileFlags.FILE_FLAGS_NULL_IF_NOT_EXISTS) {
                       return 0;
                    }

                    // Fall back to empty buffered file in the browser
                    console.warn(`Buffering missing file: ${file.fileName}`);
                    const result = mod._malloc(3 * 8);
                    const buffer = mod._malloc(1); // malloc(0) is allowed to return a nullptr
                    mod.HEAPF64[(result >> 3) + 0] = 1;
                    mod.HEAPF64[(result >> 3) + 1] = buffer;
                    mod.HEAPF64[(result >> 3) + 2] = 0;
                    return result;
                }
                case DuckDBDataProtocol.BROWSER_FSACCESS: {
                    const handle: FileSystemSyncAccessHandle = BROWSER_RUNTIME._files?.get(file.fileName);
                    if (!handle) {
                        throw new Error(`No OPFS access handle registered with name: ${file.fileName}`);
                    }
                    if (flags & FileFlags.FILE_FLAGS_FILE_CREATE_NEW) {
                        handle.truncate(0);
                    }
                    const result = mod._malloc(3 * 8);
                    const fileSize = handle.getSize();
                    mod.HEAPF64[(result >> 3) + 0] = fileSize;
                    mod.HEAPF64[(result >> 3) + 1] = 0;
                    mod.HEAPF64[(result >> 3) + 2] = 0;
                    return result;
                }
            }
        } catch (e: any) {
            // TODO (samansmink): this path causes the WASM code to hang
            console.error(e.toString());
            failWith(mod, e.toString());
        }
        return 0;
    },
    glob: (mod: DuckDBModule, pathPtr: number, pathLen: number) => {
        try {
            const path = readString(mod, pathPtr, pathLen);
            // Starts with http?
            // Try a HTTP HEAD request
            if (path.startsWith('http') || path.startsWith('s3://')) {
                // Send a dummy range request querying the first byte of the file
                const xhr = new XMLHttpRequest();
                if (path.startsWith('s3://')) {
                    const globalInfo = BROWSER_RUNTIME.getGlobalFileInfo(mod);
                    xhr.open('HEAD', getHTTPUrl(globalInfo?.s3Config, path), false);
                    addS3Headers(xhr, globalInfo?.s3Config, path, 'HEAD');
                } else {
                    xhr.open('HEAD', path!, false);
                }
                xhr.send(null);
                if (xhr.status != 200 && xhr.status !== 206) {
                    // Pre-signed resources on S3 in common configurations fail on any HEAD request
                    // https://docs.aws.amazon.com/sdk-for-go/v1/developer-guide/s3-example-presigned-urls.html
                    // so we need (if enabled) to bump to a ranged GET
                    if (!BROWSER_RUNTIME.getGlobalFileInfo(mod)?.allowFullHttpReads) {
                        console.log(`HEAD request failed: ${path}, with full http reads are disabled`);
                        return 0;
                    }
                    const xhr2 = new XMLHttpRequest();
                    if (path.startsWith('s3://')) {
                        const globalInfo = BROWSER_RUNTIME.getGlobalFileInfo(mod);
                        xhr2.open('GET', getHTTPUrl(globalInfo?.s3Config, path), false);
                        addS3Headers(xhr2, globalInfo?.s3Config, path, 'HEAD');
                    } else {
                        xhr2.open('GET', path!, false);
                    }
                    xhr2.setRequestHeader('Range', `bytes=0-0`);
                    xhr2.send(null);
                    if (xhr2.status != 200 && xhr2.status !== 206) {
                        console.log(`HEAD and GET requests failed: ${path}`);
                        return 0;
                    }
                    let contentLength = null;
                    try { contentLength = xhr2.getResponseHeader('Content-Length'); } catch (e: any) {console.warn(`Failed to get Content-Length on request`);}
                    if (contentLength && +contentLength > 1) {
                        console.warn(
                            `Range request for ${path} did not return a partial response: ${xhr2.status} "${xhr2.statusText}"`,
                        );
                    }
                }
                mod.ccall('duckdb_web_fs_glob_add_path', null, ['string'], [path]);
            } else {
                for (const [filePath] of BROWSER_RUNTIME._files!.entries() || []) {
                    if (filePath.startsWith(path)) {
                        mod.ccall('duckdb_web_fs_glob_add_path', null, ['string'], [filePath]);
                    }
                }
            }
        } catch (e: any) {
            console.log(e);
            failWith(mod, e.toString());
            return 0;
        }
    },
    checkFile: (mod: DuckDBModule, pathPtr: number, pathLen: number): boolean => {
        try {
            const path = readString(mod, pathPtr, pathLen);
            // Starts with http or S3?
            // Try a HTTP HEAD request
            if (path.startsWith('http') || path.startsWith('s3://')) {
                // Send a dummy range request querying the first byte of the file
                const xhr = new XMLHttpRequest();
                if (path.startsWith('s3://')) {
                    const globalInfo = BROWSER_RUNTIME.getGlobalFileInfo(mod);
                    xhr.open('HEAD', getHTTPUrl(globalInfo?.s3Config, path), false);
                    addS3Headers(xhr, globalInfo?.s3Config, path, 'HEAD');
                } else {
                    xhr.open('HEAD', path!, false);
                }
                xhr.send(null);
                return xhr.status == 206 || xhr.status == 200;
            } else {
                return BROWSER_RUNTIME._files.has(path);
            }
        } catch (e: any) {
            console.log(e);
            return false;
        }
        return false;
    },
    syncFile: (_mod: DuckDBModule, _fileId: number) => {},
    closeFile: (mod: DuckDBModule, fileId: number) => {
        const file = BROWSER_RUNTIME.getFileInfo(mod, fileId);
        BROWSER_RUNTIME._fileInfoCache.delete(fileId);
        try {
            switch (file?.dataProtocol) {
                case DuckDBDataProtocol.BUFFER:
                case DuckDBDataProtocol.HTTP:
                case DuckDBDataProtocol.S3:
                    break;
                case DuckDBDataProtocol.NODE_FS:
                case DuckDBDataProtocol.BROWSER_FILEREADER:
                    // XXX Remove from registry
                    return;
                case DuckDBDataProtocol.BROWSER_FSACCESS: {
                    const handle: FileSystemSyncAccessHandle = BROWSER_RUNTIME._files?.get(file.fileName);
                    if (!handle) {
                        throw new Error(`No OPFS access handle registered with name: ${file.fileName}`);
                    }
                    return handle.flush();
                }
            }
        } catch (e: any) {
            console.log(e);
            failWith(mod, e.toString());
        }
    },
    dropFile: (mod: DuckDBModule, fileNamePtr: number, fileNameLen: number) => {
        const fileName = readString(mod, fileNamePtr, fileNameLen);
        if (BROWSER_RUNTIME._files?.has(fileName)) {
            const handle = BROWSER_RUNTIME._files?.get(fileName);
            BROWSER_RUNTIME._files.delete(fileName);
            if (handle instanceof FileSystemSyncAccessHandle) {
                try {
                    handle.flush();
                    handle.close();
                } catch (e: any) {
                    throw new Error(`Cannot drop file with name: ${fileName}`);
                }
            }
            if (handle instanceof Blob) {
                // nothing
            }
        } else if (BROWSER_RUNTIME._preparedHandles[fileName]){
            // File was prepared but not used.
            const handle = BROWSER_RUNTIME._preparedHandles[fileName];
            if (handle instanceof FileSystemSyncAccessHandle) {
                delete BROWSER_RUNTIME._preparedHandles[fileName];
                handle.flush();
                handle.close();
            }
        }

    },
    truncateFile: (mod: DuckDBModule, fileId: number, newSize: number) => {
        const file = BROWSER_RUNTIME.getFileInfo(mod, fileId);
        switch (file?.dataProtocol) {
            case DuckDBDataProtocol.HTTP:
                failWith(mod, `Cannot truncate a http file`);
                return;
            case DuckDBDataProtocol.S3:
                failWith(mod, `Cannot truncate an s3 file`);
                return;
            case DuckDBDataProtocol.BUFFER:
            case DuckDBDataProtocol.NODE_FS:
            case DuckDBDataProtocol.BROWSER_FILEREADER:
                failWith(mod, `truncateFile not implemented`);
                return;
            case DuckDBDataProtocol.BROWSER_FSACCESS: {
                const handle = BROWSER_RUNTIME._files?.get(file.fileName);
                if (!handle) {
                    throw new Error(`No OPFS access handle registered with name: ${file.fileName}`);
                }
                return handle.truncate(newSize);
            }
        }
        return 0;
    },
    readFile(mod: DuckDBModule, fileId: number, buf: number, bytes: number, location: number) {
        if (bytes == 0) {
            // Be robust to empty reads
            return 0;
        }
        try {
            // Fix #5: avoid calling getFileInfo() on every read — it triggers a WASM
            // round-trip through the global WASMResponseBuffer (race-prone with pthreads).
            // File info is stable for HTTP/S3 files after open; use the cache.
            // In pthread builds, each worker has its own JS runtime and _fileInfoCache.
            // A read can land on a worker that did not execute openFile() — lazy-fill
            // the local cache via getFileInfo() in that case. WASMResponseBuffer is now
            // thread_local so this fallback is safe.
            const file = BROWSER_RUNTIME._fileInfoCache.get(fileId) ??
                         BROWSER_RUNTIME.getFileInfo(mod, fileId);
            if (!file) {
                throw new Error(`File info not available for fileId ${fileId}`);
            }
            switch (file?.dataProtocol) {
                // File reading from BLOB or HTTP MUST be done with range requests.
                // We have to check in OPEN if such file supports range requests and upgrade to BUFFER if not.
                case DuckDBDataProtocol.HTTP:
                case DuckDBDataProtocol.S3: {
                    if (!file.dataUrl) {
                        throw new Error(`Missing data URL for file ${fileId}`);
                    }
                    try {
                        // DuckDB 2's ASYNC pool already submits independent reads in
                        // parallel. Chromium serializes synchronous XHRs even across
                        // dedicated workers in our COI acceptance environment, so for
                        // pthread HTTP reads delegate the network transfer to a nested
                        // async-fetch worker. The calling pthread sleeps on a tiny SAB
                        // while the broker writes directly into shared WASM memory.
                        if (file.dataProtocol === DuckDBDataProtocol.HTTP && canUseHTTPRangeBroker(mod)) {
                            return readHTTPRangeViaBroker(mod, file.dataUrl, buf, bytes, location);
                        }

                        const xhr = new XMLHttpRequest();
                        if (file.dataProtocol == DuckDBDataProtocol.S3) {
                            xhr.open('GET', getHTTPUrl(file?.s3Config, file.dataUrl!), false);
                            addS3Headers(xhr, file?.s3Config, file.dataUrl!, 'GET');
                        } else {
                            xhr.open('GET', file.dataUrl!, false);
                        }
                        xhr.responseType = 'arraybuffer';
                        xhr.setRequestHeader('Range', `bytes=${location}-${location + bytes - 1}`);

                        // Instrumentation: measure Range request concurrency
                        const g = globalThis as any;
                        const workerId =
                            g.__duckdbRangeWorkerId ??=
                                Math.random().toString(36).slice(2, 8);
                        const t0 = performance.now();
                        console.log(
                            `[range:start] worker=${workerId} location=${location} bytes=${bytes} t0=${t0.toFixed(3)}`,
                        );
                        xhr.send(null);
                        const t1 = performance.now();
                        console.log(
                            `[range:end] worker=${workerId} location=${location} bytes=${bytes} status=${xhr.status} responseBytes=${xhr.response?.byteLength ?? 0} t0=${t0.toFixed(3)} t1=${t1.toFixed(3)} duration=${(t1 - t0).toFixed(3)}`,
                        );

                        // Fix #4: strict validation of Range response.
                        // A Content-Range header is REQUIRED for all 206 responses.
                        // CORS setup MUST include:
                        //   Access-Control-Expose-Headers: Content-Range
                        const contentRange = xhr.getResponseHeader('Content-Range');
                        if (!contentRange) {
                            throw new Error(
                                `Missing Content-Range header for ${file.dataUrl}. ` +
                                `Ensure the server exposes Content-Range via Access-Control-Expose-Headers.`,
                            );
                        }
                        const expectedPrefix = `bytes ${location}-${location + bytes - 1}/`;
                        if (!contentRange.startsWith(expectedPrefix)) {
                            throw new Error(
                                `Content-Range mismatch for ${file.dataUrl}: ` +
                                `expected prefix '${expectedPrefix}', got '${contentRange}'`,
                            );
                        }

                        const src = new Uint8Array(xhr.response, 0, bytes);
                        mod.HEAPU8.set(src, buf);
                        return src.byteLength;
                    } catch (e) {
                        console.log(e);
                        throw new Error(`Range request for ${file.dataUrl} failed with error: ${e}"`);
                    }
                }
                case DuckDBDataProtocol.BROWSER_FILEREADER: {
                    const handle = BROWSER_RUNTIME._files?.get(file.fileName);
                    if (!handle) {
                        throw new Error(`No HTML5 file registered with name: ${file.fileName}`);
                    }
                    const sliced = handle!.slice(location, location + bytes);
                    const data = new Uint8Array(new FileReaderSync().readAsArrayBuffer(sliced));
                    mod.HEAPU8.set(data, buf);
                    return data.byteLength;
                }
                case DuckDBDataProtocol.BROWSER_FSACCESS: {
                    const handle: FileSystemSyncAccessHandle = BROWSER_RUNTIME._files.get(file.fileName);
                    if (!handle) {
                        throw new Error(`No OPFS access handle registered with name: ${file.fileName}`);
                    }
                    const out = mod.HEAPU8.subarray(buf, buf + bytes);
                    return handle.read(out, { at: location });
                }
            }
            return 0;
        } catch (e: any) {
            console.log(e);
            failWith(mod, e.toString());
            return 0;
        }
    },
    writeFile: (mod: DuckDBModule, fileId: number, buf: number, bytes: number, location: number) => {
        const file = BROWSER_RUNTIME.getFileInfo(mod, fileId);
        switch (file?.dataProtocol) {
            case DuckDBDataProtocol.HTTP:
                failWith(mod, 'Cannot write to HTTP file');
                return 0;
            case DuckDBDataProtocol.S3: {
                const buffer = mod.HEAPU8.subarray(buf, buf + bytes);
                const xhr = new XMLHttpRequest();
                xhr.open('PUT', getHTTPUrl(file?.s3Config, file.dataUrl!), false);
                addS3Headers(xhr, file?.s3Config, file.dataUrl!, 'PUT', '', buffer);
                xhr.send(buffer);
                if (xhr.status !== 200) {
                    failWith(mod, 'Failed writing file: HTTP ' + xhr.status);
                    return 0;
                }
                return bytes;
            }
            case DuckDBDataProtocol.BROWSER_FILEREADER:
                failWith(mod, 'cannot write using the html5 file reader api');
                return 0;
            case DuckDBDataProtocol.BROWSER_FSACCESS: {
                const handle: FileSystemSyncAccessHandle = BROWSER_RUNTIME._files?.get(file.fileName);
                if (!handle) {
                    throw new Error(`No OPFS access handle registered with name: ${file.fileName}`);
                }
                const input = mod.HEAPU8.subarray(buf, buf + bytes);
                return handle.write(input, { at: location });
            }
        }
        return 0;
    },
    getLastFileModificationTime: (mod: DuckDBModule, fileId: number) => {
        const file = BROWSER_RUNTIME.getFileInfo(mod, fileId);
        switch (file?.dataProtocol) {
            case DuckDBDataProtocol.BROWSER_FILEREADER: {
                const handle = BROWSER_RUNTIME._files?.get(file.fileName);
                if (!handle) {
                    throw Error(`No handle available for file: ${file.fileName}`);
                }
                return 0;
            }

            case DuckDBDataProtocol.HTTP:
            case DuckDBDataProtocol.S3:
                // getTime() returns milliseconds, we need seconds
                return new Date().getTime() / 1000;
        }
        return 0;
    },
    progressUpdate: (done: number, percentage: number, repeat: number): void => {
        if (postMessage) {
            postMessage({
                requestId: 0,
                type: WorkerResponseType.PROGRESS_UPDATE,
                data: { status: done ? 'completed' : 'in-progress', percentage: percentage, repetitions: repeat },
            });
        }
    },
    checkDirectory: (mod: DuckDBModule, pathPtr: number, pathLen: number) => {
        const path = readString(mod, pathPtr, pathLen);
        console.log(`checkDirectory: ${path}`);
        return false;
    },
    createDirectory: (mod: DuckDBModule, pathPtr: number, pathLen: number) => {
        const path = readString(mod, pathPtr, pathLen);
        console.log(`createDirectory: ${path}`);
    },
    removeDirectory: (mod: DuckDBModule, pathPtr: number, pathLen: number) => {
        const path = readString(mod, pathPtr, pathLen);
        console.log(`removeDirectory: ${path}`);
    },
    listDirectoryEntries: (mod: DuckDBModule, pathPtr: number, pathLen: number) => {
        const path = readString(mod, pathPtr, pathLen);
        console.log(`listDirectoryEntries: ${path}`);
        return false;
    },
    moveFile: (mod: DuckDBModule, fromPtr: number, fromLen: number, toPtr: number, toLen: number) => {
        const from = readString(mod, fromPtr, fromLen);
        const to = readString(mod, toPtr, toLen);
        const handle = BROWSER_RUNTIME._files?.get(from);

        // if we have a sync handle we need to reuse files
        if (handle instanceof FileSystemSyncAccessHandle) {
            const to_handle = BROWSER_RUNTIME._files?.get(to);
            if (to_handle === undefined) {
                throw new Error(`Not implemented error move from OPFS into non existent file`);
            } else if (!(to_handle instanceof FileSystemSyncAccessHandle)) {
                throw new Error(`Not implemented error move from OPFS into non OPFS file`);
            }
            // We have x -> y, y will be destroyed in this process.
            // y is truncated so it is an empty file and stored as x.
            to_handle.truncate(0);
            const size = handle.getSize();
            // Reads need to go somewhere copy data in one MB chunks.
            const fileContents = new ArrayBuffer(Math.min(size, 1024 * 1024));
            let bytes_read = 0;
            for (let offset = 0; offset < size; offset += bytes_read) {
                bytes_read = handle.read(fileContents, { at: offset });
                to_handle.write(fileContents, { at: offset });
            }
            // Ensure that the from handle is empty again
            handle.truncate(0);
            // We do not remove files from the runtime as they would otherwise not
            // be able to be dropped
        } else if (handle !== undefined) {
            const to_handle = BROWSER_RUNTIME._files?.get(to);
            if (to_handle instanceof FileSystemSyncAccessHandle) {
                throw new Error(`Not implemented move from arbitrary file into OPFS file`);
            }

            BROWSER_RUNTIME._files!.delete(from);
            BROWSER_RUNTIME._files!.set(to, handle);
        }
        for (const [key, value] of BROWSER_RUNTIME._fileInfoCache?.entries() || []) {
            if (value.dataUrl == from) {
                BROWSER_RUNTIME._fileInfoCache.delete(key);
                break;
            }
        }
        return true;
    },
    removeFile: (_mod: DuckDBModule, _pathPtr: number, _pathLen: number) => {},
    callScalarUDF: (
        mod: DuckDBModule,
        response: number,
        funcId: number,
        descPtr: number,
        descSize: number,
        ptrsPtr: number,
        ptrsSize: number,
    ): void => {
        udf.callScalarUDF(BROWSER_RUNTIME, mod, response, funcId, descPtr, descSize, ptrsPtr, ptrsSize);
    },
};

export default BROWSER_RUNTIME;
