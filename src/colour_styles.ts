import { RGBA, RGBAUtil } from './colour';

export type TColourStyle =
    | 'none'
    | 'vibrant'
    | 'pastel'
    | 'cel-shaded'
    | 'warm-vintage'
    | 'cool-noir'
    | 'sepia'
    | 'cyberpunk';

export interface ColourGradingOptions {
    brightnessOffset?: number;
    saturationOffset?: number;
    contrastOffset?: number;
    temperatureOffset?: number;
    colourStyle?: TColourStyle;
    colourStyleStrength?: number;
}

export interface AtkinsonNeighbourOffset {
    dx: number;
    dy: number;
    dz: number;
    weight: number;
}

/**
 * Classic 3D-adapted Atkinson diffusion kernel: distributes 6/8 (75%) of quantization error
 * equally (1/8 each) across forward neighbours, preserving crisp highlights without speckle mud.
 */
export function getAtkinsonOffsets(dirX: 1 | -1): ReadonlyArray<AtkinsonNeighbourOffset> {
    return [
        { dx: dirX, dy: 0, dz: 0, weight: 1 / 8 },
        { dx: dirX * 2, dy: 0, dz: 0, weight: 1 / 8 },
        { dx: -dirX, dy: 0, dz: 1, weight: 1 / 8 },
        { dx: 0, dy: 0, dz: 1, weight: 1 / 8 },
        { dx: dirX, dy: 0, dz: 1, weight: 1 / 8 },
        { dx: 0, dy: 1, dz: 0, weight: 1 / 8 },
    ];
}

function clamp01(v: number): number {
    return v < 0 ? 0 : (v > 1 ? 1 : v);
}

/**
 * Applies non-destructive Oklab colour grading (brightness, contrast, saturation, colour temperature)
 * and optional artistic visual style presets blended by `colourStyleStrength`.
 */
export function applyColourGrading(colour: RGBA, opts: ColourGradingOptions): RGBA {
    const brightness = opts.brightnessOffset ?? 0;
    const saturation = opts.saturationOffset ?? 0;
    const contrast = opts.contrastOffset ?? 0;
    const temperature = opts.temperatureOffset ?? 0;
    const style = opts.colourStyle ?? 'none';
    const strength = clamp01(opts.colourStyleStrength ?? 0.8);

    if (
        brightness === 0 &&
        saturation === 0 &&
        contrast === 0 &&
        temperature === 0 &&
        (style === 'none' || strength === 0)
    ) {
        return RGBAUtil.copy(colour);
    }

    let [L, a, b] = RGBAUtil.toOklab(colour);

    // 1. Brightness
    if (brightness !== 0) {
        L = clamp01(L + (brightness / 100) * 0.45);
    }

    // 2. Contrast around mid-tone L = 0.55
    if (contrast !== 0) {
        const factor = contrast >= 0 ?
            1.0 + (contrast / 40) * 0.65 :
            Math.max(0.35, 1.0 + (contrast / 40) * 0.55);
        L = clamp01(0.55 + (L - 0.55) * factor);
    }

    // 3. Saturation
    if (saturation !== 0) {
        const satScale = saturation >= 0 ?
            1.0 + (saturation / 50) * 0.75 :
            Math.max(0, 1.0 + saturation / 50);
        a *= satScale;
        b *= satScale;
    }

    // 4. White-balance temperature (-40 cool cyan/blue .. +40 warm amber/gold)
    if (temperature !== 0) {
        const t = temperature / 40;
        b += t * 0.048;
        a += t * 0.015;
    }

    // 5. Visual style preset (blended smoothly with `strength`)
    if (style !== 'none' && strength > 0) {
        let sL = L;
        let sa = a;
        let sb = b;

        switch (style) {
            case 'vibrant': {
                sL = clamp01(0.54 + (L - 0.54) * 1.18);
                sa = a * 1.48;
                sb = b * 1.48;
                break;
            }
            case 'pastel': {
                sL = clamp01(L * 0.72 + 0.24);
                sa = a * 0.62 + 0.004;
                sb = b * 0.62 + 0.006;
                break;
            }
            case 'cel-shaded': {
                const bands = 5;
                const quantL = Math.round(L * bands) / bands;
                sL = clamp01(L * 0.18 + quantL * 0.82);
                const chroma = Math.sqrt(a * a + b * b);
                if (chroma > 0.01) {
                    sa = a * 1.2;
                    sb = b * 1.2;
                }
                break;
            }
            case 'warm-vintage': {
                sL = clamp01(0.5 + (L - 0.5) * 0.88 + 0.03);
                sa = a * 0.82 + 0.016;
                sb = b * 0.82 + 0.036;
                break;
            }
            case 'cool-noir': {
                sL = clamp01(0.5 + (L - 0.5) * 1.32);
                sa = a * 0.35 - 0.008;
                sb = b * 0.35 - 0.042;
                break;
            }
            case 'sepia': {
                sL = clamp01(0.52 + (L - 0.52) * 1.05);
                const toneWeight = clamp01(0.35 + L * 0.65);
                sa = 0.024 * toneWeight;
                sb = 0.064 * toneWeight;
                break;
            }
            case 'cyberpunk': {
                sL = clamp01(0.5 + (L - 0.5) * 1.38);
                const mag = Math.sqrt(a * a + b * b);
                const boost = 1.45;
                if (L < 0.52) {
                    // Cool shadows -> cyan/electric blue push
                    sa = a * boost - 0.032;
                    sb = b * boost - 0.055;
                } else {
                    // Highlights -> neon magenta/pink push
                    sa = a * boost + 0.055;
                    sb = b * boost - 0.018;
                }
                if (mag < 0.02) {
                    sa *= 0.8;
                }
                break;
            }
        }

        const outL = L + (sL - L) * strength;
        const outA = a + (sa - a) * strength;
        const outB = b + (sb - b) * strength;
        return RGBAUtil.oklabToSrgb(clamp01(outL), outA, outB, colour.a);
    }

    return RGBAUtil.oklabToSrgb(clamp01(L), a, b, colour.a);
}

