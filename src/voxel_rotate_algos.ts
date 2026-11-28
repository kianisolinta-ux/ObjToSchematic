import { RGBA, RGBAUtil } from './colour';
import { VoxelColourRecord } from './voxel_postprocess';

const DEG_TO_RAD = Math.PI / 180;
const RIGHT_ANGLE_EPS = 1e-6;
const MATRIX_ZERO_EPS = 1e-12;
export const MAX_DENSE_GRID_CELLS = 8_000_000;

export const DIRS6: readonly [number, number, number][] = [
    [1, 0, 0], [-1, 0, 0],
    [0, 1, 0], [0, -1, 0],
    [0, 0, 1], [0, 0, -1],
];

export type CoordMap = Map<number, Map<number, Map<number, number>>>;

export interface IDenseSourceGrid {
    grid: Int32Array; // -3 = enclosed interior, -1 = exterior empty, >= 0 = source voxel index
    minX: number;
    minY: number;
    minZ: number;
    sx: number;
    sy: number;
    sz: number;
}

export type RotationMatrix9 = [
    number, number, number,
    number, number, number,
    number, number, number,
];

export interface ISourceHoleRepairContext {
    sourceVoxels: readonly VoxelColourRecord[];
    lookupSourceCode: (x: number, y: number, z: number) => number;
    cx: number;
    cy: number;
    cz: number;
    m: RotationMatrix9;
    hasCavities: boolean;
}

/**
 * 256-entry lookup table identifying 2x2x2 source cells whose occupied corners contain
 * a diagonal disconnection (face-diagonal or space-diagonal without an edge-connected path
 * inside the cell).
 */
export const SADDLE_LUT = (() => {
    const lut = new Uint8Array(256);
    for (let mask = 0; mask < 256; ++mask) {
        let saddle = false;
        for (let a = 0; a < 8 && !saddle; ++a) {
            if ((mask & (1 << a)) === 0) {
                continue;
            }
            for (let b = a + 1; b < 8; ++b) {
                if ((mask & (1 << b)) === 0) {
                    continue;
                }
                const diff = a ^ b;
                const bits = (diff & 1) + ((diff >> 1) & 1) + ((diff >> 2) & 1);
                if (bits === 2) {
                    const lsb = diff & -diff;
                    const m1 = a ^ lsb;
                    const m2 = b ^ lsb;
                    if ((mask & (1 << m1)) === 0 && (mask & (1 << m2)) === 0) {
                        saddle = true;
                        break;
                    }
                } else if (bits === 3) {
                    let vis = 1 << a;
                    const q = [a];
                    while (q.length > 0) {
                        const cur = q.pop()!;
                        for (const step of [1, 2, 4]) {
                            const nxt = cur ^ step;
                            if ((mask & (1 << nxt)) !== 0 && (vis & (1 << nxt)) === 0) {
                                vis |= (1 << nxt);
                                q.push(nxt);
                            }
                        }
                    }
                    if ((vis & (1 << b)) === 0) {
                        saddle = true;
                        break;
                    }
                }
            }
        }
        lut[mask] = saddle ? 1 : 0;
    }
    return lut;
})();

// Precomputed 3x3x3 neighbourhood tables for exact (26, 6) 3D simple-point topology checks.
export const N26_ADJ: number[][] = [];
export const N18_ADJ: number[][] = [];
export const N6_IDXS: number[] = [];
export const N18_MASK = (() => {
    let m = 0;
    for (let i = 0; i < 27; ++i) {
        if (i === 13) {
            N26_ADJ.push([]);
            N18_ADJ.push([]);
            continue;
        }
        const x1 = Math.floor(i / 9) - 1;
        const y1 = Math.floor((i % 9) / 3) - 1;
        const z1 = (i % 3) - 1;
        const manh1 = Math.abs(x1) + Math.abs(y1) + Math.abs(z1);
        if (manh1 === 1) {
            N6_IDXS.push(i);
        }
        if (manh1 <= 2) {
            m |= (1 << i);
        }
        const a26: number[] = [];
        const a18: number[] = [];
        for (let j = 0; j < 27; ++j) {
            if (j === 13 || j === i) {
                continue;
            }
            const x2 = Math.floor(j / 9) - 1;
            const y2 = Math.floor((j % 9) / 3) - 1;
            const z2 = (j % 3) - 1;
            const dx = Math.abs(x1 - x2);
            const dy = Math.abs(y1 - y2);
            const dz = Math.abs(z1 - z2);
            if (dx <= 1 && dy <= 1 && dz <= 1) {
                a26.push(j);
            }
            if (dx + dy + dz === 1) {
                a18.push(j);
            }
        }
        N26_ADJ.push(a26);
        N18_ADJ.push(a18);
    }
    return m;
})();

/**
 * Returns true iff removing the centre voxel preserves both:
 * 1) Foreground 26-connectivity in N26(p) (never splits sheets, ridges, or tips)
 * 2) Background 6-connectivity of N6(p) inside N18(p) (never opens a 6-connected hole/leak).
 */
export function isSimplePoint26_6(occMask27: number): boolean {
    const fg = occMask27 & ~(1 << 13);
    if (fg === 0) {
        return false;
    }
    const firstFg = 31 - Math.clz32(fg);
    let visFg = 1 << firstFg;
    const qFg = [firstFg];
    while (qFg.length > 0) {
        const cur = qFg.pop()!;
        const neighbors = N26_ADJ[cur];
        for (let i = 0; i < neighbors.length; ++i) {
            const nxt = neighbors[i];
            const bit = 1 << nxt;
            if ((fg & bit) !== 0 && (visFg & bit) === 0) {
                visFg |= bit;
                qFg.push(nxt);
            }
        }
    }
    if (visFg !== fg) {
        return false;
    }

    const bg18 = (~occMask27) & N18_MASK;
    let firstBg6 = -1;
    let bg6Mask = 0;
    for (let i = 0; i < N6_IDXS.length; ++i) {
        const idx6 = N6_IDXS[i];
        const bit = 1 << idx6;
        if ((bg18 & bit) !== 0) {
            bg6Mask |= bit;
            if (firstBg6 === -1) {
                firstBg6 = idx6;
            }
        }
    }
    if (firstBg6 === -1) {
        return false;
    }
    let visBg = 1 << firstBg6;
    const qBg = [firstBg6];
    while (qBg.length > 0) {
        const cur = qBg.pop()!;
        const neighbors = N18_ADJ[cur];
        for (let i = 0; i < neighbors.length; ++i) {
            const nxt = neighbors[i];
            const bit = 1 << nxt;
            if ((bg18 & bit) !== 0 && (visBg & bit) === 0) {
                visBg |= bit;
                qBg.push(nxt);
            }
        }
    }
    return (visBg & bg6Mask) === bg6Mask;
}

export function cloneColour(c: RGBA): RGBA {
    return { r: c.r, g: c.g, b: c.b, a: c.a };
}

export function normaliseDegrees(deg: number): number {
    if (!Number.isFinite(deg)) {
        return 0;
    }
    const mod = ((deg % 360) + 360) % 360;
    return Math.abs(mod - 360) < RIGHT_ANGLE_EPS ? 0 : mod;
}

export function isRightAngleMultiple(deg: number): boolean {
    const mod = normaliseDegrees(deg);
    const nearest = Math.round(mod / 90) * 90;
    return Math.abs(mod - nearest) < RIGHT_ANGLE_EPS;
}

function snapZero(v: number): number {
    return Math.abs(v) < MATRIX_ZERO_EPS ? 0 : v;
}

/**
 * Builds the 3x3 rotation matrix R = Rz(z) * Ry(y) * Rx(x),
 * matching Mesh._rotateMesh(pitch=y, roll=x, yaw=z).
 */
export function buildRotationMatrix(rot: { x: number; y: number; z: number }): RotationMatrix9 {
    const cosa = Math.cos(rot.z * DEG_TO_RAD);
    const sina = Math.sin(rot.z * DEG_TO_RAD);

    const cosb = Math.cos(rot.y * DEG_TO_RAD);
    const sinb = Math.sin(rot.y * DEG_TO_RAD);

    const cosc = Math.cos(rot.x * DEG_TO_RAD);
    const sinc = Math.sin(rot.x * DEG_TO_RAD);

    return [
        snapZero(cosa * cosb),
        snapZero(cosa * sinb * sinc - sina * cosc),
        snapZero(cosa * sinb * cosc + sina * sinc),
        snapZero(sina * cosb),
        snapZero(sina * sinb * sinc + cosa * cosc),
        snapZero(sina * sinb * cosc - cosa * sinc),
        snapZero(-sinb),
        snapZero(cosb * sinc),
        snapZero(cosb * cosc),
    ];
}

export function buildCoordMap(voxels: readonly VoxelColourRecord[]): CoordMap {
    const map: CoordMap = new Map();
    for (let i = 0; i < voxels.length; ++i) {
        const v = voxels[i];
        setCoordMap(map, v.x, v.y, v.z, i);
    }
    return map;
}

export function setCoordMap(map: CoordMap, x: number, y: number, z: number, val: number): void {
    let yMap = map.get(x);
    if (!yMap) {
        yMap = new Map();
        map.set(x, yMap);
    }
    let zMap = yMap.get(y);
    if (!zMap) {
        zMap = new Map();
        yMap.set(y, zMap);
    }
    zMap.set(z, val);
}

export function lookupCoordMap(map: CoordMap, x: number, y: number, z: number): number {
    return map.get(x)?.get(y)?.get(z) ?? -1;
}

export function buildDenseSourceGridWithCavities(
    voxels: readonly VoxelColourRecord[],
    minX: number,
    minY: number,
    minZ: number,
    maxX: number,
    maxY: number,
    maxZ: number,
): IDenseSourceGrid | null {
    const bMinX = minX - 1;
    const bMinY = minY - 1;
    const bMinZ = minZ - 1;
    const sx = (maxX + 1) - bMinX + 1;
    const sy = (maxY + 1) - bMinY + 1;
    const sz = (maxZ + 1) - bMinZ + 1;
    const total = sx * sy * sz;
    if (!Number.isSafeInteger(total) || total > MAX_DENSE_GRID_CELLS) {
        return null;
    }

    const grid = new Int32Array(total).fill(-3);
    const sY = sz;
    const sX = sy * sz;
    for (let i = 0; i < voxels.length; ++i) {
        const v = voxels[i];
        grid[(v.x - bMinX) * sX + (v.y - bMinY) * sY + (v.z - bMinZ)] = i;
    }

    const queue = new Int32Array(total);
    let head = 0;
    let tail = 0;
    grid[0] = -1;
    queue[tail++] = 0;

    while (head < tail) {
        const p = queue[head++];
        const x = Math.floor(p / sX);
        const rem = p - x * sX;
        const y = Math.floor(rem / sY);
        const z = rem - y * sY;

        if (x > 0 && grid[p - sX] === -3) {
            grid[p - sX] = -1;
            queue[tail++] = p - sX;
        }
        if (x + 1 < sx && grid[p + sX] === -3) {
            grid[p + sX] = -1;
            queue[tail++] = p + sX;
        }
        if (y > 0 && grid[p - sY] === -3) {
            grid[p - sY] = -1;
            queue[tail++] = p - sY;
        }
        if (y + 1 < sy && grid[p + sY] === -3) {
            grid[p + sY] = -1;
            queue[tail++] = p + sY;
        }
        if (z > 0 && grid[p - 1] === -3) {
            grid[p - 1] = -1;
            queue[tail++] = p - 1;
        }
        if (z + 1 < sz && grid[p + 1] === -3) {
            grid[p + 1] = -1;
            queue[tail++] = p + 1;
        }
    }

    return { grid, minX: bMinX, minY: bMinY, minZ: bMinZ, sx, sy, sz };
}

