import { RGBA, RGBAUtil } from './colour';
import { Tri } from './mesh';
import { repairMeshData } from './mesh_repair';
import { UV } from './util';
import { Vector3 } from './vector';

export interface MeshGeometrySnapshot {
    vertices: Vector3[];
    normals: Vector3[];
    uvs: UV[];
    tris: Tri[];
    vertexColours?: RGBA[];
}

export interface MeshDiagnostics {
    vertexCount: number;
    triangleCount: number;
    dimensions: { x: number; y: number; z: number };
    minY: number;
    connectedComponents: number;
    degenerateTriangles: number;
    missingNormalTriangles: number;
    hasOobUVs: boolean;
    hasVertexColours: boolean;
}

export interface MeshEditParams {
    operation:
        | 'transform'
        | 'translate'
        | 'smoothMesh'
        | 'inflateMesh'
        | 'symmetrizeMesh'
        | 'flipNormals'
        | 'recomputeNormals'
        | 'flatNormals'
        | 'centerGround'
        | 'putOnGround'
        | 'normalizeSize'
        | 'weldVertices'
        | 'decimate'
        | 'cleanRepair'
        | 'cropBounds'
        | 'reset'
        | 'undo';
    rotateDeg?: { x: number; y: number; z: number };
    scale?: { x: number; y: number; z: number };
    offset?: { x: number; y: number; z: number };
    preservePivot?: boolean;
    flipAxis?: 'x' | 'y' | 'z' | null;
    weldTolerance?: number;
    decimateRatio?: number;
    smoothFactor?: number;
    smoothIterations?: number;
    inflateAmount?: number;
    symmetryAxis?: 'x' | 'z';
    symmetryDirection?: 'posToNeg' | 'negToPos';
    removeSmallIslands?: boolean;
    minIslandTriangles?: number;
    forceRecomputeNormals?: boolean;
    groundAndCenter?: boolean;
    cropMin?: { x: number; y: number; z: number };
    cropMax?: { x: number; y: number; z: number };
}

export function cloneMeshGeometry(geom: MeshGeometrySnapshot): MeshGeometrySnapshot {
    return {
        vertices: geom.vertices.map((v) => v.copy()),
        normals: geom.normals.map((n) => n.copy()),
        uvs: geom.uvs.map((uv) => new UV(uv.u, uv.v)),
        tris: geom.tris.map((t) => ({
            positionIndices: { ...t.positionIndices },
            texcoordIndices: t.texcoordIndices ? { ...t.texcoordIndices } : undefined,
            normalIndices: t.normalIndices ? { ...t.normalIndices } : undefined,
            vertexColourIndices: t.vertexColourIndices ? { ...t.vertexColourIndices } : undefined,
            material: t.material,
        })),
        vertexColours: geom.vertexColours ? geom.vertexColours.map((c) => RGBAUtil.copy(c)) : undefined,
    };
}

function getBoundsOfVertices(vertices: Vector3[]): { min: Vector3; max: Vector3 } {
    const min = new Vector3(Infinity, Infinity, Infinity);
    const max = new Vector3(-Infinity, -Infinity, -Infinity);
    for (let i = 0; i < vertices.length; ++i) {
        const v = vertices[i];
        if (v.x < min.x) min.x = v.x;
        if (v.y < min.y) min.y = v.y;
        if (v.z < min.z) min.z = v.z;
        if (v.x > max.x) max.x = v.x;
        if (v.y > max.y) max.y = v.y;
        if (v.z > max.z) max.z = v.z;
    }
    if (!Number.isFinite(min.x)) {
        return { min: new Vector3(0, 0, 0), max: new Vector3(0, 0, 0) };
    }
    return { min, max };
}

function reverseTriangleWinding(tris: Tri[]) {
    for (let i = 0; i < tris.length; ++i) {
        const t = tris[i];
        const tmpPos = t.positionIndices.y;
        t.positionIndices.y = t.positionIndices.z;
        t.positionIndices.z = tmpPos;

        if (t.texcoordIndices) {
            const tmpUv = t.texcoordIndices.y;
            t.texcoordIndices.y = t.texcoordIndices.z;
            t.texcoordIndices.z = tmpUv;
        }
        if (t.normalIndices) {
            const tmpNorm = t.normalIndices.y;
            t.normalIndices.y = t.normalIndices.z;
            t.normalIndices.z = tmpNorm;
        }
        if (t.vertexColourIndices) {
            const tmpCol = t.vertexColourIndices.y;
            t.vertexColourIndices.y = t.vertexColourIndices.z;
            t.vertexColourIndices.z = tmpCol;
        }
    }
}

export function recomputeSmoothNormals(geom: MeshGeometrySnapshot): void {
    const accum = geom.vertices.map(() => new Vector3(0, 0, 0));

    for (let i = 0; i < geom.tris.length; ++i) {
        const t = geom.tris[i];
        const v0 = geom.vertices[t.positionIndices.x];
        const v1 = geom.vertices[t.positionIndices.y];
        const v2 = geom.vertices[t.positionIndices.z];
        if (!v0 || !v1 || !v2) continue;

        const e1 = Vector3.sub(v1, v0);
        const e2 = Vector3.sub(v2, v0);
        const faceN = Vector3.cross(e1, e2);
        accum[t.positionIndices.x].add(faceN);
        accum[t.positionIndices.y].add(faceN);
        accum[t.positionIndices.z].add(faceN);

        t.normalIndices = {
            x: t.positionIndices.x,
            y: t.positionIndices.y,
            z: t.positionIndices.z,
        };
    }

    geom.normals = accum.map((n) => {
        const mag = n.magnitude();
        return mag > 1e-8 ? n.normalise() : new Vector3(0, 1, 0);
    });
}

