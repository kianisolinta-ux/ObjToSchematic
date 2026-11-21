import assert from 'node:assert/strict';
import test from 'node:test';

import { RGBAUtil } from './colour';

test('RGBAUtil.lerpLinear interpolates in physical linear light instead of naive gamma space', () => {
    const midGray = RGBAUtil.lerpLinear(
        { r: 0, g: 0, b: 0, a: 1 },
        { r: 1, g: 1, b: 1, a: 1 },
        0.5,
    );
    assert.ok(midGray.r > 0.72 && midGray.r < 0.75, `expected ~0.735, got ${midGray.r}`);
    assert.equal(midGray.a, 1);

    const yellowMix = RGBAUtil.lerpLinear(
        { r: 1, g: 0, b: 0, a: 1 },
        { r: 0, g: 1, b: 0, a: 1 },
        0.5,
    );
    assert.ok(yellowMix.r > 0.72 && yellowMix.g > 0.72, 'red + green linear midpoint stays luminous yellow');
});

test('RGBAUtil.averageLinearAlphaWeighted prevents transparent black fringe halos', () => {
    const pureGreenEdge = RGBAUtil.averageLinearAlphaWeighted(
        { r: 0, g: 1, b: 0, a: 1 },
        { r: 0, g: 0, b: 0, a: 0 },
        { r: 1, g: 0, b: 1, a: 0 },
    );
    assert.equal(pureGreenEdge.r, 0);
    assert.ok(pureGreenEdge.g > 0.99, `expected pure green chroma, got g=${pureGreenEdge.g}`);
    assert.equal(pureGreenEdge.b, 0);
    assert.ok(Math.abs(pureGreenEdge.a - 1 / 3) < 1e-6);

    const emptyAlpha = RGBAUtil.averageLinearAlphaWeighted(
        { r: 1, g: 0, b: 0, a: 0 },
        { r: 0, g: 0, b: 1, a: 0 },
    );
    assert.deepEqual(emptyAlpha, { r: 0, g: 0, b: 0, a: 0 });
});
