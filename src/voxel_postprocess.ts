import { RGBA, RGBAUtil } from './colour';

export type TMorphMode = 'none' | 'close' | 'smooth' | 'dilate' | 'erode';
export type TVoxelMirrorAxis = 'none' | 'x' | 'z' | 'xz';

export interface VoxelColourRecord {
    x: number;
    y: number;
    z: number;
    colour: RGBA;
}

const MAX_GRID_CELLS = 36_000_000;

const NEIGHBOURS_6: ReadonlyArray<readonly [number, number, number]> = [
    [-1, 0, 0],
    [1, 0, 0],
    [0, -1, 0],
    [0, 1, 0],
    [0, 0, -1],
    [0, 0, 1],
];

function cloneColour(c: RGBA): RGBA {
    return { r: c.r, g: c.g, b: c.b, a: c.a };
}

function getBounds(voxels: readonly VoxelColourRecord[]) {
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < voxels.length; ++i) {
        const p = voxels[i];
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.z < minZ) minZ = p.z;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
        if (p.z > maxZ) maxZ = p.z;
    }
    return { minX, minY, minZ, maxX, maxY, maxZ };
}

function buildCoordMap(voxels: readonly VoxelColourRecord[]): Map<number, Map<number, Map<number, number>>> {
    const map = new Map<number, Map<number, Map<number, number>>>();
    for (let i = 0; i < voxels.length; ++i) {
        const v = voxels[i];
        let yMap = map.get(v.x);
        if (!yMap) {
            yMap = new Map();
            map.set(v.x, yMap);
        }
        let zMap = yMap.get(v.y);
        if (!zMap) {
            zMap = new Map();
            yMap.set(v.y, zMap);
        }
        zMap.set(v.z, i);
    }
    return map;
}

function lookupCoordMap(
    map: Map<number, Map<number, Map<number, number>>>,
    x: number,
    y: number,
    z: number,
): number {
    return map.get(x)?.get(y)?.get(z) ?? -1;
}

/**
 * Applies morphological 3D voxel filtering:
 * - 'close': fills 1-voxel pinholes & thin surface gaps with neighbour-averaged colour.
 * - 'smooth': prunes isolated 1-neighbour spikes and fills 5/6-enclosed pockets.
 * - 'dilate': expands outer shell by +1 block along 6-neighbours.
 * - 'erode': trims exposed outer 1-layer skin (with safety guard against wiping thin shells).
 */
