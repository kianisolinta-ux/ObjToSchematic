import { RGBA, RGBAUtil } from './colour';
import { Tri } from './mesh';
import { applyMeshEditOp, cloneMeshGeometry, MeshEditParams, MeshGeometrySnapshot } from './mesh_editor';
import { UV } from './util';
import { Vector3 } from './vector';

export type ModelLayerKind = 'original' | 'working' | 'snapshot' | 'part';

export interface ModelLayer {
    id: string;
    name: string;
    kind: ModelLayerKind;
    visible: boolean;
    locked: boolean;
    solo: boolean;
    geometry: MeshGeometrySnapshot;
    triangleCount: number;
    vertexCount: number;
    createdAt: number;
}

export interface ModelLayerStackState {
    layers: ModelLayer[];
    activeLayerId: string;
    originalLayerId: string;
    nextSeq: number;
}

function makeLayerId(prefix: string, seq: number): string {
    return `${prefix}-${seq}-${Math.random().toString(36).slice(2, 6)}`;
}

function compactTriSubset(geom: MeshGeometrySnapshot, tris: Tri[]): MeshGeometrySnapshot {
    const vertRemap = new Map<number, number>();
    const normRemap = new Map<number, number>();
    const uvRemap = new Map<number, number>();
    const colRemap = new Map<number, number>();

    const outVertices: Vector3[] = [];
    const outNormals: Vector3[] = [];
    const outUVs: UV[] = [];
    const outColours: RGBA[] | undefined = geom.vertexColours ? [] : undefined;
    const outTris: Tri[] = [];

    const mapVert = (idx: number): number => {
        const ex = vertRemap.get(idx);
        if (ex !== undefined) return ex;
        const next = outVertices.length;
        const v = geom.vertices[idx] ?? new Vector3(0, 0, 0);
        outVertices.push(v.copy());
        vertRemap.set(idx, next);
        return next;
    };

    const mapNorm = (idx: number): number => {
        const ex = normRemap.get(idx);
        if (ex !== undefined) return ex;
        const next = outNormals.length;
        const n = geom.normals[idx] ?? new Vector3(0, 1, 0);
        outNormals.push(n.copy());
        normRemap.set(idx, next);
        return next;
    };

    const mapUV = (idx: number): number => {
        const ex = uvRemap.get(idx);
        if (ex !== undefined) return ex;
        const next = outUVs.length;
        const uv = geom.uvs[idx] ?? new UV(0, 0);
        outUVs.push(new UV(uv.u, uv.v));
        uvRemap.set(idx, next);
        return next;
    };

    const mapCol = (idx: number): number => {
        const ex = colRemap.get(idx);
        if (ex !== undefined) return ex;
        const next = outColours!.length;
        const c = geom.vertexColours![idx] ?? { r: 1, g: 1, b: 1, a: 1 };
        outColours!.push(RGBAUtil.copy(c));
        colRemap.set(idx, next);
        return next;
    };

    for (let t = 0; t < tris.length; ++t) {
        const tri = tris[t];
        const nv0 = mapVert(tri.positionIndices.x);
        const nv1 = mapVert(tri.positionIndices.y);
        const nv2 = mapVert(tri.positionIndices.z);
        if (nv0 === nv1 || nv1 === nv2 || nv2 === nv0) continue;

        const nextTri: Tri = {
            positionIndices: { x: nv0, y: nv1, z: nv2 },
            material: tri.material,
        };
        if (tri.normalIndices) {
            nextTri.normalIndices = {
                x: mapNorm(tri.normalIndices.x),
                y: mapNorm(tri.normalIndices.y),
                z: mapNorm(tri.normalIndices.z),
            };
        }
        if (tri.texcoordIndices) {
            nextTri.texcoordIndices = {
                x: mapUV(tri.texcoordIndices.x),
                y: mapUV(tri.texcoordIndices.y),
                z: mapUV(tri.texcoordIndices.z),
            };
        }
        if (tri.vertexColourIndices && outColours) {
            nextTri.vertexColourIndices = {
                x: mapCol(tri.vertexColourIndices.x),
                y: mapCol(tri.vertexColourIndices.y),
                z: mapCol(tri.vertexColourIndices.z),
            };
        }
        outTris.push(nextTri);
    }

    return {
        vertices: outVertices,
        normals: outNormals,
        uvs: outUVs,
        tris: outTris,
        vertexColours: outColours,
    };
}

