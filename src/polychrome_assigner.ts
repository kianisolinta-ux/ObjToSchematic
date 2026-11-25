import { RGBA, RGBAUtil } from './colour';

export type OklabTriple = readonly [number, number, number];

export interface PolychromeBiasInput {
    mode?: 'weights' | 'percentages';
    values?: readonly number[];
    percentages?: readonly number[];
    x?: number;
    y?: number;
}

const POLYCHROME_LIGHTNESS_WEIGHT = 0.85;
const POLYCHROME_CHROMA_WEIGHT = 1.15;

export function weightedOklabDistFromTriples(
    a: OklabTriple,
    b: OklabTriple,
): number {
    const dL = (a[0] - b[0]) * POLYCHROME_LIGHTNESS_WEIGHT;
    const da = (a[1] - b[1]) * POLYCHROME_CHROMA_WEIGHT;
    const db = (a[2] - b[2]) * POLYCHROME_CHROMA_WEIGHT;
    return Math.sqrt(dL * dL + da * da + db * db);
}

/**
 * Extracts normalized weights [w_0, ..., w_{N-1}] summing to 1 from the shared
 * radial/equalizer diagram config. Uniform presets (even with 0.1% rounding like 33.3/33.3/33.4)
 * snap cleanly to exact [1/N, ..., 1/N] so Equal (1/N) always yields zero bias.
 */
export function extractPolychromeWeights(
    toneBias: number | PolychromeBiasInput | undefined,
    numBlocks: number,
): number[] {
    const n = Math.max(2, numBlocks);
    const uniform = Array.from({ length: n }, () => 1 / n);

    if (typeof toneBias === 'object' && toneBias !== null) {
        if (toneBias.mode === 'weights' && Array.isArray(toneBias.values)) {
            const raw = Array.from({ length: n }, (_, i) => {
                const v = toneBias.values![i];
                return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, v) : 1.0;
            });
            const sum = raw.reduce((a, b) => a + b, 0);
            if (sum <= 1e-9) {
                return uniform;
            }
            const minV = Math.min(...raw);
            const maxV = Math.max(...raw);
            if (maxV - minV <= 1e-4) {
                return uniform;
            }
            return raw.map((v) => v / sum);
        }

        if (Array.isArray(toneBias.percentages)) {
            const raw = Array.from({ length: n }, (_, i) => {
                const v = toneBias.percentages![i];
                return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, v) : 100 / n;
            });
            const sum = raw.reduce((a, b) => a + b, 0);
            if (sum <= 1e-9) {
                return uniform;
            }
            const minP = Math.min(...raw);
            const maxP = Math.max(...raw);
            if (maxP - minP <= 0.25) {
                return uniform;
            }
            return raw.map((v) => v / sum);
        }
    }

    return uniform;
}

/**
 * Computes the characteristic nearest-neighbour spacing in perceptual Oklab space
 * across the active block palette, calibrating weight sensitivity across both
 * tight monochrome ramps and wide multi-hue palettes.
 */
export function computePaletteCharacteristicSpacing(
    blockOklabs: readonly OklabTriple[],
): number {
    if (blockOklabs.length < 2) {
        return 0.15;
    }

    const nearestDistances: number[] = [];
    for (let i = 0; i < blockOklabs.length; ++i) {
        let nearest = Infinity;
        for (let j = 0; j < blockOklabs.length; ++j) {
            if (i === j) continue;
            const d = weightedOklabDistFromTriples(blockOklabs[i], blockOklabs[j]);
            if (d > 1e-4 && d < nearest) {
                nearest = d;
            }
        }
        if (Number.isFinite(nearest)) {
            nearestDistances.push(nearest);
        }
    }

    if (nearestDistances.length === 0) {
        return 0.15;
    }

    nearestDistances.sort((a, b) => a - b);
    const mid = Math.floor(nearestDistances.length / 2);
    const median = nearestDistances.length % 2 === 1 ?
        nearestDistances[mid] :
        (nearestDistances[mid - 1] + nearestDistances[mid]) * 0.5;
    return median;
}

export function computePolychromeSigma(
    blockOklabs: readonly OklabTriple[],
): number {
    const spacing = computePaletteCharacteristicSpacing(blockOklabs);
    return Math.max(0.07, Math.min(0.28, spacing * 0.75));
}

/**
 * Computes log-prior offsets `sigma * ln(w_i / (1/N))` for each block.
 * - Equal weights => all offsets are 0 (pure perceptual nearest-colour matching).
 * - Zero weight => -Infinity (block excluded unless all weights are 0).
 * - Higher weight => larger positive offset, shrinking effective score `dist - offset`.
 */
export function computePolychromeLogOffsets(
    normalizedWeights: readonly number[],
    sigma: number,
): number[] {
    const n = normalizedWeights.length;
    if (n === 0) {
        return [];
    }
    const u = 1 / n;
    const isUniform = normalizedWeights.every((w) => Math.abs(w - u) <= 1e-6);
    if (isUniform) {
        return Array.from({ length: n }, () => 0);
    }

    return normalizedWeights.map((w) => {
        if (w <= 1e-6) {
            return -Infinity;
        }
        return sigma * Math.log(w / u);
    });
}

/**
 * Selects the optimal block index for a voxel colour given candidate block Oklab triples,
 * log-prior weight offsets, and optional texture standard deviation tie-breakers.
 */
export function selectPolychromeBlockIndex(
    voxelOklab: OklabTriple,
    candidateOklabs: readonly OklabTriple[],
    logOffsets: readonly number[],
    candidateStds?: readonly number[],
): number {
    let bestIndex = 0;
    let bestScore = Infinity;

    for (let i = 0; i < candidateOklabs.length; ++i) {
        const offset = logOffsets[i] ?? 0;
        if (!Number.isFinite(offset) && offset < 0) {
            continue;
        }
        const dist = weightedOklabDistFromTriples(voxelOklab, candidateOklabs[i]);
        const stdTieBreaker = candidateStds ? (candidateStds[i] ?? 0) * 1e-4 : 0;
        const score = dist - offset + stdTieBreaker;
        if (score < bestScore) {
            bestScore = score;
            bestIndex = i;
        }
    }

    return bestIndex;
}

export function colourToOklabTriple(colour: RGBA): OklabTriple {
    return RGBAUtil.toOklab(colour);
}