function makeVisitedTracker() {
    const visited = new Map<number, Map<number, Set<number>>>();
    return (tx: number, ty: number, tz: number): boolean => {
        let yMap = visited.get(tx);
        if (!yMap) {
            yMap = new Map();
            visited.set(tx, yMap);
        }
        let zSet = yMap.get(ty);
        if (!zSet) {
            zSet = new Set();
            yMap.set(ty, zSet);
        }
        if (zSet.has(tz)) {
            return false;
        }
        zSet.add(tz);
        return true;
    };
}

/**
 * 1. Forward Mapping: projects each source voxel through R and rounds to target grid.
 */
export function rotateForward(
    voxels: readonly VoxelColourRecord[],
    cx: number,
    cy: number,
    cz: number,
    m: RotationMatrix9,
): VoxelColourRecord[] {
    const [r00, r01, r02, r10, r11, r12, r20, r21, r22] = m;
    const cellMap = buildCoordMap([]);
    const out: VoxelColourRecord[] = [];
    const bestDistSq: number[] = [];

    for (let i = 0; i < voxels.length; ++i) {
        const v = voxels[i];
        const dx = v.x - cx;
        const dy = v.y - cy;
        const dz = v.z - cz;

        const fx = cx + r00 * dx + r01 * dy + r02 * dz;
        const fy = cy + r10 * dx + r11 * dy + r12 * dz;
        const fz = cz + r20 * dx + r21 * dy + r22 * dz;

        const tx = Math.round(fx);
        const ty = Math.round(fy);
        const tz = Math.round(fz);

        const ddx = fx - tx;
        const ddy = fy - ty;
        const ddz = fz - tz;
        const distSq = ddx * ddx + ddy * ddy + ddz * ddz;

        const existingIdx = lookupCoordMap(cellMap, tx, ty, tz);
        if (existingIdx === -1) {
            setCoordMap(cellMap, tx, ty, tz, out.length);
            bestDistSq.push(distSq);
            out.push({
                x: tx,
                y: ty,
                z: tz,
                colour: cloneColour(v.colour),
            });
        } else if (distSq < bestDistSq[existingIdx]) {
            bestDistSq[existingIdx] = distSq;
            out[existingIdx].colour = cloneColour(v.colour);
        }
    }

    return out;
}

/**
 * 2. Inverse Nearest-Neighbor: sweeps candidate target cells and queries round(R^T * (t - c) + c).
 */
export function rotateNearest(
    voxels: readonly VoxelColourRecord[],
    cx: number,
    cy: number,
    cz: number,
    m: RotationMatrix9,
    lookupSourceCode: (x: number, y: number, z: number) => number,
): VoxelColourRecord[] {
    const [r00, r01, r02, r10, r11, r12, r20, r21, r22] = m;
    const markVisited = makeVisitedTracker();
    const out: VoxelColourRecord[] = [];

    for (let i = 0; i < voxels.length; ++i) {
        const v = voxels[i];
        const dx = v.x - cx;
        const dy = v.y - cy;
        const dz = v.z - cz;

        const baseX = Math.round(cx + r00 * dx + r01 * dy + r02 * dz);
        const baseY = Math.round(cy + r10 * dx + r11 * dy + r12 * dz);
        const baseZ = Math.round(cz + r20 * dx + r21 * dy + r22 * dz);

        for (let ox = -1; ox <= 1; ++ox) {
            const tx = baseX + ox;
            for (let oy = -1; oy <= 1; ++oy) {
                const ty = baseY + oy;
                for (let oz = -1; oz <= 1; ++oz) {
                    const tz = baseZ + oz;
                    if (!markVisited(tx, ty, tz)) {
                        continue;
                    }
                    const vx = tx - cx;
                    const vy = ty - cy;
                    const vz = tz - cz;

                    const sx = Math.round(cx + r00 * vx + r10 * vy + r20 * vz);
                    const sy = Math.round(cy + r01 * vx + r11 * vy + r21 * vz);
                    const sz = Math.round(cz + r02 * vx + r12 * vy + r22 * vz);

                    const code = lookupSourceCode(sx, sy, sz);
                    if (code >= 0) {
                        out.push({
                            x: tx,
                            y: ty,
                            z: tz,
                            colour: cloneColour(voxels[code].colour),
                        });
                    }
                }
            }
        }
    }

    return out;
}

/**
 * 3. Trilinear / 2x2x2 Supersampling: averages trilinear occupancy across 8 sub-samples per target voxel.
 */
export function rotateTrilinear(
    voxels: readonly VoxelColourRecord[],
    cx: number,
    cy: number,
    cz: number,
    m: RotationMatrix9,
    lookupSourceCode: (x: number, y: number, z: number) => number,
    hasCavities: boolean,
): VoxelColourRecord[] {
    const [r00, r01, r02, r10, r11, r12, r20, r21, r22] = m;
    const markVisited = makeVisitedTracker();
    const out: VoxelColourRecord[] = [];

    const samplePoint = (px: number, py: number, pz: number) => {
        const vx = px - cx;
        const vy = py - cy;
        const vz = pz - cz;

        const sx = cx + r00 * vx + r10 * vy + r20 * vz;
        const sy = cy + r01 * vx + r11 * vy + r21 * vz;
        const sz = cz + r02 * vx + r12 * vy + r22 * vz;

        const x0 = Math.floor(sx);
        const y0 = Math.floor(sy);
        const z0 = Math.floor(sz);
        const fx = sx - x0;
        const fy = sy - y0;
        const fz = sz - z0;

        let occSolid = 0;
        let occShell = 0;
        let occCavity = 0;
        let bestIdx = -1;
        let bestWeight = -1;

        for (let ix = 0; ix <= 1; ++ix) {
            const wx = ix === 1 ? fx : 1 - fx;
            const pxSrc = x0 + ix;
            for (let iy = 0; iy <= 1; ++iy) {
                const wy = iy === 1 ? fy : 1 - fy;
                const pySrc = y0 + iy;
                const wxy = wx * wy;
                for (let iz = 0; iz <= 1; ++iz) {
                    const pzSrc = z0 + iz;
                    const w = wxy * (iz === 1 ? fz : 1 - fz);
                    const code = lookupSourceCode(pxSrc, pySrc, pzSrc);
                    if (code === -1) {
                        continue;
                    }
                    occSolid += w;
                    if (code === -3) {
                        occCavity += w;
                    } else if (code >= 0) {
                        occShell += w;
                        if (w > bestWeight) {
                            bestWeight = w;
                            bestIdx = code;
                        }
                    }
                }
            }
        }
        return { occSolid, occShell, occCavity, bestIdx };
    };

    for (let i = 0; i < voxels.length; ++i) {
        const v = voxels[i];
        const dx = v.x - cx;
        const dy = v.y - cy;
        const dz = v.z - cz;

        const baseX = Math.round(cx + r00 * dx + r01 * dy + r02 * dz);
        const baseY = Math.round(cy + r10 * dx + r11 * dy + r12 * dz);
        const baseZ = Math.round(cz + r20 * dx + r21 * dy + r22 * dz);

        for (let ox = -1; ox <= 1; ++ox) {
            const tx = baseX + ox;
            for (let oy = -1; oy <= 1; ++oy) {
                const ty = baseY + oy;
                for (let oz = -1; oz <= 1; ++oz) {
                    const tz = baseZ + oz;
                    if (!markVisited(tx, ty, tz)) {
                        continue;
                    }

                    const center = samplePoint(tx, ty, tz);
                    if (center.bestIdx === -1 && !hasCavities) {
                        continue;
                    }

                    let sumSolid = 0;
                    let sumShell = 0;
                    let sumCavity = 0;
                    let bestIdx = center.bestIdx;

                    for (let sx = 0; sx <= 1; ++sx) {
                        const subX = tx + (sx === 0 ? -0.25 : 0.25);
                        for (let sy = 0; sy <= 1; ++sy) {
                            const subY = ty + (sy === 0 ? -0.25 : 0.25);
                            for (let sz = 0; sz <= 1; ++sz) {
                                const subZ = tz + (sz === 0 ? -0.25 : 0.25);
                                const s = samplePoint(subX, subY, subZ);
                                sumSolid += s.occSolid;
                                sumShell += s.occShell;
                                sumCavity += s.occCavity;
                                if (bestIdx === -1 && s.bestIdx !== -1) {
                                    bestIdx = s.bestIdx;
                                }
                            }
                        }
                    }

                    if (bestIdx === -1) {
                        continue;
                    }

                    const avgSolid = sumSolid * 0.125;
                    const avgShell = sumShell * 0.125;
                    const avgCavity = sumCavity * 0.125;

                    if (hasCavities && avgShell < 0.08 && avgCavity >= 0.45) {
                        continue;
                    }

                    if (avgSolid >= 0.5 || center.occSolid >= 0.5) {
                        out.push({
                            x: tx,
                            y: ty,
                            z: tz,
                            colour: cloneColour(voxels[bestIdx].colour),
                        });
                    }
                }
            }
        }
    }

    return out;
}

/**
 * 4. 3D Shear (Paeth): decomposes Euler rotations Rx -> Ry -> Rz into exact 90° turns + 1D shear passes.
 */
