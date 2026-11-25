import assert from 'node:assert/strict';
import test from 'node:test';

import { IStorageLike } from './palette_presets';
import {
    applyFloatingMove,
    applyFloatingResize,
    clampDragFraction,
    clampFloatingBounds,
    clampRadarViewport,
    clampRadarZoom,
    clampToneWeight,
    clientPointToRadarWorld,
    computeDefaultFloatingBounds,
    computeEqualizerFractionFromClientY,
    computeEqualizerLayoutMetrics,
    computePercentagesFromValues,
    computeRadarHandleRenderMetrics,
    computeRadarViewBox,
    createDefaultRadarViewport,
    formatEqualizerValue,
    getPercentageMaxScale,
    isRadarViewportDefault,
    loadDichromeFloatingBounds,
    loadDichromeViewMode,
    panRadarViewportByDelta,
    RADAR_MAX_ZOOM,
    RADAR_MIN_ZOOM,
    redistributePercentages,
    saveDichromeFloatingBounds,
    saveDichromeViewMode,
    zoomRadarViewportAtPoint,
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

test('radar zoom and pan preserve cursor anchor point and clamp bounds', () => {
    const def = createDefaultRadarViewport();
    assert.equal(isRadarViewportDefault(def), true);
    assert.equal(clampRadarZoom(100), RADAR_MAX_ZOOM);
    assert.equal(clampRadarZoom(0.01), RADAR_MIN_ZOOM);

    // Non-square wide SVG box (600x340) preserves xMidYMid meet aspect ratio
    const rectLeft = 100;
    const rectTop = 50;
    const rectWidth = 600;
    const rectHeight = 340;
    const cursorX = 460;
    const cursorY = 180;

    const worldBefore = clientPointToRadarWorld(
        cursorX, cursorY, rectLeft, rectTop, rectWidth, rectHeight, def, 380, 340,
    );
    const zoomedIn = zoomRadarViewportAtPoint(
        def, -120, cursorX, cursorY, rectLeft, rectTop, rectWidth, rectHeight, 380, 340,
    );
    assert.ok(zoomedIn.zoom > 1.15);
    assert.equal(isRadarViewportDefault(zoomedIn), false);

    const worldAfter = clientPointToRadarWorld(
        cursorX, cursorY, rectLeft, rectTop, rectWidth, rectHeight, zoomedIn, 380, 340,
    );
    assert.ok(Math.abs(worldAfter.x - worldBefore.x) < 0.05);
    assert.ok(Math.abs(worldAfter.y - worldBefore.y) < 0.05);

    // Zoom out shrinks scale cleanly
    const zoomedOut = zoomRadarViewportAtPoint(
        def, 180, cursorX, cursorY, rectLeft, rectTop, rectWidth, rectHeight, 380, 340,
    );
    assert.ok(zoomedOut.zoom < 0.9);
    const vbOut = computeRadarViewBox(zoomedOut, 380, 340);
    assert.ok(vbOut.width > 380 && vbOut.height > 340);

    // Pan shifts viewBox in opposite direction so content follows cursor
    const panned = panRadarViewportByDelta(def, 50, -30, 380, 340, 380, 340);
    assert.ok(panned.panX > 0 && panned.panY < 0);
    const clamped = clampRadarViewport({ zoom: 2, panX: 5000, panY: -5000 }, 380, 340);
    assert.ok(clamped.panX <= 380 * 0.9 && clamped.panY >= -340 * 0.9);
});

test('computeEqualizerLayoutMetrics fits any block count without horizontal overflow', () => {
    // Narrow sidebar (296px) with 2 blocks -> full density
    const sparse = computeEqualizerLayoutMetrics(2, 296, 326);
    assert.equal(sparse.density, 'full');
    assert.equal(sparse.showValues, 'full');
    assert.equal(sparse.showIndexLabels, true);

    // Narrow sidebar (296px) with 18 blocks -> tiny/micro, all 18 columns fit strictly inside 296px
    const denseSidebar = computeEqualizerLayoutMetrics(18, 296, 326);
    assert.ok(denseSidebar.density === 'tiny' || denseSidebar.density === 'micro');
    assert.ok(denseSidebar.columnWidth * 18 + denseSidebar.gap * 17 <= 296);
    assert.equal(denseSidebar.showValues, 'hover');

    // Stretched floating window (900px) with 18 blocks -> upgrades back to full density!
    const wideFloating = computeEqualizerLayoutMetrics(18, 900, 480);
    assert.equal(wideFloating.density, 'full');
    assert.equal(wideFloating.showValues, 'full');
    assert.ok(wideFloating.columnWidth >= 36);

    // Extreme block count (48 blocks) in 300px -> micro density, fits strictly inside width
    const extreme = computeEqualizerLayoutMetrics(48, 300, 220);
    assert.equal(extreme.density, 'micro');
    assert.equal(extreme.showIndexLabels, false);
    assert.ok(extreme.columnWidth * 48 + extreme.gap * 47 <= 300);

    assert.equal(formatEqualizerValue('percentages', 0.5, 12.6, 'full'), '12.6%');
    assert.equal(formatEqualizerValue('percentages', 0.5, 12.6, 'compact'), '13%');
    assert.equal(formatEqualizerValue('weights', 0.75, 50, 'compact'), '0.8');
});

test('computeRadarHandleRenderMetrics scales handle radii down in world units on zoom-in and preserves clickable hit target', () => {
    const base = computeRadarHandleRenderMetrics({ zoom: 1, panX: 0, panY: 0 }, 380, 340, 380, 340, false);
    const zoomedIn = computeRadarHandleRenderMetrics({ zoom: 3.5, panX: 0, panY: 0 }, 380, 340, 380, 340, false);
    const largeWindow = computeRadarHandleRenderMetrics({ zoom: 1, panX: 0, panY: 0 }, 380, 340, 760, 680, false);
    const zoomedOut = computeRadarHandleRenderMetrics({ zoom: 0.5, panX: 0, panY: 0 }, 380, 340, 380, 340, false);

    // Zooming in reduces world-space handle, hit, and stroke radii so handles stay crisp and never overlap
    assert.ok(zoomedIn.handleRadius < base.handleRadius * 0.35);
    assert.ok(zoomedIn.hitRadius < base.hitRadius * 0.35);
    assert.ok(zoomedIn.axisHitWidth < base.axisHitWidth * 0.35);
    assert.ok(zoomedIn.lineHaloWidth < base.lineHaloWidth * 0.35);
    assert.ok(zoomedIn.polygonStrokeWidth < base.polygonStrokeWidth * 0.35);
    assert.ok(zoomedIn.handleHoverRadius > zoomedIn.handleRadius);

    // Enlarging the floating window keeps handle screen pixel size constant (half in world space at 2x box)
    assert.ok(Math.abs(largeWindow.handleRadius - base.handleRadius * 0.5) < 0.05);

    // Zooming out keeps clickable hit target generous (>= 11 screen px -> >= 22 world units at 0.5x zoom)
    assert.ok(zoomedOut.hitRadius >= 22);
    assert.ok(zoomedOut.axisHitWidth >= 20);

    // Screen-pixel handle radius scales down both when zoomed in and zoomed out
    assert.ok(zoomedIn.handleRadius * 3.5 < base.handleRadius);
    assert.ok(zoomedOut.handleRadius * 0.5 < base.handleRadius);
});
