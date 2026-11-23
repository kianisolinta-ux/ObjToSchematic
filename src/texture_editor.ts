export interface PixelRGBA {
    r: number;
    g: number;
    b: number;
    a: number;
}

export interface TextureFilterParams {
    brightness: number; // -100..100
    contrast: number; // -100..100
    saturation: number; // -100..100
    hue: number; // -180..180 degrees
    posterize: number; // 0 = off, 2..32 = levels per channel
    gamma?: number; // -100..100 (midtone lift/crush)
    warmth?: number; // -100..100 (cool-warm shift)
    sharpen?: number; // 0..100
    blur?: number; // 0..100
}

function wrapCoord(v: number): number {
    if (Number.isInteger(v)) {
        return v > 0.5 ? 1.0 : 0.0;
    }
    const frac = Math.abs(v) - Math.floor(Math.abs(v));
    return v < 0.0 ? 1.0 - frac : frac;
}

/**
 * Matches `Texture.getRGBA` + `texture_tri_fragment.fs` V-flip mapping:
 * texcoord (0, 1) is top-left (y=0), texcoord (1, 0) is bottom-right (y=height-1).
 */
export function uvToPixelCoord(
    u: number,
    v: number,
    width: number,
    height: number,
    extension: 'clamp' | 'repeat' = 'clamp',
): { x: number; y: number } {
    const safeU = extension === 'repeat' ? wrapCoord(u) : Math.max(0, Math.min(1, u));
    const safeV = extension === 'repeat' ? wrapCoord(v) : Math.max(0, Math.min(1, v));
    const flippedV = 1.0 - safeV;
    const x = Math.max(0, Math.min(width - 1, Math.floor(safeU * width)));
    const y = Math.max(0, Math.min(height - 1, Math.floor(flippedV * height)));
    return { x, y };
}

export function createSolidRgbaBuffer(width: number, height: number, rgba: PixelRGBA): Uint8ClampedArray {
    const data = new Uint8ClampedArray(width * height * 4);
    const r = Math.max(0, Math.min(255, Math.round(rgba.r)));
    const g = Math.max(0, Math.min(255, Math.round(rgba.g)));
    const b = Math.max(0, Math.min(255, Math.round(rgba.b)));
    const a = Math.max(0, Math.min(255, Math.round(rgba.a)));
    for (let i = 0; i < data.length; i += 4) {
        data[i] = r;
        data[i + 1] = g;
        data[i + 2] = b;
        data[i + 3] = a;
    }
    return data;
}

export function paintBrushDab(
    pixels: Uint8ClampedArray,
    width: number,
    height: number,
    cx: number,
    cy: number,
    radius: number,
    rgba: PixelRGBA,
    hardness: number,
    mode: 'paint' | 'erase',
): void {
    const r = Math.max(0.5, radius);
    const minX = Math.max(0, Math.floor(cx - r));
    const maxX = Math.min(width - 1, Math.ceil(cx + r));
    const minY = Math.max(0, Math.floor(cy - r));
    const maxY = Math.min(height - 1, Math.ceil(cy + r));
    const hard = Math.max(0, Math.min(1, hardness));
    const srcAlpha = Math.max(0, Math.min(1, rgba.a / 255));

    for (let y = minY; y <= maxY; ++y) {
        for (let x = minX; x <= maxX; ++x) {
            const dist = Math.hypot(x - cx, y - cy);
            if (dist > r) continue;

            let falloff = 1.0;
            if (r > 1.0 && hard < 0.999) {
                const normDist = dist / r;
                if (normDist > hard) {
                    falloff = 1.0 - (normDist - hard) / Math.max(1e-5, 1.0 - hard);
                }
            }
            const effectiveAlpha = srcAlpha * falloff;
            const idx = (y * width + x) * 4;

            if (mode === 'erase') {
                pixels[idx + 3] = Math.max(0, Math.round(pixels[idx + 3] * (1 - effectiveAlpha)));
            } else {
                const dstAlpha = pixels[idx + 3] / 255;
                const outAlpha = effectiveAlpha + dstAlpha * (1 - effectiveAlpha);
                if (outAlpha > 1e-6) {
                    const invOut = 1 / outAlpha;
                    pixels[idx] = Math.round((rgba.r * effectiveAlpha + pixels[idx] * dstAlpha * (1 - effectiveAlpha)) * invOut);
                    pixels[idx + 1] = Math.round((rgba.g * effectiveAlpha + pixels[idx + 1] * dstAlpha * (1 - effectiveAlpha)) * invOut);
                    pixels[idx + 2] = Math.round((rgba.b * effectiveAlpha + pixels[idx + 2] * dstAlpha * (1 - effectiveAlpha)) * invOut);
                    pixels[idx + 3] = Math.round(outAlpha * 255);
                }
            }
        }
    }
}