export function createInitialModelLayersState(
    geom: MeshGeometrySnapshot,
    options?: { originalName?: string; workingName?: string },
): ModelLayerStackState {
    const now = Date.now();
    const origClone = cloneMeshGeometry(geom);
    const workClone = cloneMeshGeometry(geom);
    const originalId = makeLayerId('orig', 1);
    const workingId = makeLayerId('work', 2);

    const origLayer: ModelLayer = {
        id: originalId,
        name: options?.originalName ?? 'Original (Ref)',
        kind: 'original',
        visible: false,
        locked: true,
        solo: false,
        geometry: origClone,
        triangleCount: origClone.tris.length,
        vertexCount: origClone.vertices.length,
        createdAt: now,
    };

    const workLayer: ModelLayer = {
        id: workingId,
        name: options?.workingName ?? 'Base Mesh',
        kind: 'working',
        visible: true,
        locked: false,
        solo: false,
        geometry: workClone,
        triangleCount: workClone.tris.length,
        vertexCount: workClone.vertices.length,
        createdAt: now + 1,
    };

    return {
        layers: [workLayer, origLayer],
        activeLayerId: workingId,
        originalLayerId: originalId,
        nextSeq: 3,
    };
}

export function getActiveModelLayer(state: ModelLayerStackState): ModelLayer | undefined {
    return state.layers.find((l) => l.id === state.activeLayerId);
}

export function getOriginalModelLayer(state: ModelLayerStackState): ModelLayer | undefined {
    return state.layers.find((l) => l.id === state.originalLayerId);
}

export function mergeVisibleModelLayers(layers: ModelLayer[]): MeshGeometrySnapshot | null {
    const nonOriginal = layers.filter((l) => l.kind !== 'original');
    const soloed = nonOriginal.filter((l) => l.solo);
    let chosen: ModelLayer[] = [];

    if (soloed.length > 0) {
        chosen = soloed;
    } else {
        chosen = nonOriginal.filter((l) => l.visible);
    }

    if (chosen.length === 0) {
        const visibleOrig = layers.find((l) => l.kind === 'original' && (l.visible || l.solo));
        if (!visibleOrig) {
            return null;
        }
        return cloneMeshGeometry(visibleOrig.geometry);
    }

    if (chosen.length === 1) {
        return cloneMeshGeometry(chosen[0].geometry);
    }

    const outVertices: Vector3[] = [];
    const outNormals: Vector3[] = [];
    const outUVs: UV[] = [];
    const outTris: Tri[] = [];
    const anyHasVertexColours = chosen.some((l) => Boolean(l.geometry.vertexColours && l.geometry.vertexColours.length > 0));
    const outColours: RGBA[] | undefined = anyHasVertexColours ? [] : undefined;

    for (let li = 0; li < chosen.length; ++li) {
        const g = chosen[li].geometry;
        const vOff = outVertices.length;
        const nOff = outNormals.length;
        const uOff = outUVs.length;
        const cOff = outColours ? outColours.length : 0;

        for (let i = 0; i < g.vertices.length; ++i) outVertices.push(g.vertices[i].copy());
        for (let i = 0; i < g.normals.length; ++i) outNormals.push(g.normals[i].copy());
        for (let i = 0; i < g.uvs.length; ++i) outUVs.push(new UV(g.uvs[i].u, g.uvs[i].v));

        if (outColours) {
            if (g.vertexColours && g.vertexColours.length > 0) {
                for (let i = 0; i < g.vertexColours.length; ++i) {
                    outColours.push(RGBAUtil.copy(g.vertexColours[i]));
                }
            } else {
                outColours.push({ r: 1, g: 1, b: 1, a: 1 });
            }
        }

        for (let t = 0; t < g.tris.length; ++t) {
            const tri = g.tris[t];
            const nextTri: Tri = {
                positionIndices: {
                    x: tri.positionIndices.x + vOff,
                    y: tri.positionIndices.y + vOff,
                    z: tri.positionIndices.z + vOff,
                },
                material: tri.material,
            };
            if (tri.normalIndices) {
                nextTri.normalIndices = {
                    x: tri.normalIndices.x + nOff,
                    y: tri.normalIndices.y + nOff,
                    z: tri.normalIndices.z + nOff,
                };
            }
            if (tri.texcoordIndices) {
                nextTri.texcoordIndices = {
                    x: tri.texcoordIndices.x + uOff,
                    y: tri.texcoordIndices.y + uOff,
                    z: tri.texcoordIndices.z + uOff,
                };
            }
            if (outColours) {
                if (tri.vertexColourIndices && g.vertexColours && g.vertexColours.length > 0) {
                    nextTri.vertexColourIndices = {
                        x: tri.vertexColourIndices.x + cOff,
                        y: tri.vertexColourIndices.y + cOff,
                        z: tri.vertexColourIndices.z + cOff,
                    };
                } else {
                    nextTri.vertexColourIndices = { x: cOff, y: cOff, z: cOff };
                }
            }
            outTris.push(nextTri);
        }
    }

    return {
        vertices: outVertices,
        normals: outNormals,
        uvs: outUVs,
        tris: outTris,
        vertexColours: outColours,
    };
}

