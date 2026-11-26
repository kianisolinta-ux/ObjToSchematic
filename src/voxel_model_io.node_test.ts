import assert from 'node:assert/strict';
import test from 'node:test';

import {
    deriveModelNameFromVoxelFilename,
    parseVoxelModelJson,
    serializeVoxelModel,
    VOXEL_MODEL_FORMAT,
    VOXEL_MODEL_VERSION,
} from './voxel_model_io';

test('serializeVoxelModel and parseVoxelModelJson round-trip voxels and metadata', () => {
    const json = serializeVoxelModel(
        [
            { position: { x: 0, y: 1, z: 2 }, colour: { r: 0.5, g: 0.25, b: 0.75, a: 1 } },
            { position: { x: -3, y: 4, z: 0 }, colour: { r: 1, g: 0, b: 0, a: 0.5 } },
        ],
        {
            modelName: 'skull',
            constraintAxis: 'y',
            size: 16,
            enableAmbientOcclusion: true,
            voxelOverlapRule: 'average',
        },
    );

    const parsedRaw = JSON.parse(json);
    assert.equal(parsedRaw.format, VOXEL_MODEL_FORMAT);
    assert.equal(parsedRaw.version, VOXEL_MODEL_VERSION);

    const parsed = parseVoxelModelJson(json);
    assert.equal(parsed.voxels.length, 2);
    assert.equal(parsed.meta.modelName, 'skull');
    assert.equal(parsed.meta.constraintAxis, 'y');
    assert.equal(parsed.meta.size, 16);
    assert.equal(parsed.desiredHeight, 16);
    assert.deepEqual(parsed.dimensions, { x: 4, y: 4, z: 3 });
    assert.deepEqual(parsed.voxels[0], {
        x: 0,
        y: 1,
        z: 2,
        colour: { r: 0.5, g: 0.25, b: 0.75, a: 1 },
    });
});

test('parseVoxelModelJson deduplicates coordinates and computes fallback desiredHeight', () => {
    const json = JSON.stringify({
        format: VOXEL_MODEL_FORMAT,
        version: VOXEL_MODEL_VERSION,
        createdAt: '2026-11-26T00:00:00.000Z',
        meta: {},
        voxels: [
            [1.2, 2.8, 3.1, 0.1, 0.2, 0.3, 1],
            [1, 3, 3, 0.9, 0.8, 0.7, 1],
            [1, 5, 3, 0.4, 0.4, 0.4, 1],
            [9, 9, 9, 1, 1, 1, 0],
        ],
    });

    const parsed = parseVoxelModelJson(json);
    assert.equal(parsed.voxels.length, 2);
    assert.deepEqual(parsed.voxels[0], { x: 1, y: 3, z: 3, colour: { r: 0.9, g: 0.8, b: 0.7, a: 1 } });
    assert.deepEqual(parsed.dimensions, { x: 1, y: 3, z: 1 });
    assert.equal(parsed.desiredHeight, 3);
});

test('parseVoxelModelJson rejects invalid JSON, wrong format, or empty voxels', () => {
    assert.throws(() => parseVoxelModelJson('{bad json'));
    assert.throws(() => parseVoxelModelJson(JSON.stringify({ format: 'other', version: 1, voxels: [[0, 0, 0, 1, 1, 1, 1]] })));
    assert.throws(() => parseVoxelModelJson(JSON.stringify({ format: VOXEL_MODEL_FORMAT, version: 1, voxels: [] })));
    assert.throws(() => parseVoxelModelJson(JSON.stringify({ format: VOXEL_MODEL_FORMAT, version: 1, voxels: [[0, 0, 0, 1, 1, 1, 0]] })));
});

test('deriveModelNameFromVoxelFilename strips voxel json extensions cleanly', () => {
    assert.equal(deriveModelNameFromVoxelFilename('castle_keep.voxels.json'), 'castle_keep');
    assert.equal(deriveModelNameFromVoxelFilename('tower.json'), 'tower');
    assert.equal(deriveModelNameFromVoxelFilename('   '), 'voxel_model');
});
