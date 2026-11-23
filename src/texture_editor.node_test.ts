import assert from 'node:assert/strict';
import test from 'node:test';

import {
    adjustTexturePixels,
    autoLevelsRgba,
    createSolidRgbaBuffer,
    flipRgbaHorizontal,
    flipRgbaVertical,
    floodFillRgba,
    paintBrushStroke,
    rotateRgba90CW,
    uvToPixelCoord,
} from './texture_editor';

test('uvToPixelCoord applies V-flip matching Texture.getRGBA', () => {
    const topLeft = uvToPixelCoord(0.0, 1.0, 16, 16, 'clamp');
    assert.deepEqual(topLeft, { x: 0, y: 0 });

    const bottomRight = uvToPixelCoord(1.0, 0.0, 16, 16, 'clamp');
    assert.deepEqual(bottomRight, { x: 15, y: 15 });

    const wrapped = uvToPixelCoord(1.25, 0.75, 16, 16, 'repeat');
    assert.equal(wrapped.x, 4);
    assert.equal(wrapped.y, 4);
});

test('paintBrushStroke draws continuous line across pixels and erases cleanly', () => {
    const pixels = createSolidRgbaBuffer(32, 32, { r: 0, g: 0, b: 0, a: 255 });
    paintBrushStroke(pixels, 32, 32, 2, 16, 20, 16, 2, { r: 255, g: 0, b: 0, a: 255 }, 1.0, 'paint');

    const midIdx = (16 * 32 + 11) * 4;
    assert.equal(pixels[midIdx], 255);
    assert.equal(pixels[midIdx + 1], 0);
    assert.equal(pixels[midIdx + 2], 0);

    paintBrushStroke(pixels, 32, 32, 11, 16, 11, 16, 1.5, { r: 0, g: 0, b: 0, a: 255 }, 1.0, 'erase');
    assert.equal(pixels[midIdx + 3], 0);
});

test('floodFillRgba fills bounded region without crossing wall colour', () => {
    const pixels = createSolidRgbaBuffer(8, 8, { r: 20, g: 20, b: 20, a: 255 });
    for (let y = 0; y < 8; ++y) {
        const idx = (y * 8 + 4) * 4;
        pixels[idx] = 255;
        pixels[idx + 1] = 255;
        pixels[idx + 2] = 255;
    }

    const filled = floodFillRgba(pixels, 8, 8, 1, 1, { r: 0, g: 200, b: 100, a: 255 }, 15);
    assert.equal(filled, 4 * 8);
    assert.equal(pixels[(0 * 8 + 5) * 4], 20);
});

test('adjustTexturePixels handles brightness, saturation=0 grayscale, gamma, warmth, sharpen, blur, and posterize', () => {
    const src = new Uint8ClampedArray([
        200, 100, 50, 255,
        40, 80, 160, 200,
    ]);

    const gray = adjustTexturePixels(src, 2, 1, {
        brightness: 0,
        contrast: 0,
        saturation: -100,
        hue: 0,
        posterize: 0,
    });
    assert.equal(gray[0], gray[1]);
    assert.equal(gray[1], gray[2]);
    assert.equal(gray[3], 255);
    assert.equal(gray[7], 200);

    const poster = adjustTexturePixels(src, 2, 1, {
        brightness: 20,
        contrast: 10,
        saturation: 0,
        hue: 0,
        posterize: 2,
    });
    assert.ok(poster[0] === 0 || poster[0] === 255);

    const lifted = adjustTexturePixels(
        new Uint8ClampedArray([100, 100, 100, 255]),
        1,
        1,
        { brightness: 0, contrast: 0, saturation: 0, hue: 0, posterize: 0, gamma: 60 },
    );
    assert.ok(lifted[0] > 100);

    const warmed = adjustTexturePixels(
        new Uint8ClampedArray([120, 120, 120, 255]),
        1,
        1,
        { brightness: 0, contrast: 0, saturation: 0, hue: 0, posterize: 0, warmth: 50 },
    );
    assert.ok(warmed[0] > warmed[2]);

    const grid = new Uint8ClampedArray([
        0, 0, 0, 255, 255, 255, 255, 255,
        255, 255, 255, 255, 0, 0, 0, 255,
    ]);
    const blurred = adjustTexturePixels(grid, 2, 2, {
        brightness: 0, contrast: 0, saturation: 0, hue: 0, posterize: 0, blur: 100,
    });
    assert.ok(blurred[0] > 0 && blurred[0] < 255);

    const centerSpike = new Uint8ClampedArray([
        100, 100, 100, 255, 100, 100, 100, 255, 100, 100, 100, 255,
        100, 100, 100, 255, 140, 140, 140, 255, 100, 100, 100, 255,
        100, 100, 100, 255, 100, 100, 100, 255, 100, 100, 100, 255,
    ]);
    const sharpened = adjustTexturePixels(centerSpike, 3, 3, {
        brightness: 0, contrast: 0, saturation: 0, hue: 0, posterize: 0, sharpen: 80,
    });
    const centerIdx = (1 * 3 + 1) * 4;
    assert.ok(sharpened[centerIdx] > 140);
});

test('autoLevelsRgba stretches low-contrast channel histogram and flip/rotate transform pixel buffers cleanly', () => {
    const lowContrast = new Uint8ClampedArray([
        80, 90, 100, 255,
        140, 150, 160, 255,
    ]);
    const leveled = autoLevelsRgba(lowContrast, 2, 1, 0);
    assert.equal(leveled[0], 0);
    assert.equal(leveled[4], 255);

    const uniform = createSolidRgbaBuffer(4, 4, { r: 185, g: 210, b: 65, a: 255 });
    const uniformLeveled = autoLevelsRgba(uniform, 4, 4, 0.01);
    assert.equal(uniformLeveled[0], 185);
    assert.equal(uniformLeveled[1], 210);
    assert.equal(uniformLeveled[2], 65);
    assert.equal(uniformLeveled[3], 255);

    const img2x2 = new Uint8ClampedArray([
        10, 0, 0, 255, 20, 0, 0, 255,
        30, 0, 0, 255, 40, 0, 0, 255,
    ]);
    const fh = flipRgbaHorizontal(img2x2, 2, 2);
    assert.equal(fh[0], 20);
    assert.equal(fh[4], 10);

    const fv = flipRgbaVertical(img2x2, 2, 2);
    assert.equal(fv[0], 30);
    assert.equal(fv[8], 10);

    const rot = rotateRgba90CW(img2x2, 2, 2);
    assert.equal(rot.width, 2);
    assert.equal(rot.height, 2);
    assert.equal(rot.pixels[0], 30);
    assert.equal(rot.pixels[4], 10);
});