export function rotateShearPaeth(
    voxels: readonly VoxelColourRecord[],
    cx: number,
    cy: number,
    cz: number,
    nx: number,
    ny: number,
    nz: number,
): VoxelColourRecord[] {
    if (voxels.length === 0) {
        return [];
    }

    const work = voxels.map((v) => ({
        x: Math.round(v.x),
        y: Math.round(v.y),
        z: Math.round(v.z),
        colour: cloneColour(v.colour),
    }));

    const factorAngle = (deg: number): { q: number; rem: number } => {
        const mod = normaliseDegrees(deg);
        const q = Math.round(mod / 90) * 90;
        const rem = mod - q;
        return { q: q % 360, rem };
    };

    const applyAxisX = (deg: number) => {
        const { q, rem } = factorAngle(deg);
        if (q === 90 || q === 180 || q === 270) {
            const first = work[0];
            const dy0 = first.y - cy;
            const dz0 = first.z - cz;
            let ry0 = first.y;
            let rz0 = first.z;
            if (q === 90) {
                ry0 = cy - dz0;
                rz0 = cz + dy0;
            } else if (q === 180) {
                ry0 = cy - dy0;
                rz0 = cz - dz0;
            } else {
                ry0 = cy + dz0;
                rz0 = cz - dy0;
            }
            const shiftY = Math.round(ry0) - ry0;
            const shiftZ = Math.round(rz0) - rz0;
            for (let i = 0; i < work.length; ++i) {
                const v = work[i];
                const dy = v.y - cy;
                const dz = v.z - cz;
                if (q === 90) {
                    v.y = Math.round(cy - dz + shiftY);
                    v.z = Math.round(cz + dy + shiftZ);
                } else if (q === 180) {
                    v.y = Math.round(cy - dy + shiftY);
                    v.z = Math.round(cz - dz + shiftZ);
                } else {
                    v.y = Math.round(cy + dz + shiftY);
                    v.z = Math.round(cz - dy + shiftZ);
                }
            }
        }
        if (Math.abs(rem) > RIGHT_ANGLE_EPS) {
            const theta = rem * DEG_TO_RAD;
            const a = -Math.tan(theta * 0.5);
            const b = Math.sin(theta);
            for (let i = 0; i < work.length; ++i) {
                const v = work[i];
                v.y = Math.round(v.y + a * (v.z - cz));
                v.z = Math.round(v.z + b * (v.y - cy));
                v.y = Math.round(v.y + a * (v.z - cz));
            }
        }
    };

    const applyAxisY = (deg: number) => {
        const { q, rem } = factorAngle(deg);
        if (q === 90 || q === 180 || q === 270) {
            const first = work[0];
            const dx0 = first.x - cx;
            const dz0 = first.z - cz;
            let rx0 = first.x;
            let rz0 = first.z;
            if (q === 90) {
                rx0 = cx + dz0;
                rz0 = cz - dx0;
            } else if (q === 180) {
                rx0 = cx - dx0;
                rz0 = cz - dz0;
            } else {
                rx0 = cx - dz0;
                rz0 = cz + dx0;
            }
            const shiftX = Math.round(rx0) - rx0;
            const shiftZ = Math.round(rz0) - rz0;
            for (let i = 0; i < work.length; ++i) {
                const v = work[i];
                const dx = v.x - cx;
                const dz = v.z - cz;
                if (q === 90) {
                    v.x = Math.round(cx + dz + shiftX);
                    v.z = Math.round(cz - dx + shiftZ);
                } else if (q === 180) {
                    v.x = Math.round(cx - dx + shiftX);
                    v.z = Math.round(cz - dz + shiftZ);
                } else {
                    v.x = Math.round(cx - dz + shiftX);
                    v.z = Math.round(cz + dx + shiftZ);
                }
            }
        }
        if (Math.abs(rem) > RIGHT_ANGLE_EPS) {
            const theta = rem * DEG_TO_RAD;
            const a = -Math.tan(theta * 0.5);
            const b = Math.sin(theta);
            for (let i = 0; i < work.length; ++i) {
                const v = work[i];
                v.z = Math.round(v.z + a * (v.x - cx));
                v.x = Math.round(v.x + b * (v.z - cz));
                v.z = Math.round(v.z + a * (v.x - cx));
            }
        }
    };

    const applyAxisZ = (deg: number) => {
        const { q, rem } = factorAngle(deg);
        if (q === 90 || q === 180 || q === 270) {
            const first = work[0];
            const dx0 = first.x - cx;
            const dy0 = first.y - cy;
            let rx0 = first.x;
            let ry0 = first.y;
            if (q === 90) {
                rx0 = cx - dy0;
                ry0 = cy + dx0;
            } else if (q === 180) {
                rx0 = cx - dx0;
                ry0 = cy - dy0;
            } else {
                rx0 = cx + dy0;
                ry0 = cy - dx0;
            }
            const shiftX = Math.round(rx0) - rx0;
            const shiftY = Math.round(ry0) - ry0;
            for (let i = 0; i < work.length; ++i) {
                const v = work[i];
                const dx = v.x - cx;
                const dy = v.y - cy;
                if (q === 90) {
                    v.x = Math.round(cx - dy + shiftX);
                    v.y = Math.round(cy + dx + shiftY);
                } else if (q === 180) {
                    v.x = Math.round(cx - dx + shiftX);
                    v.y = Math.round(cy - dy + shiftY);
                } else {
                    v.x = Math.round(cx + dy + shiftX);
                    v.y = Math.round(cy - dx + shiftY);
                }
            }
        }
        if (Math.abs(rem) > RIGHT_ANGLE_EPS) {
            const theta = rem * DEG_TO_RAD;
            const a = -Math.tan(theta * 0.5);
            const b = Math.sin(theta);
            for (let i = 0; i < work.length; ++i) {
                const v = work[i];
                v.x = Math.round(v.x + a * (v.y - cy));
                v.y = Math.round(v.y + b * (v.x - cx));
                v.x = Math.round(v.x + a * (v.y - cy));
            }
        }
    };

    applyAxisX(nx);
    applyAxisY(ny);
    applyAxisZ(nz);

    return work;
}

/**
 * 6. 3D Upscale x2 (RotSprite-style): evaluates 3D Scale2x/bevel upscaled sub-octants on-the-fly,
 * rotates in 2x resolution space, and downsamples 2x2x2 -> 1x with colour voting.
 */
export function rotateRotSprite2x(
    voxels: readonly VoxelColourRecord[],
    cx: number,
    cy: number,
    cz: number,
    m: RotationMatrix9,
    lookupSourceCode: (x: number, y: number, z: number) => number,
    hasCavities: boolean,
): VoxelColourRecord[] {
    const [r00, r01, r02, r10, r11, r12, r20, r21, r22] = m;
    const markVisited = makeVisitedTracker();
    const out: VoxelColourRecord[] = [];

    const isSolidCode = (code: number) => code !== -1;

    // On-the-fly 3D Scale2x / morphological octant test at 2x coordinate (hx, hy, hz)
    const sample2x = (hx: number, hy: number, hz: number): { solid: boolean; cavity: boolean; code: number } => {
        const sx = Math.floor(hx / 2);
        const sy = Math.floor(hy / 2);
        const sz = Math.floor(hz / 2);
        const ox = (hx & 1) === 1 ? 1 : -1;
        const oy = (hy & 1) === 1 ? 1 : -1;
        const oz = (hz & 1) === 1 ? 1 : -1;

        const centerCode = lookupSourceCode(sx, sy, sz);
        const centerSolid = isSolidCode(centerCode);

        const cX = lookupSourceCode(sx + ox, sy, sz);
        const cY = lookupSourceCode(sx, sy + oy, sz);
        const cZ = lookupSourceCode(sx, sy, sz + oz);
        const sX = isSolidCode(cX);
        const sY = isSolidCode(cY);
        const sZ = isSolidCode(cZ);

        if (centerSolid) {
            // Keep solid octant unless it is an exposed outer staircase tip on >=2 axes
            const oX = isSolidCode(lookupSourceCode(sx - ox, sy, sz));
            const oY = isSolidCode(lookupSourceCode(sx, sy - oy, sz));
            const oZ = isSolidCode(lookupSourceCode(sx, sy, sz - oz));
            const diagXY = isSolidCode(lookupSourceCode(sx + ox, sy + oy, sz));
            const diagXZ = isSolidCode(lookupSourceCode(sx + ox, sy, sz + oz));
            const diagYZ = isSolidCode(lookupSourceCode(sx, sy + oy, sz + oz));
            const bevelOuter =
                (!sX && !sY && oX && oY && !diagXY) ||
                (!sX && !sZ && oX && oZ && !diagXZ) ||
                (!sY && !sZ && oY && oZ && !diagYZ);

            if (bevelOuter) {
                return { solid: false, cavity: false, code: -1 };
            }
            return {
                solid: true,
                cavity: centerCode === -3,
                code: centerCode >= 0 ? centerCode : -1,
            };
        }

        // Empty cell: fill inner concave staircase step if at least 2 adjacent directions are solid
        const oX = isSolidCode(lookupSourceCode(sx - ox, sy, sz));
        const oY = isSolidCode(lookupSourceCode(sx, sy - oy, sz));
        const oZ = isSolidCode(lookupSourceCode(sx, sy, sz - oz));
        const fillInner =
            (sX && sY && !oX && !oY) ||
            (sX && sZ && !oX && !oZ) ||
            (sY && sZ && !oY && !oZ);

        if (!fillInner) {
            return { solid: false, cavity: false, code: -1 };
        }
        const pickCode = cX >= 0 ? cX : (cY >= 0 ? cY : cZ);
        return {
            solid: true,
            cavity: pickCode === -1,
            code: pickCode >= 0 ? pickCode : -1,
        };
    };

    for (let i = 0; i < voxels.length; ++i) {
        const v = voxels[i];
        const dx = v.x - cx;
        const dy = v.y - cy;
        const dz = v.z - cz;

        const baseX = Math.round(cx + r00 * dx + r01 * dy + r02 * dz);
        const baseY = Math.round(cy + r10 * dx + r11 * dy + r12 * dz);
        const baseZ = Math.round(cz + r20 * dx + r21 * dy + r22 * dz);

        for (let ox = -1; ox <= 1; ++ox) {
            const tx = baseX + ox;
            for (let oy = -1; oy <= 1; ++oy) {
                const ty = baseY + oy;
                for (let oz = -1; oz <= 1; ++oz) {
                    const tz = baseZ + oz;
                    if (!markVisited(tx, ty, tz)) {
                        continue;
                    }

                    let solidHits = 0;
                    let cavityHits = 0;
                    let shellHits = 0;
                    const hitColours: RGBA[] = [];

                    for (let ux = 0; ux <= 1; ++ux) {
                        const px = tx + (ux === 0 ? -0.25 : 0.25) - cx;
                        for (let uy = 0; uy <= 1; ++uy) {
                            const py = ty + (uy === 0 ? -0.25 : 0.25) - cy;
                            for (let uz = 0; uz <= 1; ++uz) {
                                const pz = tz + (uz === 0 ? -0.25 : 0.25) - cz;
                                const sx = cx + r00 * px + r10 * py + r20 * pz;
                                const sy = cy + r01 * px + r11 * py + r21 * pz;
                                const sz = cz + r02 * px + r12 * py + r22 * pz;

                                const hx = Math.floor(2 * (sx + 0.5));
                                const hy = Math.floor(2 * (sy + 0.5));
                                const hz = Math.floor(2 * (sz + 0.5));
                                const res = sample2x(hx, hy, hz);
                                if (res.solid) {
                                    solidHits++;
                                    if (res.cavity) {
                                        cavityHits++;
                                    } else if (res.code >= 0) {
                                        shellHits++;
                                        hitColours.push(voxels[res.code].colour);
                                    }
                                }
                            }
                        }
                    }

                    if (hitColours.length === 0) {
                        continue;
                    }
                    if (hasCavities && shellHits === 0 && cavityHits >= 4) {
                        continue;
                    }
                    if (solidHits >= 4) {
                        out.push({
                            x: tx,
                            y: ty,
                            z: tz,
                            colour: RGBAUtil.averageLinearAlphaWeighted(...hitColours),
                        });
                    }
                }
            }
        }
    }

    return out;
}