/**
 * Hue-Locked Perceptual distance in cylindrical Oklab (LCh):
 * penalizes hue angle drift (2.4x) and saturation loss more strongly than brightness steps,
 * ensuring foliage stays green, skin never turns green/grey, and colourful accents stay faithful.
 */
export function huePreserveDistance(target: RGBA, candidate: RGBA): number {
    const [L1, a1, b1] = RGBAUtil.toOklab(target);
    const [L2, a2, b2] = RGBAUtil.toOklab(candidate);

    const dL = L1 - L2;
    const C1 = Math.sqrt(a1 * a1 + b1 * b1);
    const C2 = Math.sqrt(a2 * a2 + b2 * b2);
    const dC = C1 - C2;

    const da = a1 - a2;
    const db = b1 - b2;
    const dH2 = Math.max(0, da * da + db * db - dC * dC);
    const dH = Math.sqrt(dH2);

    const hueWeight = C1 > 0.04 ? 2.45 : 1.5;
    const chromaWeight = C1 > 0.06 ? 1.25 : 1.0;
    const lightnessWeight = 0.72;

    // Extra penalty if chromatic target gets mapped to a near-achromatic grey block
    let greyPenalty = 0;
    if (C1 > 0.06 && C2 < C1 * 0.45) {
        greyPenalty = (C1 * 0.45 - C2) * 1.4;
    }

    return Math.sqrt(
        (dL * lightnessWeight) * (dL * lightnessWeight) +
        (dC * chromaWeight) * (dC * chromaWeight) +
        (dH * hueWeight) * (dH * hueWeight),
    ) + greyPenalty;
}

/**
 * Contour-aware colour distance for `edge-contour` mode:
 * silhouettes/exposed corners (few occluded faces) amplify lightness contrast,
 * while flat inner faces prioritize smooth perceptual colour matching.
 */
export function edgeContourDistance(target: RGBA, candidate: RGBA, visibleFaceCount: number): number {
    const [L1, a1, b1] = RGBAUtil.toOklab(target);
    const [L2, a2, b2] = RGBAUtil.toOklab(candidate);

    const isSilhouette = visibleFaceCount >= 3;
    const wl = isSilhouette ? 1.35 : 0.85;
    const wc = isSilhouette ? 1.05 : 1.2;

    const dL = (L1 - L2) * wl;
    const da = (a1 - a2) * wc;
    const db = (b1 - b2) * wc;
    return Math.sqrt(dL * dL + da * da + db * db);
}
