import assert from 'node:assert/strict';
import test from 'node:test';

import { IStorageLike } from './palette_presets';
import {
    applyFloatingMove,
    applyFloatingResize,
    clampDragFraction,
    clampFloatingBounds,
    clampToneWeight,
    computeDefaultFloatingBounds,
    computeEqualizerFractionFromClientY,
    computePercentagesFromValues,
    getPercentageMaxScale,
    loadDichromeFloatingBounds,
    loadDichromeViewMode,
    redistributePercentages,
    saveDichromeFloatingBounds,
    saveDichromeViewMode,
} from './radial_tone_helpers';

function createMemoryStorage(): IStorageLike {
    const map = new Map<string, string>();
    return {
        getItem: (key: string) => map.get(key) ?? null,
        setItem: (key: string, value: string) => {
            map.set(key, value);
        },
    };
}

test('loadDichromeViewMode & saveDichromeViewMode persist radar/equalizer preference', () => {
    const storage = createMemoryStorage();
    assert.equal(loadDichromeViewMode(storage), 'radar');
    assert.equal(saveDichromeViewMode('equalizer', storage), true);
    assert.equal(loadDichromeViewMode(storage), 'equalizer');
    assert.equal(saveDichromeViewMode('radar', storage), true);
    assert.equal(loadDichromeViewMode(storage), 'radar');
});

test('computeEqualizerFractionFromClientY maps vertical track coords to snapped [0..1] fraction', () => {
    // Track top=100, height=200 (bottom=300)
    assert.equal(computeEqualizerFractionFromClientY(100, 100, 200), 1.0);
    assert.equal(computeEqualizerFractionFromClientY(102, 100, 200), 1.0); // snaps >=0.98
    assert.equal(computeEqualizerFractionFromClientY(200, 100, 200), 0.5);
    assert.equal(computeEqualizerFractionFromClientY(298, 100, 200), 0);   // snaps <=0.02
    assert.equal(computeEqualizerFractionFromClientY(350, 100, 200), 0);
});

test('clampDragFraction & clampToneWeight handle edge inputs', () => {
    assert.equal(clampDragFraction(-0.5), 0);
    assert.equal(clampDragFraction(1.4), 1);
    assert.equal(clampDragFraction(0.55), 0.55);
    assert.equal(clampToneWeight(0.334), 0.33);
    assert.equal(clampToneWeight(2), 1);
});

test('redistributePercentages keeps sum = 100 across N >= 2 blocks', () => {
    const two = redistributePercentages([50, 50], 0, 72.4);
    assert.deepEqual(two, [72.4, 27.6]);

    const four = redistributePercentages([25, 25, 25, 25], 1, 55);
    assert.equal(four[1], 55);
    const total = Math.round(four.reduce((a, b) => a + b, 0) * 10) / 10;
    assert.equal(total, 100);

    const zeroOthers = redistributePercentages([25, 25, 25], 0, 100);
    assert.deepEqual(zeroOthers, [100, 0, 0]);
});

test('computePercentagesFromValues & getPercentageMaxScale compute valid scales', () => {
    const res = computePercentagesFromValues('weights', [1, 1, 2]);
    assert.deepEqual(res.percentages, [25, 25, 50]);

    assert.equal(getPercentageMaxScale([50, 50], 2), 100);
    assert.equal(getPercentageMaxScale([25, 25, 50], 3), 60);
});

test('floating window clamp, move, and 8-direction resize keep pinned opposite edges and viewport bounds', () => {
    const def = computeDefaultFloatingBounds(1440, 900);
    assert.equal(def.width, 560);
    assert.equal(def.height, 440);
    assert.ok(def.left >= 8 && def.left + def.width <= 1432);

    const movedOut = applyFloatingMove({ left: 400, top: 200, width: 500, height: 400 }, 2000, -500, 1440, 900);
    assert.equal(movedOut.top, 8);
    assert.equal(movedOut.left, 1440 - 500 - 8);

    const base = { left: 400, top: 200, width: 500, height: 400 };

    // SE expand
    const se = applyFloatingResize(base, 'se', 120, 80, 1440, 900);
    assert.deepEqual(se, { left: 400, top: 200, width: 620, height: 480 });

    // NW shrink past min clamps at minWidth/minHeight while keeping bottom-right pinned (900, 600)
    const nwClamp = applyFloatingResize(base, 'nw', 400, 300, 1440, 900);
    assert.equal(nwClamp.width, 300);
    assert.equal(nwClamp.height, 280);
    assert.equal(nwClamp.left + nwClamp.width, 900);
    assert.equal(nwClamp.top + nwClamp.height, 600);

    // W expand leftwards past margin keeps right edge pinned and clamps left at 8
    const wClamp = applyFloatingResize(base, 'w', -1000, 0, 1440, 900);
    assert.equal(wClamp.left, 8);
    assert.equal(wClamp.left + wClamp.width, 900);

    // NE diagonal resize
    const ne = applyFloatingResize(base, 'ne', 100, -50, 1440, 900);
    assert.deepEqual(ne, { left: 400, top: 150, width: 600, height: 450 });

    // SW diagonal resize
    const sw = applyFloatingResize(base, 'sw', -50, 70, 1440, 900);
    assert.deepEqual(sw, { left: 350, top: 200, width: 550, height: 470 });

    const clamped = clampFloatingBounds({ left: 1200, top: 800, width: 500, height: 400 }, 1000, 700);
    assert.equal(clamped.left + clamped.width, 992);
    assert.equal(clamped.top + clamped.height, 692);

    const storage = createMemoryStorage();
    assert.equal(saveDichromeFloatingBounds(se, storage), true);
    assert.deepEqual(loadDichromeFloatingBounds(1440, 900, storage), se);
});

