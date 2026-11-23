import { RGBA, RGBAUtil } from '../colour';

export interface SimpleVec3 {
    x: number;
    y: number;
    z: number;
}

function cross(a: SimpleVec3, b: SimpleVec3): SimpleVec3 {
    return {
        x: a.y * b.z - a.z * b.y,
        y: a.z * b.x - a.x * b.z,
        z: a.x * b.y - a.y * b.x,
    };
}

function dot(a: SimpleVec3, b: SimpleVec3): number {
    return a.x * b.x + a.y * b.y + a.z * b.z;
}

function sub(a: SimpleVec3, b: SimpleVec3): SimpleVec3 {
    return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function axisTest(axis: SimpleVec3, v0: SimpleVec3, v1: SimpleVec3, v2: SimpleVec3, halfSize: number): boolean {
    const p0 = dot(v0, axis);
    const p1 = dot(v1, axis);
    const p2 = dot(v2, axis);
    const r = halfSize * (Math.abs(axis.x) + Math.abs(axis.y) + Math.abs(axis.z));
    const minP = Math.min(p0, p1, p2);
    const maxP = Math.max(p0, p1, p2);
    return !(minP > r + 1e-6 || maxP < -r - 1e-6);
}

/**
 * Exact Akenine-Möller Triangle-AABB Separating Axis Theorem intersection test.
 * Guarantees thin walls, sharp spikes, and grazing triangles never drop voxels.
 */
export function triangleIntersectsAabb(
    a: SimpleVec3,
    b: SimpleVec3,
    c: SimpleVec3,
    boxCenter: SimpleVec3,
    halfSize = 0.5,
): boolean {
    const v0 = sub(a, boxCenter);
    const v1 = sub(b, boxCenter);
    const v2 = sub(c, boxCenter);

    // 1. AABB face normals (X, Y, Z)
    if (Math.min(v0.x, v1.x, v2.x) > halfSize + 1e-6 || Math.max(v0.x, v1.x, v2.x) < -halfSize - 1e-6) return false;
    if (Math.min(v0.y, v1.y, v2.y) > halfSize + 1e-6 || Math.max(v0.y, v1.y, v2.y) < -halfSize - 1e-6) return false;
    if (Math.min(v0.z, v1.z, v2.z) > halfSize + 1e-6 || Math.max(v0.z, v1.z, v2.z) < -halfSize - 1e-6) return false;

    const f0 = sub(v1, v0);
    const f1 = sub(v2, v1);
    const f2 = sub(v0, v2);

    // 2. Triangle plane normal
    const triNormal = cross(f0, f1);
    if (!axisTest(triNormal, v0, v1, v2, halfSize)) return false;

    // 3. 9 edge cross-product separating axes
    const edges = [f0, f1, f2];
    for (let i = 0; i < 3; ++i) {
        const e = edges[i];
        // e x (1,0,0) = (0, e.z, -e.y)
        if (!axisTest({ x: 0, y: e.z, z: -e.y }, v0, v1, v2, halfSize)) return false;
        // e x (0,1,0) = (-e.z, 0, e.x)
        if (!axisTest({ x: -e.z, y: 0, z: e.x }, v0, v1, v2, halfSize)) return false;
        // e x (0,0,1) = (e.y, -e.x, 0)
        if (!axisTest({ x: e.y, y: -e.x, z: 0 }, v0, v1, v2, halfSize)) return false;
    }

    return true;
}

/**
 * Exact Voronoi-region closest point on triangle (a, b, c) to query point p.
 */
export function closestPointOnTriangle(p: SimpleVec3, a: SimpleVec3, b: SimpleVec3, c: SimpleVec3): SimpleVec3 {
    const ab = sub(b, a);
    const ac = sub(c, a);
    const ap = sub(p, a);

    const d1 = dot(ab, ap);
    const d2 = dot(ac, ap);
    if (d1 <= 0 && d2 <= 0) return { x: a.x, y: a.y, z: a.z };

    const bp = sub(p, b);
    const d3 = dot(ab, bp);
    const d4 = dot(ac, bp);
    if (d3 >= 0 && d4 <= d3) return { x: b.x, y: b.y, z: b.z };

    const vc = d1 * d4 - d3 * d2;
    if (vc <= 0 && d1 >= 0 && d3 <= 0) {
        const v = d1 / (d1 - d3);
        return { x: a.x + v * ab.x, y: a.y + v * ab.y, z: a.z + v * ab.z };
    }

    const cp = sub(p, c);
    const d5 = dot(ab, cp);
    const d6 = dot(ac, cp);
    if (d6 >= 0 && d5 <= d6) return { x: c.x, y: c.y, z: c.z };

    const vb = d5 * d2 - d1 * d6;
    if (vb <= 0 && d2 >= 0 && d6 <= 0) {
        const w = d2 / (d2 - d6);
        return { x: a.x + w * ac.x, y: a.y + w * ac.y, z: a.z + w * ac.z };
    }

    const va = d3 * d6 - d5 * d4;
    if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) {
        const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
        return { x: b.x + w * (c.x - b.x), y: b.y + w * (c.y - b.y), z: b.z + w * (c.z - b.z) };
    }

    const denom = 1.0 / (va + vb + vc);
    const v = vb * denom;
    const w = vc * denom;
    return {
        x: a.x + ab.x * v + ac.x * w,
        y: a.y + ab.y * v + ac.y * w,
        z: a.z + ab.z * v + ac.z * w,
    };
}