export function addSnapshotLayer(
    state: ModelLayerStackState,
    geom: MeshGeometrySnapshot,
    name?: string,
    makeActive = false,
): { state: ModelLayerStackState; layer: ModelLayer } {
    const seq = state.nextSeq;
    const snapGeom = cloneMeshGeometry(geom);
    const layer: ModelLayer = {
        id: makeLayerId('snap', seq),
        name: name?.trim() || `Snapshot ${seq - 1}`,
        kind: 'snapshot',
        visible: false,
        locked: true,
        solo: false,
        geometry: snapGeom,
        triangleCount: snapGeom.tris.length,
        vertexCount: snapGeom.vertices.length,
        createdAt: Date.now(),
    };

    const origIdx = state.layers.findIndex((l) => l.id === state.originalLayerId);
    const layers = [...state.layers];
    if (origIdx >= 0) {
        layers.splice(origIdx, 0, layer);
    } else {
        layers.push(layer);
    }

    return {
        layer,
        state: {
            ...state,
            layers,
            activeLayerId: makeActive ? layer.id : state.activeLayerId,
            nextSeq: seq + 1,
        },
    };
}

export function duplicateModelLayer(
    state: ModelLayerStackState,
    layerId: string,
    makeVisible = true,
): { state: ModelLayerStackState; layer: ModelLayer | null } {
    const source = state.layers.find((l) => l.id === layerId);
    if (!source) return { state, layer: null };

    const seq = state.nextSeq;
    const clonedGeom = cloneMeshGeometry(source.geometry);
    const copyLayer: ModelLayer = {
        id: makeLayerId('layer', seq),
        name: `${source.name} Copy`,
        kind: source.kind === 'part' ? 'part' : 'working',
        visible: makeVisible,
        locked: false,
        solo: false,
        geometry: clonedGeom,
        triangleCount: clonedGeom.tris.length,
        vertexCount: clonedGeom.vertices.length,
        createdAt: Date.now(),
    };

    const layers = [copyLayer, ...state.layers];
    return {
        layer: copyLayer,
        state: {
            ...state,
            layers,
            activeLayerId: copyLayer.id,
            nextSeq: seq + 1,
        },
    };
}

