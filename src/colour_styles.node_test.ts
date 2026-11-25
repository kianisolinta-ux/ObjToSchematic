import assert from 'node:assert/strict';
import test from 'node:test';

import { filterBlockNamesByMaterialStyle } from './block_styles';
import { RGBAUtil } from './colour';
import {
    applyColourGrading,
    edgeContourDistance,
    getAtkinsonOffsets,
    huePreserveDistance,
} from './colour_styles';

test('applyColourGrading returns identical colour when no offsets/style active', () => {
    const base = { r: 0.4, g: 0.7, b: 0.25, a: 1.0 };
    const res = applyColourGrading(base, {
        brightnessOffset: 0,
        saturationOffset: 0,
        contrastOffset: 0,
        temperatureOffset: 0,
        colourStyle: 'none',
    });
    assert.ok(Math.abs(res.r - base.r) < 1e-6);
    assert.ok(Math.abs(res.g - base.g) < 1e-6);
    assert.ok(Math.abs(res.b - base.b) < 1e-6);
});

test('applyColourGrading contrast and temperature adjust luminance and warmth cleanly', () => {
    const bright = { r: 0.8, g: 0.8, b: 0.8, a: 1.0 };
    const highContrast = applyColourGrading(bright, { contrastOffset: 40 });
    assert.ok(highContrast.r > bright.r);

    const neutral = { r: 0.5, g: 0.5, b: 0.5, a: 1.0 };
    const warm = applyColourGrading(neutral, { temperatureOffset: 40 });
    const cool = applyColourGrading(neutral, { temperatureOffset: -40 });
    assert.ok(warm.r > warm.b);
    assert.ok(cool.b > cool.r);
});

test('applyColourGrading visual styles produce distinct expected tonal effects', () => {
    const red = { r: 0.72, g: 0.28, b: 0.24, a: 1.0 };

    const pastel = applyColourGrading(red, { colourStyle: 'pastel', colourStyleStrength: 1.0 });
    const [LBase] = RGBAUtil.toOklab(red);
    const [LPastel] = RGBAUtil.toOklab(pastel);
    assert.ok(LPastel > LBase);

    const sepia = applyColourGrading(red, { colourStyle: 'sepia', colourStyleStrength: 1.0 });
    assert.ok(sepia.r >= sepia.g && sepia.g >= sepia.b);

    const noir = applyColourGrading({ r: 0.9, g: 0.2, b: 0.1, a: 1.0 }, {
        colourStyle: 'cool-noir',
        colourStyleStrength: 1.0,
    });
    assert.ok(noir.b > noir.g);

    const celBands = new Set<number>();
    for (let i = 1; i <= 9; ++i) {
        const v = i / 10;
        const graded = applyColourGrading({ r: v, g: v, b: v, a: 1.0 }, {
            colourStyle: 'cel-shaded',
            colourStyleStrength: 1.0,
        });
        celBands.add(Math.round(RGBAUtil.toOklab(graded)[0] * 10));
    }
    assert.ok(celBands.size <= 7);
});

test('huePreserveDistance penalizes off-hue matches more heavily than darker same-hue matches', () => {
    const skin = { r: 0.9, g: 0.7, b: 0.58, a: 1.0 };
    const darkerWarm = { r: 0.72, g: 0.52, b: 0.42, a: 1.0 };
    const greenishSameL = { r: 0.65, g: 0.80, b: 0.58, a: 1.0 };

    const dSameHue = huePreserveDistance(skin, darkerWarm);
    const dOffHue = huePreserveDistance(skin, greenishSameL);
    assert.ok(dSameHue < dOffHue);
});

test('edgeContourDistance sharpens lightness contrast on silhouette faces', () => {
    const mid = { r: 0.55, g: 0.55, b: 0.55, a: 1.0 };
    const lighter = { r: 0.75, g: 0.75, b: 0.75, a: 1.0 };
    const flatDist = edgeContourDistance(mid, lighter, 1);
    const silhouetteDist = edgeContourDistance(mid, lighter, 4);
    assert.ok(silhouetteDist > flatDist);
});

test('getAtkinsonOffsets distributes exact 6/8 total weight across 6 forward neighbours', () => {
    const pos = getAtkinsonOffsets(1);
    const neg = getAtkinsonOffsets(-1);
    assert.equal(pos.length, 6);
    assert.equal(neg.length, 6);
    const sum = pos.reduce((acc, item) => acc + item.weight, 0);
    assert.ok(Math.abs(sum - 0.75) < 1e-9);
    assert.equal(pos[0].dx, 1);
    assert.equal(neg[0].dx, -1);
});

test('filterBlockNamesByMaterialStyle filters noisy/translucent/organic palettes with safe fallback', () => {
    const palette = [
        'minecraft:white_concrete',
        'minecraft:terracotta',
        'minecraft:oak_planks',
        'minecraft:oak_leaves',
        'minecraft:iron_ore',
        'minecraft:diamond_block',
        'minecraft:gold_block',
        'minecraft:chiseled_stone_bricks',
        'minecraft:white_stained_glass',
        'minecraft:moss_block',
    ];

    const smooth = filterBlockNamesByMaterialStyle(palette, 'smooth-only');
    assert.equal(smooth.includes('minecraft:white_concrete'), true);
    assert.equal(smooth.includes('minecraft:terracotta'), true);
    assert.equal(smooth.includes('minecraft:iron_ore'), false);
    assert.equal(smooth.includes('minecraft:oak_leaves'), false);
    assert.equal(smooth.includes('minecraft:diamond_block'), false);
    assert.equal(smooth.includes('minecraft:gold_block'), false);
    assert.equal(smooth.includes('minecraft:chiseled_stone_bricks'), false);

    const noGlass = filterBlockNamesByMaterialStyle(palette, 'no-translucent');
    assert.equal(noGlass.includes('minecraft:white_stained_glass'), false);
    assert.equal(noGlass.includes('minecraft:white_concrete'), true);

    const organic = filterBlockNamesByMaterialStyle(palette, 'organic-nature');
    assert.equal(organic.includes('minecraft:moss_block'), true);
    assert.equal(organic.includes('minecraft:white_concrete'), false);

    // Fallback when filter matches nothing
    const glassOnly = ['minecraft:glass'];
    assert.deepEqual(filterBlockNamesByMaterialStyle(glassOnly, 'no-translucent'), glassOnly);
});
