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

