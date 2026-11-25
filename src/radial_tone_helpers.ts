import { getDefaultStorage, IStorageLike } from './palette_presets';

export type TRadialViewMode = 'radar' | 'equalizer';

export const DICHROME_VIEW_MODE_STORAGE_KEY = 'ots_dichrome_view_mode_v1';

export function loadDichromeViewMode(storage: IStorageLike | null = getDefaultStorage()): TRadialViewMode {
    if (!storage) {
        return 'radar';
    }
    try {
        const raw = storage.getItem(DICHROME_VIEW_MODE_STORAGE_KEY);
        return raw === 'equalizer' ? 'equalizer' : 'radar';
    } catch {
        return 'radar';
    }
}

export function saveDichromeViewMode(
    mode: TRadialViewMode,
    storage: IStorageLike | null = getDefaultStorage(),
): boolean {
    if (!storage) {
        return false;
    }
    try {
        storage.setItem(DICHROME_VIEW_MODE_STORAGE_KEY, mode);
        return true;
    } catch {
        return false;
    }
}

export function clampDragFraction(rawFrac: number): number {
    if (!Number.isFinite(rawFrac)) {
        return 0;
    }
    if (rawFrac <= 0.02) {
        return 0;
    }
    if (rawFrac >= 0.98) {
        return 1.0;
    }
    return Math.max(0, Math.min(1.0, rawFrac));
}

export function clampToneWeight(weight: number): number {
    if (!Number.isFinite(weight)) {
        return 0;
    }
    return Math.max(0, Math.min(1.0, Math.round(weight * 100) / 100));
}

export function computeEqualizerFractionFromClientY(
    clientY: number,
    trackTop: number,
    trackHeight: number,
): number {
    if (!Number.isFinite(trackHeight) || trackHeight <= 0) {
        return 0;
    }
    const rawFrac = (trackTop + trackHeight - clientY) / trackHeight;
    return clampDragFraction(rawFrac);
}

export function getPercentageMaxScale(percentages: readonly number[], blockCount: number): number {
    const n = Math.max(2, blockCount);
    if (n === 2) {
        return 100;
    }
    const baseline = (100 / n) * 1.75;
    const maxVal = Math.max(...percentages, baseline);
    return Math.min(100, Math.max(30, Math.ceil(maxVal / 5) * 5));
}

export function computePercentagesFromValues(
    mode: 'weights' | 'percentages',
    rawValues: readonly number[],
): { values: number[]; percentages: number[] } {
    const values = [...rawValues];
    const n = Math.max(2, values.length);

    if (mode === 'weights') {
        const sum = values.reduce((a, b) => a + Math.max(0, b), 0);
        if (sum <= 0) {
            return {
                values,
                percentages: Array.from({ length: n }, () => Math.round((100 / n) * 10) / 10),
            };
        }
        let roundedTotal = 0;
        const p = values.map((v, i) => {
            const frac = Math.max(0, v) / sum;
            const rounded = Math.round(frac * 1000) / 10;
            if (i < n - 1) roundedTotal += rounded;
            return rounded;
        });
        p[n - 1] = Math.max(0, Math.round((100 - roundedTotal) * 10) / 10);
        return { values, percentages: p };
    }

    let sum = values.reduce((a, b) => a + Math.max(0, b), 0);
    if (sum <= 0) {
        for (let i = 0; i < n; ++i) {
            values[i] = Math.round((100 / n) * 10) / 10;
        }
        sum = 100;
    }
    let roundedTotal = 0;
    const p = values.map((v, i) => {
        const rounded = Math.round((Math.max(0, v) / sum) * 1000) / 10;
        if (i < n - 1) roundedTotal += rounded;
        return rounded;
    });
    p[n - 1] = Math.max(0, Math.round((100 - roundedTotal) * 10) / 10);
    return { values, percentages: p };
}

