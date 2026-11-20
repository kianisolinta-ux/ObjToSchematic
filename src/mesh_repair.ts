import { RGBA } from './colour';

export interface Vec3Like {
    x: number;
    y: number;
    z: number;
}

export interface UVLike {
    u: number;
    v: number;
}

export interface VertexIndicesLike {
    x: number;
    y: number;
    z: number;
}

export interface TriLike {
    positionIndices: VertexIndicesLike;
    texcoordIndices?: VertexIndicesLike;
    normalIndices?: VertexIndicesLike;
    vertexColourIndices?: VertexIndicesLike;
    material: string;
}

export interface RawMeshData {
    vertices: Vec3Like[];
    normals: Vec3Like[];
    uvs: UVLike[];
    tris: TriLike[];
    vertexColours?: RGBA[];
}

export interface MeshRepairOptions {
    /** Shift X/Z center to 0 and place minimum Y at 0. Default true. */
    groundAndCenter?: boolean;
    /** Recompute smooth area-weighted vertex normals for missing/broken normals (or all if forceRecomputeNormals). Default true. */
    fixNormals?: boolean;
    /** Force recomputing smooth vertex normals for every triangle even if existing normals are valid. Default false. */
    forceRecomputeNormals?: boolean;
    /** Minimum cross-product magnitude squared to consider a triangle non-degenerate. Default 1e-14. */
    minAreaEpsilon?: number;
    /** Remove small disconnected triangle islands (common scan noise in Tripo3D meshes). Default false. */
    removeSmallIslands?: boolean;
    /** Minimum triangles required to keep a secondary connected component when removeSmallIslands is true. Default 16. */
    minIslandTriangles?: number;
}

export interface MeshRepairStats {
    originalTriangles: number;
    keptTriangles: number;
    removedDegenerateTriangles: number;
    removedInvalidIndexTriangles: number;
    removedIslandTriangles: number;
    removedIslandComponents: number;
    keptVertices: number;
    fixedNormals: number;
    fixedUVs: number;
}

export interface RepairedMeshData {
    vertices: Vec3Like[];
    normals: Vec3Like[];
    uvs: UVLike[];
    tris: TriLike[];
    vertexColours?: RGBA[];
    stats: MeshRepairStats;
}

function isFiniteVec3(v: Vec3Like | undefined): v is Vec3Like {
    return v !== undefined &&
        Number.isFinite(v.x) &&
        Number.isFinite(v.y) &&
        Number.isFinite(v.z);
}

function clamp01(val: number): number {
    if (!Number.isFinite(val)) {
        return 1.0;
    }
    return Math.max(0.0, Math.min(1.0, val));
}

function cleanRGBA(c: RGBA | undefined): RGBA {
    if (!c) {
        return { r: 1, g: 1, b: 1, a: 1 };
    }
    return {
        r: clamp01(c.r),
        g: clamp01(c.g),
        b: clamp01(c.b),
        a: clamp01(c.a),
    };
}

/**
 * Repairs triangle mesh geometry:
 * - Drops out-of-bounds, duplicate-vertex, NaN-vertex, and degenerate zero-area triangles
 * - Cleans non-finite UVs and clamps vertex colours
 * - Fixes missing/NaN normals using area-weighted smooth face normals
 * - Compacts unused vertices/normals/UVs/colours
 * - Optionally centers XZ at 0 and grounds minY = 0
 */