export function applyVoxelMorphology(
    voxels: readonly VoxelColourRecord[],
    mode: TMorphMode,
): { voxels: VoxelColourRecord[]; addedCount: number; removedCount: number } {
    if (voxels.length === 0 || mode === 'none') {
        return {
            voxels: voxels.map((v) => ({ x: v.x, y: v.y, z: v.z, colour: cloneColour(v.colour) })),
            addedCount: 0,
            removedCount: 0,
        };
    }

    const coordMap = buildCoordMap(voxels);
    const keepMask = new Uint8Array(voxels.length);
    keepMask.fill(1);
    const additions: VoxelColourRecord[] = [];
    const seenCandidates = new Map<number, Map<number, Set<number>>>();

    const markCandidateSeen = (x: number, y: number, z: number): boolean => {
        let yMap = seenCandidates.get(x);
        if (!yMap) {
            yMap = new Map();
            seenCandidates.set(x, yMap);
        }
        let zSet = yMap.get(y);
        if (!zSet) {
            zSet = new Set();
            yMap.set(y, zSet);
        }
        if (zSet.has(z)) {
            return false;
        }
        zSet.add(z);
        return true;
    };

    const gatherNeighbourColours = (cx: number, cy: number, cz: number): {
        colours: RGBA[];
        hasOpposingPair: boolean;
    } => {
        const colours: RGBA[] = [];
        const present = new Uint8Array(6);
        for (let k = 0; k < 6; ++k) {
            const d = NEIGHBOURS_6[k];
            const idx = lookupCoordMap(coordMap, cx + d[0], cy + d[1], cz + d[2]);
            if (idx !== -1) {
                present[k] = 1;
                colours.push(voxels[idx].colour);
            }
        }
        const hasOpposingPair = (present[0] === 1 && present[1] === 1) ||
            (present[2] === 1 && present[3] === 1) ||
            (present[4] === 1 && present[5] === 1);
        return { colours, hasOpposingPair };
    };

    if (mode === 'smooth' || mode === 'erode') {
        let keptCount = 0;
        for (let i = 0; i < voxels.length; ++i) {
            const v = voxels[i];
            let nbCount = 0;
            for (let k = 0; k < 6; ++k) {
                const d = NEIGHBOURS_6[k];
                if (lookupCoordMap(coordMap, v.x + d[0], v.y + d[1], v.z + d[2]) !== -1) {
                    ++nbCount;
                }
            }
            const shouldRemove = mode === 'smooth' ? nbCount <= 1 : nbCount < 6;
            if (shouldRemove) {
                keepMask[i] = 0;
            } else {
                ++keptCount;
            }
        }
        // Safety guard: never allow erosion/despeckle to erase the whole mesh
        if (keptCount === 0) {
            keepMask.fill(1);
            return {
                voxels: voxels.map((v) => ({ x: v.x, y: v.y, z: v.z, colour: cloneColour(v.colour) })),
                addedCount: 0,
                removedCount: 0,
            };
        }
    }

    if (mode === 'close' || mode === 'smooth' || mode === 'dilate') {
        for (let i = 0; i < voxels.length; ++i) {
            const v = voxels[i];
            for (let k = 0; k < 6; ++k) {
                const d = NEIGHBOURS_6[k];
                const nx = v.x + d[0];
                const ny = v.y + d[1];
                const nz = v.z + d[2];
                if (lookupCoordMap(coordMap, nx, ny, nz) !== -1) {
                    continue;
                }
                if (!markCandidateSeen(nx, ny, nz)) {
                    continue;
                }
                const { colours, hasOpposingPair } = gatherNeighbourColours(nx, ny, nz);
                const nCount = colours.length;
                let shouldFill = false;
                if (mode === 'dilate') {
                    shouldFill = nCount >= 1;
                } else if (mode === 'close') {
                    shouldFill = nCount >= 4 || (hasOpposingPair && nCount >= 3);
                } else if (mode === 'smooth') {
                    shouldFill = nCount >= 5;
                }
                if (shouldFill) {
                    additions.push({
                        x: nx,
                        y: ny,
                        z: nz,
                        colour: RGBAUtil.averageLinearAlphaWeighted(...colours),
                    });
                }
            }
        }
    }

    const out: VoxelColourRecord[] = [];
    let removedCount = 0;
    for (let i = 0; i < voxels.length; ++i) {
        if (keepMask[i] === 1) {
            const v = voxels[i];
            out.push({ x: v.x, y: v.y, z: v.z, colour: cloneColour(v.colour) });
        } else {
            ++removedCount;
        }
    }
    for (let i = 0; i < additions.length; ++i) {
        out.push(additions[i]);
    }

    return {
        voxels: out,
        addedCount: additions.length,
        removedCount,
    };
}

/**
 * Mirrors existing voxels across the model bounding-box center along X, Z, or both axes,
 * filling only missing symmetric cells while preserving all original voxels.
 */
export function computeMirroredVoxels(
    voxels: readonly VoxelColourRecord[],
    axis: TVoxelMirrorAxis,
): { voxels: VoxelColourRecord[]; addedCount: number } {
    if (voxels.length === 0 || axis === 'none') {
        return {
            voxels: voxels.map((v) => ({ x: v.x, y: v.y, z: v.z, colour: cloneColour(v.colour) })),
            addedCount: 0,
        };
    }

    const bounds = getBounds(voxels);
    const coordMap = buildCoordMap(voxels);
    const out: VoxelColourRecord[] = voxels.map((v) => ({
        x: v.x,
        y: v.y,
        z: v.z,
        colour: cloneColour(v.colour),
    }));

    const seenAdded = new Map<number, Map<number, Set<number>>>();
    let addedCount = 0;

    const tryAdd = (x: number, y: number, z: number, colour: RGBA) => {
        if (lookupCoordMap(coordMap, x, y, z) !== -1) {
            return;
        }
        let yMap = seenAdded.get(x);
        if (!yMap) {
            yMap = new Map();
            seenAdded.set(x, yMap);
        }
        let zSet = yMap.get(y);
        if (!zSet) {
            zSet = new Set();
            yMap.set(y, zSet);
        }
        if (zSet.has(z)) {
            return;
        }
        zSet.add(z);
        out.push({ x, y, z, colour: cloneColour(colour) });
        ++addedCount;
    };

    const sumX = bounds.minX + bounds.maxX;
    const sumZ = bounds.minZ + bounds.maxZ;

    for (let i = 0; i < voxels.length; ++i) {
        const v = voxels[i];
        const mx = sumX - v.x;
        const mz = sumZ - v.z;
        if (axis === 'x') {
            tryAdd(mx, v.y, v.z, v.colour);
        } else if (axis === 'z') {
            tryAdd(v.x, v.y, mz, v.colour);
        } else if (axis === 'xz') {
            tryAdd(mx, v.y, v.z, v.colour);
            tryAdd(v.x, v.y, mz, v.colour);
            tryAdd(mx, v.y, mz, v.colour);
        }
    }

    return { voxels: out, addedCount };
}

