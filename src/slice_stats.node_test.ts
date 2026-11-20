import assert from 'node:assert/strict';
import test from 'node:test';

import { computeSliceLayerBlockSummary, computeSliceLayerStats } from './slice_stats';

test('computeSliceLayerStats computes layer number, total layers, and per-layer counts', () => {
    const ys = [-2, -2, -1, 0, 0, 0, 1];
    const stats = computeSliceLayerStats(ys, -2, 1, 0);
    assert.deepEqual(stats, {
        layerNumber: 3,
        totalLayers: 4,
        sliceY: 0,
        minY: -2,
        maxY: 1,
        blocksOnLayer: 3,
        blocksUpToLayer: 6,
        totalBlocks: 7,
    });
});

test('computeSliceLayerStats handles empty meshes and clamps sliceHeight', () => {
    const empty = computeSliceLayerStats([], 0, 0, 0);
    assert.equal(empty.totalLayers, 0);
    assert.equal(empty.blocksOnLayer, 0);

    const clamped = computeSliceLayerStats([5, 6, 7], 5, 7, 99);
    assert.equal(clamped.sliceY, 7);
    assert.equal(clamped.layerNumber, 3);
    assert.equal(clamped.totalLayers, 3);
    assert.equal(clamped.blocksOnLayer, 1);
    assert.equal(clamped.blocksUpToLayer, 3);
});

test('computeSliceLayerBlockSummary filters blocks to active sliceY and sorts by count', () => {
    const summary = computeSliceLayerBlockSummary(
        [
            { y: 0, name: 'minecraft:stone' },
            { y: 1, name: 'minecraft:stone' },
            { y: 1, name: 'minecraft:oak_planks' },
            { y: 1, name: 'minecraft:oak_planks' },
            { y: 2, name: 'minecraft:glass' },
        ],
        1,
        new Map([
            ['minecraft:stone', '#7d7d7d'],
            ['minecraft:oak_planks', '#a2824e'],
        ]),
    );

    assert.equal(summary.sliceY, 1);
    assert.equal(summary.total, 3);
    assert.equal(summary.unique, 2);
    assert.deepEqual(summary.blocks, [
        { name: 'minecraft:oak_planks', count: 2, hexColour: '#a2824e', percentage: (2 / 3) * 100 },
        { name: 'minecraft:stone', count: 1, hexColour: '#7d7d7d', percentage: (1 / 3) * 100 },
    ]);
});

