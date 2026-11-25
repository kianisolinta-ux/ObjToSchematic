import assert from 'node:assert/strict';
import test from 'node:test';

import { RGBA } from './colour';
import {
    colourToOklabTriple,
    computePolychromeLogOffsets,
    computePolychromeSigma,
    extractPolychromeWeights,
    selectPolychromeBlockIndex,
} from './polychrome_assigner';

const PALETTE: Array<{ name: string; colour: RGBA }> = [
    { name: 'red', colour: { r: 0.85, g: 0.12, b: 0.12, a: 1 } },
    { name: 'green', colour: { r: 0.14, g: 0.72, b: 0.18, a: 1 } },
    { name: 'blue', colour: { r: 0.12, g: 0.22, b: 0.88, a: 1 } },
    { name: 'yellow', colour: { r: 0.94, g: 0.86, b: 0.18, a: 1 } },
    { name: 'white', colour: { r: 0.95, g: 0.95, b: 0.95, a: 1 } },
];

const PALETTE_OKLAB = PALETTE.map((p) => colourToOklabTriple(p.colour));

test('extractPolychromeWeights snaps near-equal percentages and weights to exact uniform', () => {
    const pctThree = extractPolychromeWeights({
        mode: 'percentages',
        percentages: [33.3, 33.3, 33.4],
    }, 3);
    assert.deepEqual(pctThree, [1 / 3, 1 / 3, 1 / 3]);

    const wFive = extractPolychromeWeights({
        mode: 'weights',
        values: [0.5, 0.5, 0.5, 0.5, 0.5],
    }, 5);
    assert.deepEqual(wFive, [0.2, 0.2, 0.2, 0.2, 0.2]);
});

test('uniform weights yield zero log offsets and match exact perceptual colours regardless of order', () => {
    const weights = extractPolychromeWeights({
        mode: 'percentages',
        percentages: [20, 20, 20, 20, 20],
    }, 5);
    const sigma = computePolychromeSigma(PALETTE_OKLAB);
    const offsets = computePolychromeLogOffsets(weights, sigma);
    assert.deepEqual(offsets, [0, 0, 0, 0, 0]);

    // Check reversed order still maps every hue to its true colour block
    const reversed = [...PALETTE].reverse();
    const reversedOklab = reversed.map((p) => colourToOklabTriple(p.colour));

    const queries: Array<{ expected: string; colour: RGBA }> = [
        { expected: 'red', colour: { r: 0.78, g: 0.16, b: 0.15, a: 1 } },
        { expected: 'green', colour: { r: 0.18, g: 0.65, b: 0.22, a: 1 } },
        { expected: 'blue', colour: { r: 0.15, g: 0.25, b: 0.82, a: 1 } },
        { expected: 'yellow', colour: { r: 0.90, g: 0.80, b: 0.20, a: 1 } },
        { expected: 'white', colour: { r: 0.90, g: 0.91, b: 0.92, a: 1 } },
    ];

    for (const q of queries) {
        const idxFwd = selectPolychromeBlockIndex(colourToOklabTriple(q.colour), PALETTE_OKLAB, offsets);
        const idxRev = selectPolychromeBlockIndex(colourToOklabTriple(q.colour), reversedOklab, offsets);
        assert.equal(PALETTE[idxFwd].name, q.expected);
        assert.equal(reversed[idxRev].name, q.expected);
    }
});

test('increasing a block weight expands its voxel selection share monotonically', () => {
    // Generate a gradient of neutral-to-warm-to-cool colours
    const sampleVoxels: RGBA[] = [];
    for (let i = 0; i <= 20; ++i) {
        const t = i / 20;
        sampleVoxels.push({
            r: 0.25 + 0.65 * t,
            g: 0.35 + 0.25 * (1 - Math.abs(t - 0.5)),
            b: 0.85 - 0.65 * t,
            a: 1,
        });
    }

    const sigma = computePolychromeSigma(PALETTE_OKLAB);

    const countRed = (percentages: number[]) => {
        const w = extractPolychromeWeights({ mode: 'percentages', percentages }, 5);
        const offsets = computePolychromeLogOffsets(w, sigma);
        let redCount = 0;
        for (const v of sampleVoxels) {
            const idx = selectPolychromeBlockIndex(colourToOklabTriple(v), PALETTE_OKLAB, offsets);
            if (PALETTE[idx].name === 'red') redCount++;
        }
        return redCount;
    };

    const redAtZero = countRed([0, 25, 25, 25, 25]);
    const redAtLow = countRed([5, 23.75, 23.75, 23.75, 23.75]);
    const redAtEqual = countRed([20, 20, 20, 20, 20]);
    const redAtHigh = countRed([60, 10, 10, 10, 10]);

    assert.equal(redAtZero, 0);
    assert.ok(redAtLow <= redAtEqual);
    assert.ok(redAtHigh > redAtEqual, `expected redAtHigh (${redAtHigh}) > redAtEqual (${redAtEqual})`);
});

test('zero-weighted block is never chosen when another block has positive weight', () => {
    const sigma = computePolychromeSigma(PALETTE_OKLAB);
    const weights = extractPolychromeWeights({
        mode: 'percentages',
        percentages: [0, 25, 25, 25, 25], // red = 0%
    }, 5);
    const offsets = computePolychromeLogOffsets(weights, sigma);

    // Query exact red colour: since red is 0%, it must NOT pick index 0 (red)
    const idx = selectPolychromeBlockIndex(colourToOklabTriple(PALETTE[0].colour), PALETTE_OKLAB, offsets);
    assert.notEqual(idx, 0);
});
