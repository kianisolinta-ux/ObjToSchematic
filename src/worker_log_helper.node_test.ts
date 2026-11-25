import assert from 'node:assert/strict';
import test from 'node:test';

import { formatWorkerPayloadForLog } from './worker_log_helper';

test('formatWorkerPayloadForLog formats small payloads cleanly', () => {
    const out = formatWorkerPayloadForLog({
        action: 'Voxelise',
        params: {
            size: 24,
            voxeliser: 'bvh-ray',
        },
    });
    const parsed = JSON.parse(out);
    assert.equal(parsed.action, 'Voxelise');
    assert.equal(parsed.params.size, 24);
    assert.equal(parsed.params.voxeliser, 'bvh-ray');
});

test('formatWorkerPayloadForLog summarizes huge arrays and typed arrays without throwing', () => {
    const hugeVertices = new Array<number>(5_000_000).fill(1.25);
    const hugePixels = new Uint8ClampedArray(16 * 1024 * 1024);
    const hugeBase64 = 'A'.repeat(2_000_000);

    const out = formatWorkerPayloadForLog({
        action: 'LoadPreprocessedMesh',
        params: {
            geometry: {
                vertices: hugeVertices,
                pixels: hugePixels,
            },
            materials: [
                { name: 'mat0', rgbaBase64: hugeBase64 },
            ],
        },
    });

    assert.ok(out.length <= 4200);
    assert.match(out, /total 5000000/);
    assert.match(out, /\[Uint8ClampedArray\(16777216\)\]/);
    assert.match(out, /\[string\(2000000\)\]/);
});

test('formatWorkerPayloadForLog handles circular refs, Map, Set, BigInt, and deep nesting', () => {
    const circular: Record<string, unknown> = { name: 'root' };
    circular.self = circular;

    const map = new Map<string, unknown>([
        ['wood', { count: 12, buf: new Float32Array(1024) }],
    ]);

    const out = formatWorkerPayloadForLog({
        circular,
        map,
        set: new Set([1, 2, 3, 4, 5, 6, 7, 8]),
        big: BigInt(999),
        nested: { a: { b: { c: { d: { e: 'deep' } } } } },
    });

    assert.match(out, /\[Circular\]/);
    assert.match(out, /Map\(1\)/);
    assert.match(out, /Set\(8\)/);
    assert.match(out, /999n/);
    assert.match(out, /\[Float32Array\(1024\)\]/);
});
