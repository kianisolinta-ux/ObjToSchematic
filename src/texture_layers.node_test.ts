import assert from 'node:assert/strict';
import test from 'node:test';

import {
    addPaintTextureLayer,
    compositeTextureLayers,
    createTextureLayerStack,
    deleteTextureLayer,
    duplicateTextureLayer,
    flattenTextureLayers,
    mergeTextureLayerDown,
    moveTextureLayer,
    offsetRgbaWrap,
    pixelizeRgba,
} from './texture_layers';

test('createTextureLayerStack preserves locked base and active transparent paint layer', () => {
    const base = new Uint8ClampedArray([
        200, 100, 50, 255, 200, 100, 50, 255,
        200, 100, 50, 255, 200, 100, 50, 255,
    ]);
    const stack = createTextureLayerStack(2, 2, base);
    assert.equal(stack.layers.length, 2);
    assert.equal(stack.layers[0].locked, true);
    assert.equal(stack.layers[1].locked, false);
    assert.equal(stack.activeLayerId, stack.layers[1].id);

    const comp = compositeTextureLayers(stack.layers, 2, 2);
    assert.equal(comp[0], 200);
    assert.equal(comp[1], 100);
    assert.equal(comp[2], 50);
    assert.equal(comp[3], 255);
});

test('compositeTextureLayers respects visibility, opacity, and multiply/screen blend modes', () => {
    const base = new Uint8ClampedArray([
        200, 200, 200, 255, 200, 200, 200, 255,
        200, 200, 200, 255, 200, 200, 200, 255,
    ]);
    let stack = createTextureLayerStack(2, 2, base);
    // Paint half-intensity red on top layer in Multiply mode
    stack.layers[1].blendMode = 'multiply';
    stack.layers[1].opacity = 1;
    stack.layers[1].pixels.set([128, 255, 255, 255], 0);

    const mult = compositeTextureLayers(stack.layers, 2, 2);
    // Pixel 0: (200/255)*(128/255)*255 ≈ 100
    assert.ok(mult[0] >= 95 && mult[0] <= 105);
    assert.equal(mult[1], 200);

    // Hide top layer -> reveals base pixel 200
    stack.layers[1].visible = false;
    const hidden = compositeTextureLayers(stack.layers, 2, 2);
    assert.equal(hidden[0], 200);

    // Re-show at 50% opacity normal mode
    stack.layers[1].visible = true;
    stack.layers[1].blendMode = 'normal';
    stack.layers[1].opacity = 0.5;
    stack.layers[1].pixels.set([0, 0, 0, 255], 0);
    const half = compositeTextureLayers(stack.layers, 2, 2);
    assert.ok(half[0] >= 95 && half[0] <= 105);

    // Add, duplicate, move, mergeDown, flatten, delete
    stack = addPaintTextureLayer(stack, 'Details');
    assert.equal(stack.layers.length, 3);
    stack = duplicateTextureLayer(stack, stack.activeLayerId);
    assert.equal(stack.layers.length, 4);
    stack = moveTextureLayer(stack, stack.activeLayerId, -1);
    stack = mergeTextureLayerDown(stack, stack.activeLayerId);
    assert.equal(stack.layers.length, 3);
    stack = deleteTextureLayer(stack, stack.layers[2].id);
    assert.equal(stack.layers.length, 2);
    stack = flattenTextureLayers(stack);
    assert.equal(stack.layers.length, 1);
    assert.equal(stack.layers[0].locked, false);
});

test('offsetRgbaWrap wraps pixels toroidally and pixelizeRgba downsamples in blocks', () => {
    const src = new Uint8ClampedArray([
        10, 0, 0, 255, 20, 0, 0, 255,
        30, 0, 0, 255, 40, 0, 0, 255,
    ]);
    const wrapped = offsetRgbaWrap(src, 2, 2, 1, 1);
    // (0,0)=10 moves to (1,1); (1,1)=40 moves to (0,0)
    assert.equal(wrapped[0], 40);
    assert.equal(wrapped[12], 10);

    const pix = pixelizeRgba(src, 2, 2, 2);
    // Average of 10,20,30,40 = 25 across all 4 pixels
    assert.equal(pix[0], 25);
    assert.equal(pix[4], 25);
    assert.equal(pix[8], 25);
    assert.equal(pix[12], 25);
});
