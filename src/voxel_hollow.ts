export interface VoxelPoint {
    x: number;
    y: number;
    z: number;
}

export interface HollowResult {
    keptIndices: number[];
    removedIndices: number[];
}

/**
 * Computes which occupied voxels form a watertight exterior shell of the given thickness (1..4)
 * using a padded 3D grid BFS from exterior air so hidden internal solids / Tripo3D interior shells
 * are removed without creating diagonal pin-holes on the surface.
 *
 * Layer 1 (outermost surface): any occupied voxel 26-adjacent to exterior air is kept (guarantees
 * zero diagonal pin-holes on sloped/curved surfaces).
 * Layers 2..wallThickness: inward 6-neighbor expansion through occupied voxels.
 */
export function computeHollowShellIndices(
    positions: readonly VoxelPoint[],
    wallThickness: number = 1,
): HollowResult {
    if (positions.length === 0) {
        return { keptIndices: [], removedIndices: [] };
    }

    const thickness = Math.max(1, Math.min(4, Math.floor(wallThickness)));

    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;

    for (const p of positions) {
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.z < minZ) minZ = p.z;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
        if (p.z > maxZ) maxZ = p.z;
    }

    // Pad by 1 voxel on every side so index 0 and max+2 are guaranteed exterior air
    const ox = minX - 1;
    const oy = minY - 1;
    const oz = minZ - 1;
    const sx = (maxX - minX) + 3;
    const sy = (maxY - minY) + 3;
    const sz = (maxZ - minZ) + 3;
    const totalCells = sx * sy * sz;

    // 0 = empty/interior air, 1 = occupied, 2 = exterior air, 3 = kept shell
    const grid = new Uint8Array(totalCells);
    const cellToVoxelIdx = new Int32Array(totalCells);
    cellToVoxelIdx.fill(-1);

    const idxOf = (gx: number, gy: number, gz: number) => (gy * sz + gz) * sx + gx;

    for (let i = 0; i < positions.length; ++i) {
        const gx = positions[i].x - ox;
        const gy = positions[i].y - oy;
        const gz = positions[i].z - oz;
        const c = idxOf(gx, gy, gz);
        grid[c] = 1;
        cellToVoxelIdx[c] = i;
    }

    // 1. Flood-fill exterior air (6-connected) starting at corner (0, 0, 0)
    const airQueue = new Int32Array(totalCells);
    let airHead = 0;
    let airTail = 0;

    grid[0] = 2;
    airQueue[airTail++] = 0;

    const strideY = sx * sz;
    const strideZ = sx;

    while (airHead < airTail) {
        const c = airQueue[airHead++];
        const gx = c % sx;
        const rem = (c - gx) / sx;
        const gz = rem % sz;
        const gy = (rem - gz) / sz;

        if (gx > 0 && grid[c - 1] === 0) { grid[c - 1] = 2; airQueue[airTail++] = c - 1; }
        if (gx + 1 < sx && grid[c + 1] === 0) { grid[c + 1] = 2; airQueue[airTail++] = c + 1; }
        if (gz > 0 && grid[c - strideZ] === 0) { grid[c - strideZ] = 2; airQueue[airTail++] = c - strideZ; }
        if (gz + 1 < sz && grid[c + strideZ] === 0) { grid[c + strideZ] = 2; airQueue[airTail++] = c + strideZ; }
        if (gy > 0 && grid[c - strideY] === 0) { grid[c - strideY] = 2; airQueue[airTail++] = c - strideY; }
        if (gy + 1 < sy && grid[c + strideY] === 0) { grid[c + strideY] = 2; airQueue[airTail++] = c + strideY; }
    }

    // 2. Mark layer 1 (occupied cells 26-adjacent to any exterior air cell)
    const shellQueue = new Int32Array(positions.length);
    let shellHead = 0;
    let shellTail = 0;

    for (let i = 0; i < positions.length; ++i) {
        const gx = positions[i].x - ox;
        const gy = positions[i].y - oy;
        const gz = positions[i].z - oz;
        const c = idxOf(gx, gy, gz);
        if (grid[c] !== 1) {
            continue;
        }

        let touchesAir = false;
        for (let dy = -1; dy <= 1 && !touchesAir; ++dy) {
            for (let dz = -1; dz <= 1 && !touchesAir; ++dz) {
                for (let dx = -1; dx <= 1; ++dx) {
                    if (dx === 0 && dy === 0 && dz === 0) continue;
                    const nc = idxOf(gx + dx, gy + dy, gz + dz);
                    if (grid[nc] === 2) {
                        touchesAir = true;
                        break;
                    }
                }
            }
        }

        if (touchesAir) {
            grid[c] = 3;
            shellQueue[shellTail++] = c;
        }
    }

    // 3. Expand inward up to `thickness` layers using 6-connectivity
    let currentLayerEnd = shellTail;
    for (let layer = 2; layer <= thickness && shellHead < currentLayerEnd; ++layer) {
        while (shellHead < currentLayerEnd) {
            const c = shellQueue[shellHead++];
            const gx = c % sx;
            const rem = (c - gx) / sx;
            const gz = rem % sz;
            const gy = (rem - gz) / sz;

            if (gx > 0 && grid[c - 1] === 1) { grid[c - 1] = 3; shellQueue[shellTail++] = c - 1; }
            if (gx + 1 < sx && grid[c + 1] === 1) { grid[c + 1] = 3; shellQueue[shellTail++] = c + 1; }
            if (gz > 0 && grid[c - strideZ] === 1) { grid[c - strideZ] = 3; shellQueue[shellTail++] = c - strideZ; }
            if (gz + 1 < sz && grid[c + strideZ] === 1) { grid[c + strideZ] = 3; shellQueue[shellTail++] = c + strideZ; }
            if (gy > 0 && grid[c - strideY] === 1) { grid[c - strideY] = 3; shellQueue[shellTail++] = c - strideY; }
            if (gy + 1 < sy && grid[c + strideY] === 1) { grid[c + strideY] = 3; shellQueue[shellTail++] = c + strideY; }
        }
        currentLayerEnd = shellTail;
    }

    const keptIndices: number[] = [];
    const removedIndices: number[] = [];
    for (let i = 0; i < positions.length; ++i) {
        const c = idxOf(positions[i].x - ox, positions[i].y - oy, positions[i].z - oz);
        if (grid[c] === 3) {
            keptIndices.push(i);
        } else {
            removedIndices.push(i);
        }
    }

    return { keptIndices, removedIndices };
}
