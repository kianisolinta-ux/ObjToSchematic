import { RGBA, RGBAUtil } from './colour';

export interface DominantColourCluster {
    lr: number;
    lg: number;
    lb: number;
    alphaSum: number;
    count: number;
}

/**
 * Merges an incoming sRGB colour sample into the nearest linear-light colour cluster,
 * or opens a new cluster when the sample represents a distinct colour family.
 */
export function mergeDominantColourSample(
    clusters: DominantColourCluster[],
    colour: RGBA,
    thresholdSq: number = 0.018,
    maxClusters: number = 8,
): RGBA {
    const lr = RGBAUtil.srgbToLinear(colour.r);
    const lg = RGBAUtil.srgbToLinear(colour.g);
    const lb = RGBAUtil.srgbToLinear(colour.b);

    let bestCluster: DominantColourCluster | undefined;
    let bestDistSq = Infinity;

    for (let i = 0; i < clusters.length; ++i) {
        const c = clusters[i];
        const cr = c.lr / c.count;
        const cg = c.lg / c.count;
        const cb = c.lb / c.count;
        const distSq = (lr - cr) * (lr - cr) + (lg - cg) * (lg - cg) + (lb - cb) * (lb - cb);
        if (distSq < bestDistSq) {
            bestDistSq = distSq;
            bestCluster = c;
        }
    }

    if (bestCluster !== undefined && (bestDistSq <= thresholdSq || clusters.length >= maxClusters)) {
        bestCluster.lr += lr;
        bestCluster.lg += lg;
        bestCluster.lb += lb;
        bestCluster.alphaSum += colour.a;
        bestCluster.count += 1;
    } else {
        clusters.push({
            lr,
            lg,
            lb,
            alphaSum: colour.a,
            count: 1,
        });
    }

    let winner = clusters[0];
    for (let i = 1; i < clusters.length; ++i) {
        if (clusters[i].count > winner.count) {
            winner = clusters[i];
        }
    }

    return {
        r: RGBAUtil.linearToSrgb(winner.lr / winner.count),
        g: RGBAUtil.linearToSrgb(winner.lg / winner.count),
        b: RGBAUtil.linearToSrgb(winner.lb / winner.count),
        a: winner.alphaSum / winner.count,
    };
}

/**
 * Accumulates a colour sample in physically-linear RGB light space and returns the linear-light average converted back to sRGB.
 */
export function mergeLinearAverageColourSample(
    acc: DominantColourCluster,
    colour: RGBA,
): RGBA {
    acc.lr += RGBAUtil.srgbToLinear(colour.r);
    acc.lg += RGBAUtil.srgbToLinear(colour.g);
    acc.lb += RGBAUtil.srgbToLinear(colour.b);
    acc.alphaSum += colour.a;
    acc.count += 1;

    return {
        r: RGBAUtil.linearToSrgb(acc.lr / acc.count),
        g: RGBAUtil.linearToSrgb(acc.lg / acc.count),
        b: RGBAUtil.linearToSrgb(acc.lb / acc.count),
        a: acc.alphaSum / acc.count,
    };
}

function halton(index: number, base: number): number {
    let result = 0;
    let f = 1 / base;
    let i = index;
    while (i > 0) {
        result += f * (i % base);
        i = Math.floor(i / base);
        f /= base;
    }
    return result;
}

/**
 * Deterministic stratified 3D offset within [-0.5, +0.5)^3 using Halton bases (2, 3, 5).
 * Sample 0 stays centered at (0, 0, 0) while subsequent taps cover the voxel volume without random clustering.
 */
export function getStratifiedSampleOffset(sampleIndex: number): { x: number; y: number; z: number } {
    if (sampleIndex <= 0) {
        return { x: 0, y: 0, z: 0 };
    }
    return {
        x: halton(sampleIndex, 2) - 0.5,
        y: halton(sampleIndex, 3) - 0.5,
        z: halton(sampleIndex, 5) - 0.5,
    };
}