export function paintBrushStroke(
    pixels: Uint8ClampedArray,
    width: number,
    height: number,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    radius: number,
    rgba: PixelRGBA,
    hardness: number,
    mode: 'paint' | 'erase',
): void {
    const dist = Math.hypot(x1 - x0, y1 - y0);
    const step = Math.max(1, radius * 0.35);
    const steps = Math.max(1, Math.ceil(dist / step));
    for (let i = 0; i <= steps; ++i) {
        const t = i / steps;
        paintBrushDab(
            pixels,
            width,
            height,
            x0 + (x1 - x0) * t,
            y0 + (y1 - y0) * t,
            radius,
            rgba,
            hardness,
            mode,
        );
    }
}

export function floodFillRgba(
    pixels: Uint8ClampedArray,
    width: number,
    height: number,
    startX: number,
    startY: number,
    fillColour: PixelRGBA,
    tolerance = 18,
): number {
    const sx = Math.floor(startX);
    const sy = Math.floor(startY);
    if (sx < 0 || sx >= width || sy < 0 || sy >= height) return 0;

    const startIdx = (sy * width + sx) * 4;
    const sr = pixels[startIdx];
    const sg = pixels[startIdx + 1];
    const sb = pixels[startIdx + 2];
    const sa = pixels[startIdx + 3];

    if (
        Math.abs(sr - fillColour.r) <= 1 &&
        Math.abs(sg - fillColour.g) <= 1 &&
        Math.abs(sb - fillColour.b) <= 1 &&
        Math.abs(sa - fillColour.a) <= 1
    ) {
        return 0;
    }

    const tolSq = tolerance * tolerance * 3;
    const visited = new Uint8Array(width * height);
    const queue = new Int32Array(width * height);
    let head = 0;
    let tail = 0;

    const startPos = sy * width + sx;
    queue[tail++] = startPos;
    visited[startPos] = 1;

    let filled = 0;
    while (head < tail) {
        const p = queue[head++];
        const px = p % width;
        const py = (p - px) / width;
        const idx = p * 4;

        pixels[idx] = fillColour.r;
        pixels[idx + 1] = fillColour.g;
        pixels[idx + 2] = fillColour.b;
        pixels[idx + 3] = fillColour.a;
        ++filled;

        const neighbors = [
            px > 0 ? p - 1 : -1,
            px + 1 < width ? p + 1 : -1,
            py > 0 ? p - width : -1,
            py + 1 < height ? p + width : -1,
        ];

        for (let i = 0; i < 4; ++i) {
            const np = neighbors[i];
            if (np < 0 || visited[np]) continue;
            const nIdx = np * 4;
            const dr = pixels[nIdx] - sr;
            const dg = pixels[nIdx + 1] - sg;
            const db = pixels[nIdx + 2] - sb;
            const da = pixels[nIdx + 3] - sa;
            if (dr * dr + dg * dg + db * db <= tolSq && Math.abs(da) <= Math.max(tolerance, 24)) {
                visited[np] = 1;
                queue[tail++] = np;
            }
        }
    }

    return filled;
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) * 0.5;
    if (max === min) {
        return [0, 0, l];
    }
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h = 0;
    switch (max) {
        case r:
            h = (g - b) / d + (g < b ? 6 : 0);
            break;
        case g:
            h = (b - r) / d + 2;
            break;
        case b:
            h = (r - g) / d + 4;
            break;
    }
    return [h / 6, s, l];
}