export function redistributePercentages(
    rawValues: readonly number[],
    index: number,
    targetPercent: number,
): number[] {
    const values = [...rawValues];
    const n = values.length;
    if (index < 0 || index >= n) {
        return values;
    }

    const clampedTarget = Math.max(0, Math.min(100, Math.round(targetPercent * 10) / 10));
    if (n === 2) {
        values[index] = clampedTarget;
        const otherIndex = index === 0 ? 1 : 0;
        values[otherIndex] = Math.round((100 - clampedTarget) * 10) / 10;
        return values;
    }

    values[index] = clampedTarget;
    const targetOthers = Math.max(0, 100 - clampedTarget);
    const otherIndices = Array.from({ length: n }, (_, i) => i).filter((i) => i !== index);
    const sumOthers = otherIndices.reduce((sum, i) => sum + Math.max(0, values[i] ?? 0), 0);

    if (targetOthers <= 0) {
        otherIndices.forEach((i) => {
            values[i] = 0;
        });
    } else if (sumOthers <= 0) {
        const share = Math.round((targetOthers / otherIndices.length) * 10) / 10;
        let allocated = 0;
        otherIndices.forEach((i, idx) => {
            if (idx < otherIndices.length - 1) {
                values[i] = share;
                allocated += share;
            } else {
                values[i] = Math.max(0, Math.round((targetOthers - allocated) * 10) / 10);
            }
        });
    } else {
        let allocated = 0;
        otherIndices.forEach((i, idx) => {
            const ratio = Math.max(0, values[i] ?? 0) / sumOthers;
            const rounded = Math.round(ratio * targetOthers * 10) / 10;
            if (idx < otherIndices.length - 1) {
                values[i] = rounded;
                allocated += rounded;
            } else {
                values[i] = Math.max(0, Math.round((targetOthers - allocated) * 10) / 10);
            }
        });
    }

    return values;
}

export interface TRadialFloatingBounds {
    left: number;
    top: number;
    width: number;
    height: number;
}

export type TResizeEdge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

export const DICHROME_FLOATING_BOUNDS_STORAGE_KEY = 'ots_dichrome_floating_bounds_v1';
export const FLOATING_WINDOW_MARGIN = 8;
export const FLOATING_WINDOW_MIN_WIDTH = 300;
export const FLOATING_WINDOW_MIN_HEIGHT = 280;

export function clampFloatingBounds(
    bounds: TRadialFloatingBounds,
    viewportWidth: number,
    viewportHeight: number,
    minWidth: number = FLOATING_WINDOW_MIN_WIDTH,
    minHeight: number = FLOATING_WINDOW_MIN_HEIGHT,
): TRadialFloatingBounds {
    const safeVw = Number.isFinite(viewportWidth) && viewportWidth > 0 ? viewportWidth : 1280;
    const safeVh = Number.isFinite(viewportHeight) && viewportHeight > 0 ? viewportHeight : 800;
    const maxW = Math.max(160, safeVw - FLOATING_WINDOW_MARGIN * 2);
    const maxH = Math.max(160, safeVh - FLOATING_WINDOW_MARGIN * 2);
    const effMinW = Math.min(minWidth, maxW);
    const effMinH = Math.min(minHeight, maxH);

    const width = Math.round(Math.max(effMinW, Math.min(maxW, Number.isFinite(bounds.width) ? bounds.width : 540)));
    const height = Math.round(Math.max(effMinH, Math.min(maxH, Number.isFinite(bounds.height) ? bounds.height : 440)));

    const maxLeft = Math.max(FLOATING_WINDOW_MARGIN, safeVw - width - FLOATING_WINDOW_MARGIN);
    const maxTop = Math.max(FLOATING_WINDOW_MARGIN, safeVh - height - FLOATING_WINDOW_MARGIN);

    const left = Math.round(Math.max(FLOATING_WINDOW_MARGIN, Math.min(maxLeft, Number.isFinite(bounds.left) ? bounds.left : FLOATING_WINDOW_MARGIN)));
    const top = Math.round(Math.max(FLOATING_WINDOW_MARGIN, Math.min(maxTop, Number.isFinite(bounds.top) ? bounds.top : FLOATING_WINDOW_MARGIN)));

    return { left, top, width, height };
}