/**
 * Extrudes a flat structural plinth of `thickness` layers beneath the lowest footprint (`minY`),
 * inheriting each base column's colour.
 */
export function computeBasePlinthVoxels(
    voxels: readonly VoxelColourRecord[],
    thickness: number = 1,
): { voxels: VoxelColourRecord[]; addedCount: number } {
    const safeThickness = Number.isFinite(thickness) ? Math.max(1, Math.min(8, Math.floor(thickness))) : 1;
    if (voxels.length === 0) {
        return { voxels: [], addedCount: 0 };
    }

    let minY = Infinity;
    for (let i = 0; i < voxels.length; ++i) {
        if (voxels[i].y < minY) {
            minY = voxels[i].y;
        }
    }

    const coordMap = buildCoordMap(voxels);
    const out: VoxelColourRecord[] = voxels.map((v) => ({
        x: v.x,
        y: v.y,
        z: v.z,
        colour: cloneColour(v.colour),
    }));

    let addedCount = 0;
    for (let i = 0; i < voxels.length; ++i) {
        const v = voxels[i];
        if (v.y !== minY) {
            continue;
        }
        for (let dy = 1; dy <= safeThickness; ++dy) {
            const py = minY - dy;
            if (lookupCoordMap(coordMap, v.x, py, v.z) === -1) {
                out.push({ x: v.x, y: py, z: v.z, colour: cloneColour(v.colour) });
                ++addedCount;
            }
        }
    }

    return { voxels: out, addedCount };
}

/**
 * Given a watertight boundary shell, flood-fills exterior air in a padded 3D grid,
 * then propagates surface colours inward layer-by-layer to fill every enclosed interior voxel.
 * Returns only the newly generated interior voxels.
 */