export function computeFlatNormals(geom: MeshGeometrySnapshot): void {
    const outNormals: Vector3[] = [];
    for (let i = 0; i < geom.tris.length; ++i) {
        const t = geom.tris[i];
        const v0 = geom.vertices[t.positionIndices.x];
        const v1 = geom.vertices[t.positionIndices.y];
        const v2 = geom.vertices[t.positionIndices.z];
        let fn = new Vector3(0, 1, 0);
        if (v0 && v1 && v2) {
            const e1 = Vector3.sub(v1, v0);
            const e2 = Vector3.sub(v2, v0);
            const cross = Vector3.cross(e1, e2);
            const mag = cross.magnitude();
            if (mag > 1e-8) {
                fn = cross.normalise();
            }
        }
        const nIdx = outNormals.length;
        outNormals.push(fn);
        t.normalIndices = { x: nIdx, y: nIdx, z: nIdx };
    }
    geom.normals = outNormals;
}

export function analyzeMeshGeometry(geom: MeshGeometrySnapshot): MeshDiagnostics {
    const { min, max } = getBoundsOfVertices(geom.vertices);
    const triCount = geom.tris.length;

    let degenerateTriangles = 0;
    let missingNormalTriangles = 0;
    let hasOobUVs = false;

    const parent = new Int32Array(triCount);
    const rank = new Uint8Array(triCount);
    for (let i = 0; i < triCount; ++i) parent[i] = i;

    const find = (x: number): number => {
        while (parent[x] !== x) {
            parent[x] = parent[parent[x]];
            x = parent[x];
        }
        return x;
    };
    const union = (a: number, b: number) => {
        const ra = find(a);
        const rb = find(b);
        if (ra === rb) return;
        if (rank[ra] < rank[rb]) parent[ra] = rb;
        else if (rank[ra] > rank[rb]) parent[rb] = ra;
        else {
            parent[rb] = ra;
            rank[ra]++;
        }
    };

    const vertOwnerTri = new Map<string, number>();
    const isDegenerateTri = new Uint8Array(triCount);

    for (let t = 0; t < triCount; ++t) {
        const tri = geom.tris[t];
        const i0 = tri.positionIndices.x;
        const i1 = tri.positionIndices.y;
        const i2 = tri.positionIndices.z;
        const v0 = geom.vertices[i0];
        const v1 = geom.vertices[i1];
        const v2 = geom.vertices[i2];

        if (!v0 || !v1 || !v2 || i0 === i1 || i1 === i2 || i2 === i0) {
            degenerateTriangles++;
            isDegenerateTri[t] = 1;
        } else {
            const e1x = v1.x - v0.x;
            const e1y = v1.y - v0.y;
            const e1z = v1.z - v0.z;
            const e2x = v2.x - v0.x;
            const e2y = v2.y - v0.y;
            const e2z = v2.z - v0.z;
            const cx = e1y * e2z - e1z * e2y;
            const cy = e1z * e2x - e1x * e2z;
            const cz = e1x * e2y - e1y * e2x;
            if (!Number.isFinite(cx) || cx * cx + cy * cy + cz * cz <= 1e-14) {
                degenerateTriangles++;
                isDegenerateTri[t] = 1;
            }

            const vs = [v0, v1, v2];
            for (let k = 0; k < 3; ++k) {
                const v = vs[k];
                const key = `${Math.round(v.x * 1e4)},${Math.round(v.y * 1e4)},${Math.round(v.z * 1e4)}`;
                const owner = vertOwnerTri.get(key);
                if (owner === undefined) {
                    vertOwnerTri.set(key, t);
                } else {
                    union(owner, t);
                }
            }
        }

        if (!tri.normalIndices) {
            missingNormalTriangles++;
        } else {
            const n0 = geom.normals[tri.normalIndices.x];
            const n1 = geom.normals[tri.normalIndices.y];
            const n2 = geom.normals[tri.normalIndices.z];
            if (
                !n0 || !n1 || !n2 ||
                n0.magnitude() <= 1e-5 ||
                n1.magnitude() <= 1e-5 ||
                n2.magnitude() <= 1e-5
            ) {
                missingNormalTriangles++;
            }
        }

        if (!hasOobUVs && tri.texcoordIndices) {
            const uv0 = geom.uvs[tri.texcoordIndices.x];
            const uv1 = geom.uvs[tri.texcoordIndices.y];
            const uv2 = geom.uvs[tri.texcoordIndices.z];
            const uvs = [uv0, uv1, uv2];
            for (const uv of uvs) {
                if (uv && (uv.u < 0 || uv.u > 1 || uv.v < 0 || uv.v > 1)) {
                    hasOobUVs = true;
                    break;
                }
            }
        }
    }

    const roots = new Set<number>();
    for (let t = 0; t < triCount; ++t) {
        if (!isDegenerateTri[t]) {
            roots.add(find(t));
        }
    }

    return {
        vertexCount: geom.vertices.length,
        triangleCount: triCount,
        dimensions: {
            x: Math.max(0, max.x - min.x),
            y: Math.max(0, max.y - min.y),
            z: Math.max(0, max.z - min.z),
        },
        minY: min.y,
        connectedComponents: roots.size,
        degenerateTriangles,
        missingNormalTriangles,
        hasOobUVs,
        hasVertexColours: Boolean(geom.vertexColours && geom.vertexColours.length > 0),
    };
}

