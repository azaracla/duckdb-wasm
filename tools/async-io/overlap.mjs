// Browser/Node-compatible analysis of HTTP Range timing samples.
// All startMs/endMs MUST be epoch milliseconds from performance.timeOrigin +
// performance.now(), not performance.now() alone (different workers have
// different time origins). No network access or DuckDB dependency.

export function validateRange(sample) {
    const errors = [];
    const { startMs, endMs, offset, bytes, responseBytes, status, contentRange } = sample;
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
        errors.push('invalid or non-positive interval');
    }
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(bytes) || bytes <= 0 ||
        !Number.isSafeInteger(offset + bytes - 1)) {
        errors.push('invalid requested range');
    }
    if (status !== 206) errors.push(`expected HTTP 206, got ${status}`);
    if (responseBytes !== bytes) errors.push(`expected ${bytes} response bytes, got ${responseBytes}`);
    const match = typeof contentRange === 'string' ? /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(contentRange) : null;
    if (!match || Number(match[1]) !== offset || Number(match[2]) !== offset + bytes - 1 ||
        (match[3] !== '*' && Number(match[3]) <= Number(match[2]))) {
        errors.push(`invalid Content-Range: ${contentRange ?? '(missing)'}`);
    }
    if (sample.error) errors.push(String(sample.error));
    return errors;
}

export function summarizeRanges(samples) {
    if (!Array.isArray(samples)) throw new TypeError('samples must be an array');
    const checked = samples.map((sample) => ({ ...sample, errors: validateRange(sample) }));
    const valid = checked.filter((sample) => sample.errors.length === 0);
    let overlappingPairs = 0;
    for (let i = 0; i < valid.length; i++) {
        for (let j = i + 1; j < valid.length; j++) {
            if (valid[i].startMs < valid[j].endMs && valid[j].startMs < valid[i].endMs) overlappingPairs++;
        }
    }
    // Process end events first at equal timestamps: touching intervals do not overlap.
    const events = valid.flatMap((s) => [{ at: s.startMs, delta: 1 }, { at: s.endMs, delta: -1 }]);
    events.sort((a, b) => a.at - b.at || a.delta - b.delta);
    let active = 0;
    let maxConcurrent = 0;
    for (const event of events) {
        active += event.delta;
        maxConcurrent = Math.max(maxConcurrent, active);
    }
    const wallMs = valid.length ? Math.max(...valid.map((s) => s.endMs)) - Math.min(...valid.map((s) => s.startMs)) : 0;
    const summedDurationMs = valid.reduce((sum, s) => sum + s.endMs - s.startMs, 0);
    return {
        requests: checked.length,
        validRequests: valid.length,
        failedRequests: checked.length - valid.length,
        overlappingPairs,
        maxConcurrent,
        wallMs,
        summedDurationMs,
        concurrentVerified: valid.length >= 2 && overlappingPairs > 0,
        samples: checked,
    };
}
