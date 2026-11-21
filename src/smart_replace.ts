import { BlockInfo } from './block_atlas';
import { RGBA, RGBAUtil } from './colour';

export interface ISimilarCandidate {
    name: string;
    similarityPct: number;
    distance: number;
    inPalette: boolean;
}

export interface IRankedReplacementGroups {
    similar: ISimilarCandidate[];
    paletteOthers: string[];
    allOthers: string[];
}

/**
 * Ranks candidate target blocks by Oklab perceptual similarity to `sourceHex`.
 * Top `maxSimilar` candidates (prioritizing active palette on ties) are surfaced in a dedicated group.
 */
export function rankReplacementCandidates(
    sourceBlock: string,
    sourceHex: string | undefined,
    paletteBlocks: readonly string[],
    allReleaseBlocks: readonly string[],
    blockHexMap: ReadonlyMap<string, string>,
    maxSimilar: number = 6,
): IRankedReplacementGroups {
    const paletteSet = new Set<string>(paletteBlocks);
    const allCandidateSet = new Set<string>();
    paletteBlocks.forEach((b) => {
        if (b !== sourceBlock) allCandidateSet.add(b);
    });
    allReleaseBlocks.forEach((b) => {
        if (b !== sourceBlock) allCandidateSet.add(b);
    });

    const sourceColour = sourceHex && /^#[0-9a-fA-F]{6}$/.test(sourceHex) ?
        RGBAUtil.fromHexString(sourceHex) :
        (blockHexMap.has(sourceBlock) ? RGBAUtil.fromHexString(blockHexMap.get(sourceBlock)!) : undefined);

    let similar: ISimilarCandidate[] = [];
    const similarSet = new Set<string>();

    if (sourceColour) {
        const scored: ISimilarCandidate[] = [];
        allCandidateSet.forEach((name) => {
            const hex = blockHexMap.get(name);
            if (!hex || !/^#[0-9a-fA-F]{6}$/.test(hex)) {
                return;
            }
            const dist = RGBAUtil.oklabDistance(sourceColour, RGBAUtil.fromHexString(hex));
            // Map Oklab 0..0.45 range smoothly to 100%..0% perceptual match
            const similarityPct = Math.max(1, Math.min(99, Math.round((1 - Math.min(1, dist / 0.45)) * 100)));
            scored.push({
                name,
                similarityPct,
                distance: dist,
                inPalette: paletteSet.has(name),
            });
        });

        scored.sort((a, b) => {
            const diff = a.distance - b.distance;
            if (Math.abs(diff) > 1e-6) {
                return diff;
            }
            if (a.inPalette !== b.inPalette) {
                return a.inPalette ? -1 : 1;
            }
            return a.name.localeCompare(b.name);
        });

        similar = scored.slice(0, Math.max(0, maxSimilar));
        similar.forEach((s) => similarSet.add(s.name));
    }

    const paletteOthers = Array.from(paletteSet)
        .filter((b) => b !== sourceBlock && !similarSet.has(b))
        .sort((a, b) => a.localeCompare(b));

    const allOthers = allReleaseBlocks
        .filter((b) => b !== sourceBlock && !paletteSet.has(b) && !similarSet.has(b))
        .sort((a, b) => a.localeCompare(b));

    return { similar, paletteOthers, allOthers };
}

/**
 * Selects up to `maxTypes` block names to retain when compressing the assigned palette.
 * Balances block frequency in the model with Oklab colour diversity so small vivid accents
 * (e.g. eyes/insignia) aren't blindly erased before minor similar shades.
 */
export function selectRetainedBlockNamesForCap(
    blockCounts: ReadonlyMap<string, number>,
    blockColours: ReadonlyMap<string, RGBA>,
    maxTypes: number,
): Set<string> {
    if (maxTypes <= 0 || blockCounts.size <= maxTypes) {
        return new Set(blockCounts.keys());
    }

    const cap = Math.max(1, Math.floor(maxTypes));
    const entries = Array.from(blockCounts.entries())
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

    const selected: string[] = [entries[0][0]];
    const selectedSet = new Set<string>(selected);
    const totalCount = entries.reduce((sum, e) => sum + e[1], 0) || 1;

    while (selected.length < cap && selected.length < entries.length) {
        let bestName = '';
        let bestScore = -Infinity;

        for (let i = 0; i < entries.length; ++i) {
            const [name, count] = entries[i];
            if (selectedSet.has(name)) {
                continue;
            }

            const colour = blockColours.get(name);
            let minDist = 0.25;
            if (colour) {
                minDist = Infinity;
                for (let j = 0; j < selected.length; ++j) {
                    const selColour = blockColours.get(selected[j]);
                    if (selColour) {
                        minDist = Math.min(minDist, RGBAUtil.oklabDistance(colour, selColour));
                    }
                }
                if (!Number.isFinite(minDist)) {
                    minDist = 0.25;
                }
            }

            const freqShare = count / totalCount;
            // Combine frequency importance with perceptual novelty so distinct accents survive
            const score = Math.sqrt(freqShare) * (0.25 + minDist * 3.0);
            if (score > bestScore) {
                bestScore = score;
                bestName = name;
            }
        }

        if (!bestName) {
            break;
        }
        selected.push(bestName);
        selectedSet.add(bestName);
    }

    return selectedSet;
}

/**
 * Finds the best fallback block from `retainedBlocks` for a voxel colour using Oklab + local neighbor cohesion.
 */
export function pickBestRetainedBlock(
    voxelColour: RGBA,
    retainedBlocks: readonly BlockInfo[],
    neighborCounts: ReadonlyMap<string, number>,
): BlockInfo {
    let best = retainedBlocks[0];
    let minScore = Infinity;

    for (let i = 0; i < retainedBlocks.length; ++i) {
        const candidate = retainedBlocks[i];
        const dist = RGBAUtil.oklabDistance(voxelColour, candidate.colour);
        const cohesionBonus = Math.min(0.06, (neighborCounts.get(candidate.name) ?? 0) * 0.012);
        const score = dist - cohesionBonus;
        if (score < minScore) {
            minScore = score;
            best = candidate;
        }
    }

    return best;
}

/**
 * Scales diffused dithering error down when crossing high-contrast material seams in Oklab space
 * while preserving full error propagation across smooth gradients.
 */
export function computeEdgeAwareDiffusionFactor(sourceColour: RGBA, neighbourColour: RGBA): number {
    const dist = RGBAUtil.oklabDistance(sourceColour, neighbourColour);
    if (dist <= 0.10) {
        return 1.0;
    }
    if (dist >= 0.28) {
        return 0.2;
    }
    const t = (dist - 0.10) / (0.28 - 0.10);
    return 1.0 - t * 0.8;
}

/**
 * Prevents iterative spatial smoothing from drifting noticeably away from the voxel's original colour
 * across multi-pass neighborhood voting, preserving thin edges and contrast features.
 */
export function canReplaceInFilterPass(
    voxelColour: RGBA,
    currentBlockColour: RGBA,
    candidateBlockColour: RGBA,
    threshold: number,
): boolean {
    const currentDist = RGBAUtil.oklabDistance(voxelColour, currentBlockColour);
    const candidateDist = RGBAUtil.oklabDistance(voxelColour, candidateBlockColour);
    const maxDrift = Math.max(0.03, (Math.max(0, threshold) / 100) * 0.6);
    return candidateDist <= currentDist + maxDrift;
}
