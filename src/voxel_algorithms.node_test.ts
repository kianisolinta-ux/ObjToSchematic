import assert from 'node:assert/strict';
import test from 'node:test';

import { estimateVoxelDimensions } from './dimension_estimator';
import {
    buildSolidIntervalsFromCrossings,
    closestPointOnTriangle,
    triangleIntersectsAabb,
} from './voxelisers/voxel_algos_math';

test('triangleIntersectsAabb detects diagonal grazing triangle crossing voxel box', () => {
    const a = { x: -2, y: -2, z: -2 };
    const b = { x: 2, y: 2, z: 2 };
    const c = { x: -2, y: 2, z: 2 };

    assert.equal(triangleIntersectsAabb(a, b, c, { x: 0, y: 0, z: 0 }, 0.5), true);
    assert.equal(triangleIntersectsAabb(a, b, c, { x: 10, y: 10, z: 10 }, 0.5), false);
});

test('closestPointOnTriangle projects outside query point onto triangle plane/edge', () => {
    const a = { x: 0, y: 0, z: 0 };
    const b = { x: 2, y: 0, z: 0 };
    const c = { x: 0, y: 2, z: 0 };

    const cp = closestPointOnTriangle({ x: 0.5, y: 0.5, z: 4 }, a, b, c);
    assert.ok(Math.abs(cp.x - 0.5) < 1e-6);
    assert.ok(Math.abs(cp.y - 0.5) < 1e-6);
    assert.ok(Math.abs(cp.z) < 1e-6);

    const corner = closestPointOnTriangle({ x: -3, y: -2, z: 1 }, a, b, c);
    assert.deepEqual(corner, { x: 0, y: 0, z: 0 });
});

test('buildSolidIntervalsFromCrossings deduplicates seams and pairs entry/exit spans', () => {
    const intervals = buildSolidIntervalsFromCrossings([
        { coord: 10.0, colour: { r: 1, g: 1, b: 1, a: 1 } },
        { coord: 2.0002, colour: { r: 0, g: 1, b: 0, a: 1 } },
        { coord: 2.0, colour: { r: 1, g: 0, b: 0, a: 1 } },
    ]);
    assert.equal(intervals.length, 1);
    assert.equal(intervals[0].start, 2);
    assert.equal(intervals[0].end, 10);
});

test('estimateVoxelDimensions handles conservative-surface and solid-fill', () => {
    const dims = estimateVoxelDimensions({
        meshDimensions: { x: 2, y: 4, z: 1 },
        constraintAxis: 'y',
        size: 81,
        voxeliser: 'conservative-surface',
    });
    assert.deepEqual(dims, { x: 41, y: 81, z: 21 });
});