export function computeFloodSolidInterior(shellVoxels: readonly VoxelColourRecord[]): VoxelColourRecord[] {
    if (shellVoxels.length === 0) {
        return [];
    }

    const { minX, minY, minZ, maxX, maxY, maxZ } = getBounds(shellVoxels);
    const ox = minX - 1;
    const oy = minY - 1;
    const oz = minZ - 1;
    const sx = (maxX - minX) + 3;
    const sy = (maxY - minY) + 3;
    const sz = (maxZ - minZ) + 3;
    const totalCells = sx * sy * sz;

    if (!Number.isFinite(totalCells) || totalCells <= 0 || totalCells > MAX_GRID_CELLS) {
        return [];
    }

    // 0 = unvisited / interior, 1 = shell or resolved interior, 2 = exterior air
    const state = new Uint8Array(totalCells);
    const colR = new Float32Array(totalCells);
    const colG = new Float32Array(totalCells);
    const colB = new Float32Array(totalCells);
    const colA = new Float32Array(totalCells);

    const idxOf = (gx: number, gy: number, gz: number) => (gy * sz + gz) * sx + gx;

    const shellQueue = new Int32Array(totalCells);
    let fillHead = 0;
    let fillTail = 0;

    for (let i = 0; i < shellVoxels.length; ++i) {
        const v = shellVoxels[i];
        const c = idxOf(v.x - ox, v.y - oy, v.z - oz);
        state[c] = 1;
        colR[c] = v.colour.r;
        colG[c] = v.colour.g;
        colB[c] = v.colour.b;
        colA[c] = v.colour.a;
        shellQueue[fillTail++] = c;
    }

    // 1. Exterior 6-connected air flood-fill from padded corner (0, 0, 0)
    const airQueue = new Int32Array(totalCells);
    let airHead = 0;
    let airTail = 0;
    state[0] = 2;
    airQueue[airTail++] = 0;

    const strideY = sx * sz;
    const strideZ = sx;

    while (airHead < airTail) {
        const c = airQueue[airHead++];
        const gx = c % sx;
        const rem = (c - gx) / sx;
        const gz = rem % sz;
        const gy = (rem - gz) / sz;

        if (gx > 0 && state[c - 1] === 0) { state[c - 1] = 2; airQueue[airTail++] = c - 1; }
        if (gx + 1 < sx && state[c + 1] === 0) { state[c + 1] = 2; airQueue[airTail++] = c + 1; }
        if (gz > 0 && state[c - strideZ] === 0) { state[c - strideZ] = 2; airQueue[airTail++] = c - strideZ; }
        if (gz + 1 < sz && state[c + strideZ] === 0) { state[c + strideZ] = 2; airQueue[airTail++] = c + strideZ; }
        if (gy > 0 && state[c - strideY] === 0) { state[c - strideY] = 2; airQueue[airTail++] = c - strideY; }
        if (gy + 1 < sy && state[c + strideY] === 0) { state[c + strideY] = 2; airQueue[airTail++] = c + strideY; }
    }

    // 2. Multi-source BFS inward from shell into remaining state === 0 interior cells
    const addedInterior: VoxelColourRecord[] = [];
    const offsets = [-1, 1, -strideZ, strideZ, -strideY, strideY];

    while (fillHead < fillTail) {
        const c = shellQueue[fillHead++];
        const gx = c % sx;
        const rem = (c - gx) / sx;
        const gz = rem % sz;
        const gy = (rem - gz) / sz;

        const canMove = [
            gx > 0,
            gx + 1 < sx,
            gz > 0,
            gz + 1 < sz,
            gy > 0,
            gy + 1 < sy,
        ];

        for (let k = 0; k < 6; ++k) {
            if (!canMove[k]) continue;
            const nc = c + offsets[k];
            if (state[nc] !== 0) continue;

            const ngx = nc % sx;
            const nrem = (nc - ngx) / sx;
            const ngz = nrem % sz;
            const ngy = (nrem - ngz) / sz;

            // Average colours of already-resolved 6-neighbours around nc for smooth interior fill
            const nbColours: RGBA[] = [];
            if (ngx > 0 && state[nc - 1] === 1) nbColours.push({ r: colR[nc - 1], g: colG[nc - 1], b: colB[nc - 1], a: colA[nc - 1] });
            if (ngx + 1 < sx && state[nc + 1] === 1) nbColours.push({ r: colR[nc + 1], g: colG[nc + 1], b: colB[nc + 1], a: colA[nc + 1] });
            if (ngz > 0 && state[nc - strideZ] === 1) nbColours.push({ r: colR[nc - strideZ], g: colG[nc - strideZ], b: colB[nc - strideZ], a: colA[nc - strideZ] });
            if (ngz + 1 < sz && state[nc + strideZ] === 1) nbColours.push({ r: colR[nc + strideZ], g: colG[nc + strideZ], b: colB[nc + strideZ], a: colA[nc + strideZ] });
            if (ngy > 0 && state[nc - strideY] === 1) nbColours.push({ r: colR[nc - strideY], g: colG[nc - strideY], b: colB[nc - strideY], a: colA[nc - strideY] });
            if (ngy + 1 < sy && state[nc + strideY] === 1) nbColours.push({ r: colR[nc + strideY], g: colG[nc + strideY], b: colB[nc + strideY], a: colA[nc + strideY] });

            const resolvedColour = nbColours.length > 0 ?
                RGBAUtil.averageLinearAlphaWeighted(...nbColours) :
                { r: colR[c], g: colG[c], b: colB[c], a: colA[c] };

            state[nc] = 1;
            colR[nc] = resolvedColour.r;
            colG[nc] = resolvedColour.g;
            colB[nc] = resolvedColour.b;
            colA[nc] = resolvedColour.a;
            shellQueue[fillTail++] = nc;

            addedInterior.push({
                x: ngx + ox,
                y: ngy + oy,
                z: ngz + oz,
                colour: resolvedColour,
            });
        }
    }

    return addedInterior;
}
