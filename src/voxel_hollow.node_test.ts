import assert from 'node:assert/strict';
import test from 'node:test';

import { computeHollowShellIndices, VoxelPoint } from './voxel_hollow';

test('computeHollowShellIndices removes strictly interior voxels from a 5x5x5 solid cube', () => {
    const points: VoxelPoint[] = [];
    for (let x = 0; x < 5; ++x) {
        for (let y = 0; y < 5; ++y) {
            for (let z = 0; z < 5; ++z) {
                points.push({ x, y, z });
            }
        }
    }

    // Thickness 1: keeps 5^3 - 3^3 = 125 - 27 = 98 shell voxels
    const t1 = computeHollowShellIndices(points, 1);
    assert.equal(t1.keptIndices.length, 98);
    assert.equal(t1.removedIndices.length, 27);

    // Thickness 2: keeps 5^3 - 1^3 = 124 voxels (only center (2,2,2) removed)
    const t2 = computeHollowShellIndices(points, 2);
    assert.equal(t2.keptIndices.length, 124);
    assert.equal(t2.removedIndices.length, 1);
    assert.deepEqual(points[t2.removedIndices[0]], { x: 2, y: 2, z: 2 });

    // Thickness 3: keeps all 125
    const t3 = computeHollowShellIndices(points, 3);
    assert.equal(t3.keptIndices.length, 125);
    assert.equal(t3.removedIndices.length, 0);
});

test('computeHollowShellIndices keeps diagonal staircase watertight without pin-holes', () => {
    // Stepped diagonal 3x3 diagonal strip extruded along Z
    const points: VoxelPoint[] = [];
    for (let z = 0; z < 3; ++z) {
        points.push({ x: 0, y: 0, z });
        points.push({ x: 1, y: 0, z });
        points.push({ x: 1, y: 1, z });
        points.push({ x: 2, y: 1, z });
        points.push({ x: 2, y: 2, z });
    }
    const res = computeHollowShellIndices(points, 1);
    assert.equal(res.keptIndices.length, points.length);
    assert.equal(res.removedIndices.length, 0);
});