export function computeDefaultFloatingBounds(
    viewportWidth: number,
    viewportHeight: number,
    preferredWidth: number = 560,
    preferredHeight: number = 440,
): TRadialFloatingBounds {
    const safeVw = Number.isFinite(viewportWidth) && viewportWidth > 0 ? viewportWidth : 1280;
    const safeVh = Number.isFinite(viewportHeight) && viewportHeight > 0 ? viewportHeight : 800;
    const sidebarHint = safeVw > 980 ? 390 : 24;
    const width = Math.min(preferredWidth, Math.max(FLOATING_WINDOW_MIN_WIDTH, safeVw - sidebarHint - 32));
    const height = Math.min(preferredHeight, Math.max(FLOATING_WINDOW_MIN_HEIGHT, safeVh - 80));
    const left = safeVw > 980 ? Math.min(sidebarHint + 24, safeVw - width - FLOATING_WINDOW_MARGIN) : Math.round((safeVw - width) / 2);
    const top = Math.round((safeVh - height) / 2);
    return clampFloatingBounds({ left, top, width, height }, safeVw, safeVh);
}

export function applyFloatingMove(
    startBounds: TRadialFloatingBounds,
    dx: number,
    dy: number,
    viewportWidth: number,
    viewportHeight: number,
): TRadialFloatingBounds {
    return clampFloatingBounds(
        {
            left: startBounds.left + dx,
            top: startBounds.top + dy,
            width: startBounds.width,
            height: startBounds.height,
        },
        viewportWidth,
        viewportHeight,
    );
}

export function applyFloatingResize(
    startBounds: TRadialFloatingBounds,
    edge: TResizeEdge,
    dx: number,
    dy: number,
    viewportWidth: number,
    viewportHeight: number,
    minWidth: number = FLOATING_WINDOW_MIN_WIDTH,
    minHeight: number = FLOATING_WINDOW_MIN_HEIGHT,
): TRadialFloatingBounds {
    const safeVw = Number.isFinite(viewportWidth) && viewportWidth > 0 ? viewportWidth : 1280;
    const safeVh = Number.isFinite(viewportHeight) && viewportHeight > 0 ? viewportHeight : 800;
    const effMinW = Math.min(minWidth, Math.max(160, safeVw - FLOATING_WINDOW_MARGIN * 2));
    const effMinH = Math.min(minHeight, Math.max(160, safeVh - FLOATING_WINDOW_MARGIN * 2));

    let left = startBounds.left;
    let top = startBounds.top;
    let right = startBounds.left + startBounds.width;
    let bottom = startBounds.top + startBounds.height;

    if (edge.includes('w')) {
        const minLeft = FLOATING_WINDOW_MARGIN;
        const maxLeft = right - effMinW;
        left = Math.max(minLeft, Math.min(maxLeft, startBounds.left + dx));
    } else if (edge.includes('e')) {
        const minRight = left + effMinW;
        const maxRight = safeVw - FLOATING_WINDOW_MARGIN;
        right = Math.max(minRight, Math.min(maxRight, right + dx));
    }

    if (edge.includes('n')) {
        const minTop = FLOATING_WINDOW_MARGIN;
        const maxTop = bottom - effMinH;
        top = Math.max(minTop, Math.min(maxTop, startBounds.top + dy));
    } else if (edge.includes('s')) {
        const minBottom = top + effMinH;
        const maxBottom = safeVh - FLOATING_WINDOW_MARGIN;
        bottom = Math.max(minBottom, Math.min(maxBottom, bottom + dy));
    }

    return clampFloatingBounds(
        {
            left,
            top,
            width: right - left,
            height: bottom - top,
        },
        safeVw,
        safeVh,
        minWidth,
        minHeight,
    );
}

export function loadDichromeFloatingBounds(
    viewportWidth: number,
    viewportHeight: number,
    storage: IStorageLike | null = getDefaultStorage(),
): TRadialFloatingBounds {
    if (storage) {
        try {
            const raw = storage.getItem(DICHROME_FLOATING_BOUNDS_STORAGE_KEY);
            if (raw) {
                const parsed = JSON.parse(raw) as Partial<TRadialFloatingBounds>;
                if (
                    typeof parsed.left === 'number' &&
                    typeof parsed.top === 'number' &&
                    typeof parsed.width === 'number' &&
                    typeof parsed.height === 'number'
                ) {
                    return clampFloatingBounds(
                        {
                            left: parsed.left,
                            top: parsed.top,
                            width: parsed.width,
                            height: parsed.height,
                        },
                        viewportWidth,
                        viewportHeight,
                    );
                }
            }
        } catch {
            // ignore storage errors
        }
    }
    return computeDefaultFloatingBounds(viewportWidth, viewportHeight);
}