interface ISurfaceNetsMesh {
    verts: Float64Array; // [x0, y0, z0, x1, y1, z1, ...]
    tris: Int32Array;    // [i0, i1, i2, ...]
}

function extractSurfaceNetsMesh(
    grid: Int32Array,
    minX: number,
    minY: number,
    minZ: number,
    sx: number,
    sy: number,
    sz: number,
    isInsideFn: (code: number) => boolean,
): ISurfaceNetsMesh {
    const sY = sz;
    const sX = sy * sz;

    const csx = sx - 1;
    const csy = sy - 1;
    const csz = sz - 1;
    const csY = csz;
    const csX = csy * csz;

    const cellVertIdx = new Int32Array(csx * csy * csz).fill(-1);
    const vertList: number[] = [];

    const edgeCorners: readonly [number, number][] = [
        [0, 1], [2, 3], [4, 5], [6, 7],
        [0, 2], [1, 3], [4, 6], [5, 7],
        [0, 4], [1, 5], [2, 6], [3, 7],
    ];
    const cornerPos: readonly [number, number, number][] = [
        [0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0],
        [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1],
    ];

    for (let cx = 0; cx < csx; ++cx) {
        for (let cy = 0; cy < csy; ++cy) {
            for (let cz = 0; cz < csz; ++cz) {
                let mask = 0;
                const pBase = cx * sX + cy * sY + cz;
                if (isInsideFn(grid[pBase])) mask |= 1;
                if (isInsideFn(grid[pBase + sX])) mask |= 2;
                if (isInsideFn(grid[pBase + sY])) mask |= 4;
                if (isInsideFn(grid[pBase + sX + sY])) mask |= 8;
                if (isInsideFn(grid[pBase + 1])) mask |= 16;
                if (isInsideFn(grid[pBase + sX + 1])) mask |= 32;
                if (isInsideFn(grid[pBase + sY + 1])) mask |= 64;
                if (isInsideFn(grid[pBase + sX + sY + 1])) mask |= 128;

                if (mask === 0 || mask === 255) {
                    continue;
                }

                let ax = 0;
                let ay = 0;
                let az = 0;
                let crossings = 0;
                for (let e = 0; e < 12; ++e) {
                    const [a, b] = edgeCorners[e];
                    if (((mask >> a) & 1) !== ((mask >> b) & 1)) {
                        const pa = cornerPos[a];
                        const pb = cornerPos[b];
                        ax += 0.5 * (pa[0] + pb[0]);
                        ay += 0.5 * (pa[1] + pb[1]);
                        az += 0.5 * (pa[2] + pb[2]);
                        crossings++;
                    }
                }

                const vIdx = vertList.length / 3;
                cellVertIdx[cx * csX + cy * csY + cz] = vIdx;
                vertList.push(
                    minX + cx + ax / crossings,
                    minY + cy + ay / crossings,
                    minZ + cz + az / crossings,
                );
            }
        }
    }

    const triList: number[] = [];
    const emitQuad = (i0: number, i1: number, i2: number, i3: number, flip: boolean) => {
        if (i0 < 0 || i1 < 0 || i2 < 0 || i3 < 0) {
            return;
        }
        if (!flip) {
            triList.push(i0, i1, i2, i0, i2, i3);
        } else {
            triList.push(i0, i3, i2, i0, i2, i1);
        }
    };

    // Emit quads for surface-crossing edges along X, Y, Z
    for (let x = 0; x < sx; ++x) {
        for (let y = 0; y < sy; ++y) {
            for (let z = 0; z < sz; ++z) {
                const v0 = isInsideFn(grid[x * sX + y * sY + z]);
                if (x + 1 < sx && y > 0 && y < csy && z > 0 && z < csz) {
                    const v1 = isInsideFn(grid[(x + 1) * sX + y * sY + z]);
                    if (v0 !== v1) {
                        const c00 = cellVertIdx[x * csX + (y - 1) * csY + (z - 1)];
                        const c10 = cellVertIdx[x * csX + y * csY + (z - 1)];
                        const c11 = cellVertIdx[x * csX + y * csY + z];
                        const c01 = cellVertIdx[x * csX + (y - 1) * csY + z];
                        emitQuad(c00, c10, c11, c01, !v0);
                    }
                }
                if (y + 1 < sy && x > 0 && x < csx && z > 0 && z < csz) {
                    const v1 = isInsideFn(grid[x * sX + (y + 1) * sY + z]);
                    if (v0 !== v1) {
                        const c00 = cellVertIdx[(x - 1) * csX + y * csY + (z - 1)];
                        const c10 = cellVertIdx[(x - 1) * csX + y * csY + z];
                        const c11 = cellVertIdx[x * csX + y * csY + z];
                        const c01 = cellVertIdx[x * csX + y * csY + (z - 1)];
                        emitQuad(c00, c10, c11, c01, !v0);
                    }
                }
                if (z + 1 < sz && x > 0 && x < csx && y > 0 && y < csy) {
                    const v1 = isInsideFn(grid[x * sX + y * sY + (z + 1)]);
                    if (v0 !== v1) {
                        const c00 = cellVertIdx[(x - 1) * csX + (y - 1) * csY + z];
                        const c10 = cellVertIdx[x * csX + (y - 1) * csY + z];
                        const c11 = cellVertIdx[x * csX + y * csY + z];
                        const c01 = cellVertIdx[(x - 1) * csX + y * csY + z];
                        emitQuad(c00, c10, c11, c01, !v0);
                    }
                }
            }
        }
    }

    const verts = new Float64Array(vertList);
    const tris = new Int32Array(triList);

    // One shrinkage-free Taubin smoothing pass (lambda = 0.4, mu = -0.41)
    const vCount = verts.length / 3;
    if (vCount > 0 && tris.length > 0) {
        const accum = new Float64Array(verts.length);
        const counts = new Int32Array(vCount);
        const smoothStep = (factor: number) => {
            accum.fill(0);
            counts.fill(0);
            for (let t = 0; t < tris.length; t += 3) {
                const a = tris[t];
                const b = tris[t + 1];
                const c = tris[t + 2];
                const addEdge = (u: number, w: number) => {
                    accum[u * 3] += verts[w * 3];
                    accum[u * 3 + 1] += verts[w * 3 + 1];
                    accum[u * 3 + 2] += verts[w * 3 + 2];
                    counts[u]++;
                };
                addEdge(a, b); addEdge(b, c); addEdge(c, a);
                addEdge(b, a); addEdge(c, b); addEdge(a, c);
            }
            for (let i = 0; i < vCount; ++i) {
                const cnt = counts[i];
                if (cnt > 0) {
                    const inv = 1 / cnt;
                    const i3 = i * 3;
                    verts[i3] += factor * (accum[i3] * inv - verts[i3]);
                    verts[i3 + 1] += factor * (accum[i3 + 1] * inv - verts[i3 + 1]);
                    verts[i3 + 2] += factor * (accum[i3 + 2] * inv - verts[i3 + 2]);
                }
            }
        };
        smoothStep(0.4);
        smoothStep(-0.41);
    }

    return { verts, tris };
}

function voxeliseClosedSurfaceMesh(
    mesh: ISurfaceNetsMesh,
): CoordMap {
    const map = buildCoordMap([]);
    const { verts, tris } = mesh;
    if (verts.length === 0 || tris.length === 0) {
        return map;
    }

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < verts.length; i += 3) {
        const x = verts[i];
        const y = verts[i + 1];
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
    }

    const iMinX = Math.floor(minX) - 1;
    const iMinY = Math.floor(minY) - 1;
    const iMaxX = Math.ceil(maxX) + 1;
    const iMaxY = Math.ceil(maxY) + 1;
    const width = iMaxX - iMinX + 1;
    const height = iMaxY - iMinY + 1;

    const buckets: number[][] = Array.from({ length: width * height }, () => []);
    for (let t = 0; t < tris.length; t += 3) {
        const a = tris[t] * 3;
        const b = tris[t + 1] * 3;
        const c = tris[t + 2] * 3;

        const ax = verts[a]; const ay = verts[a + 1];
        const bx = verts[b]; const by = verts[b + 1];
        const cx = verts[c]; const cy = verts[c + 1];

        const tMinX = Math.max(iMinX, Math.floor(Math.min(ax, bx, cx)));
        const tMaxX = Math.min(iMaxX, Math.ceil(Math.max(ax, bx, cx)));
        const tMinY = Math.max(iMinY, Math.floor(Math.min(ay, by, cy)));
        const tMaxY = Math.min(iMaxY, Math.ceil(Math.max(ay, by, cy)));

        for (let ix = tMinX; ix <= tMaxX; ++ix) {
            const xOff = (ix - iMinX) * height;
            for (let iy = tMinY; iy <= tMaxY; ++iy) {
                buckets[xOff + (iy - iMinY)].push(t);
            }
        }
    }

    const hitsZ: number[] = [];
    const hitsDir: number[] = [];

    for (let ix = iMinX; ix <= iMaxX; ++ix) {
        const rx = ix + 1.13719e-5;
        const xOff = (ix - iMinX) * height;
        for (let iy = iMinY; iy <= iMaxY; ++iy) {
            const triIdxs = buckets[xOff + (iy - iMinY)];
            if (triIdxs.length === 0) {
                continue;
            }
            const ry = iy + 1.79313e-5;
            hitsZ.length = 0;
            hitsDir.length = 0;

            for (let k = 0; k < triIdxs.length; ++k) {
                const t = triIdxs[k];
                const ia = tris[t];
                const ib = tris[t + 1];
                const ic = tris[t + 2];
                const a = ia * 3;
                const b = ib * 3;
                const c = ic * 3;

                const ax = verts[a]; const ay = verts[a + 1]; const az = verts[a + 2];
                const bx = verts[b]; const by = verts[b + 1]; const bz = verts[b + 2];
                const cx = verts[c]; const cy = verts[c + 1]; const cz = verts[c + 2];

                const nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
                if (Math.abs(nz) < 1e-10) {
                    continue;
                }

                const e0 = (bx - rx) * (cy - ry) - (by - ry) * (cx - rx);
                const e1 = (cx - rx) * (ay - ry) - (cy - ry) * (ax - rx);
                const e2 = (ax - rx) * (by - ry) - (ay - ry) * (bx - rx);

                let inside = false;
                if (nz > 0) {
                    inside = (e0 > 0 || (e0 === 0 && ib < ic)) &&
                        (e1 > 0 || (e1 === 0 && ic < ia)) &&
                        (e2 > 0 || (e2 === 0 && ia < ib));
                } else {
                    inside = (e0 < 0 || (e0 === 0 && ib < ic)) &&
                        (e1 < 0 || (e1 === 0 && ic < ia)) &&
                        (e2 < 0 || (e2 === 0 && ia < ib));
                }
                if (!inside) {
                    continue;
                }

                const denom = e0 + e1 + e2;
                if (Math.abs(denom) < 1e-12) {
                    continue;
                }
                const zHit = (e0 * az + e1 * bz + e2 * cz) / denom;
                hitsZ.push(zHit);
                hitsDir.push(nz < 0 ? 1 : -1);
            }

            if (hitsZ.length === 0) {
                continue;
            }

            // Sort crossings by ascending Z
            const order = Array.from({ length: hitsZ.length }, (_, idx) => idx);
            order.sort((p, q) => hitsZ[p] - hitsZ[q]);

            let winding = 0;
            let cursor = 0;
            const zStart = Math.ceil(hitsZ[order[0]]);
            const zEnd = Math.floor(hitsZ[order[order.length - 1]]);
            for (let tz = zStart; tz <= zEnd; ++tz) {
                while (cursor < order.length && hitsZ[order[cursor]] <= tz) {
                    winding += hitsDir[order[cursor]];
                    cursor++;
                }
                if (winding > 0) {
                    setCoordMap(map, ix, iy, tz, 1);
                }
            }
        }
    }

    return map;
}