export function restoreLayerToWorking(
    state: ModelLayerStackState,
    sourceLayerId: string,
): { state: ModelLayerStackState; restoredId: string | null } {
    const source = state.layers.find((l) => l.id === sourceLayerId);
    if (!source) return { state, restoredId: null };

    const active = state.layers.find((l) => l.id === state.activeLayerId && l.kind !== 'original' && !l.locked);
    const target = active ?? state.layers.find((l) => l.kind === 'working' && !l.locked);

    if (target) {
        const clonedGeom = cloneMeshGeometry(source.geometry);
        const layers = state.layers.map((l) => {
            if (l.id !== target.id) {
                return l.kind === 'original' ? { ...l, visible: false, solo: false } : l;
            }
            return {
                ...l,
                visible: true,
                geometry: clonedGeom,
                triangleCount: clonedGeom.tris.length,
                vertexCount: clonedGeom.vertices.length,
            };
        });
        return {
            restoredId: target.id,
            state: {
                ...state,
                layers,
                activeLayerId: target.id,
            },
        };
    }

    const dup = duplicateModelLayer(state, sourceLayerId, true);
    return {
        state: dup.state,
        restoredId: dup.layer?.id ?? null,
    };
}

export function splitGeometryIntoConnectedParts(
    geom: MeshGeometrySnapshot,
    maxParts = 16,
): Array<{ name: string; geometry: MeshGeometrySnapshot }> {
    const triCount = geom.tris.length;
    if (triCount === 0) return [];

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
    for (let t = 0; t < triCount; ++t) {
        const tri = geom.tris[t];
        const idxList = [tri.positionIndices.x, tri.positionIndices.y, tri.positionIndices.z];
        for (let k = 0; k < 3; ++k) {
            const v = geom.vertices[idxList[k]];
            if (!v) continue;
            const key = `${Math.round(v.x * 1e4)},${Math.round(v.y * 1e4)},${Math.round(v.z * 1e4)}`;
            const owner = vertOwnerTri.get(key);
            if (owner === undefined) {
                vertOwnerTri.set(key, t);
            } else {
                union(owner, t);
            }
        }
    }

    const groups = new Map<number, Tri[]>();
    for (let t = 0; t < triCount; ++t) {
        const r = find(t);
        let list = groups.get(r);
        if (!list) {
            list = [];
            groups.set(r, list);
        }
        list.push(geom.tris[t]);
    }

    const sortedGroups = Array.from(groups.values()).sort((a, b) => b.length - a.length);
    const safeMax = Math.max(2, maxParts);
    const finalBuckets: Array<{ name: string; tris: Tri[] }> = [];

    for (let i = 0; i < sortedGroups.length; ++i) {
        if (i < safeMax - 1 || sortedGroups.length <= safeMax) {
            finalBuckets.push({ name: `Part ${i + 1}`, tris: sortedGroups[i] });
        } else {
            if (finalBuckets.length < safeMax) {
                finalBuckets.push({ name: `Small Details`, tris: [...sortedGroups[i]] });
            } else {
                finalBuckets[safeMax - 1].tris.push(...sortedGroups[i]);
            }
        }
    }

    return finalBuckets.map((b) => ({
        name: b.name,
        geometry: compactTriSubset(geom, b.tris),
    }));
}

export function splitGeometryByMaterial(
    geom: MeshGeometrySnapshot,
): Array<{ name: string; geometry: MeshGeometrySnapshot }> {
    const groups = new Map<string, Tri[]>();
    for (let t = 0; t < geom.tris.length; ++t) {
        const tri = geom.tris[t];
        const mat = tri.material || 'default';
        let list = groups.get(mat);
        if (!list) {
            list = [];
            groups.set(mat, list);
        }
        list.push(tri);
    }

    return Array.from(groups.entries()).map(([matName, tris]) => ({
        name: `Mat: ${matName}`,
        geometry: compactTriSubset(geom, tris),
    }));
}

export function replaceWorkingLayersWithSplitParts(
    state: ModelLayerStackState,
    parts: Array<{ name: string; geometry: MeshGeometrySnapshot }>,
): ModelLayerStackState {
    if (parts.length <= 1) return state;

    const preservedSnapshots = state.layers.filter((l) => l.kind === 'original' || l.kind === 'snapshot');
    let seq = state.nextSeq;
    const now = Date.now();

    const partLayers: ModelLayer[] = parts.map((p, idx) => ({
        id: makeLayerId('part', seq++),
        name: p.name,
        kind: 'part',
        visible: true,
        locked: false,
        solo: false,
        geometry: p.geometry,
        triangleCount: p.geometry.tris.length,
        vertexCount: p.geometry.vertices.length,
        createdAt: now + idx,
    }));

    return {
        ...state,
        layers: [...partLayers, ...preservedSnapshots],
        activeLayerId: partLayers[0].id,
        nextSeq: seq,
    };
}