export interface ScanlineCrossing {
    coord: number;
    colour: RGBA;
}

/**
 * Given sorted/unsorted ray crossings along a single scanline axis, deduplicates
 * near-coincident seams and extracts interior [enter, exit] spans.
 */
export function buildSolidIntervalsFromCrossings(crossings: ScanlineCrossing[]): Array<{
    start: number;
    end: number;
    entryColour: RGBA;
    exitColour: RGBA;
}> {
    if (crossings.length < 2) {
        return [];
    }

    const sorted = crossings.slice().sort((a, b) => a.coord - b.coord);
    const merged: ScanlineCrossing[] = [];
    for (let i = 0; i < sorted.length; ++i) {
        const cur = sorted[i];
        if (merged.length > 0 && Math.abs(cur.coord - merged[merged.length - 1].coord) < 1e-3) {
            // Seam between two adjacent co-planar/shared triangles: keep one crossing
            continue;
        }
        merged.push(cur);
    }

    // If odd number of crossings (e.g. grazed edge), drop the last stray hit so parity closes cleanly
    const pairLimit = merged.length - (merged.length % 2);
    const intervals: Array<{ start: number; end: number; entryColour: RGBA; exitColour: RGBA }> = [];
    for (let i = 0; i + 1 < pairLimit; i += 2) {
        const a = merged[i];
        const b = merged[i + 1];
        const start = Math.round(a.coord);
        const end = Math.round(b.coord);
        if (end >= start) {
            intervals.push({
                start,
                end,
                entryColour: a.colour,
                exitColour: b.colour,
            });
        }
    }
    return intervals;
}

export function interpolateSpanColour(entry: RGBA, exit: RGBA, t: number): RGBA {
    return RGBAUtil.lerpLinear(entry, exit, Math.max(0, Math.min(1, t)));
}

/**
 * Computes the closest point on triangle (a, b, c) and squared Euclidean distance from query point p.
 */
export function distanceSquaredToTriangle(
    p: SimpleVec3,
    a: SimpleVec3,
    b: SimpleVec3,
    c: SimpleVec3,
): { distSq: number; closest: SimpleVec3 } {
    const closest = closestPointOnTriangle(p, a, b, c);
    const dx = closest.x - p.x;
    const dy = closest.y - p.y;
    const dz = closest.z - p.z;
    return {
        distSq: dx * dx + dy * dy + dz * dz,
        closest,
    };
}

const SUB_VOXEL_OFFSETS: ReadonlyArray<readonly [number, number, number]> = [
    [-0.25, -0.25, -0.25],
    [0.25, -0.25, -0.25],
    [-0.25, 0.25, -0.25],
    [0.25, 0.25, -0.25],
    [-0.25, -0.25, 0.25],
    [0.25, -0.25, 0.25],
    [-0.25, 0.25, 0.25],
    [0.25, 0.25, 0.25],
];

/**
 * Evaluates 2x2x2 sub-voxel occupancy of triangle (a, b, c) inside unit voxel cell centered at `boxCenter`.
 * Returns an 8-bit bitmask (bits 0..7) indicating which sub-voxels intersect the triangle.
 */
export function evaluateSubVoxelCoverage(
    a: SimpleVec3,
    b: SimpleVec3,
    c: SimpleVec3,
    boxCenter: SimpleVec3,
): number {
    let mask = 0;
    for (let i = 0; i < 8; ++i) {
        const off = SUB_VOXEL_OFFSETS[i];
        const subCenter = {
            x: boxCenter.x + off[0],
            y: boxCenter.y + off[1],
            z: boxCenter.z + off[2],
        };
        if (triangleIntersectsAabb(a, b, c, subCenter, 0.25)) {
            mask |= (1 << i);
        }
    }
    return mask;
}

export function countMaskBits8(mask: number): number {
    let v = mask & 0xff;
    let count = 0;
    while (v !== 0) {
        v &= v - 1;
        ++count;
    }
    return count;
}