function hue2rgb(p: number, q: number, t: number): number {
    let wrapped = t;
    if (wrapped < 0) wrapped += 1;
    if (wrapped > 1) wrapped -= 1;
    if (wrapped < 1 / 6) return p + (q - p) * 6 * wrapped;
    if (wrapped < 0.5) return q;
    if (wrapped < 2 / 3) return p + (q - p) * (2 / 3 - wrapped) * 6;
    return p;
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
    if (s <= 1e-6) {
        return [l, l, l];
    }
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    return [
        hue2rgb(p, q, h + 1 / 3),
        hue2rgb(p, q, h),
        hue2rgb(p, q, h - 1 / 3),
    ];
}

function applyGaussianBlurPass(
    src: Uint8ClampedArray,
    width: number,
    height: number,
    amount: number,
): Uint8ClampedArray {
    if (width < 2 || height < 2 || amount <= 0) {
        return src;
    }
    const alpha = Math.max(0, Math.min(1, amount));
    const out = new Uint8ClampedArray(src.length);
    for (let y = 0; y < height; ++y) {
        const y0 = Math.max(0, y - 1);
        const y2 = Math.min(height - 1, y + 1);
        for (let x = 0; x < width; ++x) {
            const x0 = Math.max(0, x - 1);
            const x2 = Math.min(width - 1, x + 1);
            let sr = 0;
            let sg = 0;
            let sb = 0;
            const pts = [
                [x0, y0, 1], [x, y0, 2], [x2, y0, 1],
                [x0, y, 2], [x, y, 4], [x2, y, 2],
                [x0, y2, 1], [x, y2, 2], [x2, y2, 1],
            ];
            for (let k = 0; k < 9; ++k) {
                const idx = (pts[k][1] * width + pts[k][0]) * 4;
                const w = pts[k][2];
                sr += src[idx] * w;
                sg += src[idx + 1] * w;
                sb += src[idx + 2] * w;
            }
            const cIdx = (y * width + x) * 4;
            out[cIdx] = Math.round(src[cIdx] * (1 - alpha) + (sr / 16) * alpha);
            out[cIdx + 1] = Math.round(src[cIdx + 1] * (1 - alpha) + (sg / 16) * alpha);
            out[cIdx + 2] = Math.round(src[cIdx + 2] * (1 - alpha) + (sb / 16) * alpha);
            out[cIdx + 3] = src[cIdx + 3];
        }
    }
    return out;
}

function applySharpenPass(
    src: Uint8ClampedArray,
    width: number,
    height: number,
    amount: number,
): Uint8ClampedArray {
    if (width < 2 || height < 2 || amount <= 0) {
        return src;
    }
    const strength = Math.max(0, Math.min(1.5, amount * 1.2));
    const out = new Uint8ClampedArray(src.length);
    for (let y = 0; y < height; ++y) {
        const yUp = Math.max(0, y - 1);
        const yDn = Math.min(height - 1, y + 1);
        for (let x = 0; x < width; ++x) {
            const xLt = Math.max(0, x - 1);
            const xRt = Math.min(width - 1, x + 1);

            const cIdx = (y * width + x) * 4;
            const uIdx = (yUp * width + x) * 4;
            const dIdx = (yDn * width + x) * 4;
            const lIdx = (y * width + xLt) * 4;
            const rIdx = (y * width + xRt) * 4;

            for (let ch = 0; ch < 3; ++ch) {
                const center = src[cIdx + ch];
                const avgNeighbor = (src[uIdx + ch] + src[dIdx + ch] + src[lIdx + ch] + src[rIdx + ch]) * 0.25;
                const val = center + (center - avgNeighbor) * strength;
                out[cIdx + ch] = Math.max(0, Math.min(255, Math.round(val)));
            }
            out[cIdx + 3] = src[cIdx + 3];
        }
    }
    return out;
}