export function repairMeshData(
    input: RawMeshData,
    options: MeshRepairOptions = {},
): RepairedMeshData {
    const groundAndCenter = options.groundAndCenter ?? true;
    const fixNormals = options.fixNormals ?? true;
    const forceRecomputeNormals = options.forceRecomputeNormals ?? false;
    const minCrossSq = options.minAreaEpsilon ?? 1e-14;
    const removeSmallIslands = options.removeSmallIslands ?? false;
    const minIslandTriangles = Math.max(2, Math.floor(options.minIslandTriangles ?? 16));

    const srcVerts = input.vertices || [];
    const srcNormals = input.normals || [];
    const srcUVs = input.uvs || [];
    const srcTris = input.tris || [];
    const srcColours = input.vertexColours;

    let removedInvalidIndexTriangles = 0;
    let removedDegenerateTriangles = 0;
    let removedIslandTriangles = 0;
    let removedIslandComponents = 0;
    let fixedUVs = 0;
    let fixedNormals = 0;

    // 1. Filter valid triangles and collect used vertex indices
    let validTris: TriLike[] = [];
    let faceNormals: Vec3Like[] = [];

    for (let i = 0; i < srcTris.length; ++i) {
        const tri = srcTris[i];
        if (!tri || !tri.positionIndices) {
            removedInvalidIndexTriangles++;
            continue;
        }
        const i0 = tri.positionIndices.x;
        const i1 = tri.positionIndices.y;
        const i2 = tri.positionIndices.z;

        if (
            i0 < 0 || i0 >= srcVerts.length ||
            i1 < 0 || i1 >= srcVerts.length ||
            i2 < 0 || i2 >= srcVerts.length
        ) {
            removedInvalidIndexTriangles++;
            continue;
        }

        if (i0 === i1 || i1 === i2 || i2 === i0) {
            removedDegenerateTriangles++;
            continue;
        }

        const v0 = srcVerts[i0];
        const v1 = srcVerts[i1];
        const v2 = srcVerts[i2];
        if (!isFiniteVec3(v0) || !isFiniteVec3(v1) || !isFiniteVec3(v2)) {
            removedDegenerateTriangles++;
            continue;
        }

        const e1x = v1.x - v0.x;
        const e1y = v1.y - v0.y;
        const e1z = v1.z - v0.z;
        const e2x = v2.x - v0.x;
        const e2y = v2.y - v0.y;
        const e2z = v2.z - v0.z;

        const cx = e1y * e2z - e1z * e2y;
        const cy = e1z * e2x - e1x * e2z;
        const cz = e1x * e2y - e1y * e2x;
        const crossSq = cx * cx + cy * cy + cz * cz;

        if (!Number.isFinite(crossSq) || crossSq <= minCrossSq) {
            removedDegenerateTriangles++;
            continue;
        }

        validTris.push(tri);
        // Area-weighted normal (magnitude = 2 * triangle area)
        faceNormals.push({ x: cx, y: cy, z: cz });
    }

    // 1b. Optionally strip small disconnected triangle islands (Union-Find over quantized spatial vertices)
    if (removeSmallIslands && validTris.length > 1) {
        const triCount = validTris.length;
        const parent = new Int32Array(triCount);
        const rank = new Uint8Array(triCount);
        for (let i = 0; i < triCount; ++i) {
            parent[i] = i;
        }
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
            if (rank[ra] < rank[rb]) {
                parent[ra] = rb;
            } else if (rank[ra] > rank[rb]) {
                parent[rb] = ra;
            } else {
                parent[rb] = ra;
                rank[ra]++;
            }
        };

        const vertOwnerTri = new Map<string, number>();
        const posKey = (v: Vec3Like): string => `${Math.round(v.x * 1e5)},${Math.round(v.y * 1e5)},${Math.round(v.z * 1e5)}`;

        for (let t = 0; t < triCount; ++t) {
            const tri = validTris[t];
            const idxs = [tri.positionIndices.x, tri.positionIndices.y, tri.positionIndices.z];
            for (let k = 0; k < 3; ++k) {
                const key = posKey(srcVerts[idxs[k]]);
                const owner = vertOwnerTri.get(key);
                if (owner === undefined) {
                    vertOwnerTri.set(key, t);
                } else {
                    union(owner, t);
                }
            }
        }

        const compCounts = new Map<number, number>();
        let maxRoot = find(0);
        let maxCount = 0;
        for (let t = 0; t < triCount; ++t) {
            const r = find(t);
            const next = (compCounts.get(r) ?? 0) + 1;
            compCounts.set(r, next);
            if (next > maxCount) {
                maxCount = next;
                maxRoot = r;
            }
        }

        const keepRoots = new Set<number>([maxRoot]);
        compCounts.forEach((count, root) => {
            if (count >= minIslandTriangles) {
                keepRoots.add(root);
            } else if (root !== maxRoot) {
                removedIslandComponents++;
            }
        });

        if (keepRoots.size < compCounts.size) {
            const keptTris: TriLike[] = [];
            const keptNormals: Vec3Like[] = [];
            for (let t = 0; t < triCount; ++t) {
                if (keepRoots.has(find(t))) {
                    keptTris.push(validTris[t]);
                    keptNormals.push(faceNormals[t]);
                } else {
                    removedIslandTriangles++;
                }
            }
            validTris = keptTris;
            faceNormals = keptNormals;
        }
    }

    // 2. Compact vertices & compute smooth area-weighted normals per compacted vertex
    const oldToNewVertex = new Map<number, number>();
    const outVertices: Vec3Like[] = [];
    const smoothNormalAccum: Vec3Like[] = [];

    const getOrAddVertex = (oldIdx: number): number => {
        const existing = oldToNewVertex.get(oldIdx);
        if (existing !== undefined) {
            return existing;
        }
        const v = srcVerts[oldIdx];
        const newIdx = outVertices.length;
        outVertices.push({ x: v.x, y: v.y, z: v.z });
        smoothNormalAccum.push({ x: 0, y: 0, z: 0 });
        oldToNewVertex.set(oldIdx, newIdx);
        return newIdx;
    };

    for (let t = 0; t < validTris.length; ++t) {
        const tri = validTris[t];
        const nv0 = getOrAddVertex(tri.positionIndices.x);
        const nv1 = getOrAddVertex(tri.positionIndices.y);
        const nv2 = getOrAddVertex(tri.positionIndices.z);
        const fn = faceNormals[t];

        smoothNormalAccum[nv0].x += fn.x;
        smoothNormalAccum[nv0].y += fn.y;
        smoothNormalAccum[nv0].z += fn.z;
        smoothNormalAccum[nv1].x += fn.x;
        smoothNormalAccum[nv1].y += fn.y;
        smoothNormalAccum[nv1].z += fn.z;
        smoothNormalAccum[nv2].x += fn.x;
        smoothNormalAccum[nv2].y += fn.y;
        smoothNormalAccum[nv2].z += fn.z;
    }

    const smoothNormals: Vec3Like[] = smoothNormalAccum.map((n) => {
        const len = Math.hypot(n.x, n.y, n.z);
        if (!Number.isFinite(len) || len <= 1e-8) {
            return { x: 0, y: 1, z: 0 };
        }
        return { x: n.x / len, y: n.y / len, z: n.z / len };
    });

    // 3. Optionally ground Y=0 and center X/Z at 0
    if (groundAndCenter && outVertices.length > 0) {
        let minX = Infinity;
        let maxX = -Infinity;
        let minY = Infinity;
        let minZ = Infinity;
        let maxZ = -Infinity;

        for (const v of outVertices) {
            if (v.x < minX) minX = v.x;
            if (v.x > maxX) maxX = v.x;
            if (v.y < minY) minY = v.y;
            if (v.z < minZ) minZ = v.z;
            if (v.z > maxZ) maxZ = v.z;
        }

        const shiftX = -(minX + maxX) * 0.5;
        const shiftY = -minY;
        const shiftZ = -(minZ + maxZ) * 0.5;

        for (const v of outVertices) {
            v.x += shiftX;
            v.y += shiftY;
            v.z += shiftZ;
        }
    }

    // 4. Rebuild compacted UVs, normals, vertex colours, and triangles
    const outUVs: UVLike[] = [];
    const uvKeyToIndex = new Map<string, number>();
    const addUV = (uv: UVLike): number => {
        let u = uv.u;
        let v = uv.v;
        if (!Number.isFinite(u) || !Number.isFinite(v)) {
            u = 0;
            v = 0;
            fixedUVs++;
        }
        const key = `${u},${v}`;
        const existing = uvKeyToIndex.get(key);
        if (existing !== undefined) {
            return existing;
        }
        const idx = outUVs.length;
        outUVs.push({ u, v });
        uvKeyToIndex.set(key, idx);
        return idx;
    };

    const outNormals: Vec3Like[] = [];
    const addNormal = (oldNormalIdx: number | undefined, newVertIdx: number): number => {
        if (!forceRecomputeNormals && oldNormalIdx !== undefined && oldNormalIdx >= 0 && oldNormalIdx < srcNormals.length) {
            const n = srcNormals[oldNormalIdx];
            if (isFiniteVec3(n)) {
                const len = Math.hypot(n.x, n.y, n.z);
                if (len > 1e-6) {
                    const idx = outNormals.length;
                    outNormals.push({ x: n.x / len, y: n.y / len, z: n.z / len });
                    return idx;
                }
            }
        }
        fixedNormals++;
        const fallback = fixNormals ? smoothNormals[newVertIdx] : { x: 0, y: 1, z: 0 };
        const idx = outNormals.length;
        outNormals.push({ x: fallback.x, y: fallback.y, z: fallback.z });
        return idx;
    };

    const anyHasVertexColours = Boolean(
        srcColours &&
        srcColours.length > 0 &&
        validTris.some((t) => t.vertexColourIndices !== undefined),
    );
    const outVertexColours: RGBA[] | undefined = anyHasVertexColours ? [] : undefined;

    const addColour = (oldColourIdx: number | undefined): number => {
        const c = (oldColourIdx !== undefined && srcColours && oldColourIdx >= 0 && oldColourIdx < srcColours.length) ?
            cleanRGBA(srcColours[oldColourIdx]) :
            { r: 1, g: 1, b: 1, a: 1 };
        const idx = outVertexColours!.length;
        outVertexColours!.push(c);
        return idx;
    };

    const outTris: TriLike[] = [];
    for (let t = 0; t < validTris.length; ++t) {
        const tri = validTris[t];
        const nv0 = oldToNewVertex.get(tri.positionIndices.x)!;
        const nv1 = oldToNewVertex.get(tri.positionIndices.y)!;
        const nv2 = oldToNewVertex.get(tri.positionIndices.z)!;

        const outTri: TriLike = {
            material: tri.material,
            positionIndices: { x: nv0, y: nv1, z: nv2 },
            normalIndices: {
                x: addNormal(tri.normalIndices?.x, nv0),
                y: addNormal(tri.normalIndices?.y, nv1),
                z: addNormal(tri.normalIndices?.z, nv2),
            },
        };

        if (tri.texcoordIndices) {
            const uv0 = srcUVs[tri.texcoordIndices.x] ?? { u: 0, v: 0 };
            const uv1 = srcUVs[tri.texcoordIndices.y] ?? { u: 0, v: 0 };
            const uv2 = srcUVs[tri.texcoordIndices.z] ?? { u: 0, v: 0 };
            outTri.texcoordIndices = {
                x: addUV(uv0),
                y: addUV(uv1),
                z: addUV(uv2),
            };
        }

        if (anyHasVertexColours) {
            outTri.vertexColourIndices = {
                x: addColour(tri.vertexColourIndices?.x),
                y: addColour(tri.vertexColourIndices?.y),
                z: addColour(tri.vertexColourIndices?.z),
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
        stats: {
            originalTriangles: srcTris.length,
            keptTriangles: outTris.length,
            removedDegenerateTriangles,
            removedInvalidIndexTriangles,
            removedIslandTriangles,
            removedIslandComponents,
            keptVertices: outVertices.length,
            fixedNormals,
            fixedUVs,
        },
    };
}