export function saveDichromeFloatingBounds(
    bounds: TRadialFloatingBounds,
    storage: IStorageLike | null = getDefaultStorage(),
): boolean {
    if (!storage) {
        return false;
    }
    try {
        storage.setItem(DICHROME_FLOATING_BOUNDS_STORAGE_KEY, JSON.stringify(bounds));
        return true;
    } catch {
        return false;
    }
}

export interface TRadarViewport {
    zoom: number;
    panX: number;
    panY: number;
}

export interface TRadarViewBox {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface TRadarRenderedMetrics {
    viewBox: TRadarViewBox;
    scale: number;
    offsetX: number;
    offsetY: number;
}

export const RADAR_MIN_ZOOM = 0.45;
export const RADAR_MAX_ZOOM = 5.0;

export function createDefaultRadarViewport(): TRadarViewport {
    return { zoom: 1, panX: 0, panY: 0 };
}

export function clampRadarZoom(zoom: number): number {
    if (!Number.isFinite(zoom)) {
        return 1;
    }
    return Math.max(RADAR_MIN_ZOOM, Math.min(RADAR_MAX_ZOOM, Math.round(zoom * 1000) / 1000));
}

export function clampRadarViewport(
    viewport: TRadarViewport,
    viewWidth: number,
    viewHeight: number,
): TRadarViewport {
    const safeW = Number.isFinite(viewWidth) && viewWidth > 0 ? viewWidth : 380;
    const safeH = Number.isFinite(viewHeight) && viewHeight > 0 ? viewHeight : 340;
    const zoom = clampRadarZoom(viewport.zoom);
    const maxPanX = safeW * 0.9;
    const maxPanY = safeH * 0.9;
    const panX = Number.isFinite(viewport.panX) ? Math.max(-maxPanX, Math.min(maxPanX, viewport.panX)) : 0;
    const panY = Number.isFinite(viewport.panY) ? Math.max(-maxPanY, Math.min(maxPanY, viewport.panY)) : 0;
    return { zoom, panX, panY };
}

export function isRadarViewportDefault(viewport: TRadarViewport): boolean {
    return Math.abs(viewport.zoom - 1) < 0.01 &&
        Math.abs(viewport.panX) < 0.5 &&
        Math.abs(viewport.panY) < 0.5;
}

export function computeRadarViewBox(
    viewport: TRadarViewport,
    viewWidth: number,
    viewHeight: number,
): TRadarViewBox {
    const safeW = Number.isFinite(viewWidth) && viewWidth > 0 ? viewWidth : 380;
    const safeH = Number.isFinite(viewHeight) && viewHeight > 0 ? viewHeight : 340;
    const clamped = clampRadarViewport(viewport, safeW, safeH);
    const width = safeW / clamped.zoom;
    const height = safeH / clamped.zoom;
    const x = (safeW - width) / 2 - clamped.panX;
    const y = (safeH - height) / 2 - clamped.panY;
    return { x, y, width, height };
}

export function computeRadarRenderedMetrics(
    viewport: TRadarViewport,
    viewWidth: number,
    viewHeight: number,
    rectWidth: number,
    rectHeight: number,
): TRadarRenderedMetrics {
    const viewBox = computeRadarViewBox(viewport, viewWidth, viewHeight);
    if (!Number.isFinite(rectWidth) || !Number.isFinite(rectHeight) || rectWidth <= 0 || rectHeight <= 0) {
        return { viewBox, scale: 1, offsetX: 0, offsetY: 0 };
    }
    const vbAspect = viewBox.width / viewBox.height;
    const rectAspect = rectWidth / rectHeight;
    if (rectAspect > vbAspect) {
        const scale = viewBox.height / rectHeight;
        const renderedWidth = viewBox.width / scale;
        return {
            viewBox,
            scale,
            offsetX: (rectWidth - renderedWidth) / 2,
            offsetY: 0,
        };
    }
    const scale = viewBox.width / rectWidth;
    const renderedHeight = viewBox.height / scale;
    return {
        viewBox,
        scale,
        offsetX: 0,
        offsetY: (rectHeight - renderedHeight) / 2,
    };
}

export function clientPointToRadarWorld(
    clientX: number,
    clientY: number,
    rectLeft: number,
    rectTop: number,
    rectWidth: number,
    rectHeight: number,
    viewport: TRadarViewport,
    viewWidth: number,
    viewHeight: number,
): { x: number; y: number } {
    const m = computeRadarRenderedMetrics(viewport, viewWidth, viewHeight, rectWidth, rectHeight);
    return {
        x: m.viewBox.x + (clientX - rectLeft - m.offsetX) * m.scale,
        y: m.viewBox.y + (clientY - rectTop - m.offsetY) * m.scale,
    };
}

export function zoomRadarViewportAtPoint(
    viewport: TRadarViewport,
    deltaY: number,
    clientX: number,
    clientY: number,
    rectLeft: number,
    rectTop: number,
    rectWidth: number,
    rectHeight: number,
    viewWidth: number,
    viewHeight: number,
): TRadarViewport {
    if (!Number.isFinite(deltaY) || deltaY === 0 || rectWidth <= 0 || rectHeight <= 0) {
        return clampRadarViewport(viewport, viewWidth, viewHeight);
    }
    const clampedDelta = Math.max(-240, Math.min(240, deltaY));
    const factor = Math.exp(-clampedDelta * 0.0018);
    const nextZoom = clampRadarZoom(viewport.zoom * factor);
    if (Math.abs(nextZoom - viewport.zoom) < 1e-6) {
        return clampRadarViewport(viewport, viewWidth, viewHeight);
    }

    const worldPt = clientPointToRadarWorld(
        clientX, clientY, rectLeft, rectTop, rectWidth, rectHeight, viewport, viewWidth, viewHeight,
    );

    const nextBase: TRadarViewport = { zoom: nextZoom, panX: 0, panY: 0 };
    const nextMetrics = computeRadarRenderedMetrics(nextBase, viewWidth, viewHeight, rectWidth, rectHeight);
    const nextPanX = nextMetrics.viewBox.x + (clientX - rectLeft - nextMetrics.offsetX) * nextMetrics.scale - worldPt.x;
    const nextPanY = nextMetrics.viewBox.y + (clientY - rectTop - nextMetrics.offsetY) * nextMetrics.scale - worldPt.y;

    return clampRadarViewport({ zoom: nextZoom, panX: nextPanX, panY: nextPanY }, viewWidth, viewHeight);
}

export function panRadarViewportByDelta(
    startViewport: TRadarViewport,
    dxPx: number,
    dyPx: number,
    rectWidth: number,
    rectHeight: number,
    viewWidth: number,
    viewHeight: number,
): TRadarViewport {
    const metrics = computeRadarRenderedMetrics(startViewport, viewWidth, viewHeight, rectWidth, rectHeight);
    return clampRadarViewport(
        {
            zoom: startViewport.zoom,
            panX: startViewport.panX + dxPx * metrics.scale,
            panY: startViewport.panY + dyPx * metrics.scale,
        },
        viewWidth,
        viewHeight,
    );
}

export interface TRadarHandleRenderMetrics {
    handleRadius: number;
    handleHoverRadius: number;
    hitRadius: number;
    handleStrokeWidth: number;
    axisHitWidth: number;
    swatchRadius: number;
    swatchStrokeWidth: number;
    lineHaloWidth: number;
    lineWidth: number;
    lineCoreWidth: number;
    polygonStrokeWidth: number;
    axisStrokeWidth: number;
    gridMinorStrokeWidth: number;
    gridMajorStrokeWidth: number;
    centerDotRadius: number;
}

export function computeRadarHandleRenderMetrics(
    viewport: TRadarViewport,
    viewWidth: number,
    viewHeight: number,
    rectWidth: number,
    rectHeight: number,
    isTwoBlock: boolean,
): TRadarHandleRenderMetrics {
    const m = computeRadarRenderedMetrics(viewport, viewWidth, viewHeight, rectWidth, rectHeight);
    const zoom = clampRadarZoom(viewport.zoom);
    const safeScale = Number.isFinite(m.scale) && m.scale > 0 ? m.scale : 1;

    // Keep handles and data strokes compact when zoomed in or out so handles stay crisp,
    // proportional to the diagram, and easy to grab individually without overlapping spokes.
    const zoomVisualFactor = zoom >= 1 ?
        1 / (1 + (zoom - 1) * 0.18) :
        Math.pow(zoom, 0.58);
    const baseScreenRadius = (isTwoBlock ? 7.0 : 6.5) * zoomVisualFactor;
    const hoverScreenRadius = baseScreenRadius + Math.max(1.0, 1.5 * zoomVisualFactor);
    const hitScreenRadius = zoom >= 1 ?
        Math.max(9.5, 14 / (1 + (zoom - 1) * 0.14)) :
        Math.max(11, 14 * Math.pow(zoom, 0.35));
    const strokeScreenWidth = zoom >= 1 ?
        Math.max(1.2, 2.0 / (1 + (zoom - 1) * 0.1)) :
        Math.max(1.2, 1.8 * Math.pow(zoom, 0.35));
    const axisHitScreenWidth = zoom >= 1 ?
        Math.max(10, 15 / (1 + (zoom - 1) * 0.12)) :
        Math.max(10.5, 14 * Math.pow(zoom, 0.35));
    const swatchScaleFactor = zoom >= 1 ? Math.max(0.68, 1 / (1 + (zoom - 1) * 0.1)) : Math.pow(zoom, 0.45);
    const swatchScreenRadius = (isTwoBlock ? 4.8 : 4.4) * swatchScaleFactor;

    const lineScaleFactor = zoom >= 1 ? 1 / (1 + (zoom - 1) * 0.18) : Math.pow(zoom, 0.52);
    const gridScaleFactor = zoom >= 1 ? 1 / (1 + (zoom - 1) * 0.12) : Math.pow(zoom, 0.4);

    return {
        handleRadius: Number((baseScreenRadius * safeScale).toFixed(2)),
        handleHoverRadius: Number((hoverScreenRadius * safeScale).toFixed(2)),
        hitRadius: Number((hitScreenRadius * safeScale).toFixed(2)),
        handleStrokeWidth: Number((strokeScreenWidth * safeScale).toFixed(2)),
        axisHitWidth: Number((axisHitScreenWidth * safeScale).toFixed(2)),
        swatchRadius: Number((swatchScreenRadius * safeScale).toFixed(2)),
        swatchStrokeWidth: Number((1.2 * safeScale).toFixed(2)),
        lineHaloWidth: Number((10.5 * lineScaleFactor * safeScale).toFixed(2)),
        lineWidth: Number((4.4 * lineScaleFactor * safeScale).toFixed(2)),
        lineCoreWidth: Number((1.8 * lineScaleFactor * safeScale).toFixed(2)),
        polygonStrokeWidth: Number((2.4 * lineScaleFactor * safeScale).toFixed(2)),
        axisStrokeWidth: Number((1.3 * gridScaleFactor * safeScale).toFixed(2)),
        gridMinorStrokeWidth: Number((1.0 * gridScaleFactor * safeScale).toFixed(2)),
        gridMajorStrokeWidth: Number((1.5 * gridScaleFactor * safeScale).toFixed(2)),
        centerDotRadius: Number((2.8 * zoomVisualFactor * safeScale).toFixed(2)),
    };
}

export type TEqualizerDensity = 'full' | 'compact' | 'tiny' | 'micro';
export type TEqualizerValueMode = 'full' | 'compact' | 'hover';

export interface TEqualizerLayoutMetrics {
    density: TEqualizerDensity;
    columnWidth: number;
    gap: number;
    trackWidth: number;
    thumbWidth: number;
    thumbHeight: number;
    swatchSize: number;
    valueFontSize: number;
    labelFontSize: number;
    showIndexLabels: boolean;
    showValues: TEqualizerValueMode;
    scaleHintWidth: number;
    wrapperPadTop: number;
}

export function computeEqualizerLayoutMetrics(
    blockCount: number,
    containerWidth: number,
    containerHeight: number = 320,
): TEqualizerLayoutMetrics {
    const n = Math.max(2, Math.floor(Number.isFinite(blockCount) ? blockCount : 2));
    const safeW = Number.isFinite(containerWidth) && containerWidth > 0 ? containerWidth : 296;
    const safeH = Number.isFinite(containerHeight) && containerHeight > 0 ? containerHeight : 320;

    const scaleHintWidth = safeW >= 250 ? 26 : 20;
    const horizontalChrome = 12 + scaleHintWidth + 6;
    const columnsAvailWidth = Math.max(60, safeW - horizontalChrome);

    const rawPerCol = columnsAvailWidth / n;
    let gap = rawPerCol >= 42 ? 6 : rawPerCol >= 28 ? 4 : rawPerCol >= 18 ? 3 : rawPerCol >= 11 ? 2 : 1;
    if (n > 1 && gap * (n - 1) > columnsAvailWidth * 0.3) {
        gap = Math.max(0, Math.floor((columnsAvailWidth * 0.28) / (n - 1)));
    }

    const columnWidth = Math.max(2, (columnsAvailWidth - gap * Math.max(0, n - 1)) / n);
    const wrapperPadTop = safeH < 250 ? 30 : 36;

    if (columnWidth >= 36) {
        return {
            density: 'full',
            columnWidth,
            gap,
            trackWidth: 14,
            thumbWidth: 18,
            thumbHeight: 12,
            swatchSize: 16,
            valueFontSize: 10,
            labelFontSize: 9.5,
            showIndexLabels: true,
            showValues: 'full',
            scaleHintWidth,
            wrapperPadTop,
        };
    }
    if (columnWidth >= 24) {
        const trackWidth = Math.max(9, Math.min(13, Math.round(columnWidth * 0.42)));
        const thumbWidth = Math.max(trackWidth + 2, Math.min(Math.floor(columnWidth - 2), 16));
        return {
            density: 'compact',
            columnWidth,
            gap,
            trackWidth,
            thumbWidth,
            thumbHeight: 10,
            swatchSize: Math.max(11, Math.min(15, Math.floor(columnWidth * 0.5))),
            valueFontSize: 8.5,
            labelFontSize: 8.5,
            showIndexLabels: true,
            showValues: 'compact',
            scaleHintWidth,
            wrapperPadTop,
        };
    }
    if (columnWidth >= 14) {
        const trackWidth = Math.max(6, Math.min(10, Math.round(columnWidth * 0.52)));
        const thumbWidth = Math.max(trackWidth + 2, Math.min(Math.floor(columnWidth - 1), 13));
        return {
            density: 'tiny',
            columnWidth,
            gap,
            trackWidth,
            thumbWidth,
            thumbHeight: 9,
            swatchSize: Math.max(8, Math.min(12, Math.floor(columnWidth - 2))),
            valueFontSize: 9,
            labelFontSize: 7.5,
            showIndexLabels: true,
            showValues: 'hover',
            scaleHintWidth,
            wrapperPadTop,
        };
    }

    const trackWidth = Math.max(4, Math.min(7, Math.floor(columnWidth * 0.72)));
    const thumbWidth = Math.max(trackWidth, Math.min(9, Math.floor(columnWidth)));
    return {
        density: 'micro',
        columnWidth,
        gap,
        trackWidth,
        thumbWidth,
        thumbHeight: 7,
        swatchSize: Math.max(5, Math.min(9, Math.floor(columnWidth - 1))),
        valueFontSize: 9,
        labelFontSize: 7,
        showIndexLabels: false,
        showValues: 'hover',
        scaleHintWidth,
        wrapperPadTop,
    };
}

export function formatEqualizerValue(
    mode: 'weights' | 'percentages',
    weightVal: number,
    pctVal: number,
    showValues: TEqualizerValueMode,
): string {
    if (showValues === 'compact') {
        return mode === 'weights' ? weightVal.toFixed(1) : `${Math.round(pctVal)}%`;
    }
    return mode === 'weights' ? weightVal.toFixed(2) : `${pctVal.toFixed(1)}%`;
}