/**
 * 7. Surface Nets: extracts closed triangle meshes (outer + cavity), rotates continuously in 3D,
 * and re-voxelises onto the integer grid with nearest-source colour transfer.
 */
export function rotateSurfaceNets(
    voxels: readonly VoxelColourRecord[],
    cx: number,
    cy: number,
    cz: number,
    m: RotationMatrix9,
    denseSrc: IDenseSourceGrid | null,
    lookupSourceCode: (x: number, y: number, z: number) => number,
    hasCavities: boolean,
): VoxelColourRecord[] | null {
    if (!denseSrc) {
        return null;
    }

    const [r00, r01, r02, r10, r11, r12, r20, r21, r22] = m;
    const rotateMeshVerts = (mesh: ISurfaceNetsMesh) => {
        const verts = mesh.verts;
        for (let i = 0; i < verts.length; i += 3) {
            const dx = verts[i] - cx;
            const dy = verts[i + 1] - cy;
            const dz = verts[i + 2] - cz;
            verts[i] = cx + r00 * dx + r01 * dy + r02 * dz;
            verts[i + 1] = cy + r10 * dx + r11 * dy + r12 * dz;
            verts[i + 2] = cz + r20 * dx + r21 * dy + r22 * dz;
        }
    };

    const outerMesh = extractSurfaceNetsMesh(
        denseSrc.grid,
        denseSrc.minX,
        denseSrc.minY,
        denseSrc.minZ,
        denseSrc.sx,
        denseSrc.sy,
        denseSrc.sz,
        (code) => code !== -1,
    );
    rotateMeshVerts(outerMesh);
    const outerOcc = voxeliseClosedSurfaceMesh(outerMesh);

    let cavityOcc: CoordMap | null = null;
    if (hasCavities) {
        const cavityMesh = extractSurfaceNetsMesh(
            denseSrc.grid,
            denseSrc.minX,
            denseSrc.minY,
            denseSrc.minZ,
            denseSrc.sx,
            denseSrc.sy,
            denseSrc.sz,
            (code) => code === -3,
        );
        rotateMeshVerts(cavityMesh);
        cavityOcc = voxeliseClosedSurfaceMesh(cavityMesh);
    }

    const findNearestSourceColour = (tx: number, ty: number, tz: number): RGBA | null => {
        const vx = tx - cx;
        const vy = ty - cy;
        const vz = tz - cz;
        const sx = cx + r00 * vx + r10 * vy + r20 * vz;
        const sy = cy + r01 * vx + r11 * vy + r21 * vz;
        const sz = cz + r02 * vx + r12 * vy + r22 * vz;
        const rx = Math.round(sx);
        const ry = Math.round(sy);
        const rz = Math.round(sz);

        for (let radius = 0; radius <= 2; ++radius) {
            let bestCode = -1;
            let bestDist = Infinity;
            for (let ox = -radius; ox <= radius; ++ox) {
                for (let oy = -radius; oy <= radius; ++oy) {
                    for (let oz = -radius; oz <= radius; ++oz) {
                        const code = lookupSourceCode(rx + ox, ry + oy, rz + oz);
                        if (code >= 0) {
                            const ddx = (rx + ox) - sx;
                            const ddy = (ry + oy) - sy;
                            const ddz = (rz + oz) - sz;
                            const d2 = ddx * ddx + ddy * ddy + ddz * ddz;
                            if (d2 < bestDist) {
                                bestDist = d2;
                                bestCode = code;
                            }
                        }
                    }
                }
            }
            if (bestCode >= 0) {
                return cloneColour(voxels[bestCode].colour);
            }
        }
        return null;
    };

    const canCarveCavity = (tx: number, ty: number, tz: number): boolean => {
        if (!cavityOcc || lookupCoordMap(cavityOcc, tx, ty, tz) === -1) {
            return false;
        }
        for (let d = 0; d < 6; ++d) {
            if (lookupCoordMap(outerOcc, tx + DIRS6[d][0], ty + DIRS6[d][1], tz + DIRS6[d][2]) === -1) {
                return false;
            }
        }
        return true;
    };

    const out: VoxelColourRecord[] = [];
    const seen = buildCoordMap([]);

    outerOcc.forEach((yMap, tx) => {
        yMap.forEach((zMap, ty) => {
            zMap.forEach((_, tz) => {
                if (canCarveCavity(tx, ty, tz)) {
                    return;
                }
                const colour = findNearestSourceColour(tx, ty, tz) ?? cloneColour(voxels[0].colour);
                setCoordMap(seen, tx, ty, tz, out.length);
                out.push({ x: tx, y: ty, z: tz, colour });
            });
        });
    });

    // Preserve ultra-thin 1-voxel features that can fall between integer scanlines on tilted sheets
    for (let i = 0; i < voxels.length; ++i) {
        const v = voxels[i];
        let hasSolidPair = false;
        for (let d = 0; d < 6; ++d) {
            if (lookupSourceCode(v.x + DIRS6[d][0], v.y + DIRS6[d][1], v.z + DIRS6[d][2]) >= 0) {
                hasSolidPair = true;
                break;
            }
        }
        const dx = v.x - cx;
        const dy = v.y - cy;
        const dz = v.z - cz;
        const tx = Math.round(cx + r00 * dx + r01 * dy + r02 * dz);
        const ty = Math.round(cy + r10 * dx + r11 * dy + r12 * dz);
        const tz = Math.round(cz + r20 * dx + r21 * dy + r22 * dz);

        if (!hasSolidPair || lookupCoordMap(seen, tx, ty, tz) === -1) {
            let nearCount = 0;
            for (let d = 0; d < 6; ++d) {
                if (lookupCoordMap(seen, tx + DIRS6[d][0], ty + DIRS6[d][1], tz + DIRS6[d][2]) !== -1) {
                    nearCount++;
                }
            }
            if (!hasSolidPair || nearCount === 0) {
                if (lookupCoordMap(seen, tx, ty, tz) === -1 && (!cavityOcc || lookupCoordMap(cavityOcc, tx, ty, tz) === -1)) {
                    setCoordMap(seen, tx, ty, tz, out.length);
                    out.push({ x: tx, y: ty, z: tz, colour: cloneColour(v.colour) });
                }
            }
        }
    }

    return out;
}

function evalSourceAtTarget(
    ctx: ISourceHoleRepairContext,
    tx: number,
    ty: number,
    tz: number,
): { occShell: number; occSolid: number; occCav: number; cellMask: number; bestSrcIdx: number } {
    const [r00, r01, r02, r10, r11, r12, r20, r21, r22] = ctx.m;
    const dx = tx - ctx.cx;
    const dy = ty - ctx.cy;
    const dz = tz - ctx.cz;
    const fx = ctx.cx + r00 * dx + r10 * dy + r20 * dz;
    const fy = ctx.cy + r01 * dx + r11 * dy + r21 * dz;
    const fz = ctx.cz + r02 * dx + r12 * dy + r22 * dz;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const z0 = Math.floor(fz);
    const ax = fx - x0;
    const ay = fy - y0;
    const az = fz - z0;

    let occShell = 0;
    let occSolid = 0;
    let occCav = 0;
    let cellMask = 0;
    let bestSrcIdx = -1;
    let bestW = -1;

    for (let ix = 0; ix <= 1; ++ix) {
        const wx = ix === 1 ? ax : 1 - ax;
        for (let iy = 0; iy <= 1; ++iy) {
            const wxy = wx * (iy === 1 ? ay : 1 - ay);
            for (let iz = 0; iz <= 1; ++iz) {
                const w = wxy * (iz === 1 ? az : 1 - az);
                const code = ctx.lookupSourceCode(x0 + ix, y0 + iy, z0 + iz);
                if (code >= 0) {
                    occShell += w;
                    occSolid += w;
                    cellMask |= 1 << (ix * 4 + iy * 2 + iz);
                    if (w > bestW) {
                        bestW = w;
                        bestSrcIdx = code;
                    }
                } else if (code === -3) {
                    occCav += w;
                    occSolid += w;
                }
            }
        }
    }
    return { occShell, occSolid, occCav, cellMask, bestSrcIdx };
}

function hasOpposing26Bit(mask27: number): boolean {
    for (let i = 0; i < 13; ++i) {
        if ((mask27 & (1 << i)) !== 0 && (mask27 & (1 << (26 - i))) !== 0) {
            return true;
        }
    }
    return false;
}

function isEmptyN6DisconnectedIn27(mask27: number): boolean {
    const bg27 = (~mask27) & ~(1 << 13);
    let first = -1;
    let bg6 = 0;
    for (let i = 0; i < N6_IDXS.length; ++i) {
        const idx6 = N6_IDXS[i];
        const bit = 1 << idx6;
        if ((bg27 & bit) !== 0) {
            bg6 |= bit;
            if (first === -1) {
                first = idx6;
            }
        }
    }
    if (bg6 === 0 || (bg6 & (bg6 - 1)) === 0) {
        return false;
    }
    let vis = 1 << first;
    const q = [first];
    while (q.length > 0) {
        const cur = q.pop()!;
        const neighbors = N18_ADJ[cur];
        for (let i = 0; i < neighbors.length; ++i) {
            const nxt = neighbors[i];
            const bit = 1 << nxt;
            if ((bg27 & bit) !== 0 && (vis & bit) === 0) {
                vis |= bit;
                q.push(nxt);
            }
        }
    }
    return (vis & bg6) !== bg6;
}

