import assert from 'node:assert/strict';
import test from 'node:test';

import { computeLitematicRegionPosition } from './litematic_anchor';

test('computeLitematicRegionPosition computes expected anchor offsets without -0', () => {
    assert.deepEqual(
        computeLitematicRegionPosition({ x: 1, y: 1, z: 1 }, 'center-base'),
        { x: 0, y: 0, z: 0 },
    );
    assert.equal(
        Object.is(computeLitematicRegionPosition({ x: 1, y: 1, z: 1 }, 'center-base').x, -0),
        false,
    );

    assert.deepEqual(
        computeLitematicRegionPosition({ x: 11, y: 20, z: 9 }, 'center-base'),
        { x: -5, y: 0, z: -4 },
    );

    assert.deepEqual(
        computeLitematicRegionPosition({ x: 11, y: 20, z: 9 }, 'center'),
        { x: -5, y: -10, z: -4 },
    );

    assert.deepEqual(
        computeLitematicRegionPosition({ x: 11, y: 20, z: 9 }, 'min-corner'),
        { x: 0, y: 0, z: 0 },
    );
});
