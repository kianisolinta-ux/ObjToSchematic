import { RGBA } from './colour';
import { VoxelColourRecord } from './voxel_postprocess';

export interface IVoxelRotationAngles {
    x: number;
    y: number;
    z: number;
}

const DEG_TO_RAD = Math.PI / 180;
const RIGHT_ANGLE_EPS = 1e-6;

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
        cosa * cosb, cosa * sinb * sinc - sina * cosc, cosa * sinb * cosc + sina * sinc,
        sina * cosb, sina * sinb * sinc + cosa * cosc, sina * sinb * cosc - cosa * sinc,
        -sinb, cosb * sinc, cosb * cosc,
    ];
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
 * Rotates a sparse integer voxel grid around its bounding-box centre by Euler angles (x, y, z) in degrees.
 * - Multiples of 90 degrees use exact integer lattice mapping (100% lossless bijection).
 * - Arbitrary angles use orthogonal-bound sparse candidate generation + exact inverse lookup
 *   (O(N) complexity, zero checkerboard holes, crisp original colours).
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

    // Arbitrary angle: sparse O(N) candidate sweep + exact orthogonal inverse lookup (R^T)
    const coordMap = buildCoordMap(voxels);
    const visitedCandidates = new Map<number, Map<number, Set<number>>>();
    const out: VoxelColourRecord[] = [];

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

    const [
        r00, r01, r02,
        r10, r11, r12,
        r20, r21, r22,
    ] = m;

    for (let i = 0; i < voxels.length; ++i) {
        const v = voxels[i];
        const dx = v.x - cx;
        const dy = v.y - cy;
        const dz = v.z - cz;

        const px = cx + r00 * dx + r01 * dy + r02 * dz;
        const py = cy + r10 * dx + r11 * dy + r12 * dz;
        const pz = cz + r20 * dx + r21 * dy + r22 * dz;

        const baseX = Math.round(px);
        const baseY = Math.round(py);
        const baseZ = Math.round(pz);

        for (let ox = -1; ox <= 1; ++ox) {
            const tx = baseX + ox;
            const vx = tx - cx;
            for (let oy = -1; oy <= 1; ++oy) {
                const ty = baseY + oy;
                const vy = ty - cy;
                for (let oz = -1; oz <= 1; ++oz) {
                    const tz = baseZ + oz;
                    if (!markVisited(tx, ty, tz)) {
                        continue;
                    }
                    const vz = tz - cz;

                    // Inverse rotation R^T * (t - c) + c
                    const sx = Math.round(cx + r00 * vx + r10 * vy + r20 * vz);
                    const sy = Math.round(cy + r01 * vx + r11 * vy + r21 * vz);
                    const sz = Math.round(cz + r02 * vx + r12 * vy + r22 * vz);

                    const srcIdx = lookupCoordMap(coordMap, sx, sy, sz);
                    if (srcIdx !== -1) {
                        out.push({
                            x: tx,
                            y: ty,
                            z: tz,
                            colour: cloneColour(voxels[srcIdx].colour),
                        });
                    }
                }
            }
        }
    }

    return out;
}