function bridgesDisconnected6PairMask(mask27: number): boolean {
    let occN6Mask = 0;
    let firstN6 = -1;
    for (let i = 0; i < N6_IDXS.length; ++i) {
        const idx6 = N6_IDXS[i];
        const bit = 1 << idx6;
        if ((mask27 & bit) !== 0) {
            occN6Mask |= bit;
            if (firstN6 === -1) {
                firstN6 = idx6;
            }
        }
    }
    if (occN6Mask === 0 || (occN6Mask & (occN6Mask - 1)) === 0) {
        return false;
    }
    const fg = mask27 & ~(1 << 13);
    let vis = 1 << firstN6;
    const q = [firstN6];
    while (q.length > 0) {
        const cur = q.pop()!;
        const neighbors = N18_ADJ[cur];
        for (let i = 0; i < neighbors.length; ++i) {
            const nxt = neighbors[i];
            const bit = 1 << nxt;
            if ((fg & bit) !== 0 && (vis & bit) === 0) {
                vis |= bit;
                q.push(nxt);
            }
        }
    }
    return (vis & occN6Mask) !== occN6Mask;
}

/**
 * Closes rotation pinholes, cracks, enclosed wall voids, and diagonal 1-voxel shell tears
 * while keeping intentional >=2x2 openings and enclosed model cavities intact.
 */