function compactGeometry(
    vertices: Vector3[],
    normals: Vector3[],
    uvs: UV[],
    tris: Tri[],
    vertexColours?: RGBA[],
): MeshGeometrySnapshot {
    const vertRemap = new Map<number, number>();
    const normRemap = new Map<number, number>();
    const uvRemap = new Map<number, number>();
    const colRemap = new Map<number, number>();

    const outVertices: Vector3[] = [];
    const outNormals: Vector3[] = [];
    const outUVs: UV[] = [];
    const outVertexColours: RGBA[] | undefined = vertexColours ? [] : undefined;
    const outTris: Tri[] = [];

    const mapVert = (idx: number): number => {
        const ex = vertRemap.get(idx);
        if (ex !== undefined) return ex;
        const next = outVertices.length;
        outVertices.push(vertices[idx].copy());
        vertRemap.set(idx, next);
        return next;
    };

    const mapNorm = (idx: number): number => {
        const ex = normRemap.get(idx);
        if (ex !== undefined) return ex;
        const next = outNormals.length;
        outNormals.push((normals[idx] ?? new Vector3(0, 1, 0)).copy());
        normRemap.set(idx, next);
        return next;
    };

    const mapUV = (idx: number): number => {
        const ex = uvRemap.get(idx);
        if (ex !== undefined) return ex;
        const next = outUVs.length;
        const src = uvs[idx] ?? new UV(0, 0);
        outUVs.push(new UV(src.u, src.v));
        uvRemap.set(idx, next);
        return next;
    };

    const mapCol = (idx: number): number => {
        const ex = colRemap.get(idx);
        if (ex !== undefined) return ex;
        const next = outVertexColours!.length;
        const src = vertexColours![idx] ?? { r: 1, g: 1, b: 1, a: 1 };
        outVertexColours!.push(RGBAUtil.copy(src));
        colRemap.set(idx, next);
        return next;
    };

    for (let t = 0; t < tris.length; ++t) {
        const tri = tris[t];
        const nv0 = mapVert(tri.positionIndices.x);
        const nv1 = mapVert(tri.positionIndices.y);
        const nv2 = mapVert(tri.positionIndices.z);
        if (nv0 === nv1 || nv1 === nv2 || nv2 === nv0) continue;

        const outTri: Tri = {
            positionIndices: { x: nv0, y: nv1, z: nv2 },
            material: tri.material,
        };
        if (tri.normalIndices) {
            outTri.normalIndices = {
                x: mapNorm(tri.normalIndices.x),
                y: mapNorm(tri.normalIndices.y),
                z: mapNorm(tri.normalIndices.z),
            };
        }
        if (tri.texcoordIndices) {
            outTri.texcoordIndices = {
                x: mapUV(tri.texcoordIndices.x),
                y: mapUV(tri.texcoordIndices.y),
                z: mapUV(tri.texcoordIndices.z),
            };
        }
        if (tri.vertexColourIndices && outVertexColours) {
            outTri.vertexColourIndices = {
                x: mapCol(tri.vertexColourIndices.x),
                y: mapCol(tri.vertexColourIndices.y),
                z: mapCol(tri.vertexColourIndices.z),
            };
        }
        outTris.push(outTri);
    }

    return {
        vertices: outVertices,
        normals: outNormals,
        uvs: outUVs,
        tris: outTris,
        vertexColours: outVertexColours,
    };
}

function weldMeshVertices(geom: MeshGeometrySnapshot, tolerance: number): MeshGeometrySnapshot {
    const tol = Math.max(1e-7, tolerance);
    const invTol = 1 / tol;
    const cellToCluster = new Map<string, number>();
    const vertToCluster = new Int32Array(geom.vertices.length);
    const sumX: number[] = [];
    const sumY: number[] = [];
    const sumZ: number[] = [];
    const counts: number[] = [];

    for (let i = 0; i < geom.vertices.length; ++i) {
        const v = geom.vertices[i];
        const key = `${Math.round(v.x * invTol)},${Math.round(v.y * invTol)},${Math.round(v.z * invTol)}`;
        let cid = cellToCluster.get(key);
        if (cid === undefined) {
            cid = counts.length;
            cellToCluster.set(key, cid);
            sumX.push(0);
            sumY.push(0);
            sumZ.push(0);
            counts.push(0);
        }
        vertToCluster[i] = cid;
        sumX[cid] += v.x;
        sumY[cid] += v.y;
        sumZ[cid] += v.z;
        counts[cid] += 1;
    }

    const weldedVerts: Vector3[] = counts.map(
        (cnt, idx) => new Vector3(sumX[idx] / cnt, sumY[idx] / cnt, sumZ[idx] / cnt),
    );

    const keptTris: Tri[] = [];
    for (let t = 0; t < geom.tris.length; ++t) {
        const tri = geom.tris[t];
        const a = vertToCluster[tri.positionIndices.x];
        const b = vertToCluster[tri.positionIndices.y];
        const c = vertToCluster[tri.positionIndices.z];
        if (a === b || b === c || c === a) continue;
        keptTris.push({
            positionIndices: { x: a, y: b, z: c },
            normalIndices: tri.normalIndices ? { ...tri.normalIndices } : undefined,
            texcoordIndices: tri.texcoordIndices ? { ...tri.texcoordIndices } : undefined,
            vertexColourIndices: tri.vertexColourIndices ? { ...tri.vertexColourIndices } : undefined,
            material: tri.material,
        });
    }

    if (keptTris.length === 0) {
        return cloneMeshGeometry(geom);
    }

    return compactGeometry(weldedVerts, geom.normals, geom.uvs, keptTris, geom.vertexColours);
}

