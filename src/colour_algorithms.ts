import { RGBA, RGBAUtil } from './colour';

export interface SpatialBlockCandidate {
    name: string;
    colour: RGBA;
    contextualColour: RGBA;
    std: number;
    faceVariance: number;
    isFallable: boolean;
}

export interface PaletteLuminanceRemap {
    minPaletteL: number;
    maxPaletteL: number;
    minModelL: number;
    maxModelL: number;
    strength: number;
}

/**
 * Full CIEDE2000 (Delta E 2000) perceptual distance in CIELab space,
 * normalized roughly to [0..1] scale (dividing Delta E by 100) to balance cleanly with texture std penalties.
 */
export function ciede2000Distance(target: RGBA, candidate: RGBA): number {
    const [L1, a1, b1] = RGBAUtil.toLab(target);
    const [L2, a2, b2] = RGBAUtil.toLab(candidate);

    const C1 = Math.sqrt(a1 * a1 + b1 * b1);
    const C2 = Math.sqrt(a2 * a2 + b2 * b2);
    const avgC = (C1 + C2) * 0.5;

    const avgC7 = Math.pow(avgC, 7);
    const pow25_7 = 6103515625; // 25^7
    const G = 0.5 * (1 - Math.sqrt(avgC7 / (avgC7 + pow25_7)));

    const a1p = (1 + G) * a1;
    const a2p = (1 + G) * a2;
    const C1p = Math.sqrt(a1p * a1p + b1 * b1);
    const C2p = Math.sqrt(a2p * a2p + b2 * b2);

    const rad2deg = 180 / Math.PI;
    const deg2rad = Math.PI / 180;

    const hueAngle = (b: number, ap: number): number => {
        if (Math.abs(b) < 1e-8 && Math.abs(ap) < 1e-8) return 0;
        const h = Math.atan2(b, ap) * rad2deg;
        return h >= 0 ? h : h + 360;
    };

    const h1p = hueAngle(b1, a1p);
    const h2p = hueAngle(b2, a2p);

    const dLp = L2 - L1;
    const dCp = C2p - C1p;

    let dhp = 0;
    if (C1p * C2p > 1e-8) {
        const diff = h2p - h1p;
        if (Math.abs(diff) <= 180) {
            dhp = diff;
        } else if (diff > 180) {
            dhp = diff - 360;
        } else {
            dhp = diff + 360;
        }
    }

    const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin(dhp * 0.5 * deg2rad);
    const avgLp = (L1 + L2) * 0.5;
    const avgCp = (C1p + C2p) * 0.5;

    let avgHp = h1p + h2p;
    if (C1p * C2p > 1e-8) {
        if (Math.abs(h1p - h2p) <= 180) {
            avgHp = (h1p + h2p) * 0.5;
        } else if (h1p + h2p < 360) {
            avgHp = (h1p + h2p + 360) * 0.5;
        } else {
            avgHp = (h1p + h2p - 360) * 0.5;
        }
    }

    const T =
        1 -
        0.17 * Math.cos((avgHp - 30) * deg2rad) +
        0.24 * Math.cos(2 * avgHp * deg2rad) +
        0.32 * Math.cos((3 * avgHp + 6) * deg2rad) -
        0.20 * Math.cos((4 * avgHp - 63) * deg2rad);

    const dTheta = 30 * Math.exp(-Math.pow((avgHp - 275) / 25, 2));
    const avgCp7 = Math.pow(avgCp, 7);
    const RC = 2 * Math.sqrt(avgCp7 / (avgCp7 + pow25_7));

    const Lterm = avgLp - 50;
    const SL = 1 + (0.015 * Lterm * Lterm) / Math.sqrt(20 + Lterm * Lterm);
    const SC = 1 + 0.045 * avgCp;
    const SH = 1 + 0.015 * avgCp * T;
    const RT = -Math.sin(2 * dTheta * deg2rad) * RC;

    const termL = dLp / SL;
    const termC = dCp / SC;
    const termH = dHp / SH;

    const deltaE2 =
        termL * termL +
        termC * termC +
        termH * termH +
        RT * termC * termH;

    return Math.sqrt(Math.max(0, deltaE2)) / 100;
}

export function computeLuminanceStretchParams(
    voxelColours: RGBA[],
    paletteColours: RGBA[],
    strength = 0.65,
): PaletteLuminanceRemap | null {
    if (voxelColours.length === 0 || paletteColours.length < 2) {
        return null;
    }

    let minPal = Infinity;
    let maxPal = -Infinity;
    for (let i = 0; i < paletteColours.length; ++i) {
        const l = RGBAUtil.toOklab(paletteColours[i])[0];
        if (l < minPal) minPal = l;
        if (l > maxPal) maxPal = l;
    }
    if (maxPal - minPal < 0.05) {
        return null;
    }

    const modelLs = new Float32Array(voxelColours.length);
    for (let i = 0; i < voxelColours.length; ++i) {
        modelLs[i] = RGBAUtil.toOklab(voxelColours[i])[0];
    }
    modelLs.sort();

    const pLow = modelLs[Math.floor((modelLs.length - 1) * 0.02)];
    const pHigh = modelLs[Math.floor((modelLs.length - 1) * 0.98)];
    if (pHigh - pLow < 0.04) {
        return null;
    }

    return {
        minPaletteL: minPal,
        maxPaletteL: maxPal,
        minModelL: pLow,
        maxModelL: pHigh,
        strength: Math.max(0, Math.min(1, strength)),
    };
}

export function remapVoxelLuminance(colour: RGBA, remap: PaletteLuminanceRemap | null): RGBA {
    if (!remap) {
        return RGBAUtil.copy(colour);
    }
    const [L, a, b] = RGBAUtil.toOklab(colour);
    const norm = Math.max(0, Math.min(1, (L - remap.minModelL) / (remap.maxModelL - remap.minModelL)));
    const targetL = remap.minPaletteL + norm * (remap.maxPaletteL - remap.minPaletteL);
    const blendedL = L * (1 - remap.strength) + targetL * remap.strength;
    return RGBAUtil.oklabToSrgb(Math.max(0, Math.min(1, blendedL)), a, b, colour.a);
}

/**
 * Computes edge-aware neighbor consensus score for `spatial-coherent` block selection:
 * returns the best candidate index considering perceptual distance + similar-neighbor bonus.
 */
export function selectSpatialCoherentCandidate<T extends {
    name: string;
    colourError: number;
    stdPenalty: number;
}>(
    rankedCandidates: T[],
    neighborBlockNames: Array<{ name: string; colourSimilarity: number }>,
    errorWeight: number,
    cohesionStrength = 0.06,
): T {
    if (rankedCandidates.length === 1 || neighborBlockNames.length === 0) {
        return rankedCandidates[0];
    }

    let best = rankedCandidates[0];
    let bestScore = Infinity;

    for (let i = 0; i < rankedCandidates.length; ++i) {
        const cand = rankedCandidates[i];
        const baseError = cand.colourError * (1 - errorWeight) + cand.stdPenalty * errorWeight;
        let support = 0;
        for (let n = 0; n < neighborBlockNames.length; ++n) {
            if (neighborBlockNames[n].name === cand.name) {
                support += neighborBlockNames[n].colourSimilarity;
            }
        }
        const normalizedSupport = support / Math.max(1, neighborBlockNames.length);
        const score = baseError - cohesionStrength * normalizedSupport;
        if (score < bestScore) {
            bestScore = score;
            best = cand;
        }
    }

    return best;
}