export function closeRotationHoles(
    voxels: VoxelColourRecord[],
    sourceContext?: ISourceHoleRepairContext,
): VoxelColourRecord[] {
    if (voxels.length === 0) {
        return [];
    }

    const work = voxels.map((v) => ({
        x: Math.round(v.x),
        y: Math.round(v.y),
        z: Math.round(v.z),
        colour: cloneColour(v.colour),
    }));

    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < work.length; ++i) {
        const v = work[i];
        if (v.x < minX) minX = v.x;
        if (v.y < minY) minY = v.y;
        if (v.z < minZ) minZ = v.z;
        if (v.x > maxX) maxX = v.x;
        if (v.y > maxY) maxY = v.y;
        if (v.z > maxZ) maxZ = v.z;
    }

    const bx = minX - 2;
    const by = minY - 2;
    const bz = minZ - 2;
    const sx = maxX - minX + 5;
    const sy = maxY - minY + 5;
    const sz = maxZ - minZ + 5;
    const sY = sz;
    const sX = sy * sz;
    const total = sx * sX;

    if (!Number.isSafeInteger(total) || total > MAX_DENSE_GRID_CELLS) {
        return closeRotationHolesSparse(work);
    }

    const grid = new Int32Array(total).fill(-1);
    for (let i = 0; i < work.length; ++i) {
        const v = work[i];
        grid[(v.x - bx) * sX + (v.y - by) * sY + (v.z - bz)] = i;
    }

    const getMask27 = (gx: number, gy: number, gz: number): number => {
        let mask = 0;
        const base = (gx - 1) * sX + (gy - 1) * sY + (gz - 1);
        for (let ix = 0; ix < 3; ++ix) {
            const pX = base + ix * sX;
            const bX = ix * 9;
            for (let iy = 0; iy < 3; ++iy) {
                const pXY = pX + iy * sY;
                const bXY = bX + iy * 3;
                if (grid[pXY] >= 0) mask |= 1 << bXY;
                if (grid[pXY + 1] >= 0) mask |= 1 << (bXY + 1);
                if (grid[pXY + 2] >= 0) mask |= 1 << (bXY + 2);
            }
        }
        return mask;
    };

    const gather6Dense = (gx: number, gy: number, gz: number) => {
        const colours: RGBA[] = [];
        const p = gx * sX + gy * sY + gz;
        if (grid[p + sX] >= 0) colours.push(work[grid[p + sX]].colour);
        if (grid[p - sX] >= 0) colours.push(work[grid[p - sX]].colour);
        if (grid[p + sY] >= 0) colours.push(work[grid[p + sY]].colour);
        if (grid[p - sY] >= 0) colours.push(work[grid[p - sY]].colour);
        if (grid[p + 1] >= 0) colours.push(work[grid[p + 1]].colour);
        if (grid[p - 1] >= 0) colours.push(work[grid[p - 1]].colour);
        return colours;
    };

    const gather26Dense = (gx: number, gy: number, gz: number) => {
        const colours: RGBA[] = [];
        for (let dx = -1; dx <= 1; ++dx) {
            for (let dy = -1; dy <= 1; ++dy) {
                for (let dz = -1; dz <= 1; ++dz) {
                    if (dx === 0 && dy === 0 && dz === 0) continue;
                    const idx = grid[(gx + dx) * sX + (gy + dy) * sY + (gz + dz)];
                    if (idx >= 0) {
                        colours.push(work[idx].colour);
                    }
                }
            }
        }
        return colours;
    };

    const pickRepairColour = (gx: number, gy: number, gz: number, bestSrcIdx = -1): RGBA => {
        const c6 = gather6Dense(gx, gy, gz);
        if (c6.length > 0) {
            return RGBAUtil.averageLinearAlphaWeighted(...c6);
        }
        const c26 = gather26Dense(gx, gy, gz);
        if (c26.length > 0) {
            return RGBAUtil.averageLinearAlphaWeighted(...c26);
        }
        if (sourceContext && bestSrcIdx >= 0 && bestSrcIdx < sourceContext.sourceVoxels.length) {
            return cloneColour(sourceContext.sourceVoxels[bestSrcIdx].colour);
        }
        return cloneColour(work[0].colour);
    };

    // Stage 1 (when source geometry context is available):
    // Thin source-verified surface envelope fill + (26, 6) simple-point fringe peeling.
    // Eliminates curved-shell tears and diagonal staircase holes across all 7 algorithms
    // without touching >=2x2 openings or hollow model interiors.
    if (sourceContext) {
        const candFlag = new Uint8Array(total);
        const cands: Array<{
            gx: number;
            gy: number;
            gz: number;
            p: number;
            occShell: number;
            n6: number;
            n26: number;
            pin: boolean;
            bestSrcIdx: number;
        }> = [];

        const rawCount = work.length;
        for (let i = 0; i < rawCount; ++i) {
            const v = work[i];
            const gx0 = v.x - bx;
            const gy0 = v.y - by;
            const gz0 = v.z - bz;
            for (let dx = -1; dx <= 1; ++dx) {
                const gx = gx0 + dx;
                if (gx <= 0 || gx >= sx - 1) continue;
                for (let dy = -1; dy <= 1; ++dy) {
                    const gy = gy0 + dy;
                    if (gy <= 0 || gy >= sy - 1) continue;
                    for (let dz = -1; dz <= 1; ++dz) {
                        if (dx === 0 && dy === 0 && dz === 0) continue;
                        const gz = gz0 + dz;
                        if (gz <= 0 || gz >= sz - 1) continue;
                        const p = gx * sX + gy * sY + gz;
                        if (grid[p] >= 0 || candFlag[p] !== 0) continue;
                        candFlag[p] = 1;

                        const es = evalSourceAtTarget(sourceContext, bx + gx, by + gy, bz + gz);
                        if (sourceContext.hasCavities && es.occShell < 0.12 && es.occCav >= 0.35) {
                            continue;
                        }
                        if (
                            es.occShell >= 0.30 ||
                            es.occSolid >= 0.48 ||
                            (es.occShell >= 0.22 && SADDLE_LUT[es.cellMask] === 1)
                        ) {
                            let n6 = 0;
                            let n26 = 0;
                            for (let ix = -1; ix <= 1; ++ix) {
                                for (let iy = -1; iy <= 1; ++iy) {
                                    for (let iz = -1; iz <= 1; ++iz) {
                                        if (ix === 0 && iy === 0 && iz === 0) continue;
                                        if (grid[p + ix * sX + iy * sY + iz] >= 0) {
                                            n26++;
                                            if (Math.abs(ix) + Math.abs(iy) + Math.abs(iz) === 1) {
                                                n6++;
                                            }
                                        }
                                    }
                                }
                            }
                            const pin = es.occShell >= 0.46 && n6 >= 3 && n26 >= 9;
                            cands.push({
                                gx,
                                gy,
                                gz,
                                p,
                                occShell: es.occShell,
                                n6,
                                n26,
                                pin,
                                bestSrcIdx: es.bestSrcIdx,
                            });
                        }
                    }
                }
            }
        }

        const added = new Uint8Array(total);
        for (let i = 0; i < cands.length; ++i) {
            const c = cands[i];
            grid[c.p] = work.length;
            work.push({
                x: bx + c.gx,
                y: by + c.gy,
                z: bz + c.gz,
                colour: cloneColour(work[0].colour),
            });
            added[c.p] = 1;
        }

        cands.sort((a, b) => (a.n26 - b.n26) || (a.occShell - b.occShell));
        let changed = true;
        while (changed) {
            changed = false;
            for (let i = 0; i < cands.length; ++i) {
                const c = cands[i];
                if (grid[c.p] < 0 || added[c.p] === 0 || c.pin) {
                    continue;
                }
                const mask27 = getMask27(c.gx, c.gy, c.gz);
                let n6 = 0;
                for (let k = 0; k < N6_IDXS.length; ++k) {
                    if ((mask27 & (1 << N6_IDXS[k])) !== 0) {
                        n6++;
                    }
                }
                if (n6 <= 5 && isSimplePoint26_6(mask27)) {
                    grid[c.p] = -1;
                    changed = true;
                }
            }
        }

        // Assign clean interpolated surface colours to surviving envelope voxels using original/valid neighbours
        for (let i = 0; i < cands.length; ++i) {
            const c = cands[i];
            const idx = grid[c.p];
            if (idx < 0) {
                continue;
            }
            const c6: RGBA[] = [];
            const p = c.p;
            const n6Offsets = [sX, -sX, sY, -sY, 1, -1];
            for (let d = 0; d < 6; ++d) {
                const np = p + n6Offsets[d];
                if (grid[np] >= 0 && added[np] === 0) {
                    c6.push(work[grid[np]].colour);
                }
            }
            if (c6.length > 0) {
                work[idx].colour = RGBAUtil.averageLinearAlphaWeighted(...c6);
                continue;
            }
            const c26: RGBA[] = [];
            for (let dx = -1; dx <= 1; ++dx) {
                for (let dy = -1; dy <= 1; ++dy) {
                    for (let dz = -1; dz <= 1; ++dz) {
                        if (dx === 0 && dy === 0 && dz === 0) continue;
                        const np = p + dx * sX + dy * sY + dz;
                        if (grid[np] >= 0 && added[np] === 0) {
                            c26.push(work[grid[np]].colour);
                        }
                    }
                }
            }
            if (c26.length > 0) {
                work[idx].colour = RGBAUtil.averageLinearAlphaWeighted(...c26);
            } else if (c.bestSrcIdx >= 0 && c.bestSrcIdx < sourceContext.sourceVoxels.length) {
                work[idx].colour = cloneColour(sourceContext.sourceVoxels[c.bestSrcIdx].colour);
            }
        }

        // Stage 2a: seal small enclosed wall pockets (size <= 16) unless they correspond to a source cavity
        const bgVis = new Uint8Array(total);
        const queue = new Int32Array(total);
        let head = 0;
        let tail = 0;
        bgVis[0] = 1;
        queue[tail++] = 0;
        while (head < tail) {
            const p = queue[head++];
            const gx = Math.floor(p / sX);
            const rem = p - gx * sX;
            const gy = Math.floor(rem / sY);
            const gz = rem - gy * sY;
            if (gx > 0 && grid[p - sX] < 0 && bgVis[p - sX] === 0) { bgVis[p - sX] = 1; queue[tail++] = p - sX; }
            if (gx + 1 < sx && grid[p + sX] < 0 && bgVis[p + sX] === 0) { bgVis[p + sX] = 1; queue[tail++] = p + sX; }
            if (gy > 0 && grid[p - sY] < 0 && bgVis[p - sY] === 0) { bgVis[p - sY] = 1; queue[tail++] = p - sY; }
            if (gy + 1 < sy && grid[p + sY] < 0 && bgVis[p + sY] === 0) { bgVis[p + sY] = 1; queue[tail++] = p + sY; }
            if (gz > 0 && grid[p - 1] < 0 && bgVis[p - 1] === 0) { bgVis[p - 1] = 1; queue[tail++] = p - 1; }
            if (gz + 1 < sz && grid[p + 1] < 0 && bgVis[p + 1] === 0) { bgVis[p + 1] = 1; queue[tail++] = p + 1; }
        }

        const pocketVis = new Uint8Array(total);
        for (let p0 = 0; p0 < total; ++p0) {
            if (grid[p0] >= 0 || bgVis[p0] !== 0 || pocketVis[p0] !== 0) {
                continue;
            }
            const comp: number[] = [p0];
            pocketVis[p0] = 1;
            let qi = 0;
            while (qi < comp.length) {
                const p = comp[qi++];
                const gx = Math.floor(p / sX);
                const rem = p - gx * sX;
                const gy = Math.floor(rem / sY);
                const gz = rem - gy * sY;
                if (gx > 0 && grid[p - sX] < 0 && bgVis[p - sX] === 0 && pocketVis[p - sX] === 0) { pocketVis[p - sX] = 1; comp.push(p - sX); }
                if (gx + 1 < sx && grid[p + sX] < 0 && bgVis[p + sX] === 0 && pocketVis[p + sX] === 0) { pocketVis[p + sX] = 1; comp.push(p + sX); }
                if (gy > 0 && grid[p - sY] < 0 && bgVis[p - sY] === 0 && pocketVis[p - sY] === 0) { pocketVis[p - sY] = 1; comp.push(p - sY); }
                if (gy + 1 < sy && grid[p + sY] < 0 && bgVis[p + sY] === 0 && pocketVis[p + sY] === 0) { pocketVis[p + sY] = 1; comp.push(p + sY); }
                if (gz > 0 && grid[p - 1] < 0 && bgVis[p - 1] === 0 && pocketVis[p - 1] === 0) { pocketVis[p - 1] = 1; comp.push(p - 1); }
                if (gz + 1 < sz && grid[p + 1] < 0 && bgVis[p + 1] === 0 && pocketVis[p + 1] === 0) { pocketVis[p + 1] = 1; comp.push(p + 1); }
            }
            if (comp.length <= 16) {
                let isCavity = false;
                if (sourceContext.hasCavities) {
                    for (let k = 0; k < comp.length; ++k) {
                        const cp = comp[k];
                        const gx = Math.floor(cp / sX);
                        const rem = cp - gx * sX;
                        const gy = Math.floor(rem / sY);
                        const gz = rem - gy * sY;
                        const es = evalSourceAtTarget(sourceContext, bx + gx, by + gy, bz + gz);
                        if (es.occShell < 0.12 && es.occCav >= 0.35) {
                            isCavity = true;
                            break;
                        }
                    }
                }
                if (!isCavity) {
                    for (let k = 0; k < comp.length; ++k) {
                        const cp = comp[k];
                        const gx = Math.floor(cp / sX);
                        const rem = cp - gx * sX;
                        const gy = Math.floor(rem / sY);
                        const gz = rem - gy * sY;
                        grid[cp] = work.length;
                        work.push({
                            x: bx + gx,
                            y: by + gy,
                            z: bz + gz,
                            colour: pickRepairColour(gx, gy, gz),
                        });
                    }
                }
            }
        }
    }

    // Stage 2b: seal pinholes & diagonal checkerboard pores across N26 (including n6 === 0)
    const sealPinholesDense = (rounds: number) => {
        for (let pass = 0; pass < rounds; ++pass) {
            const toAdd: Array<{ gx: number; gy: number; gz: number; p: number; colour: RGBA }> = [];
            const checked = new Uint8Array(total);
            for (let p = 0; p < total; ++p) {
                if (grid[p] < 0) continue;
                const gx0 = Math.floor(p / sX);
                const rem = p - gx0 * sX;
                const gy0 = Math.floor(rem / sY);
                const gz0 = rem - gy0 * sY;

                for (let dx = -1; dx <= 1; ++dx) {
                    const gx = gx0 + dx;
                    if (gx <= 0 || gx >= sx - 1) continue;
                    for (let dy = -1; dy <= 1; ++dy) {
                        const gy = gy0 + dy;
                        if (gy <= 0 || gy >= sy - 1) continue;
                        for (let dz = -1; dz <= 1; ++dz) {
                            if (dx === 0 && dy === 0 && dz === 0) continue;
                            const gz = gz0 + dz;
                            if (gz <= 0 || gz >= sz - 1) continue;
                            const np = gx * sX + gy * sY + gz;
                            if (grid[np] >= 0 || checked[np] !== 0) continue;
                            checked[np] = 1;

                            const mask27 = getMask27(gx, gy, gz);
                            let n6 = 0;
                            let n26 = 0;
                            for (let b = 0; b < 27; ++b) {
                                if (b !== 13 && (mask27 & (1 << b)) !== 0) {
                                    n26++;
                                }
                            }
                            for (let k = 0; k < N6_IDXS.length; ++k) {
                                if ((mask27 & (1 << N6_IDXS[k])) !== 0) {
                                    n6++;
                                }
                            }
                            const hasOpp6 =
                                ((mask27 & (1 << 4)) !== 0 && (mask27 & (1 << 22)) !== 0) ||
                                ((mask27 & (1 << 10)) !== 0 && (mask27 & (1 << 16)) !== 0) ||
                                ((mask27 & (1 << 12)) !== 0 && (mask27 & (1 << 14)) !== 0);

                            let shouldFill = n6 >= 5 || (n6 >= 4 && hasOpp6);
                            if (!shouldFill) {
                                const disc = isEmptyN6DisconnectedIn27(mask27);
                                shouldFill =
                                    (n6 === 3 && hasOpp6 && n26 >= 7) ||
                                    (n6 === 2 && hasOpp6 && n26 >= 9) ||
                                    (disc && (n26 >= 8 || (n6 === 0 && n26 >= 6 && hasOpposing26Bit(mask27))));
                            }
                            if (shouldFill) {
                                toAdd.push({ gx, gy, gz, p: np, colour: pickRepairColour(gx, gy, gz) });
                            }
                        }
                    }
                }
            }
            if (toAdd.length === 0) {
                break;
            }
            for (let i = 0; i < toAdd.length; ++i) {
                const item = toAdd[i];
                if (grid[item.p] < 0) {
                    grid[item.p] = work.length;
                    work.push({
                        x: bx + item.gx,
                        y: by + item.gy,
                        z: bz + item.gz,
                        colour: item.colour,
                    });
                }
            }
        }
    };

    sealPinholesDense(4);

    if (!sourceContext) {
        // Stage 2c: sequential topological tear seal (bridges disconnected 6-neighbours in N26)
        const tearChecked = new Uint8Array(total);
        const tearCandidates: Array<{ gx: number; gy: number; gz: number; p: number; n6: number; n26: number }> = [];
        for (let p = 0; p < total; ++p) {
            if (grid[p] < 0) continue;
            const gx0 = Math.floor(p / sX);
            const rem = p - gx0 * sX;
            const gy0 = Math.floor(rem / sY);
            const gz0 = rem - gy0 * sY;
            for (let d = 0; d < 6; ++d) {
                const gx = gx0 + DIRS6[d][0];
                const gy = gy0 + DIRS6[d][1];
                const gz = gz0 + DIRS6[d][2];
                if (gx <= 0 || gx >= sx - 1 || gy <= 0 || gy >= sy - 1 || gz <= 0 || gz >= sz - 1) continue;
                const np = gx * sX + gy * sY + gz;
                if (grid[np] >= 0 || tearChecked[np] !== 0) continue;
                tearChecked[np] = 1;
                const mask27 = getMask27(gx, gy, gz);
                let n6 = 0;
                let n26 = 0;
                for (let k = 0; k < N6_IDXS.length; ++k) {
                    if ((mask27 & (1 << N6_IDXS[k])) !== 0) n6++;
                }
                if (n6 >= 2) {
                    for (let b = 0; b < 27; ++b) {
                        if (b !== 13 && (mask27 & (1 << b)) !== 0) n26++;
                    }
                    tearCandidates.push({ gx, gy, gz, p: np, n6, n26 });
                }
            }
        }

        tearCandidates.sort((a, b) => (b.n6 - a.n6) || (b.n26 - a.n26));
        for (let i = 0; i < tearCandidates.length; ++i) {
            const c = tearCandidates[i];
            if (grid[c.p] >= 0) continue;
            const mask27 = getMask27(c.gx, c.gy, c.gz);
            if (bridgesDisconnected6PairMask(mask27)) {
                grid[c.p] = work.length;
                work.push({
                    x: bx + c.gx,
                    y: by + c.gy,
                    z: bz + c.gz,
                    colour: pickRepairColour(c.gx, c.gy, c.gz),
                });
            }
        }

        // Stage 2d: bridge remaining space-diagonal tears where N26 neighbours lack a 6-path inside N26
        const pass3BaseLen = work.length;
        for (let i = 0; i < pass3BaseLen; ++i) {
            const v = work[i];
            const gx0 = v.x - bx;
            const gy0 = v.y - by;
            const gz0 = v.z - bz;
            if (gx0 <= 1 || gx0 >= sx - 2 || gy0 <= 1 || gy0 >= sy - 2 || gz0 <= 1 || gz0 >= sz - 2) {
                continue;
            }
            let mask27 = getMask27(gx0, gy0, gz0);

            const bfs6Bit = (m27: number): number => {
                let vis = 1 << 13;
                const q = [13];
                while (q.length > 0) {
                    const cur = q.pop()!;
                    const neighbors = N18_ADJ[cur];
                    for (let k = 0; k < neighbors.length; ++k) {
                        const nxt = neighbors[k];
                        const bit = 1 << nxt;
                        if ((m27 & bit) !== 0 && (vis & bit) === 0) {
                            vis |= bit;
                            q.push(nxt);
                        }
                    }
                }
                return vis;
            };

            let vis = bfs6Bit(mask27);
            for (let idx27 = 0; idx27 < 27; ++idx27) {
                if ((mask27 & (1 << idx27)) === 0 || (vis & (1 << idx27)) !== 0) {
                    continue;
                }
                const ux = Math.floor(idx27 / 9) - 1;
                const uy = Math.floor((idx27 % 9) / 3) - 1;
                const uz = (idx27 % 3) - 1;

                let cx = 0;
                let cy = 0;
                let cz = 0;
                while (cx !== ux || cy !== uy || cz !== uz) {
                    let bestNx = cx;
                    let bestNy = cy;
                    let bestNz = cz;
                    let bestScore = -1;
                    const tryAxis = (nx: number, ny: number, nz: number) => {
                        const agx = gx0 + nx;
                        const agy = gy0 + ny;
                        const agz = gz0 + nz;
                        const ap = agx * sX + agy * sY + agz;
                        let score = 0;
                        if (grid[ap] >= 0) {
                            score = 1000;
                        } else {
                            const mCand = getMask27(agx, agy, agz);
                            let n6c = 0;
                            let n26c = 0;
                            for (let k = 0; k < N6_IDXS.length; ++k) {
                                if ((mCand & (1 << N6_IDXS[k])) !== 0) n6c++;
                            }
                            for (let b = 0; b < 27; ++b) {
                                if (b !== 13 && (mCand & (1 << b)) !== 0) n26c++;
                            }
                            score = n6c * 30 + n26c;
                        }
                        if (score > bestScore) {
                            bestScore = score;
                            bestNx = nx;
                            bestNy = ny;
                            bestNz = nz;
                        }
                    };
                    if (cx !== ux) tryAxis(cx + Math.sign(ux - cx), cy, cz);
                    if (cy !== uy) tryAxis(cx, cy + Math.sign(uy - cy), cz);
                    if (cz !== uz) tryAxis(cx, cy, cz + Math.sign(uz - cz));

                    cx = bestNx;
                    cy = bestNy;
                    cz = bestNz;
                    const agx = gx0 + cx;
                    const agy = gy0 + cy;
                    const agz = gz0 + cz;
                    const ap = agx * sX + agy * sY + agz;
                    if (grid[ap] < 0) {
                        grid[ap] = work.length;
                        work.push({
                            x: bx + agx,
                            y: by + agy,
                            z: bz + agz,
                            colour: pickRepairColour(agx, agy, agz),
                        });
                        mask27 |= 1 << ((cx + 1) * 9 + (cy + 1) * 3 + (cz + 1));
                    }
                }
                vis = bfs6Bit(mask27);
            }
        }

        // Stage 2e: bridge stepped 1-voxel diagonal seams and opposing 18-diagonal shell gaps
        const dirs18Diag: readonly [readonly [number, number, number], readonly [number, number, number]][] = [
            [[1, 0, 0], [0, 1, 0]], [[1, 0, 0], [0, -1, 0]],
            [[1, 0, 0], [0, 0, 1]], [[1, 0, 0], [0, 0, -1]],
            [[0, 1, 0], [0, 0, 1]], [[0, 1, 0], [0, 0, -1]],
        ];
        for (let pass = 0; pass < 4; ++pass) {
            const toAdd: Array<{ gx: number; gy: number; gz: number; p: number; colour: RGBA }> = [];
            const checked = new Uint8Array(total);
            for (let p = 0; p < total; ++p) {
                if (grid[p] < 0) continue;
                const gx0 = Math.floor(p / sX);
                const rem = p - gx0 * sX;
                const gy0 = Math.floor(rem / sY);
                const gz0 = rem - gy0 * sY;
                for (let d = 0; d < 6; ++d) {
                    const gx = gx0 + DIRS6[d][0];
                    const gy = gy0 + DIRS6[d][1];
                    const gz = gz0 + DIRS6[d][2];
                    if (gx <= 0 || gx >= sx - 1 || gy <= 0 || gy >= sy - 1 || gz <= 0 || gz >= sz - 1) continue;
                    const np = gx * sX + gy * sY + gz;
                    if (grid[np] >= 0 || checked[np] !== 0) continue;
                    checked[np] = 1;

                    const mask27 = getMask27(gx, gy, gz);
                    let n26 = 0;
                    for (let b = 0; b < 27; ++b) {
                        if (b !== 13 && (mask27 & (1 << b)) !== 0) n26++;
                    }
                    let stepped = false;
                    if (n26 >= 8) {
                        for (let a = 0; a < 6 && !stepped; ++a) {
                            const [ax, ay, az] = DIRS6[a];
                            const pPlus = np + ax * sX + ay * sY + az;
                            const pMinus = np - ax * sX - ay * sY - az;
                            if (grid[pPlus] < 0 || grid[pMinus] >= 0) {
                                continue;
                            }
                            for (let b = 0; b < 6; ++b) {
                                if (Math.floor(a / 2) === Math.floor(b / 2)) continue;
                                const [bx2, by2, bz2] = DIRS6[b];
                                const offB = bx2 * sX + by2 * sY + bz2;
                                if (grid[pMinus + offB] >= 0 && grid[np + offB] < 0 && grid[pPlus + offB] < 0) {
                                    stepped = true;
                                    break;
                                }
                            }
                        }
                        if (!stepped && n26 >= 9) {
                            for (let k = 0; k < dirs18Diag.length; ++k) {
                                const [d1, d2] = dirs18Diag[k];
                                const off1 = d1[0] * sX + d1[1] * sY + d1[2];
                                const off2 = d2[0] * sX + d2[1] * sY + d2[2];
                                if (
                                    grid[np + off1 + off2] >= 0 &&
                                    grid[np - off1 - off2] >= 0 &&
                                    grid[np + off1] < 0 &&
                                    grid[np - off1] < 0 &&
                                    grid[np + off2] < 0 &&
                                    grid[np - off2] < 0
                                ) {
                                    stepped = true;
                                    break;
                                }
                            }
                        }
                    }
                    if (stepped) {
                        toAdd.push({ gx, gy, gz, p: np, colour: pickRepairColour(gx, gy, gz) });
                    }
                }
            }
            if (toAdd.length === 0) {
                break;
            }
            for (let i = 0; i < toAdd.length; ++i) {
                const item = toAdd[i];
                if (grid[item.p] < 0) {
                    grid[item.p] = work.length;
                    work.push({
                        x: bx + item.gx,
                        y: by + item.gy,
                        z: bz + item.gz,
                        colour: item.colour,
                    });
                }
            }
        }

        // Final pinhole cleanup pass after diagonal/stepped bridging
        sealPinholesDense(4);
    }

    const result: VoxelColourRecord[] = [];
    for (let p = 0; p < total; ++p) {
        const idx = grid[p];
        if (idx >= 0) {
            result.push(work[idx]);
        }
    }
    return result;
}