function decimateMeshByClustering(geom: MeshGeometrySnapshot, targetRatio: number): MeshGeometrySnapshot {
    const ratio = Math.max(0.05, Math.min(0.98, targetRatio));
    if (geom.tris.length <= 12 || ratio >= 0.98) {
        return cloneMeshGeometry(geom);
    }

    const { min, max } = getBoundsOfVertices(geom.vertices);
    const dx = Math.max(1e-5, max.x - min.x);
    const dy = Math.max(1e-5, max.y - min.y);
    const dz = Math.max(1e-5, max.z - min.z);
    const maxSpan = Math.max(dx, dy, dz);
    const desiredTris = Math.max(4, Math.round(geom.tris.length * ratio));

    const runGrid = (gridRes: number): MeshGeometrySnapshot => {
        const invCell = gridRes / maxSpan;
        const cellToCluster = new Map<string, number>();
        const vertToCluster = new Int32Array(geom.vertices.length);
        const sumX: number[] = [];
        const sumY: number[] = [];
        const sumZ: number[] = [];
        const counts: number[] = [];

        for (let i = 0; i < geom.vertices.length; ++i) {
            const v = geom.vertices[i];
            const gx = Math.floor((v.x - min.x) * invCell);
            const gy = Math.floor((v.y - min.y) * invCell);
            const gz = Math.floor((v.z - min.z) * invCell);
            const key = `${gx},${gy},${gz}`;
            let cid = cellToCluster.get(key);
            if (cid === undefined) {
                cid = counts.length;
                cellToCluster.set(key, cid);
                sumX.push(0);
                sumY.push(0);
                sumZ.push(0);
                counts.push(0);
            }
            vertToCluster[i] = cid;
            sumX[cid] += v.x;
            sumY[cid] += v.y;
            sumZ[cid] += v.z;
            counts[cid] += 1;
        }

        const outVerts = counts.map((c, idx) => new Vector3(sumX[idx] / c, sumY[idx] / c, sumZ[idx] / c));
        const keptTris: Tri[] = [];
        for (let t = 0; t < geom.tris.length; ++t) {
            const tri = geom.tris[t];
            const a = vertToCluster[tri.positionIndices.x];
            const b = vertToCluster[tri.positionIndices.y];
            const c = vertToCluster[tri.positionIndices.z];
            if (a === b || b === c || c === a) continue;
            keptTris.push({
                positionIndices: { x: a, y: b, z: c },
                texcoordIndices: tri.texcoordIndices ? { ...tri.texcoordIndices } : undefined,
                normalIndices: tri.normalIndices ? { ...tri.normalIndices } : undefined,
                vertexColourIndices: tri.vertexColourIndices ? { ...tri.vertexColourIndices } : undefined,
                material: tri.material,
            });
        }

        const compacted = compactGeometry(outVerts, geom.normals, geom.uvs, keptTris, geom.vertexColours);
        recomputeSmoothNormals(compacted);
        return compacted;
    };

    let lo = 3;
    let hi = Math.max(8, Math.ceil(Math.cbrt(geom.vertices.length) * 2.2));
    let best: MeshGeometrySnapshot | null = null;
    let bestDiff = Infinity;

    for (let iter = 0; iter < 7 && lo <= hi; ++iter) {
        const mid = Math.floor((lo + hi) * 0.5);
        const candidate = runGrid(mid);
        const count = candidate.tris.length;
        if (count >= 4) {
            const diff = Math.abs(count - desiredTris);
            if (diff < bestDiff) {
                bestDiff = diff;
                best = candidate;
            }
        }
        if (count < desiredTris) {
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }

    if (!best || best.tris.length < 4 || best.tris.length >= geom.tris.length) {
        const fallback = runGrid(Math.max(4, Math.round(Math.cbrt(desiredTris) * 1.4)));
        return fallback.tris.length >= 4 && fallback.tris.length < geom.tris.length ?
            fallback :
            cloneMeshGeometry(geom);
    }

    return best;
}

function cropMeshByNormalizedBounds(
    geom: MeshGeometrySnapshot,
    cropMin: { x: number; y: number; z: number },
    cropMax: { x: number; y: number; z: number },
): MeshGeometrySnapshot {
    const { min, max } = getBoundsOfVertices(geom.vertices);
    const minX = min.x + (max.x - min.x) * Math.max(0, Math.min(1, cropMin.x)) - 1e-6;
    const maxX = min.x + (max.x - min.x) * Math.max(0, Math.min(1, cropMax.x)) + 1e-6;
    const minY = min.y + (max.y - min.y) * Math.max(0, Math.min(1, cropMin.y)) - 1e-6;
    const maxY = min.y + (max.y - min.y) * Math.max(0, Math.min(1, cropMax.y)) + 1e-6;
    const minZ = min.z + (max.z - min.z) * Math.max(0, Math.min(1, cropMin.z)) - 1e-6;
    const maxZ = min.z + (max.z - min.z) * Math.max(0, Math.min(1, cropMax.z)) + 1e-6;

    const keptTris: Tri[] = [];
    for (let t = 0; t < geom.tris.length; ++t) {
        const tri = geom.tris[t];
        const v0 = geom.vertices[tri.positionIndices.x];
        const v1 = geom.vertices[tri.positionIndices.y];
        const v2 = geom.vertices[tri.positionIndices.z];
        if (!v0 || !v1 || !v2) continue;

        const cx = (v0.x + v1.x + v2.x) / 3;
        const cy = (v0.y + v1.y + v2.y) / 3;
        const cz = (v0.z + v1.z + v2.z) / 3;
        if (
            cx >= minX && cx <= maxX &&
            cy >= minY && cy <= maxY &&
            cz >= minZ && cz <= maxZ
        ) {
            keptTris.push(tri);
        }
    }

    if (keptTris.length === 0) {
        return cloneMeshGeometry(geom);
    }

    const out = compactGeometry(geom.vertices, geom.normals, geom.uvs, keptTris, geom.vertexColours);
    const b = getBoundsOfVertices(out.vertices);
    const mx = (b.min.x + b.max.x) * 0.5;
    const my = (b.min.y + b.max.y) * 0.5;
    const mz = (b.min.z + b.max.z) * 0.5;
    for (let i = 0; i < out.vertices.length; ++i) {
        out.vertices[i].x -= mx;
        out.vertices[i].y -= my;
        out.vertices[i].z -= mz;
    }
    return out;
}

export function applyMeshEditOp(geom: MeshGeometrySnapshot, params: MeshEditParams): MeshGeometrySnapshot {
    const out = cloneMeshGeometry(geom);

    if (params.operation === 'flipNormals') {
        reverseTriangleWinding(out.tris);
        for (let i = 0; i < out.normals.length; ++i) {
            out.normals[i].negate();
        }
        return out;
    }

    if (params.operation === 'recomputeNormals') {
        recomputeSmoothNormals(out);
        return out;
    }

    if (params.operation === 'flatNormals') {
        computeFlatNormals(out);
        return out;
    }

    if (params.operation === 'centerGround') {
        const { min, max } = getBoundsOfVertices(out.vertices);
        const cx = (min.x + max.x) * 0.5;
        const cy = (min.y + max.y) * 0.5;
        const cz = (min.z + max.z) * 0.5;
        for (let i = 0; i < out.vertices.length; ++i) {
            out.vertices[i].x -= cx;
            out.vertices[i].y -= cy;
            out.vertices[i].z -= cz;
        }
        return out;
    }

    if (params.operation === 'putOnGround') {
        const { min, max } = getBoundsOfVertices(out.vertices);
        const cx = (min.x + max.x) * 0.5;
        const minY = min.y;
        const cz = (min.z + max.z) * 0.5;
        for (let i = 0; i < out.vertices.length; ++i) {
            out.vertices[i].x -= cx;
            out.vertices[i].y -= minY;
            out.vertices[i].z -= cz;
        }
        return out;
    }

    if (params.operation === 'normalizeSize') {
        const { min, max } = getBoundsOfVertices(out.vertices);
        const dy = max.y - min.y;
        const maxDim = Math.max(max.x - min.x, dy, max.z - min.z);
        const ref = dy > 1e-5 ? dy : maxDim;
        if (ref > 1e-6) {
            const scale = 1.0 / ref;
            const cx = (min.x + max.x) * 0.5;
            const cy = (min.y + max.y) * 0.5;
            const cz = (min.z + max.z) * 0.5;
            for (let i = 0; i < out.vertices.length; ++i) {
                out.vertices[i].x = (out.vertices[i].x - cx) * scale;
                out.vertices[i].y = (out.vertices[i].y - cy) * scale;
                out.vertices[i].z = (out.vertices[i].z - cz) * scale;
            }
        }
        return out;
    }

    if (params.operation === 'weldVertices') {
        return weldMeshVertices(out, params.weldTolerance ?? 1e-4);
    }

    if (params.operation === 'decimate') {
        return decimateMeshByClustering(out, params.decimateRatio ?? 0.5);
    }

    if (params.operation === 'cleanRepair') {
        const repaired = repairMeshData(out, {
            groundAndCenter: params.groundAndCenter ?? false,
            fixNormals: true,
            forceRecomputeNormals: params.forceRecomputeNormals ?? false,
            removeSmallIslands: params.removeSmallIslands ?? false,
            minIslandTriangles: params.minIslandTriangles ?? 16,
        });
        if (repaired.tris.length === 0) {
            return out;
        }
        return {
            vertices: repaired.vertices.map((v) => new Vector3(v.x, v.y, v.z)),
            normals: repaired.normals.map((n) => new Vector3(n.x, n.y, n.z)),
            uvs: repaired.uvs.map((u) => new UV(u.u, u.v)),
            tris: repaired.tris.map((t) => ({
                positionIndices: { ...t.positionIndices },
                normalIndices: t.normalIndices ? { ...t.normalIndices } : undefined,
                texcoordIndices: t.texcoordIndices ? { ...t.texcoordIndices } : undefined,
                vertexColourIndices: t.vertexColourIndices ? { ...t.vertexColourIndices } : undefined,
                material: t.material,
            })),
            vertexColours: repaired.vertexColours?.map((c) => RGBAUtil.copy(c)),
        };
    }

    if (params.operation === 'cropBounds') {
        return cropMeshByNormalizedBounds(
            out,
            params.cropMin ?? { x: 0, y: 0, z: 0 },
            params.cropMax ?? { x: 1, y: 1, z: 1 },
        );
    }

    if (params.operation === 'translate') {
        const dx = params.offset?.x ?? 0;
        const dy = params.offset?.y ?? 0;
        const dz = params.offset?.z ?? 0;
        for (let i = 0; i < out.vertices.length; ++i) {
            out.vertices[i].x += dx;
            out.vertices[i].y += dy;
            out.vertices[i].z += dz;
        }
        return out;
    }

    if (params.operation === 'smoothMesh') {
        const factor = Math.max(0.05, Math.min(1.0, params.smoothFactor ?? 0.35));
        const iterations = Math.max(1, Math.min(12, Math.round(params.smoothIterations ?? 2)));
        smoothMeshVertices(out, factor, iterations);
        recomputeSmoothNormals(out);
        return out;
    }

    if (params.operation === 'inflateMesh') {
        const amount = Math.max(-0.5, Math.min(0.5, params.inflateAmount ?? 0.05));
        inflateMeshVertices(out, amount);
        recomputeSmoothNormals(out);
        return out;
    }

    if (params.operation === 'symmetrizeMesh') {
        const axis = params.symmetryAxis ?? 'x';
        const direction = params.symmetryDirection ?? 'posToNeg';
        return symmetrizeMeshGeometry(out, axis, direction);
    }

    if (params.operation === 'transform') {
        const sx = params.scale?.x ?? 1;
        const sy = params.scale?.y ?? 1;
        const sz = params.scale?.z ?? 1;
        const safeSx = Number.isFinite(sx) && Math.abs(sx) > 1e-4 ? sx : 1;
        const safeSy = Number.isFinite(sy) && Math.abs(sy) > 1e-4 ? sy : 1;
        const safeSz = Number.isFinite(sz) && Math.abs(sz) > 1e-4 ? sz : 1;

        const degToRad = Math.PI / 180;
        const rx = (params.rotateDeg?.x ?? 0) * degToRad;
        const ry = (params.rotateDeg?.y ?? 0) * degToRad;
        const rz = (params.rotateDeg?.z ?? 0) * degToRad;

        const cx = Math.cos(rx);
        const sxr = Math.sin(rx);
        const cy = Math.cos(ry);
        const syr = Math.sin(ry);
        const cz = Math.cos(rz);
        const szr = Math.sin(rz);

        // Intrinsic X -> Y -> Z rotation matrix
        const r00 = cy * cz;
        const r01 = sxr * syr * cz - cx * szr;
        const r02 = cx * syr * cz + sxr * szr;
        const r10 = cy * szr;
        const r11 = sxr * syr * szr + cx * cz;
        const r12 = cx * syr * szr - sxr * cz;
        const r20 = -syr;
        const r21 = sxr * cy;
        const r22 = cx * cy;

        const invSx = 1 / safeSx;
        const invSy = 1 / safeSy;
        const invSz = 1 / safeSz;

        const flipAxis = params.flipAxis ?? null;
        const flipX = flipAxis === 'x' ? -1 : 1;
        const flipY = flipAxis === 'y' ? -1 : 1;
        const flipZ = flipAxis === 'z' ? -1 : 1;

        const preBounds = getBoundsOfVertices(out.vertices);
        const pivotX = params.preservePivot ? (preBounds.min.x + preBounds.max.x) * 0.5 : 0;
        const pivotY = params.preservePivot ? (preBounds.min.y + preBounds.max.y) * 0.5 : 0;
        const pivotZ = params.preservePivot ? (preBounds.min.z + preBounds.max.z) * 0.5 : 0;

        for (let i = 0; i < out.vertices.length; ++i) {
            const v = out.vertices[i];
            const vx = (v.x - pivotX) * safeSx;
            const vy = (v.y - pivotY) * safeSy;
            const vz = (v.z - pivotZ) * safeSz;

            const rxv = r00 * vx + r01 * vy + r02 * vz;
            const ryv = r10 * vx + r11 * vy + r12 * vz;
            const rzv = r20 * vx + r21 * vy + r22 * vz;

            v.x = rxv * flipX + pivotX;
            v.y = ryv * flipY + pivotY;
            v.z = rzv * flipZ + pivotZ;
        }

        for (let i = 0; i < out.normals.length; ++i) {
            const n = out.normals[i];
            const nx = n.x * invSx;
            const ny = n.y * invSy;
            const nz = n.z * invSz;

            const rxn = (r00 * nx + r01 * ny + r02 * nz) * flipX;
            const ryn = (r10 * nx + r11 * ny + r12 * nz) * flipY;
            const rzn = (r20 * nx + r21 * ny + r22 * nz) * flipZ;

            n.x = rxn;
            n.y = ryn;
            n.z = rzn;
            const mag = n.magnitude();
            if (mag > 1e-8) {
                n.normalise();
            }
        }

        const detSign = Math.sign(safeSx * safeSy * safeSz * flipX * flipY * flipZ);
        if (detSign < 0) {
            reverseTriangleWinding(out.tris);
        }

        if (!params.preservePivot) {
            // Keep edited model centered around origin
            const { min, max } = getBoundsOfVertices(out.vertices);
            const midX = (min.x + max.x) * 0.5;
            const midY = (min.y + max.y) * 0.5;
            const midZ = (min.z + max.z) * 0.5;
            for (let i = 0; i < out.vertices.length; ++i) {
                out.vertices[i].x -= midX;
                out.vertices[i].y -= midY;
                out.vertices[i].z -= midZ;
            }
        }
    }

    return out;
}

function buildSpatialVertexClusters(vertices: Vector3[]): {
    vertToCluster: Int32Array;
    clusterCount: number;
    clusterPos: Vector3[];
} {
    const vertToCluster = new Int32Array(vertices.length);
    const keyToCluster = new Map<string, number>();
    const clusterPos: Vector3[] = [];
    for (let i = 0; i < vertices.length; ++i) {
        const v = vertices[i];
        const key = `${Math.round(v.x * 1e5)},${Math.round(v.y * 1e5)},${Math.round(v.z * 1e5)}`;
        let cid = keyToCluster.get(key);
        if (cid === undefined) {
            cid = clusterPos.length;
            keyToCluster.set(key, cid);
            clusterPos.push(v.copy());
        }
        vertToCluster[i] = cid;
    }
    return { vertToCluster, clusterCount: clusterPos.length, clusterPos };
}

function smoothMeshVertices(geom: MeshGeometrySnapshot, factor: number, iterations: number): void {
    if (geom.vertices.length === 0 || geom.tris.length === 0) return;

    const { vertToCluster, clusterCount, clusterPos } = buildSpatialVertexClusters(geom.vertices);
    const neighbors: Set<number>[] = Array.from({ length: clusterCount }, () => new Set<number>());

    for (let t = 0; t < geom.tris.length; ++t) {
        const tri = geom.tris[t];
        const a = vertToCluster[tri.positionIndices.x];
        const b = vertToCluster[tri.positionIndices.y];
        const c = vertToCluster[tri.positionIndices.z];
        if (a !== b) {
            neighbors[a].add(b);
            neighbors[b].add(a);
        }
        if (b !== c) {
            neighbors[b].add(c);
            neighbors[c].add(b);
        }
        if (c !== a) {
            neighbors[c].add(a);
            neighbors[a].add(c);
        }
    }

    let current = clusterPos.map((p) => p.copy());
    for (let it = 0; it < iterations; ++it) {
        const next = current.map((p) => p.copy());
        for (let c = 0; c < clusterCount; ++c) {
            const nbrs = neighbors[c];
            if (nbrs.size === 0) continue;
            let sx = 0;
            let sy = 0;
            let sz = 0;
            nbrs.forEach((nid) => {
                sx += current[nid].x;
                sy += current[nid].y;
                sz += current[nid].z;
            });
            const inv = 1 / nbrs.size;
            const avgX = sx * inv;
            const avgY = sy * inv;
            const avgZ = sz * inv;
            next[c].x = current[c].x + (avgX - current[c].x) * factor;
            next[c].y = current[c].y + (avgY - current[c].y) * factor;
            next[c].z = current[c].z + (avgZ - current[c].z) * factor;
        }
        current = next;
    }

    for (let i = 0; i < geom.vertices.length; ++i) {
        const cid = vertToCluster[i];
        geom.vertices[i].x = current[cid].x;
        geom.vertices[i].y = current[cid].y;
        geom.vertices[i].z = current[cid].z;
    }
}

function inflateMeshVertices(geom: MeshGeometrySnapshot, relativeAmount: number): void {
    if (geom.vertices.length === 0 || geom.tris.length === 0 || Math.abs(relativeAmount) < 1e-6) return;

    const { min, max } = getBoundsOfVertices(geom.vertices);
    const maxSpan = Math.max(1e-4, max.x - min.x, max.y - min.y, max.z - min.z);
    const displacement = relativeAmount * maxSpan;

    const { vertToCluster, clusterCount } = buildSpatialVertexClusters(geom.vertices);
    const accumNormals = Array.from({ length: clusterCount }, () => new Vector3(0, 0, 0));

    for (let t = 0; t < geom.tris.length; ++t) {
        const tri = geom.tris[t];
        const i0 = tri.positionIndices.x;
        const i1 = tri.positionIndices.y;
        const i2 = tri.positionIndices.z;
        const v0 = geom.vertices[i0];
        const v1 = geom.vertices[i1];
        const v2 = geom.vertices[i2];
        if (!v0 || !v1 || !v2) continue;

        const faceN = Vector3.cross(Vector3.sub(v1, v0), Vector3.sub(v2, v0));
        accumNormals[vertToCluster[i0]].add(faceN);
        accumNormals[vertToCluster[i1]].add(faceN);
        accumNormals[vertToCluster[i2]].add(faceN);
    }

    const unitNormals = accumNormals.map((n) => (n.magnitude() > 1e-8 ? n.normalise() : new Vector3(0, 0, 0)));
    for (let i = 0; i < geom.vertices.length; ++i) {
        const n = unitNormals[vertToCluster[i]];
        geom.vertices[i].x += n.x * displacement;
        geom.vertices[i].y += n.y * displacement;
        geom.vertices[i].z += n.z * displacement;
    }
}

function symmetrizeMeshGeometry(
    geom: MeshGeometrySnapshot,
    axis: 'x' | 'z',
    direction: 'posToNeg' | 'negToPos',
): MeshGeometrySnapshot {
    if (geom.tris.length === 0) return cloneMeshGeometry(geom);

    const { min, max } = getBoundsOfVertices(geom.vertices);
    const mid = axis === 'x' ? (min.x + max.x) * 0.5 : (min.z + max.z) * 0.5;
    const keepPositive = direction === 'posToNeg';
    const eps = 1e-5;

    const halfTris: Tri[] = [];
    for (let t = 0; t < geom.tris.length; ++t) {
        const tri = geom.tris[t];
        const v0 = geom.vertices[tri.positionIndices.x];
        const v1 = geom.vertices[tri.positionIndices.y];
        const v2 = geom.vertices[tri.positionIndices.z];
        if (!v0 || !v1 || !v2) continue;

        const cVal = axis === 'x' ?
            (v0.x + v1.x + v2.x) / 3 :
            (v0.z + v1.z + v2.z) / 3;
        const keep = keepPositive ? cVal >= mid - eps : cVal <= mid + eps;
        if (keep) {
            halfTris.push(tri);
        }
    }

    const sourceTris = halfTris.length > 0 ? halfTris : geom.tris;
    const outVertices = geom.vertices.map((v) => v.copy());
    const outNormals = geom.normals.map((n) => n.copy());
    const outUVs = geom.uvs.map((u) => new UV(u.u, u.v));
    const outColours = geom.vertexColours ? geom.vertexColours.map((c) => RGBAUtil.copy(c)) : undefined;

    // Clamp near-seam vertices slightly on kept side onto symmetry plane
    for (let i = 0; i < outVertices.length; ++i) {
        const v = outVertices[i];
        const coord = axis === 'x' ? v.x : v.z;
        if (Math.abs(coord - mid) < 1e-4) {
            if (axis === 'x') v.x = mid;
            else v.z = mid;
        }
    }

    const mirrorVertRemap = new Map<number, number>();
    const getMirroredVert = (idx: number): number => {
        const existing = mirrorVertRemap.get(idx);
        if (existing !== undefined) return existing;
        const src = outVertices[idx];
        const mirrored = new Vector3(
            axis === 'x' ? 2 * mid - src.x : src.x,
            src.y,
            axis === 'z' ? 2 * mid - src.z : src.z,
        );
        const newIdx = outVertices.length;
        outVertices.push(mirrored);
        mirrorVertRemap.set(idx, newIdx);
        return newIdx;
    };

    const mirrorNormRemap = new Map<number, number>();
    const getMirroredNorm = (idx: number): number => {
        const existing = mirrorNormRemap.get(idx);
        if (existing !== undefined) return existing;
        const src = outNormals[idx] ?? new Vector3(0, 1, 0);
        const mirrored = new Vector3(
            axis === 'x' ? -src.x : src.x,
            src.y,
            axis === 'z' ? -src.z : src.z,
        );
        const newIdx = outNormals.length;
        outNormals.push(mirrored);
        mirrorNormRemap.set(idx, newIdx);
        return newIdx;
    };

    const outTris: Tri[] = [];
    for (let t = 0; t < sourceTris.length; ++t) {
        const tri = sourceTris[t];
        outTris.push({
            positionIndices: { ...tri.positionIndices },
            normalIndices: tri.normalIndices ? { ...tri.normalIndices } : undefined,
            texcoordIndices: tri.texcoordIndices ? { ...tri.texcoordIndices } : undefined,
            vertexColourIndices: tri.vertexColourIndices ? { ...tri.vertexColourIndices } : undefined,
            material: tri.material,
        });

        // Reverse winding (y <-> z) for mirrored triangle so normals stay outward
        const mx = getMirroredVert(tri.positionIndices.x);
        const my = getMirroredVert(tri.positionIndices.z);
        const mz = getMirroredVert(tri.positionIndices.y);
        if (mx === my || my === mz || mz === mx) continue;

        const mTri: Tri = {
            positionIndices: { x: mx, y: my, z: mz },
            material: tri.material,
        };
        if (tri.normalIndices) {
            mTri.normalIndices = {
                x: getMirroredNorm(tri.normalIndices.x),
                y: getMirroredNorm(tri.normalIndices.z),
                z: getMirroredNorm(tri.normalIndices.y),
            };
        }
        if (tri.texcoordIndices) {
            mTri.texcoordIndices = {
                x: tri.texcoordIndices.x,
                y: tri.texcoordIndices.z,
                z: tri.texcoordIndices.y,
            };
        }
        if (tri.vertexColourIndices) {
            mTri.vertexColourIndices = {
                x: tri.vertexColourIndices.x,
                y: tri.vertexColourIndices.z,
                z: tri.vertexColourIndices.y,
            };
        }
        outTris.push(mTri);
    }

    const welded = weldMeshVertices(
        compactGeometry(outVertices, outNormals, outUVs, outTris, outColours),
        1e-5,
    );
    recomputeSmoothNormals(welded);
    return welded;
}
