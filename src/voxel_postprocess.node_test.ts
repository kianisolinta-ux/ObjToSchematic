import assert from 'node:assert/strict';
import test from 'node:test';

import {
    applyVoxelMorphology,
    computeBasePlinthVoxels,
    computeFloodSolidInterior,
    computeMirroredVoxels,
    VoxelColourRecord,
} from './voxel_postprocess';
import {
    countMaskBits8,
    distanceSquaredToTriangle,
    evaluateSubVoxelCoverage,
} from './voxelisers/voxel_algos_math';

const RED = { r: 1, g: 0, b: 0, a: 1 };
const BLUE = { r: 0, g: 0, b: 1, a: 1 };

function keySet(voxels: readonly VoxelColourRecord[]): Set<string> {
    return new Set(voxels.map((v) => `${v.x},${v.y},${v.z}`));
}

test('distanceSquaredToTriangle measures exact SDF distance and closest point', () => {
    const a = { x: 0, y: 0, z: 0 };
    const b = { x: 2, y: 0, z: 0 };
    const c = { x: 0, y: 2, z: 0 };
    const res = distanceSquaredToTriangle({ x: 0.5, y: 0.5, z: 1.5 }, a, b, c);
    assert.ok(Math.abs(res.distSq - 2.25) < 1e-6);
    assert.ok(Math.abs(res.closest.z) < 1e-6);
});

test('evaluateSubVoxelCoverage counts intersected 2x2x2 sub-voxels accurately', () => {
    // Horizontal plane slicing across upper half y = 0.25 fills upper 4 sub-voxels
    const a = { x: -2, y: 0.25, z: -2 };
    const b = { x: 2, y: 0.25, z: -2 };
    const c = { x: 0, y: 0.25, z: 2 };
    const mask = evaluateSubVoxelCoverage(a, b, c, { x: 0, y: 0, z: 0 });
    assert.equal(countMaskBits8(mask), 4);
});

test('applyVoxelMorphology close fills 1-voxel pinhole in flat sheet', () => {
    const voxels: VoxelColourRecord[] = [];
    for (let x = -1; x <= 1; ++x) {
        for (let z = -1; z <= 1; ++z) {
            if (x === 0 && z === 0) continue; // center pinhole
            voxels.push({ x, y: 0, z, colour: RED });
        }
    }
    const res = applyVoxelMorphology(voxels, 'close');
    assert.equal(res.addedCount, 1);
    assert.equal(keySet(res.voxels).has('0,0,0'), true);
});

test('applyVoxelMorphology smooth prunes isolated spike without deleting bulk', () => {
    const voxels: VoxelColourRecord[] = [];
    for (let x = 0; x < 3; ++x) {
        for (let y = 0; y < 3; ++y) {
            for (let z = 0; z < 3; ++z) {
                voxels.push({ x, y, z, colour: BLUE });
            }
        }
    }
    // Isolated distant spike + 1-neighbour tip
    voxels.push({ x: 10, y: 10, z: 10, colour: RED });
    const res = applyVoxelMorphology(voxels, 'smooth');
    assert.equal(res.removedCount, 1);
    assert.equal(keySet(res.voxels).has('10,10,10'), false);
    assert.equal(keySet(res.voxels).has('1,1,1'), true);
});

test('applyVoxelMorphology erode trims outer layer and preserves safety on 1-voxel thin plate', () => {
    // 3x3x3 solid cube: only center (1,1,1) has 6 neighbours
    const cube: VoxelColourRecord[] = [];
    for (let x = 0; x < 3; ++x) {
        for (let y = 0; y < 3; ++y) {
            for (let z = 0; z < 3; ++z) {
                cube.push({ x, y, z, colour: RED });
            }
        }
    }
    const eroded = applyVoxelMorphology(cube, 'erode');
    assert.equal(eroded.voxels.length, 1);
    assert.equal(keySet(eroded.voxels).has('1,1,1'), true);

    // Thin sheet safety guard: must not wipe entire shape
    const sheet: VoxelColourRecord[] = [{ x: 0, y: 0, z: 0, colour: RED }];
    const safeSheet = applyVoxelMorphology(sheet, 'erode');
    assert.equal(safeSheet.voxels.length, 1);
});

test('computeMirroredVoxels mirrors asymmetric arm across X bounds without overwriting', () => {
    const voxels: VoxelColourRecord[] = [
        { x: 0, y: 0, z: 0, colour: RED },
        { x: 4, y: 0, z: 0, colour: BLUE },
        { x: 1, y: 2, z: 0, colour: RED },
    ];
    const res = computeMirroredVoxels(voxels, 'x');
    const keys = keySet(res.voxels);
    assert.equal(res.addedCount, 1);
    assert.equal(keys.has('3,2,0'), true);
});

test('computeBasePlinthVoxels extrudes N layers below minY footprint', () => {
    const voxels: VoxelColourRecord[] = [
        { x: 0, y: 2, z: 0, colour: RED },
        { x: 1, y: 2, z: 0, colour: BLUE },
        { x: 0, y: 3, z: 0, colour: RED },
    ];
    const res = computeBasePlinthVoxels(voxels, 2);
    const keys = keySet(res.voxels);
    assert.equal(res.addedCount, 4);
    assert.equal(keys.has('0,1,0'), true);
    assert.equal(keys.has('0,0,0'), true);
    assert.equal(keys.has('1,1,0'), true);
    assert.equal(keys.has('1,0,0'), true);
});

test('computeFloodSolidInterior fills enclosed 5x5x5 hollow box interior cleanly', () => {
    const shell: VoxelColourRecord[] = [];
    for (let x = 0; x < 5; ++x) {
        for (let y = 0; y < 5; ++y) {
            for (let z = 0; z < 5; ++z) {
                const isBoundary = x === 0 || x === 4 || y === 0 || y === 4 || z === 0 || z === 4;
                if (isBoundary) {
                    shell.push({ x, y, z, colour: RED });
                }
            }
        }
    }
    const interior = computeFloodSolidInterior(shell);
    // Interior is 3x3x3 = 27 voxels
    assert.equal(interior.length, 27);
    const keys = keySet(interior);
    assert.equal(keys.has('2,2,2'), true);
    assert.equal(keys.has('0,0,0'), false);
});
