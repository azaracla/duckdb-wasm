import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeRanges, validateRange } from './overlap.mjs';

const sample = (startMs, endMs, offset = 0) => ({
    workerId: `worker-${offset}`,
    startMs,
    endMs,
    offset,
    bytes: 1024,
    responseBytes: 1024,
    status: 206,
    contentRange: `bytes ${offset}-${offset + 1023}/8192`,
});

test('overlapping valid HTTP Range responses prove concurrent requests', () => {
    const result = summarizeRanges([
        sample(1000, 1400, 0),
        sample(1100, 1350, 1024),
        sample(1200, 1300, 2048),
        sample(1250, 1450, 3072),
    ]);
    assert.equal(result.validRequests, 4);
    assert.equal(result.overlappingPairs, 6);
    assert.equal(result.maxConcurrent, 4);
    assert.equal(result.wallMs, 450);
    assert.equal(result.concurrentVerified, true);
});

test('sequential and exactly touching intervals are not concurrent', () => {
    const result = summarizeRanges([
        sample(1000, 1100),
        sample(1100, 1200, 1024),
        sample(1200, 1300, 2048),
    ]);
    assert.equal(result.overlappingPairs, 0);
    assert.equal(result.maxConcurrent, 1);
    assert.equal(result.concurrentVerified, false);
    assert.equal(result.summedDurationMs, 300);
});

test('HTTP 403, short bodies and wrong Content-Range cannot count as proof', () => {
    const bad = [
        { ...sample(1000, 1400), status: 403 },
        { ...sample(1000, 1400, 1024), responseBytes: 100 },
        { ...sample(1000, 1400, 2048), contentRange: 'bytes 1-1024/8192' },
    ];
    const result = summarizeRanges(bad);
    assert.equal(result.validRequests, 0);
    assert.equal(result.failedRequests, 3);
    assert.equal(result.overlappingPairs, 0);
    assert.equal(result.maxConcurrent, 0);
    assert.equal(result.concurrentVerified, false);
    assert.ok(bad.every((s) => validateRange(s).length));
});

test('reject missing or invalid timestamps, body and requested offsets', () => {
    assert.ok(validateRange({ ...sample(1000, 1000) }).some((e) => e.includes('interval')));
    assert.ok(validateRange({ ...sample(1000, 1100), offset: -1 }).some((e) => e.includes('range')));
    assert.ok(validateRange({ ...sample(1000, 1100), contentRange: null }).some((e) => e.includes('Content-Range')));
    assert.throws(() => summarizeRanges(null), TypeError);
});