export function adjustTexturePixels(
    src: Uint8ClampedArray,
    width: number,
    height: number,
    params: TextureFilterParams,
): Uint8ClampedArray {
    let working = src;
    const blurAmt = (params.blur ?? 0) / 100;
    if (blurAmt > 0) {
        working = applyGaussianBlurPass(working, width, height, blurAmt);
    }
    const sharpAmt = (params.sharpen ?? 0) / 100;
    if (sharpAmt > 0) {
        working = applySharpenPass(working, width, height, sharpAmt);
    }

    const out = new Uint8ClampedArray(width * height * 4);
    const brightnessDelta = (params.brightness / 100) * 255;
    const cVal = params.contrast;
    const contrastFactor = cVal === 0 ? 1 : (259 * (cVal + 255)) / (255 * (259 - cVal));
    const satShift = params.saturation / 100;
    const hueShift = params.hue / 360;
    const posterizeLevels = params.posterize >= 2 ? Math.round(params.posterize) : 0;
    const gammaVal = params.gamma ?? 0;
    const gammaExp = gammaVal === 0 ? 1 : Math.pow(2, -gammaVal / 100);
    const warmthShift = (params.warmth ?? 0) * 0.65;

    for (let i = 0; i < working.length; i += 4) {
        let r = working[i];
        let g = working[i + 1];
        let b = working[i + 2];
        const a = working[i + 3];

        if (brightnessDelta !== 0) {
            r += brightnessDelta;
            g += brightnessDelta;
            b += brightnessDelta;
        }
        if (warmthShift !== 0) {
            r += warmthShift;
            b -= warmthShift;
        }
        if (contrastFactor !== 1) {
            r = contrastFactor * (r - 128) + 128;
            g = contrastFactor * (g - 128) + 128;
            b = contrastFactor * (b - 128) + 128;
        }

        let nr = Math.max(0, Math.min(1, r / 255));
        let ng = Math.max(0, Math.min(1, g / 255));
        let nb = Math.max(0, Math.min(1, b / 255));

        if (gammaExp !== 1) {
            nr = Math.pow(nr, gammaExp);
            ng = Math.pow(ng, gammaExp);
            nb = Math.pow(nb, gammaExp);
        }

        if (satShift !== 0 || hueShift !== 0) {
            let [h, s, l] = rgbToHsl(nr, ng, nb);
            if (hueShift !== 0) {
                h = (h + hueShift) % 1;
                if (h < 0) h += 1;
            }
            if (satShift > 0) {
                s = Math.min(1, s + (1 - s) * satShift);
            } else if (satShift < 0) {
                s = Math.max(0, s * (1 + satShift));
            }
            [nr, ng, nb] = hslToRgb(h, s, l);
        }

        if (posterizeLevels >= 2) {
            const denom = posterizeLevels - 1;
            nr = Math.round(nr * denom) / denom;
            ng = Math.round(ng * denom) / denom;
            nb = Math.round(nb * denom) / denom;
        }

        out[i] = Math.max(0, Math.min(255, Math.round(nr * 255)));
        out[i + 1] = Math.max(0, Math.min(255, Math.round(ng * 255)));
        out[i + 2] = Math.max(0, Math.min(255, Math.round(nb * 255)));
        out[i + 3] = a;
    }

    return out;
}

