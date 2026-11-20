export interface VoxelCoord {
    x: number;
    y: number;
    z: number;
}

export interface VoxelCleanupResult {
    keptIndices: number[];
    removedIndices: number[];
    totalComponents: number;
    removedComponents: number;
}

const NEIGHBOURS_26: ReadonlyArray<readonly [number, number, number]> = (() => {
    const offsets: Array<readonly [number, number, number]> = [];
    for (let dx = -1; dx <= 1; ++dx) {
        for (let dy = -1; dy <= 1; ++dy) {
            for (let dz = -1; dz <= 1; ++dz) {
                if (dx === 0 && dy === 0 && dz === 0) {
                    continue;
                }
                offsets.push([dx, dy, dz] as const);
            }
        }
    }
    return offsets;
})();

/**
 * Computes 26-connected components of a voxel set and prunes detached
 * floating islands smaller than `minIslandSize`, always preserving the
 * single largest connected component.
 */
export function computeCleanVoxelIndices(
    positions: ReadonlyArray<VoxelCoord>,
    minIslandSize: number = 4,
): VoxelCleanupResult {
    const count = positions.length;
    if (count === 0) {
        return {
            keptIndices: [],
            removedIndices: [],
            totalComponents: 0,
            removedComponents: 0,
        };
    }

    const threshold = Number.isFinite(minIslandSize) ? Math.max(1, Math.floor(minIslandSize)) : 1;
    if (threshold <= 1) {
        const keptIndices = new Array<number>(count);
        for (let i = 0; i < count; ++i) {
            keptIndices[i] = i;
        }
        return {
            keptIndices,
            removedIndices: [],
            totalComponents: 1,
            removedComponents: 0,
        };
    }

    const grid = new Map<number, Map<number, Map<number, number>>>();
    for (let i = 0; i < count; ++i) {
        const p = positions[i];
        let yMap = grid.get(p.x);
        if (!yMap) {
            yMap = new Map();
            grid.set(p.x, yMap);
        }
        let zMap = yMap.get(p.y);
        if (!zMap) {
            zMap = new Map();
            yMap.set(p.y, zMap);
        }
        zMap.set(p.z, i);
    }

    const lookup = (x: number, y: number, z: number): number => {
        return grid.get(x)?.get(y)?.get(z) ?? -1;
    };

    const componentOf = new Int32Array(count);
    componentOf.fill(-1);
    const queue = new Int32Array(count);
    const componentSizes: number[] = [];

    for (let startIdx = 0; startIdx < count; ++startIdx) {
        if (componentOf[startIdx] !== -1) {
            continue;
        }
        const compId = componentSizes.length;
        componentOf[startIdx] = compId;
        let head = 0;
        let tail = 0;
        queue[tail++] = startIdx;

        while (head < tail) {
            const curIdx = queue[head++];
            const p = positions[curIdx];
            for (let k = 0; k < NEIGHBOURS_26.length; ++k) {
                const d = NEIGHBOURS_26[k];
                const nbIdx = lookup(p.x + d[0], p.y + d[1], p.z + d[2]);
                if (nbIdx !== -1 && componentOf[nbIdx] === -1) {
                    componentOf[nbIdx] = compId;
                    queue[tail++] = nbIdx;
                }
            }
        }

        componentSizes.push(tail);
    }

    let largestCompId = 0;
    for (let c = 1; c < componentSizes.length; ++c) {
        if (componentSizes[c] > componentSizes[largestCompId]) {
            largestCompId = c;
        }
    }

    const keepComponent = new Uint8Array(componentSizes.length);
    let removedComponents = 0;
    for (let c = 0; c < componentSizes.length; ++c) {
        if (c === largestCompId || componentSizes[c] >= threshold) {
            keepComponent[c] = 1;
        } else {
            ++removedComponents;
        }
    }

    const keptIndices: number[] = [];
    const removedIndices: number[] = [];
    for (let i = 0; i < count; ++i) {
        if (keepComponent[componentOf[i]] === 1) {
            keptIndices.push(i);
        } else {
            removedIndices.push(i);
        }
    }

    return {
        keptIndices,
        removedIndices,
        totalComponents: componentSizes.length,
        removedComponents,
    };
}