function closeRotationHolesSparse(work: VoxelColourRecord[]): VoxelColourRecord[] {
    const coordMap = buildCoordMap(work);
    const hasVoxel = (x: number, y: number, z: number): boolean => lookupCoordMap(coordMap, x, y, z) !== -1;

    const addVoxel = (x: number, y: number, z: number, colour: RGBA): void => {
        if (hasVoxel(x, y, z)) {
            return;
        }
        setCoordMap(coordMap, x, y, z, work.length);
        work.push({ x, y, z, colour });
    };

    const getMask27Sparse = (x: number, y: number, z: number): { mask27: number; colours6: RGBA[]; colours26: RGBA[] } => {
        let mask27 = 0;
        const colours6: RGBA[] = [];
        const colours26: RGBA[] = [];
        for (let dx = -1; dx <= 1; ++dx) {
            for (let dy = -1; dy <= 1; ++dy) {
                for (let dz = -1; dz <= 1; ++dz) {
                    if (dx === 0 && dy === 0 && dz === 0) continue;
                    const idx = lookupCoordMap(coordMap, x + dx, y + dy, z + dz);
                    if (idx !== -1) {
                        mask27 |= 1 << ((dx + 1) * 9 + (dy + 1) * 3 + (dz + 1));
                        colours26.push(work[idx].colour);
                        if (Math.abs(dx) + Math.abs(dy) + Math.abs(dz) === 1) {
                            colours6.push(work[idx].colour);
                        }
                    }
                }
            }
        }
        return { mask27, colours6, colours26 };
    };

    for (let pass = 0; pass < 4; ++pass) {
        const toAdd: VoxelColourRecord[] = [];
        const checked = buildCoordMap([]);
        const curLen = work.length;
        for (let i = 0; i < curLen; ++i) {
            const v = work[i];
            for (let dx = -1; dx <= 1; ++dx) {
                for (let dy = -1; dy <= 1; ++dy) {
                    for (let dz = -1; dz <= 1; ++dz) {
                        if (dx === 0 && dy === 0 && dz === 0) continue;
                        const nx = v.x + dx;
                        const ny = v.y + dy;
                        const nz = v.z + dz;
                        if (hasVoxel(nx, ny, nz) || lookupCoordMap(checked, nx, ny, nz) !== -1) continue;
                        setCoordMap(checked, nx, ny, nz, 1);

                        const { mask27, colours6, colours26 } = getMask27Sparse(nx, ny, nz);
                        const n6 = colours6.length;
                        const n26 = colours26.length;
                        const hasOpp6 =
                            ((mask27 & (1 << 4)) !== 0 && (mask27 & (1 << 22)) !== 0) ||
                            ((mask27 & (1 << 10)) !== 0 && (mask27 & (1 << 16)) !== 0) ||
                            ((mask27 & (1 << 12)) !== 0 && (mask27 & (1 << 14)) !== 0);
                        const disc = isEmptyN6DisconnectedIn27(mask27);
                        const shouldFill =
                            n6 >= 5 ||
                            (n6 >= 4 && hasOpp6) ||
                            (n6 === 3 && hasOpp6 && n26 >= 7) ||
                            (n6 === 2 && hasOpp6 && n26 >= 9) ||
                            (disc && (n26 >= 8 || (n6 === 0 && n26 >= 6 && hasOpposing26Bit(mask27))));
                        if (shouldFill && colours26.length > 0) {
                            const srcColours = colours6.length > 0 ? colours6 : colours26;
                            toAdd.push({
                                x: nx,
                                y: ny,
                                z: nz,
                                colour: RGBAUtil.averageLinearAlphaWeighted(...srcColours),
                            });
                        }
                    }
                }
            }
        }
        if (toAdd.length === 0) break;
        for (let i = 0; i < toAdd.length; ++i) {
            addVoxel(toAdd[i].x, toAdd[i].y, toAdd[i].z, toAdd[i].colour);
        }
    }

    return work;
}