export function mergeVisiblePartsIntoSingleLayer(
    state: ModelLayerStackState,
    mergedName = 'Merged Mesh',
): ModelLayerStackState {
    const mergedGeom = mergeVisibleModelLayers(state.layers);
    if (!mergedGeom) return state;

    const preservedSnapshots = state.layers.filter((l) => l.kind === 'original' || l.kind === 'snapshot');
    const seq = state.nextSeq;
    const mergedLayer: ModelLayer = {
        id: makeLayerId('work', seq),
        name: mergedName,
        kind: 'working',
        visible: true,
        locked: false,
        solo: false,
        geometry: mergedGeom,
        triangleCount: mergedGeom.tris.length,
        vertexCount: mergedGeom.vertices.length,
        createdAt: Date.now(),
    };

    return {
        ...state,
        layers: [mergedLayer, ...preservedSnapshots],
        activeLayerId: mergedLayer.id,
        nextSeq: seq + 1,
    };
}

export function applyEditToActiveModelLayer(
    state: ModelLayerStackState,
    params: MeshEditParams,
): { state: ModelLayerStackState; edited: boolean } {
    const active = state.layers.find((l) => l.id === state.activeLayerId);
    if (!active || active.locked || active.kind === 'original') {
        return { state, edited: false };
    }

    const nextGeom = applyMeshEditOp(active.geometry, params);
    const layers = state.layers.map((l) => {
        if (l.id !== active.id) return l;
        return {
            ...l,
            geometry: nextGeom,
            triangleCount: nextGeom.tris.length,
            vertexCount: nextGeom.vertices.length,
        };
    });

    return {
        edited: true,
        state: {
            ...state,
            layers,
        },
    };
}

export function toggleModelLayerVisibility(state: ModelLayerStackState, layerId: string): ModelLayerStackState {
    return {
        ...state,
        layers: state.layers.map((l) => (l.id === layerId ? { ...l, visible: !l.visible } : l)),
    };
}

export function toggleModelLayerSolo(state: ModelLayerStackState, layerId: string): ModelLayerStackState {
    const target = state.layers.find((l) => l.id === layerId);
    if (!target || target.kind === 'original') return state;
    const nextSolo = !target.solo;
    return {
        ...state,
        layers: state.layers.map((l) => {
            if (l.id === layerId) {
                return { ...l, solo: nextSolo, visible: nextSolo ? true : l.visible };
            }
            return { ...l, solo: false };
        }),
    };
}

export function toggleModelLayerLock(state: ModelLayerStackState, layerId: string): ModelLayerStackState {
    const target = state.layers.find((l) => l.id === layerId);
    if (!target || target.kind === 'original') return state;
    return {
        ...state,
        layers: state.layers.map((l) => (l.id === layerId ? { ...l, locked: !l.locked } : l)),
    };
}

export function renameModelLayer(state: ModelLayerStackState, layerId: string, name: string): ModelLayerStackState {
    const clean = name.trim();
    if (!clean) return state;
    return {
        ...state,
        layers: state.layers.map((l) => (l.id === layerId && l.kind !== 'original' ? { ...l, name: clean } : l)),
    };
}

export function deleteModelLayer(state: ModelLayerStackState, layerId: string): ModelLayerStackState {
    const target = state.layers.find((l) => l.id === layerId);
    if (!target || target.kind === 'original') return state;

    const editableLeft = state.layers.filter((l) => l.id !== layerId && l.kind !== 'original');
    if (editableLeft.length === 0) {
        return state;
    }

    const nextLayers = state.layers.filter((l) => l.id !== layerId);
    const nextActiveId = state.activeLayerId === layerId ? editableLeft[0].id : state.activeLayerId;
    return {
        ...state,
        layers: nextLayers,
        activeLayerId: nextActiveId,
    };
}
