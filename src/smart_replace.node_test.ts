import assert from 'node:assert/strict';
import test from 'node:test';

import { BlockInfo } from './block_atlas';
import {
    canReplaceInFilterPass,
    computeEdgeAwareDiffusionFactor,
    pickBestRetainedBlock,
    rankReplacementCandidates,
    selectRetainedBlockNamesForCap,
} from './smart_replace';

function makeBlockInfo(name: string, r: number, g: number, b: number): BlockInfo {
    return {
        name,
        colour: { r, g, b, a: 1 },
        faces: {} as BlockInfo['faces'],
    };
}

test('computeEdgeAwareDiffusionFactor preserves gradients and attenuates sharp Oklab seams', () => {
    const gradFactor = computeEdgeAwareDiffusionFactor(
        { r: 0.60, g: 0.20, b: 0.20, a: 1 },
        { r: 0.62, g: 0.22, b: 0.21, a: 1 },
    );
    assert.equal(gradFactor, 1.0);

    const sharpFactor = computeEdgeAwareDiffusionFactor(
        { r: 0.85, g: 0.12, b: 0.12, a: 1 },
        { r: 0.12, g: 0.20, b: 0.85, a: 1 },
    );
    assert.equal(sharpFactor, 0.2);

    const mediumFactor = computeEdgeAwareDiffusionFactor(
        { r: 0.45, g: 0.45, b: 0.45, a: 1 },
        { r: 0.85, g: 0.40, b: 0.40, a: 1 },
    );
    assert.ok(mediumFactor > 0.2 && mediumFactor < 1.0, `expected smooth taper, got ${mediumFactor}`);
});

test('pickBestRetainedBlock applies spatial neighbour cohesion without overriding clear colour contrast', () => {
    const stone = makeBlockInfo('minecraft:stone', 0.49, 0.49, 0.49);
    const andesite = makeBlockInfo('minecraft:andesite', 0.51, 0.51, 0.51);
    const red = makeBlockInfo('minecraft:red_concrete', 0.65, 0.15, 0.15);

    const cohesiveChoice = pickBestRetainedBlock(
        { r: 0.51, g: 0.51, b: 0.51, a: 1 },
        [andesite, stone, red],
        new Map([['minecraft:stone', 4]]),
    );
    assert.equal(cohesiveChoice.name, 'minecraft:stone');

    const contrastingChoice = pickBestRetainedBlock(
        { r: 0.66, g: 0.14, b: 0.14, a: 1 },
        [andesite, stone, red],
        new Map([['minecraft:stone', 6]]),
    );
    assert.equal(contrastingChoice.name, 'minecraft:red_concrete');
});

test('selectRetainedBlockNamesForCap retains distinct vivid accents over redundant shades', () => {
    const counts = new Map([
        ['minecraft:stone', 100],
        ['minecraft:andesite', 25],
        ['minecraft:gold_block', 12],
    ]);
    const colours = new Map([
        ['minecraft:stone', { r: 0.49, g: 0.49, b: 0.49, a: 1 }],
        ['minecraft:andesite', { r: 0.51, g: 0.51, b: 0.51, a: 1 }],
        ['minecraft:gold_block', { r: 0.95, g: 0.78, b: 0.22, a: 1 }],
    ]);

    const retained = selectRetainedBlockNamesForCap(counts, colours, 2);
    assert.equal(retained.size, 2);
    assert.ok(retained.has('minecraft:stone'));
    assert.ok(retained.has('minecraft:gold_block'));
});

test('rankReplacementCandidates ranks closest Oklab neighbours and splits palette groups', () => {
    const hexMap = new Map([
        ['minecraft:white_wool', '#e9ecec'],
        ['minecraft:white_concrete', '#cfd5d6'],
        ['minecraft:stone', '#7d7d7d'],
        ['minecraft:black_wool', '#141519'],
    ]);
    const ranked = rankReplacementCandidates(
        'minecraft:white_wool',
        '#e9ecec',
        ['minecraft:white_concrete', 'minecraft:stone'],
        ['minecraft:white_wool', 'minecraft:white_concrete', 'minecraft:stone', 'minecraft:black_wool'],
        hexMap,
        1,
    );

    assert.equal(ranked.similar[0].name, 'minecraft:white_concrete');
    assert.deepEqual(ranked.paletteOthers, ['minecraft:stone']);
    assert.deepEqual(ranked.allOthers, ['minecraft:black_wool']);
});

test('canReplaceInFilterPass permits close shade smoothing and blocks contrasting colour drift', () => {
    const voxel = { r: 0.50, g: 0.50, b: 0.50, a: 1 };
    const stone = { r: 0.49, g: 0.49, b: 0.49, a: 1 };
    const andesite = { r: 0.52, g: 0.52, b: 0.52, a: 1 };
    const obsidian = { r: 0.08, g: 0.07, b: 0.11, a: 1 };

    assert.equal(canReplaceInFilterPass(voxel, stone, andesite, 15), true);
    assert.equal(canReplaceInFilterPass(voxel, stone, obsidian, 15), false);
});
