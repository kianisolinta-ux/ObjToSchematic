import assert from 'node:assert/strict';
import test from 'node:test';

import { computeCleanVoxelIndices, VoxelCoord } from './voxel_cleanup';

test('computeCleanVoxelIndices keeps single connected block intact', () => {
    const coords: VoxelCoord[] = [
        { x: 0, y: 0, z: 0 },
        { x: 1, y: 0, z: 0 },
        { x: 2, y: 1, z: 1 }, // diagonally 26-connected to (1,0,0)
    ];
    const res = computeCleanVoxelIndices(coords, 10);
    assert.equal(res.totalComponents, 1);
    assert.equal(res.removedComponents, 0);
    assert.deepEqual(res.keptIndices, [0, 1, 2]);
    assert.deepEqual(res.removedIndices, []);
});

test('computeCleanVoxelIndices removes small floating specks while keeping large islands', () => {
    const coords: VoxelCoord[] = [
        // Main body (5 voxels)
        { x: 0, y: 0, z: 0 },
        { x: 1, y: 0, z: 0 },
        { x: 2, y: 0, z: 0 },
        { x: 0, y: 1, z: 0 },
        { x: 1, y: 1, z: 0 },
        // Detached speck of 2 voxels
        { x: 10, y: 10, z: 10 },
        { x: 10, y: 11, z: 10 },
        // Secondary detached part of 4 voxels (>= threshold 4)
        { x: -10, y: 0, z: 0 },
        { x: -11, y: 0, z: 0 },
        { x: -10, y: 1, z: 0 },
        { x: -11, y: 1, z: 0 },
        // Single isolated noise voxel
        { x: 20, y: 20, z: 20 },
    ];
    const res = computeCleanVoxelIndices(coords, 4);
    assert.equal(res.totalComponents, 4);
    assert.equal(res.removedComponents, 2);
    assert.deepEqual(res.removedIndices, [5, 6, 11]);
    assert.deepEqual(res.keptIndices, [0, 1, 2, 3, 4, 7, 8, 9, 10]);
});

test('computeCleanVoxelIndices always preserves the largest component even below threshold', () => {
    const coords: VoxelCoord[] = [
        { x: 0, y: 0, z: 0 },
        { x: 1, y: 0, z: 0 },
        { x: 2, y: 0, z: 0 },
        { x: 8, y: 8, z: 8 },
    ];
    const res = computeCleanVoxelIndices(coords, 20);
    assert.equal(res.totalComponents, 2);
    assert.equal(res.removedComponents, 1);
    assert.deepEqual(res.keptIndices, [0, 1, 2]);
    assert.deepEqual(res.removedIndices, [3]);
});
