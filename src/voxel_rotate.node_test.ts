import assert from 'node:assert/strict';
import test from 'node:test';

import { VoxelColourRecord } from './voxel_postprocess';
import { rotateVoxelRecords } from './voxel_rotate';

function boundsOf(voxels: readonly VoxelColourRecord[]) {
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    for (const v of voxels) {
        if (v.x < minX) minX = v.x;
        if (v.y < minY) minY = v.y;
        if (v.z < minZ) minZ = v.z;
        if (v.x > maxX) maxX = v.x;
        if (v.y > maxY) maxY = v.y;
        if (v.z > maxZ) maxZ = v.z;
    }
    return {
        dimX: maxX - minX + 1,
        dimY: maxY - minY + 1,
        dimZ: maxZ - minZ + 1,
    };
}

function makeAsymmetricBox(): VoxelColourRecord[] {
    const voxels: VoxelColourRecord[] = [];
    // 2 x 3 x 5 asymmetric box + corner marker
    for (let x = 0; x < 2; ++x) {
        for (let y = 0; y < 3; ++y) {
            for (let z = 0; z < 5; ++z) {
                const isCorner = x === 1 && y === 2 && z === 4;
                voxels.push({
                    x,
                    y,
                    z,
                    colour: isCorner ?
                        { r: 1, g: 0, b: 0, a: 1 } :
                        { r: 0.2, g: 0.6, b: 0.9, a: 1 },
                });
            }
        }
    }
    return voxels;
}

test('rotateVoxelRecords handles empty input and 0/360 degree identity rotations', () => {
    assert.deepEqual(rotateVoxelRecords([], { x: 90, y: 45, z: 0 }), []);

    const box = makeAsymmetricBox();
    const zeroRot = rotateVoxelRecords(box, { x: 0, y: 0, z: 0 });
    const fullTurn = rotateVoxelRecords(box, { x: 360, y: -360, z: 720 });

    assert.equal(zeroRot.length, box.length);
    assert.equal(fullTurn.length, box.length);
    assert.deepEqual(zeroRot, box);
    assert.deepEqual(fullTurn, box);
});

test('rotateVoxelRecords performs exact lossless 90-degree rotations along X, Y, and Z axes', () => {
    const box = makeAsymmetricBox(); // dims 2 x 3 x 5

    // 90 deg around Y swaps X and Z -> dims 5 x 3 x 2
    const rotY90 = rotateVoxelRecords(box, { x: 0, y: 90, z: 0 });
    assert.equal(rotY90.length, box.length);
    assert.deepEqual(boundsOf(rotY90), { dimX: 5, dimY: 3, dimZ: 2 });

    // 90 deg around X swaps Y and Z -> dims 2 x 5 x 3
    const rotX90 = rotateVoxelRecords(box, { x: 90, y: 0, z: 0 });
    assert.equal(rotX90.length, box.length);
    assert.deepEqual(boundsOf(rotX90), { dimX: 2, dimY: 5, dimZ: 3 });

    // 90 deg around Z swaps X and Y -> dims 3 x 2 x 5
    const rotZ90 = rotateVoxelRecords(box, { x: 0, y: 0, z: 90 });
    assert.equal(rotZ90.length, box.length);
    assert.deepEqual(boundsOf(rotZ90), { dimX: 3, dimY: 2, dimZ: 5 });

    // Check uniqueness (no collapsed duplicate coordinates)
    const keys = new Set(rotY90.map((v) => `${v.x},${v.y},${v.z}`));
    assert.equal(keys.size, box.length);
});

test('rotateVoxelRecords produces hole-free rotated plate at arbitrary angles (45 deg and compound)', () => {
    // 1-voxel thick 9x9 horizontal plate at y=0
    const plate: VoxelColourRecord[] = [];
    for (let x = 0; x < 9; ++x) {
        for (let z = 0; z < 9; ++z) {
            plate.push({ x, y: 0, z, colour: { r: 0.4, g: 0.8, b: 0.3, a: 1 } });
        }
    }

    const rotated45 = rotateVoxelRecords(plate, { x: 0, y: 45, z: 0 });
    const keys = new Set(rotated45.map((v) => `${v.x},${v.y},${v.z}`));
    assert.equal(keys.size, rotated45.length);
    assert.ok(rotated45.length >= 65, `Expected dense rotated plate, got ${rotated45.length}`);
    // Every voxel on y=0 should remain on y=0 when only rotating around Y
    for (const v of rotated45) {
        assert.equal(v.y, 0);
    }

    // Compound rotation around all three axes produces valid unique integer voxels
    const compound = rotateVoxelRecords(makeAsymmetricBox(), { x: 25, y: 45, z: -15 });
    const compoundKeys = new Set(compound.map((v) => `${v.x},${v.y},${v.z}`));
    assert.equal(compoundKeys.size, compound.length);
    assert.ok(compound.length >= 20);
});
