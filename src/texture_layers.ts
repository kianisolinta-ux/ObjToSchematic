export type TextureBlendMode = 'normal' | 'multiply' | 'screen' | 'overlay' | 'darken' | 'lighten';

export interface TextureLayer {
    id: string;
    name: string;
    visible: boolean;
    locked: boolean;
    opacity: number; // 0..1
    blendMode: TextureBlendMode;
    pixels: Uint8ClampedArray;
    undoStack: Uint8ClampedArray[];
}

export interface TextureLayerStack {
    width: number;
    height: number;
    layers: TextureLayer[];
    activeLayerId: string;
    nextSeq: number;
}

function makeTexLayerId(prefix: string, seq: number): string {
    return `${prefix}-${seq}-${Math.random().toString(36).slice(2, 6)}`;
}

export function createTextureLayerStack(
    width: number,
    height: number,
    basePixels: Uint8ClampedArray,
): TextureLayerStack {
    const baseLayer: TextureLayer = {
        id: makeTexLayerId('base', 1),
        name: 'Original Base',
        visible: true,
        locked: true,
        opacity: 1,
        blendMode: 'normal',
        pixels: new Uint8ClampedArray(basePixels),
        undoStack: [],
    };
    const paintLayer: TextureLayer = {
        id: makeTexLayerId('paint', 2),
        name: 'Paint 1',
        visible: true,
        locked: false,
        opacity: 1,
        blendMode: 'normal',
        pixels: new Uint8ClampedArray(width * height * 4),
        undoStack: [],
    };
    return {
        width,
        height,
        layers: [baseLayer, paintLayer],
        activeLayerId: paintLayer.id,
        nextSeq: 3,
    };
}

export function getActiveTextureLayer(stack: TextureLayerStack): TextureLayer | undefined {
    return stack.layers.find((l) => l.id === stack.activeLayerId);
}

export function addPaintTextureLayer(stack: TextureLayerStack, name?: string): TextureLayerStack {
    const seq = stack.nextSeq;
    const layer: TextureLayer = {
        id: makeTexLayerId('paint', seq),
        name: name?.trim() || `Paint ${seq - 1}`,
        visible: true,
        locked: false,
        opacity: 1,
        blendMode: 'normal',
        pixels: new Uint8ClampedArray(stack.width * stack.height * 4),
        undoStack: [],
    };
    const activeIdx = stack.layers.findIndex((l) => l.id === stack.activeLayerId);
    const layers = [...stack.layers];
    const insertAt = activeIdx >= 0 ? activeIdx + 1 : layers.length;
    layers.splice(insertAt, 0, layer);
    return {
        ...stack,
        layers,
        activeLayerId: layer.id,
        nextSeq: seq + 1,
    };
}

export function duplicateTextureLayer(stack: TextureLayerStack, layerId: string): TextureLayerStack {
    const idx = stack.layers.findIndex((l) => l.id === layerId);
    if (idx < 0) return stack;
    const src = stack.layers[idx];
    const seq = stack.nextSeq;
    const copy: TextureLayer = {
        id: makeTexLayerId('copy', seq),
        name: `${src.name} Copy`,
        visible: src.visible,
        locked: false,
        opacity: src.opacity,
        blendMode: src.blendMode,
        pixels: new Uint8ClampedArray(src.pixels),
        undoStack: [],
    };
    const layers = [...stack.layers];
    layers.splice(idx + 1, 0, copy);
    return {
        ...stack,
        layers,
        activeLayerId: copy.id,
        nextSeq: seq + 1,
    };
}

export function deleteTextureLayer(stack: TextureLayerStack, layerId: string): TextureLayerStack {
    if (stack.layers.length <= 1) return stack;
    const idx = stack.layers.findIndex((l) => l.id === layerId);
    if (idx < 0) return stack;
    const layers = stack.layers.filter((l) => l.id !== layerId);
    const nextActive = stack.activeLayerId === layerId ?
        layers[Math.max(0, idx - 1)].id :
        stack.activeLayerId;
    return {
        ...stack,
        layers,
        activeLayerId: nextActive,
    };
}

export function moveTextureLayer(stack: TextureLayerStack, layerId: string, delta: -1 | 1): TextureLayerStack {
    const idx = stack.layers.findIndex((l) => l.id === layerId);
    if (idx < 0) return stack;
    const targetIdx = idx + delta;
    if (targetIdx < 0 || targetIdx >= stack.layers.length) return stack;
    const layers = [...stack.layers];
    const [item] = layers.splice(idx, 1);
    layers.splice(targetIdx, 0, item);
    return {
        ...stack,
        layers,
    };
}

function blendChannel(bg: number, fg: number, mode: TextureBlendMode): number {
    switch (mode) {
        case 'multiply':
            return bg * fg;
        case 'screen':
            return 1 - (1 - bg) * (1 - fg);
        case 'overlay':
            return bg < 0.5 ? 2 * bg * fg : 1 - 2 * (1 - bg) * (1 - fg);
        case 'darken':
            return Math.min(bg, fg);
        case 'lighten':
            return Math.max(bg, fg);
        case 'normal':
        default:
            return fg;
    }
}

