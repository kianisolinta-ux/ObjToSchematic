import { RGBA } from './colour';
import { VoxelColourRecord } from './voxel_postprocess';

export interface IVoxelRotationAngles {
    x: number;
    y: number;
    z: number;
}

const DEG_TO_RAD = Math.PI / 180;
const RIGHT_ANGLE_EPS = 1e-6;
const MATRIX_ZERO_EPS = 1e-12;
const MAX_DENSE_GRID_CELLS = 8_000_000;
const MAX_SDF_GRID_CELLS = 2_000_000;
const SDF_CLAMP = 0.75;
const SDF_BLEND_WEIGHT = 0.60;

/**
 * 256-entry lookup table identifying 2x2x2 source cells whose occupied corners contain
 * a diagonal disconnection (face-diagonal or space-diagonal without an edge-connected path
 * inside the cell). Bridging such saddles prevents thin 1-voxel shells from tearing under
 * arbitrary-angle rotation while leaving thick/solid faces untouched.
 */
const SADDLE_LUT = (() => {
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
const N26_ADJ: number[][] = [];
const N18_ADJ: number[][] = [];
const N6_IDXS: number[] = [];
const N18_MASK = (() => {
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

const DIRS6: readonly [number, number, number][] = [
    [1, 0, 0], [-1, 0, 0],
    [0, 1, 0], [0, -1, 0],
    [0, 0, 1], [0, 0, -1],
];

/**
 * Returns true iff removing the centre voxel preserves both:
 * 1) Foreground 26-connectivity in N26(p) (never splits sheets, ridges, or tips)
 * 2) Background 6-connectivity of N6(p) inside N18(p) (never opens a 6-connected hole/leak).
 */
function isSimplePoint26_6(occMask27: number): boolean {
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

function countPopBits(mask: number): number {
    let v = mask;
    let count = 0;
    while (v !== 0) {
        v &= v - 1;
        count++;
    }
    return count;
}

function countN6(mask27: number): number {
    let n6 = 0;
    for (let i = 0; i < N6_IDXS.length; ++i) {
        if ((mask27 & (1 << N6_IDXS[i])) !== 0) {
            n6++;
        }
    }
    return n6;
}

function cloneColour(c: RGBA): RGBA {
    return { r: c.r, g: c.g, b: c.b, a: c.a };
}

function normaliseDegrees(deg: number): number {
    if (!Number.isFinite(deg)) {
        return 0;
    }
    const mod = ((deg % 360) + 360) % 360;
    return Math.abs(mod - 360) < RIGHT_ANGLE_EPS ? 0 : mod;
}

function isRightAngleMultiple(deg: number): boolean {
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
function buildRotationMatrix(rot: IVoxelRotationAngles): [
    number, number, number,
    number, number, number,
    number, number, number,
] {
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

type CoordMap = Map<number, Map<number, Map<number, number>>>;

function buildCoordMap(voxels: readonly VoxelColourRecord[]): CoordMap {
    const map: CoordMap = new Map();
    for (let i = 0; i < voxels.length; ++i) {
        const v = voxels[i];
        setCoordMap(map, v.x, v.y, v.z, i);
    }
    return map;
}

function setCoordMap(map: CoordMap, x: number, y: number, z: number, val: number): void {
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

function lookupCoordMap(map: CoordMap, x: number, y: number, z: number): number {
    return map.get(x)?.get(y)?.get(z) ?? -1;
}

interface IDenseSourceGrid {
    grid: Int32Array; // -3 = enclosed interior, -1 = exterior empty, >= 0 = source voxel index
    minX: number;
    minY: number;
    minZ: number;
    sx: number;
    sy: number;
    sz: number;
}

function buildDenseSourceGridWithCavities(
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

    // -3 = unvisited, -1 = exterior empty, >= 0 = source index
    const grid = new Int32Array(total).fill(-3);
    const sY = sz;
    const sX = sy * sz;
    for (let i = 0; i < voxels.length; ++i) {
        const v = voxels[i];
        grid[(v.x - bMinX) * sX + (v.y - bMinY) * sY + (v.z - bMinZ)] = i;
    }

    // 6-connected flood fill from guaranteed exterior corner (0, 0, 0)
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

function edt1dPass(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array): void {
    let k = 0;
    v[0] = 0;
    z[0] = -Infinity;
    z[1] = Infinity;
    for (let q = 1; q < n; ++q) {
        let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
        while (s <= z[k]) {
            k--;
            s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
        }
        k++;
        v[k] = q;
        z[k] = s;
        z[k + 1] = Infinity;
    }
    k = 0;
    for (let q = 0; q < n; ++q) {
        while (z[k + 1] < q) {
            k++;
        }
        const dx = q - v[k];
        d[q] = dx * dx + f[v[k]];
    }
}

function computeUnsignedEdt3D(
    srcGrid: Int32Array,
    zeroIfExterior: boolean,
    sx: number,
    sy: number,
    sz: number,
): Float32Array {
    const total = sx * sy * sz;
    const INF = 1e12;
    const dist = new Float32Array(total);
    for (let i = 0; i < total; ++i) {
        const isExterior = srcGrid[i] === -1;
        dist[i] = (zeroIfExterior ? isExterior : !isExterior) ? 0 : INF;
    }

    const maxDim = Math.max(sx, sy, sz);
    const f = new Float64Array(maxDim);
    const d = new Float64Array(maxDim);
    const v = new Int32Array(maxDim);
    const z = new Float64Array(maxDim + 1);
    const sY = sz;
    const sX = sy * sz;

    for (let x = 0; x < sx; ++x) {
        for (let y = 0; y < sy; ++y) {
            const off = x * sX + y * sY;
            for (let k = 0; k < sz; ++k) {
                f[k] = dist[off + k];
            }
            edt1dPass(f, sz, d, v, z);
            for (let k = 0; k < sz; ++k) {
                dist[off + k] = d[k];
            }
        }
    }

    for (let x = 0; x < sx; ++x) {
        for (let k = 0; k < sz; ++k) {
            const off = x * sX + k;
            for (let y = 0; y < sy; ++y) {
                f[y] = dist[off + y * sY];
            }
            edt1dPass(f, sy, d, v, z);
            for (let y = 0; y < sy; ++y) {
                dist[off + y * sY] = d[y];
            }
        }
    }

    for (let y = 0; y < sy; ++y) {
        for (let k = 0; k < sz; ++k) {
            const off = y * sY + k;
            for (let x = 0; x < sx; ++x) {
                f[x] = dist[x * sX + off];
            }
            edt1dPass(f, sx, d, v, z);
            for (let x = 0; x < sx; ++x) {
                dist[x * sX + off] = Math.sqrt(d[x]);
            }
        }
    }

    return dist;
}

function computeClampedSolidSdf(dense: IDenseSourceGrid): Float32Array | null {
    const total = dense.sx * dense.sy * dense.sz;
    if (total > MAX_SDF_GRID_CELLS) {
        return null;
    }
    const dOut = computeUnsignedEdt3D(dense.grid, true, dense.sx, dense.sy, dense.sz);
    const dIn = computeUnsignedEdt3D(dense.grid, false, dense.sx, dense.sy, dense.sz);
    const sdf = new Float32Array(total);
    for (let i = 0; i < total; ++i) {
        const raw = dense.grid[i] !== -1 ? (dOut[i] - 0.5) : -(dIn[i] - 0.5);
        sdf[i] = Math.max(-SDF_CLAMP, Math.min(SDF_CLAMP, raw));
    }
    return sdf;
}

/**
 * Identifies genuine OPEN thin 1-voxel sheets/wires/arches/open-shells: voxels neither
 * inside/6-adjacent to any 2x2x2 solid core NOR 26-adjacent to an enclosed `-3` cavity.
 * Closed shells enclosing `-3` cavities (e.g. hollow skulls/spheres) are rotated cleanly
 * via their smooth outer solid O = S U C and then carved back, preventing 1-vs-2 seam
 * distortion and uneven swelling while keeping open 1-voxel arches/plates watertight.
 */
function buildTrueOpenThinMask(
    voxels: readonly VoxelColourRecord[],
    lookupSourceCode: (x: number, y: number, z: number) => number,
    hasCavities: boolean,
): Uint8Array {
    const core = new Uint8Array(voxels.length);
    for (let i = 0; i < voxels.length; ++i) {
        const v = voxels[i];
        let inSolid2x2 = false;
        for (let ox = -1; ox <= 0 && !inSolid2x2; ++ox) {
            for (let oy = -1; oy <= 0 && !inSolid2x2; ++oy) {
                for (let oz = -1; oz <= 0 && !inSolid2x2; ++oz) {
                    let full = true;
                    for (let ix = 0; ix <= 1 && full; ++ix) {
                        for (let iy = 0; iy <= 1 && full; ++iy) {
                            for (let iz = 0; iz <= 1; ++iz) {
                                if (lookupSourceCode(v.x + ox + ix, v.y + oy + iy, v.z + oz + iz) < 0) {
                                    full = false;
                                    break;
                                }
                            }
                        }
                    }
                    if (full) {
                        inSolid2x2 = true;
                    }
                }
            }
        }
        if (inSolid2x2) {
            core[i] = 1;
        }
    }

    const thin = new Uint8Array(voxels.length);
    for (let i = 0; i < voxels.length; ++i) {
        if (core[i] !== 0) {
            continue;
        }
        const v = voxels[i];
        let solidBacked = false;
        for (let d = 0; d < 6; ++d) {
            const code = lookupSourceCode(v.x + DIRS6[d][0], v.y + DIRS6[d][1], v.z + DIRS6[d][2]);
            if (code >= 0 && core[code] !== 0) {
                solidBacked = true;
                break;
            }
        }
        if (solidBacked) {
            continue;
        }
        if (hasCavities) {
            let touchesCavity = false;
            for (let dx = -1; dx <= 1 && !touchesCavity; ++dx) {
                for (let dy = -1; dy <= 1 && !touchesCavity; ++dy) {
                    for (let dz = -1; dz <= 1; ++dz) {
                        if (lookupSourceCode(v.x + dx, v.y + dy, v.z + dz) === -3) {
                            touchesCavity = true;
                            break;
                        }
                    }
                }
            }
            if (touchesCavity) {
                continue;
            }
        }
        thin[i] = 1;
    }
    return thin;
}

interface IActiveVoxel {
    x: number;
    y: number;
    z: number;
    colour: RGBA;
    occShell: number;
    occCavity: number;
    occField: number;
    bestIdx: number;
    anyTrueThin: boolean;
    alive: boolean;
}

interface IEvaluatedTargetSample {
    occShell: number;
    occCavity: number;
    occSolid: number;
    occField: number;
    cellMask: number;
    anyTrueThin: boolean;
    bestIdx: number;
}

/**
 * Rotates a sparse integer voxel grid around its bounding-box centre by Euler angles (x, y, z) in degrees.
 * - Multiples of 90 degrees use exact integer lattice mapping (100% lossless bijection).
 * - Arbitrary angles resample via cavity-aware isotropic anti-aliased occupancy + true-thin/saddle
 *   bridging (never bloating staircase steps on solid bodies), followed by topology-preserving
 *   (26, 6) surface fairing (notch fill + wart/spur peel) so rotated shapes stay faithful,
 *   watertight, and smooth without roughness or localized swelling.
 */
export function rotateVoxelRecords(
    voxels: readonly VoxelColourRecord[],
    rotation: IVoxelRotationAngles,
): VoxelColourRecord[] {
    if (voxels.length === 0) {
        return [];
    }

    const nx = normaliseDegrees(rotation.x);
    const ny = normaliseDegrees(rotation.y);
    const nz = normaliseDegrees(rotation.z);

    if (nx < RIGHT_ANGLE_EPS && ny < RIGHT_ANGLE_EPS && nz < RIGHT_ANGLE_EPS) {
        return voxels.map((v) => ({
            x: Math.round(v.x),
            y: Math.round(v.y),
            z: Math.round(v.z),
            colour: cloneColour(v.colour),
        }));
    }

    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < voxels.length; ++i) {
        const v = voxels[i];
        if (v.x < minX) minX = v.x;
        if (v.y < minY) minY = v.y;
        if (v.z < minZ) minZ = v.z;
        if (v.x > maxX) maxX = v.x;
        if (v.y > maxY) maxY = v.y;
        if (v.z > maxZ) maxZ = v.z;
    }

    const cx = (minX + maxX) * 0.5;
    const cy = (minY + maxY) * 0.5;
    const cz = (minZ + maxZ) * 0.5;

    const m = buildRotationMatrix({ x: nx, y: ny, z: nz });

    // Exact 90-degree lossless bijection path
    if (isRightAngleMultiple(nx) && isRightAngleMultiple(ny) && isRightAngleMultiple(nz)) {
        const r00 = Math.round(m[0]);
        const r01 = Math.round(m[1]);
        const r02 = Math.round(m[2]);
        const r10 = Math.round(m[3]);
        const r11 = Math.round(m[4]);
        const r12 = Math.round(m[5]);
        const r20 = Math.round(m[6]);
        const r21 = Math.round(m[7]);
        const r22 = Math.round(m[8]);

        const first = voxels[0];
        const fdx = first.x - cx;
        const fdy = first.y - cy;
        const fdz = first.z - cz;
        const rawFirstX = cx + r00 * fdx + r01 * fdy + r02 * fdz;
        const rawFirstY = cy + r10 * fdx + r11 * fdy + r12 * fdz;
        const rawFirstZ = cz + r20 * fdx + r21 * fdy + r22 * fdz;

        // Constant parity alignment shift ensures spacing stays strictly invariant across odd/even dimensions
        const shiftX = Math.round(rawFirstX) - rawFirstX;
        const shiftY = Math.round(rawFirstY) - rawFirstY;
        const shiftZ = Math.round(rawFirstZ) - rawFirstZ;

        const out: VoxelColourRecord[] = new Array(voxels.length);
        for (let i = 0; i < voxels.length; ++i) {
            const v = voxels[i];
            const dx = v.x - cx;
            const dy = v.y - cy;
            const dz = v.z - cz;
            out[i] = {
                x: Math.round(cx + r00 * dx + r01 * dy + r02 * dz + shiftX),
                y: Math.round(cy + r10 * dx + r11 * dy + r12 * dz + shiftY),
                z: Math.round(cz + r20 * dx + r21 * dy + r22 * dz + shiftZ),
                colour: cloneColour(v.colour),
            };
        }
        return out;
    }

    // Arbitrary angle: O(N) sparse candidate sweep + isotropic anti-aliased resampling
    const coordMap = buildCoordMap(voxels);
    const denseSrc = buildDenseSourceGridWithCavities(voxels, minX, minY, minZ, maxX, maxY, maxZ);

    const dGrid = denseSrc?.grid;
    const dMinX = denseSrc?.minX ?? 0;
    const dMinY = denseSrc?.minY ?? 0;
    const dMinZ = denseSrc?.minZ ?? 0;
    const dSx = denseSrc?.sx ?? 0;
    const dSy = denseSrc?.sy ?? 0;
    const dSz = denseSrc?.sz ?? 0;
    const dStrideX = dSy * dSz;
    const dStrideY = dSz;

    const lookupSourceCode = (x: number, y: number, z: number): number => {
        if (dGrid) {
            const gx = x - dMinX;
            const gy = y - dMinY;
            const gz = z - dMinZ;
            if (gx < 0 || gx >= dSx || gy < 0 || gy >= dSy || gz < 0 || gz >= dSz) {
                return -1;
            }
            return dGrid[gx * dStrideX + gy * dStrideY + gz];
        }
        return lookupCoordMap(coordMap, x, y, z);
    };

    let hasCavities = false;
    if (dGrid) {
        for (let i = 0; i < dGrid.length; ++i) {
            if (dGrid[i] === -3) {
                hasCavities = true;
                break;
            }
        }
    }

    const dSdf = denseSrc ? computeClampedSolidSdf(denseSrc) : null;

    const thinMask = buildTrueOpenThinMask(voxels, lookupSourceCode, hasCavities);

    const [
        r00, r01, r02,
        r10, r11, r12,
        r20, r21, r22,
    ] = m;

    const lookupSdf = (x: number, y: number, z: number): number => {
        if (!dSdf) {
            return -SDF_CLAMP;
        }
        const gx = x - dMinX;
        const gy = y - dMinY;
        const gz = z - dMinZ;
        if (gx < 0 || gx >= dSx || gy < 0 || gy >= dSy || gz < 0 || gz >= dSz) {
            return -SDF_CLAMP;
        }
        return dSdf[gx * dStrideX + gy * dStrideY + gz];
    };

    const isDeepInteriorCavity = (tx: number, ty: number, tz: number): boolean => {
        if (!hasCavities) {
            return false;
        }
        const vx = tx - cx;
        const vy = ty - cy;
        const vz = tz - cz;

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
        let hasOccupied = false;
        for (let ix = 0; ix <= 1; ++ix) {
            const wx = ix === 1 ? fx : 1 - fx;
            const pxSrc = x0 + ix;
            for (let iy = 0; iy <= 1; ++iy) {
                const wy = iy === 1 ? fy : 1 - fy;
                const pySrc = y0 + iy;
                const wxy = wx * wy;
                for (let iz = 0; iz <= 1; ++iz) {
                    const code = lookupSourceCode(pxSrc, pySrc, z0 + iz);
                    if (code === -1) {
                        continue;
                    }
                    if (code >= 0) {
                        hasOccupied = true;
                    }
                    occSolid += wxy * (iz === 1 ? fz : 1 - fz);
                }
            }
        }
        return !hasOccupied && occSolid >= 0.5;
    };

    const evaluateTargetSample = (tx: number, ty: number, tz: number): IEvaluatedTargetSample | null => {
        const vx = tx - cx;
        const vy = ty - cy;
        const vz = tz - cz;

        // Continuous inverse coordinate s = R^T * (t - c) + c
        const sx = cx + r00 * vx + r10 * vy + r20 * vz;
        const sy = cy + r01 * vx + r11 * vy + r21 * vz;
        const sz = cz + r02 * vx + r12 * vy + r22 * vz;

        const x0 = Math.floor(sx);
        const y0 = Math.floor(sy);
        const z0 = Math.floor(sz);
        const fx = sx - x0;
        const fy = sy - y0;
        const fz = sz - z0;

        let occShell = 0;
        let occCavity = 0;
        let occSolid = 0;
        let valSdf = 0;
        let anyTrueThin = false;
        let cellMask = 0;
        let bestIdx = -1;
        let bestWeight = -1;
        let bestDistSq = Infinity;

        for (let ix = 0; ix <= 1; ++ix) {
            const wx = ix === 1 ? fx : 1 - fx;
            const pxSrc = x0 + ix;
            const ddx = sx - pxSrc;
            for (let iy = 0; iy <= 1; ++iy) {
                const wy = iy === 1 ? fy : 1 - fy;
                const pySrc = y0 + iy;
                const ddy = sy - pySrc;
                const wxy = wx * wy;
                for (let iz = 0; iz <= 1; ++iz) {
                    const pzSrc = z0 + iz;
                    const w = wxy * (iz === 1 ? fz : 1 - fz);
                    if (dSdf) {
                        valSdf += lookupSdf(pxSrc, pySrc, pzSrc) * w;
                    }
                    const code = lookupSourceCode(pxSrc, pySrc, pzSrc);
                    if (code === -1) {
                        continue;
                    }
                    occSolid += w;
                    if (code === -3) {
                        occCavity += w;
                    } else if (code >= 0) {
                        occShell += w;
                        cellMask |= 1 << ((ix << 2) | (iy << 1) | iz);
                        if (thinMask[code] !== 0) {
                            anyTrueThin = true;
                        }
                        const ddz = sz - pzSrc;
                        const distSq = ddx * ddx + ddy * ddy + ddz * ddz;
                        if (w > bestWeight + 1e-9 || (Math.abs(w - bestWeight) <= 1e-9 && distSq < bestDistSq)) {
                            bestWeight = w;
                            bestDistSq = distSq;
                            bestIdx = code;
                        }
                    }
                }
            }
        }

        if (bestIdx === -1) {
            return null;
        }

        const occField = dSdf ?
            0.5 + (1 - SDF_BLEND_WEIGHT) * (occSolid - 0.5) + SDF_BLEND_WEIGHT * valSdf :
            occSolid;

        return { occShell, occCavity, occSolid, occField, cellMask, anyTrueThin, bestIdx };
    };

    const visitedCandidates = new Map<number, Map<number, Set<number>>>();
    const markVisited = (tx: number, ty: number, tz: number): boolean => {
        let yMap = visitedCandidates.get(tx);
        if (!yMap) {
            yMap = new Map();
            visitedCandidates.set(tx, yMap);
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

    const items: IActiveVoxel[] = [];
    const refCount = new Int32Array(voxels.length);
    let tMinX = Infinity;
    let tMinY = Infinity;
    let tMinZ = Infinity;
    let tMaxX = -Infinity;
    let tMaxY = -Infinity;
    let tMaxZ = -Infinity;

    const recordBounds = (tx: number, ty: number, tz: number): void => {
        if (tx < tMinX) tMinX = tx;
        if (ty < tMinY) tMinY = ty;
        if (tz < tMinZ) tMinZ = tz;
        if (tx > tMaxX) tMaxX = tx;
        if (ty > tMaxY) tMaxY = ty;
        if (tz > tMaxZ) tMaxZ = tz;
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
                    const sample = evaluateTargetSample(tx, ty, tz);
                    if (!sample) {
                        continue;
                    }
                    const accept =
                        (sample.anyTrueThin ?
                            (sample.occShell >= 0.34 || (sample.occShell >= 0.22 && SADDLE_LUT[sample.cellMask] !== 0)) :
                            sample.occField >= 0.5);
                    if (!accept) {
                        continue;
                    }

                    refCount[sample.bestIdx]++;
                    items.push({
                        x: tx,
                        y: ty,
                        z: tz,
                        colour: cloneColour(voxels[sample.bestIdx].colour),
                        occShell: sample.occShell,
                        occCavity: sample.occCavity,
                        occField: sample.occField,
                        bestIdx: sample.bestIdx,
                        anyTrueThin: sample.anyTrueThin,
                        alive: true,
                    });
                    recordBounds(tx, ty, tz);
                }
            }
        }
    }

    if (items.length === 0) {
        return [];
    }

    // Pad by 2 voxels on each side so dimple-fill insertions stay safely within dense bounds
    const tPadMinX = tMinX - 2;
    const tPadMinY = tMinY - 2;
    const tPadMinZ = tMinZ - 2;
    const tSx = (tMaxX + 2) - tPadMinX + 1;
    const tSy = (tMaxY + 2) - tPadMinY + 1;
    const tSz = (tMaxZ + 2) - tPadMinZ + 1;
    const tTotal = tSx * tSy * tSz;
    const useDenseTarget = Number.isSafeInteger(tTotal) && tTotal <= MAX_DENSE_GRID_CELLS;

    let targetGrid: Int32Array | null = null;
    let targetMap: CoordMap | null = null;
    const tStrideX = tSy * tSz;
    const tStrideY = tSz;

    if (useDenseTarget) {
        targetGrid = new Int32Array(tTotal).fill(-1);
        for (let i = 0; i < items.length; ++i) {
            const it = items[i];
            targetGrid[(it.x - tPadMinX) * tStrideX + (it.y - tPadMinY) * tStrideY + (it.z - tPadMinZ)] = i;
        }
    } else {
        targetMap = new Map();
        for (let i = 0; i < items.length; ++i) {
            const it = items[i];
            setCoordMap(targetMap, it.x, it.y, it.z, i);
        }
    }

    const getTargetItemIdx = (x: number, y: number, z: number): number => {
        if (targetGrid) {
            const gx = x - tPadMinX;
            const gy = y - tPadMinY;
            const gz = z - tPadMinZ;
            if (gx < 0 || gx >= tSx || gy < 0 || gy >= tSy || gz < 0 || gz >= tSz) {
                return -1;
            }
            return targetGrid[gx * tStrideX + gy * tStrideY + gz];
        }
        return lookupCoordMap(targetMap!, x, y, z);
    };

    const setTargetItemIdx = (x: number, y: number, z: number, idx: number): void => {
        if (targetGrid) {
            const gx = x - tPadMinX;
            const gy = y - tPadMinY;
            const gz = z - tPadMinZ;
            if (gx >= 0 && gx < tSx && gy >= 0 && gy < tSy && gz >= 0 && gz < tSz) {
                targetGrid[gx * tStrideX + gy * tStrideY + gz] = idx;
            }
        } else {
            setCoordMap(targetMap!, x, y, z, idx);
        }
    };

    const removeItem = (idx: number): void => {
        const it = items[idx];
        it.alive = false;
        if (it.bestIdx >= 0) {
            refCount[it.bestIdx]--;
        }
        setTargetItemIdx(it.x, it.y, it.z, -1);
    };

    const getMask27 = (x: number, y: number, z: number): number => {
        let mask = 0;
        let bitIdx = 0;
        if (!hasCavities && targetGrid) {
            const bx = x - tPadMinX;
            const by = y - tPadMinY;
            const bz = z - tPadMinZ;
            if (bx >= 1 && bx + 1 < tSx && by >= 1 && by + 1 < tSy && bz >= 1 && bz + 1 < tSz) {
                for (let dx = -1; dx <= 1; ++dx) {
                    const offX = (bx + dx) * tStrideX;
                    for (let dy = -1; dy <= 1; ++dy) {
                        const offXY = offX + (by + dy) * tStrideY + bz;
                        for (let dz = -1; dz <= 1; ++dz) {
                            if (targetGrid[offXY + dz] >= 0) {
                                mask |= (1 << bitIdx);
                            }
                            bitIdx++;
                        }
                    }
                }
                return mask;
            }
        }
        for (let dx = -1; dx <= 1; ++dx) {
            for (let dy = -1; dy <= 1; ++dy) {
                for (let dz = -1; dz <= 1; ++dz) {
                    const nx = x + dx;
                    const ny = y + dy;
                    const nz = z + dz;
                    if (getTargetItemIdx(nx, ny, nz) >= 0 || isDeepInteriorCavity(nx, ny, nz)) {
                        mask |= (1 << bitIdx);
                    }
                    bitIdx++;
                }
            }
        }
        return mask;
    };

    // Pass 1: Peel excess thin/saddle fringe voxels down toward clean 1-voxel / 0.5-isosurface thickness
    const peelThinFringe = (occFieldCap: number, occShellCap: number): void => {
        const candidates: number[] = [];
        for (let i = 0; i < items.length; ++i) {
            const it = items[i];
            if (!it.alive) {
                continue;
            }
            if (it.occField < occFieldCap || (it.anyTrueThin && it.occShell < occShellCap)) {
                candidates.push(i);
            }
        }
        candidates.sort((a, b) => {
            const ia = items[a];
            const ib = items[b];
            const sa = ia.anyTrueThin ? ia.occShell : ia.occField;
            const sb = ib.anyTrueThin ? ib.occShell : ib.occField;
            return sa - sb;
        });
        for (let k = 0; k < candidates.length; ++k) {
            const idx = candidates[k];
            const it = items[idx];
            if (!it.alive) {
                continue;
            }
            if (it.anyTrueThin && it.bestIdx >= 0 && refCount[it.bestIdx] <= 1) {
                continue;
            }
            const mask27 = getMask27(it.x, it.y, it.z);
            if (countN6(mask27) <= 3 && isSimplePoint26_6(mask27)) {
                removeItem(idx);
            }
        }
    };

    peelThinFringe(0.5, 0.58);

    // Pass 2: Topology-safe surface fairing (2 balanced rounds of notch-fill + spur-peel)
    const fillSurfaceNotches = (): void => {
        const checked = new Map<number, Map<number, Set<number>>>();
        const markChecked = (x: number, y: number, z: number): boolean => {
            let yMap = checked.get(x);
            if (!yMap) {
                yMap = new Map();
                checked.set(x, yMap);
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

        const toAdd: IActiveVoxel[] = [];
        const currentLen = items.length;
        for (let i = 0; i < currentLen; ++i) {
            const it = items[i];
            if (!it.alive) {
                continue;
            }
            for (let d = 0; d < 6; ++d) {
                const nxPos = it.x + DIRS6[d][0];
                const nyPos = it.y + DIRS6[d][1];
                const nzPos = it.z + DIRS6[d][2];
                if (getTargetItemIdx(nxPos, nyPos, nzPos) >= 0 || isDeepInteriorCavity(nxPos, nyPos, nzPos)) {
                    continue;
                }
                if (!markChecked(nxPos, nyPos, nzPos)) {
                    continue;
                }
                const mask27 = getMask27(nxPos, nyPos, nzPos);
                const n6 = countN6(mask27);
                if (n6 < 4) {
                    continue;
                }
                const n26 = countPopBits(mask27);
                // n6 >= 5 seals dead-end pinholes; n6 === 4 && n26 >= 15 fills 1-voxel surface
                // notches on solid faces while leaving 1x1/2x2 thin-wall windows open (n26 <= 12).
                if (n6 < 5 && n26 < 15) {
                    continue;
                }
                const sample = evaluateTargetSample(nxPos, nyPos, nzPos);
                if (!sample) {
                    continue;
                }
                if (n6 === 4 && (sample.anyTrueThin || sample.occField < 0.38)) {
                    continue;
                }
                toAdd.push({
                    x: nxPos,
                    y: nyPos,
                    z: nzPos,
                    colour: cloneColour(voxels[sample.bestIdx].colour),
                    occShell: sample.occShell,
                    occCavity: sample.occCavity,
                    occField: sample.occField,
                    bestIdx: sample.bestIdx,
                    anyTrueThin: sample.anyTrueThin,
                    alive: true,
                });
            }
        }

        for (let i = 0; i < toAdd.length; ++i) {
            const item = toAdd[i];
            const newIdx = items.length;
            items.push(item);
            if (item.bestIdx >= 0) {
                refCount[item.bestIdx]++;
            }
            setTargetItemIdx(item.x, item.y, item.z, newIdx);
        }
    };

    const peelSurfaceRoughness = (): void => {
        const candidates: number[] = [];
        for (let i = 0; i < items.length; ++i) {
            const it = items[i];
            if (it.alive && (it.occField < 0.62 || (it.anyTrueThin && it.occShell < 0.62))) {
                candidates.push(i);
            }
        }
        candidates.sort((a, b) => {
            const ia = items[a];
            const ib = items[b];
            const sa = ia.anyTrueThin ? ia.occShell : ia.occField;
            const sb = ib.anyTrueThin ? ib.occShell : ib.occField;
            return sa - sb;
        });
        for (let k = 0; k < candidates.length; ++k) {
            const idx = candidates[k];
            const it = items[idx];
            if (!it.alive) {
                continue;
            }
            if (it.anyTrueThin && it.bestIdx >= 0 && refCount[it.bestIdx] <= 1) {
                continue;
            }
            const mask27 = getMask27(it.x, it.y, it.z);
            const n6 = countN6(mask27);
            const n26 = countPopBits(mask27 & ~(1 << 13));
            if (n6 <= 1) {
                if ((it.anyTrueThin || n26 >= 9) && isSimplePoint26_6(mask27)) {
                    removeItem(idx);
                }
                continue;
            }
            // Peel jagged n6 === 2 surface bumps & isolated n6 === 3 staircase teeth on solid faces
            // without eroding sharp 90-degree cube corners (n26=7) or 2-voxel edges.
            if (!it.anyTrueThin && ((n6 === 2 && it.occField < 0.56 && n26 >= 11) || (n6 === 3 && it.occField < 0.53 && n26 === 11))) {
                if (isSimplePoint26_6(mask27)) {
                    removeItem(idx);
                }
            }
        }
    };

    for (let round = 0; round < 2; ++round) {
        fillSurfaceNotches();
        peelSurfaceRoughness();
    }
    fillSurfaceNotches();

    // Pass 3: Simultaneously carve enclosed cavity interior inside the faired outer Skin6(O')
    if (hasCavities) {
        const toCarve: number[] = [];
        for (let i = 0; i < items.length; ++i) {
            const it = items[i];
            if (!it.alive || it.anyTrueThin || it.occCavity < 0.30) {
                continue;
            }
            let all6InSolid = true;
            for (let d = 0; d < 6; ++d) {
                const nxPos = it.x + DIRS6[d][0];
                const nyPos = it.y + DIRS6[d][1];
                const nzPos = it.z + DIRS6[d][2];
                if (getTargetItemIdx(nxPos, nyPos, nzPos) < 0 && !isDeepInteriorCavity(nxPos, nyPos, nzPos)) {
                    all6InSolid = false;
                    break;
                }
            }
            if (all6InSolid) {
                toCarve.push(i);
            }
        }
        for (let i = 0; i < toCarve.length; ++i) {
            removeItem(toCarve[i]);
        }
    }

    const out: VoxelColourRecord[] = [];
    for (let i = 0; i < items.length; ++i) {
        const it = items[i];
        if (it.alive) {
            out.push({
                x: it.x,
                y: it.y,
                z: it.z,
                colour: it.colour,
            });
        }
    }
    return out;
}
