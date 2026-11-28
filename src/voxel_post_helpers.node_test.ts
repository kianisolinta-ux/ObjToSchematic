import assert from 'node:assert/strict';
import test from 'node:test';

import { computeVoxelPostControlState } from './voxel_post_helpers';

test('computeVoxelPostControlState disables reset button when group or mesh is unavailable', () => {
    const noGroup = computeVoxelPostControlState({
        groupEnabled: false,
        hasVoxelMesh: true,
    });
    assert.equal(noGroup.resetButtonEnabled, false);

    const noMesh = computeVoxelPostControlState({
        groupEnabled: true,
        hasVoxelMesh: false,
    });
    assert.equal(noMesh.resetButtonEnabled, false);
});

test('computeVoxelPostControlState enables reset button when group and voxel mesh are available', () => {
    const ready = computeVoxelPostControlState({
        groupEnabled: true,
        hasVoxelMesh: true,
    });
    assert.equal(ready.resetButtonEnabled, true);
});