export function autoLevelsRgba(
    src: Uint8ClampedArray,
    width: number,
    height: number,
    clipFraction = 0.01,
): Uint8ClampedArray {
    const totalPixels = width * height;
    const histR = new Uint32Array(256);
    const histG = new Uint32Array(256);
    const histB = new Uint32Array(256);
    let opaqueCount = 0;

    for (let i = 0; i < totalPixels * 4; i += 4) {
        if (src[i + 3] === 0) continue;
        histR[src[i]]++;
        histG[src[i + 1]]++;
        histB[src[i + 2]]++;
        opaqueCount++;
    }

    if (opaqueCount === 0) {
        return new Uint8ClampedArray(src);
    }

    const findRange = (hist: Uint32Array): [number, number] => {
        const clipCount = Math.floor(opaqueCount * clipFraction);
        let lo = 0;
        let acc = 0;
        while (lo < 255) {
            acc += hist[lo];
            if (acc > clipCount) break;
            lo++;
        }
        let hi = 255;
        acc = 0;
        while (hi > lo) {
            acc += hist[hi];
            if (acc > clipCount) break;
            hi--;
        }
        if (hi <= lo) {
            return [0, 255];
        }
        return [lo, hi];
    };

    const [loR, hiR] = findRange(histR);
    const [loG, hiG] = findRange(histG);
    const [loB, hiB] = findRange(histB);

    const out = new Uint8ClampedArray(src.length);
    const scaleR = hiR > loR ? 255 / (hiR - loR) : 1;
    const scaleG = hiG > loG ? 255 / (hiG - loG) : 1;
    const scaleB = hiB > loB ? 255 / (hiB - loB) : 1;

    for (let i = 0; i < src.length; i += 4) {
        out[i] = Math.max(0, Math.min(255, Math.round((src[i] - loR) * scaleR)));
        out[i + 1] = Math.max(0, Math.min(255, Math.round((src[i + 1] - loG) * scaleG)));
        out[i + 2] = Math.max(0, Math.min(255, Math.round((src[i + 2] - loB) * scaleB)));
        out[i + 3] = src[i + 3];
    }

    return out;
}

export function flipRgbaHorizontal(src: Uint8ClampedArray, width: number, height: number): Uint8ClampedArray {
    const out = new Uint8ClampedArray(src.length);
    for (let y = 0; y < height; ++y) {
        for (let x = 0; x < width; ++x) {
            const srcIdx = (y * width + x) * 4;
            const dstIdx = (y * width + (width - 1 - x)) * 4;
            out[dstIdx] = src[srcIdx];
            out[dstIdx + 1] = src[srcIdx + 1];
            out[dstIdx + 2] = src[srcIdx + 2];
            out[dstIdx + 3] = src[srcIdx + 3];
        }
    }
    return out;
}

export function flipRgbaVertical(src: Uint8ClampedArray, width: number, height: number): Uint8ClampedArray {
    const out = new Uint8ClampedArray(src.length);
    for (let y = 0; y < height; ++y) {
        const srcRowStart = y * width * 4;
        const dstRowStart = (height - 1 - y) * width * 4;
        out.set(src.subarray(srcRowStart, srcRowStart + width * 4), dstRowStart);
    }
    return out;
}

export function rotateRgba90CW(
    src: Uint8ClampedArray,
    width: number,
    height: number,
): { pixels: Uint8ClampedArray; width: number; height: number } {
    const outW = height;
    const outH = width;
    const out = new Uint8ClampedArray(outW * outH * 4);
    for (let y = 0; y < height; ++y) {
        for (let x = 0; x < width; ++x) {
            const srcIdx = (y * width + x) * 4;
            const nx = height - 1 - y;
            const ny = x;
            const dstIdx = (ny * outW + nx) * 4;
            out[dstIdx] = src[srcIdx];
            out[dstIdx + 1] = src[srcIdx + 1];
            out[dstIdx + 2] = src[srcIdx + 2];
            out[dstIdx + 3] = src[srcIdx + 3];
        }
    }
    return { pixels: out, width: outW, height: outH };
}
