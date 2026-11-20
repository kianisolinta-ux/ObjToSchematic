export interface SliceLayerStats {
    layerNumber: number;
    totalLayers: number;
    sliceY: number;
    minY: number;
    maxY: number;
    blocksOnLayer: number;
    blocksUpToLayer: number;
    totalBlocks: number;
}

/**
 * Computes active Y-slice layer metrics for Survival layer-by-layer building.
 */
export function computeSliceLayerStats(
    blockYs: ReadonlyArray<number>,
    minY: number,
    maxY: number,
    sliceHeight: number,
): SliceLayerStats {
    const totalBlocks = blockYs.length;
    if (totalBlocks === 0 || maxY < minY) {
        return {
            layerNumber: 0,
            totalLayers: 0,
            sliceY: 0,
            minY: 0,
            maxY: 0,
            blocksOnLayer: 0,
            blocksUpToLayer: 0,
            totalBlocks: 0,
        };
    }

    const clampedY = Math.max(minY, Math.min(maxY, Math.round(sliceHeight)));
    const totalLayers = (maxY - minY) + 1;
    const layerNumber = (clampedY - minY) + 1;

    let blocksOnLayer = 0;
    let blocksUpToLayer = 0;
    for (let i = 0; i < totalBlocks; ++i) {
        const y = blockYs[i];
        if (y === clampedY) {
            ++blocksOnLayer;
        }
        if (y <= clampedY) {
            ++blocksUpToLayer;
        }
    }

    return {
        layerNumber,
        totalLayers,
        sliceY: clampedY,
        minY,
        maxY,
        blocksOnLayer,
        blocksUpToLayer,
        totalBlocks,
    };
}

export interface SliceLayerBlockItem {
    name: string;
    count: number;
    hexColour: string;
    percentage: number;
}

export interface SliceLayerBlockSummary {
    sliceY: number;
    total: number;
    unique: number;
    blocks: SliceLayerBlockItem[];
}

/**
 * Computes sorted block breakdown strictly for the active Y slice layer.
 */
export function computeSliceLayerBlockSummary(
    blocks: ReadonlyArray<{ y: number; name: string }>,
    sliceY: number,
    colourLookup?: ReadonlyMap<string, string>,
): SliceLayerBlockSummary {
    const counts = new Map<string, number>();
    let total = 0;

    for (let i = 0; i < blocks.length; ++i) {
        const b = blocks[i];
        if (b.y === sliceY && b.name) {
            counts.set(b.name, (counts.get(b.name) ?? 0) + 1);
            total++;
        }
    }

    const items: SliceLayerBlockItem[] = [];
    counts.forEach((count, name) => {
        items.push({
            name,
            count,
            hexColour: colourLookup?.get(name) ?? '#888888',
            percentage: total > 0 ? (count / total) * 100 : 0,
        });
    });

    items.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

    return {
        sliceY,
        total,
        unique: items.length,
        blocks: items,
    };
}

