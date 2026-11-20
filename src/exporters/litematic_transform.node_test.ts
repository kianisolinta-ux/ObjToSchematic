import assert from 'node:assert/strict';
import test from 'node:test';

import { rotateBlockNameFacingY, rotateBoundsSizeY, rotateLocalBlockCoordY } from './litematic_transform';

test('rotateBoundsSizeY swaps X and Z for 90 and 270 degree rotations', () => {
    assert.deepEqual(rotateBoundsSizeY({ x: 10, y: 5, z: 4 }, 0), { x: 10, y: 5, z: 4 });
    assert.deepEqual(rotateBoundsSizeY({ x: 10, y: 5, z: 4 }, 90), { x: 4, y: 5, z: 10 });
    assert.deepEqual(rotateBoundsSizeY({ x: 10, y: 5, z: 4 }, 180), { x: 10, y: 5, z: 4 });
    assert.deepEqual(rotateBoundsSizeY({ x: 10, y: 5, z: 4 }, 270), { x: 4, y: 5, z: 10 });
});

test('rotateLocalBlockCoordY maps corner coordinates consistently across 4x90 steps', () => {
    const size = { x: 4, y: 3, z: 2 };
    // Point (dx=3, dy=1, dz=0) rotated 90 CW -> size (2,3,4), coord (1, 1, 3)
    const r90 = rotateLocalBlockCoordY(3, 1, 0, size, 90);
    assert.deepEqual(r90, { x: 1, y: 1, z: 3 });

    const r180 = rotateLocalBlockCoordY(3, 1, 0, size, 180);
    assert.deepEqual(r180, { x: 0, y: 1, z: 1 });

    const r270 = rotateLocalBlockCoordY(3, 1, 0, size, 270);
    assert.deepEqual(r270, { x: 0, y: 1, z: 0 });
});

test('rotateBlockNameFacingY rotates cardinal facing property clockwise', () => {
    assert.equal(rotateBlockNameFacingY('minecraft:stone', 90), 'minecraft:stone');
    assert.equal(rotateBlockNameFacingY('minecraft:wall_torch[facing=north]', 90), 'minecraft:wall_torch[facing=east]');
    assert.equal(rotateBlockNameFacingY('minecraft:wall_torch[facing=east]', 180), 'minecraft:wall_torch[facing=west]');
    assert.equal(rotateBlockNameFacingY('minecraft:wall_torch[facing=north]', 270), 'minecraft:wall_torch[facing=west]');
});
