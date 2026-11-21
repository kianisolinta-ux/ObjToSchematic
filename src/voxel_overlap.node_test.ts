import assert from 'node:assert/strict';
import test from 'node:test';

import { RGBAColours, RGBAUtil } from './colour';
import {
    DominantColourCluster,
    getStratifiedSampleOffset,
    mergeDominantColourSample,
    mergeLinearAverageColourSample,
} from './voxel_overlap';

test('mergeDominantColourSample keeps majority cluster crisp instead of blurring into muddy gray', () => {
    const clusters: DominantColourCluster[] = [];
    // 3 bright red samples + 1 bright blue outlier -> red cluster must win cleanly
    mergeDominantColourSample(clusters, RGBAColours.RED);
    mergeDominantColourSample(clusters, { r: 0.96, g: 0.05, b: 0.05, a: 1.0 });
    mergeDominantColourSample(clusters, { r: 0.98, g: 0.02, b: 0.04, a: 1.0 });
    const result = mergeDominantColourSample(clusters, RGBAColours.BLUE);

    assert.equal(clusters.length, 2);
    assert.ok(result.r > 0.95 && result.b < 0.1, `Expected crisp red dominant cluster, got (${result.r}, ${result.g}, ${result.b})`);
});

test('mergeLinearAverageColourSample uses physically-correct linear-light blending', () => {
    const acc: DominantColourCluster = { lr: 0, lg: 0, lb: 0, alphaSum: 0, count: 0 };
    mergeLinearAverageColourSample(acc, RGBAColours.BLACK);
    const out = mergeLinearAverageColourSample(acc, RGBAColours.WHITE);
    const expected = RGBAUtil.linearToSrgb(0.5);
    assert.ok(Math.abs(out.r - expected) < 1e-5);
});

test('getStratifiedSampleOffset provides deterministic centred Halton 3D offsets inside [-0.5, 0.5)', () => {
    assert.deepEqual(getStratifiedSampleOffset(0), { x: 0, y: 0, z: 0 });
    const seen = new Set<string>();
    let hasNegX = false;
    let hasPosX = false;
    for (let i = 1; i < 16; ++i) {
        const tap = getStratifiedSampleOffset(i);
        assert.ok(tap.x >= -0.5 && tap.x < 0.5);
        assert.ok(tap.y >= -0.5 && tap.y < 0.5);
        assert.ok(tap.z >= -0.5 && tap.z < 0.5);
        if (tap.x < 0) hasNegX = true;
        if (tap.x > 0) hasPosX = true;
        seen.add(`${tap.x.toFixed(6)},${tap.y.toFixed(6)},${tap.z.toFixed(6)}`);
    }
    assert.equal(seen.size, 15);
    assert.ok(hasNegX && hasPosX);
});
