import assert from 'node:assert/strict';
import test from 'node:test';

import { estimateVoxelDimensions } from './dimension_estimator';

test('estimateVoxelDimensions estimates Y-constrained dimensions for ray/bvh voxelisers', () => {
    const res = estimateVoxelDimensions({
        meshDimensions: { x: 2, y: 1, z: 0.5 },
        constraintAxis: 'y',
        size: 33,
        voxeliser: 'bvh-ray',
    });
    // scale = (33 - 1) / 1 = 32 -> X = 2*32+1 = 65, Y = 33, Z = 0.5*32+1 = 17
    assert.deepEqual(res, { x: 65, y: 33, z: 17 });
});

test('estimateVoxelDimensions estimates X-constrained and Z-constrained dimensions for ncrb', () => {
    const xConstrained = estimateVoxelDimensions({
        meshDimensions: { x: 10, y: 5, z: 2.5 },
        constraintAxis: 'x',
        size: 40,
        voxeliser: 'ncrb',
    });
    assert.deepEqual(xConstrained, { x: 40, y: 20, z: 10 });

    const zConstrained = estimateVoxelDimensions({
        meshDimensions: { x: 4, y: 8, z: 2 },
        constraintAxis: 'z',
        size: 16,
        voxeliser: 'ncrb',
    });
    assert.deepEqual(zConstrained, { x: 32, y: 64, z: 16 });
});

test('estimateVoxelDimensions clamps minimum axis size to 1 and handles invalid bounds', () => {
    const thin = estimateVoxelDimensions({
        meshDimensions: { x: 100, y: 100, z: 0.001 },
        constraintAxis: 'y',
        size: 10,
        voxeliser: 'ncrb',
    });
    assert.equal(thin.z, 1);

    const sizeOne = estimateVoxelDimensions({
        meshDimensions: { x: 2, y: 1, z: 2 },
        constraintAxis: 'y',
        size: 1,
        voxeliser: 'ray',
    });
    assert.deepEqual(sizeOne, { x: 1, y: 1, z: 1 });

    const invalid = estimateVoxelDimensions({
        meshDimensions: { x: 1, y: 0, z: 1 },
        constraintAxis: 'y',
        size: 25,
        voxeliser: 'bvh-ray',
    });
    assert.deepEqual(invalid, { x: 25, y: 25, z: 25 });
});