export function compositeTextureLayers(
    layers: TextureLayer[],
    width: number,
    height: number,
): Uint8ClampedArray {
    const len = width * height * 4;
    const out = new Uint8ClampedArray(len);

    for (let li = 0; li < layers.length; ++li) {
        const layer = layers[li];
        if (!layer.visible || layer.opacity <= 0) continue;
        const src = layer.pixels;
        const layerOpacity = Math.max(0, Math.min(1, layer.opacity));
        const mode = layer.blendMode;

        for (let i = 0; i < len; i += 4) {
            const sa = (src[i + 3] / 255) * layerOpacity;
            if (sa <= 1e-6) continue;

            const sr = src[i] / 255;
            const sg = src[i + 1] / 255;
            const sb = src[i + 2] / 255;

            const da = out[i + 3] / 255;
            if (da <= 1e-6) {
                out[i] = Math.round(sr * 255);
                out[i + 1] = Math.round(sg * 255);
                out[i + 2] = Math.round(sb * 255);
                out[i + 3] = Math.round(sa * 255);
                continue;
            }

            const dr = out[i] / 255;
            const dg = out[i + 1] / 255;
            const db = out[i + 2] / 255;

            const br = blendChannel(dr, sr, mode);
            const bg = blendChannel(dg, sg, mode);
            const bb = blendChannel(db, sb, mode);

            // Standard Porter-Duff source-over compositing with blended foreground
            const outA = sa + da * (1 - sa);
            const invOutA = 1 / Math.max(1e-6, outA);
            const mixR = (br * sa * da + sr * sa * (1 - da) + dr * da * (1 - sa)) * invOutA;
            const mixG = (bg * sa * da + sg * sa * (1 - da) + dg * da * (1 - sa)) * invOutA;
            const mixB = (bb * sa * da + sb * sa * (1 - da) + db * da * (1 - sa)) * invOutA;

            out[i] = Math.max(0, Math.min(255, Math.round(mixR * 255)));
            out[i + 1] = Math.max(0, Math.min(255, Math.round(mixG * 255)));
            out[i + 2] = Math.max(0, Math.min(255, Math.round(mixB * 255)));
            out[i + 3] = Math.max(0, Math.min(255, Math.round(outA * 255)));
        }
    }

    return out;
}

export function mergeTextureLayerDown(stack: TextureLayerStack, layerId: string): TextureLayerStack {
    const idx = stack.layers.findIndex((l) => l.id === layerId);
    if (idx <= 0) return stack;

    const lower = stack.layers[idx - 1];
    const upper = stack.layers[idx];
    const mergedPixels = compositeTextureLayers([
        { ...lower, visible: true },
        { ...upper, visible: true },
    ], stack.width, stack.height);

    const nextLower: TextureLayer = {
        ...lower,
        opacity: 1,
        blendMode: 'normal',
        pixels: mergedPixels,
        undoStack: [...lower.undoStack, new Uint8ClampedArray(lower.pixels)].slice(-15),
    };

    const layers = [...stack.layers];
    layers.splice(idx - 1, 2, nextLower);

    return {
        ...stack,
        layers,
        activeLayerId: nextLower.id,
    };
}

export function flattenTextureLayers(stack: TextureLayerStack): TextureLayerStack {
    const flat = compositeTextureLayers(stack.layers, stack.width, stack.height);
    const seq = stack.nextSeq;
    const flatLayer: TextureLayer = {
        id: makeTexLayerId('flat', seq),
        name: 'Flattened',
        visible: true,
        locked: false,
        opacity: 1,
        blendMode: 'normal',
        pixels: flat,
        undoStack: [],
    };
    return {
        ...stack,
        layers: [flatLayer],
        activeLayerId: flatLayer.id,
        nextSeq: seq + 1,
    };
}

export function offsetRgbaWrap(
    src: Uint8ClampedArray,
    width: number,
    height: number,
    dx: number,
    dy: number,
): Uint8ClampedArray {
    const out = new Uint8ClampedArray(src.length);
    const shiftX = ((Math.round(dx) % width) + width) % width;
    const shiftY = ((Math.round(dy) % height) + height) % height;

    for (let y = 0; y < height; ++y) {
        const ny = (y + shiftY) % height;
        for (let x = 0; x < width; ++x) {
            const nx = (x + shiftX) % width;
            const sIdx = (y * width + x) * 4;
            const dIdx = (ny * width + nx) * 4;
            out[dIdx] = src[sIdx];
            out[dIdx + 1] = src[sIdx + 1];
            out[dIdx + 2] = src[sIdx + 2];
            out[dIdx + 3] = src[sIdx + 3];
        }
    }
    return out;
}

export function pixelizeRgba(
    src: Uint8ClampedArray,
    width: number,
    height: number,
    blockSize: number,
): Uint8ClampedArray {
    const size = Math.max(1, Math.round(blockSize));
    if (size <= 1) return new Uint8ClampedArray(src);
    const out = new Uint8ClampedArray(src.length);

    for (let by = 0; by < height; by += size) {
        const yEnd = Math.min(height, by + size);
        for (let bx = 0; bx < width; bx += size) {
            const xEnd = Math.min(width, bx + size);
            let sr = 0;
            let sg = 0;
            let sb = 0;
            let sa = 0;
            let cnt = 0;

            for (let y = by; y < yEnd; ++y) {
                for (let x = bx; x < xEnd; ++x) {
                    const idx = (y * width + x) * 4;
                    sr += src[idx];
                    sg += src[idx + 1];
                    sb += src[idx + 2];
                    sa += src[idx + 3];
                    cnt++;
                }
            }

            const ar = Math.round(sr / cnt);
            const ag = Math.round(sg / cnt);
            const ab = Math.round(sb / cnt);
            const aa = Math.round(sa / cnt);

            for (let y = by; y < yEnd; ++y) {
                for (let x = bx; x < xEnd; ++x) {
                    const idx = (y * width + x) * 4;
                    out[idx] = ar;
                    out[idx + 1] = ag;
                    out[idx + 2] = ab;
                    out[idx + 3] = aa;
                }
            }
        }
    }
    return out;
}
