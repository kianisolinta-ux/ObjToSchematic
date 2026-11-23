import assert from 'node:assert/strict';
import test from 'node:test';

import {
    ciede2000Distance,
    computeLuminanceStretchParams,
    remapVoxelLuminance,
    selectSpatialCoherentCandidate,
} from './colour_algorithms';

test('ciede2000Distance satisfies symmetry, zero identity, and perceptual ordering', () => {
    const red = { r: 0.9, g: 0.15, b: 0.15, a: 1 };
    const warmRed = { r: 0.85, g: 0.2, b: 0.15, a: 1 };
    const blue = { r: 0.1, g: 0.2, b: 0.9, a: 1 };

    assert.equal(ciede2000Distance(red, red), 0);
    assert.ok(Math.abs(ciede2000Distance(red, blue) - ciede2000Distance(blue, red)) < 1e-9);
    assert.ok(ciede2000Distance(red, warmRed) < ciede2000Distance(red, blue));
});

test('computeLuminanceStretchParams expands narrow dark model toward brighter palette range', () => {
    const darkVoxels = Array.from({ length: 20 }, (_, i) => ({
        r: 0.1 + i * 0.01,
        g: 0.1 + i * 0.01,
        b: 0.1 + i * 0.01,
        a: 1,
    }));
    const palette = [
        { r: 0.15, g: 0.15, b: 0.15, a: 1 },
        { r: 0.9, g: 0.9, b: 0.9, a: 1 },
    ];

    const params = computeLuminanceStretchParams(darkVoxels, palette, 1.0);
    assert.ok(params !== null);

    const brightestRemapped = remapVoxelLuminance(darkVoxels[19], params);
    assert.ok(brightestRemapped.r > 0.75);
});

test('selectSpatialCoherentCandidate favors cohesive neighbor without overriding big colour mismatch', () => {
    const candidates = [
        { name: 'minecraft:white_concrete', colourError: 0.03, stdPenalty: 0.01 },
        { name: 'minecraft:light_gray_wool', colourError: 0.04, stdPenalty: 0.01 },
        { name: 'minecraft:black_wool', colourError: 0.50, stdPenalty: 0.01 },
    ];
    const similarNeighbors = [
        { name: 'minecraft:light_gray_wool', colourSimilarity: 0.95 },
        { name: 'minecraft:light_gray_wool', colourSimilarity: 0.95 },
        { name: 'minecraft:light_gray_wool', colourSimilarity: 0.95 },
    ];

    const winner = selectSpatialCoherentCandidate(candidates, similarNeighbors, 0.2, 0.065);
    assert.equal(winner.name, 'minecraft:light_gray_wool');

    // Even if black_wool had neighbors, big colour error prevents choosing black
    const extremeNeighbors = [
        { name: 'minecraft:black_wool', colourSimilarity: 1.0 },
        { name: 'minecraft:black_wool', colourSimilarity: 1.0 },
    ];
    const safeWinner = selectSpatialCoherentCandidate(candidates, extremeNeighbors, 0.2, 0.065);
    assert.equal(safeWinner.name, 'minecraft:white_concrete');
});
