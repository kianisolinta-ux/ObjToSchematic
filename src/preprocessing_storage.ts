import type { MaterialMap, MaterialType, SolidMaterial, TexturedMaterial, Tri } from './mesh';
import type { MeshDiagnostics, MeshGeometrySnapshot } from './mesh_editor';
import type { TextureFilterParams } from './texture_editor';
import { UV } from './util';
import { Vector3 } from './vector';

export interface SerializedVec3 {
    x: number;
    y: number;
    z: number;
}

export interface SerializedUV {
    u: number;
    v: number;
}

export interface SerializedMeshGeometry {
    vertices: SerializedVec3[];
    normals: SerializedVec3[];
    uvs: SerializedUV[];
    tris: Tri[];
    vertexColours?: Array<{ r: number; g: number; b: number; a: number }>;
}

export type SerializedMaterialEntry =
    | {
        name: string;
        type: MaterialType.solid;
        colour: { r: number; g: number; b: number; a: number };
        canBeTextured: boolean;
        needsAttention: boolean;
    }
    | {
        name: string;
        type: MaterialType.textured;
        diffuse?: { filetype: 'png' | 'jpg'; raw: string };
        interpolation: 'linear' | 'nearest';
        extension: 'clamp' | 'repeat';
        transparency: TexturedMaterial['transparency'];
        tint?: { r: number; g: number; b: number; a: number };
        alphaCutoff?: number;
        needsAttention: boolean;
    };

export interface PreprocessOperationLogEntry {
    timestamp: number;
    label: string;
}

export interface PreprocessRecipeParams {
    weldTolerance: number;
    decimateRatio: number;
    minIslandTriangles: number;
    forceSmoothNormals: boolean;
    cropMin: { x: number; y: number; z: number };
    cropMax: { x: number; y: number; z: number };
    filters?: TextureFilterParams;
}

export interface PreprocessRecipe {
    id: string;
    name: string;
    savedAt: number;
    params: PreprocessRecipeParams;
}

export interface PreprocessBundleV1 {
    format: 'objtoschematic-preprocess';
    version: 1;
    id: string;
    name: string;
    savedAt: number;
    sourceFilename: string;
    diagnostics: MeshDiagnostics;
    geometry: SerializedMeshGeometry;
    materials: SerializedMaterialEntry[];
    operations: PreprocessOperationLogEntry[];
    recipe?: PreprocessRecipeParams;
}

export interface PreprocessCheckpointSummary {
    id: string;
    name: string;
    savedAt: number;
    sourceFilename: string;
    triangleCount: number;
    vertexCount: number;
    materialCount: number;
    operationsCount: number;
}

export function serializeGeometrySnapshot(geom: MeshGeometrySnapshot): SerializedMeshGeometry {
    return {
        vertices: geom.vertices.map((v) => ({ x: v.x, y: v.y, z: v.z })),
        normals: geom.normals.map((n) => ({ x: n.x, y: n.y, z: n.z })),
        uvs: geom.uvs.map((uv) => ({ u: uv.u, v: uv.v })),
        tris: geom.tris.map((t) => ({
            positionIndices: { ...t.positionIndices },
            texcoordIndices: t.texcoordIndices ? { ...t.texcoordIndices } : undefined,
            normalIndices: t.normalIndices ? { ...t.normalIndices } : undefined,
            vertexColourIndices: t.vertexColourIndices ? { ...t.vertexColourIndices } : undefined,
            material: t.material,
        })),
        vertexColours: geom.vertexColours ? geom.vertexColours.map((c) => ({ ...c })) : undefined,
    };
}

export function deserializeGeometrySnapshot(data: SerializedMeshGeometry): MeshGeometrySnapshot {
    return {
        vertices: data.vertices.map((v) => new Vector3(v.x, v.y, v.z)),
        normals: data.normals.map((n) => new Vector3(n.x, n.y, n.z)),
        uvs: data.uvs.map((uv) => new UV(uv.u, uv.v)),
        tris: data.tris.map((t) => ({
            positionIndices: { ...t.positionIndices },
            texcoordIndices: t.texcoordIndices ? { ...t.texcoordIndices } : undefined,
            normalIndices: t.normalIndices ? { ...t.normalIndices } : undefined,
            vertexColourIndices: t.vertexColourIndices ? { ...t.vertexColourIndices } : undefined,
            material: t.material,
        })),
        vertexColours: data.vertexColours ? data.vertexColours.map((c) => ({ ...c })) : undefined,
    };
}

export function serializeMaterialMap(materials: MaterialMap): SerializedMaterialEntry[] {
    const entries: SerializedMaterialEntry[] = [];
    materials.forEach((mat, name) => {
        if (mat.type === 0) {
            entries.push({
                name,
                type: 0 as MaterialType.solid,
                colour: { ...mat.colour },
                canBeTextured: mat.canBeTextured,
                needsAttention: mat.needsAttention,
            });
        } else {
            entries.push({
                name,
                type: 1 as MaterialType.textured,
                diffuse: mat.diffuse ? { ...mat.diffuse } : undefined,
                interpolation: mat.interpolation,
                extension: mat.extension,
                transparency: mat.transparency ? { ...mat.transparency } : { type: 'None' },
                tint: mat.tint ? { ...mat.tint } : undefined,
                alphaCutoff: mat.alphaCutoff,
                needsAttention: mat.needsAttention,
            });
        }
    });
    return entries;
}

export function deserializeMaterialMap(entries: SerializedMaterialEntry[]): MaterialMap {
    const map: MaterialMap = new Map();
    for (const entry of entries) {
        if (entry.type === 0) {
            const solid: SolidMaterial = {
                type: 0 as MaterialType.solid,
                colour: { ...entry.colour },
                canBeTextured: entry.canBeTextured,
                needsAttention: entry.needsAttention,
            };
            map.set(entry.name, solid);
        } else {
            const textured: TexturedMaterial = {
                type: 1 as MaterialType.textured,
                diffuse: entry.diffuse ? { ...entry.diffuse } : undefined,
                interpolation: entry.interpolation,
                extension: entry.extension,
                transparency: entry.transparency ? { ...entry.transparency } : { type: 'None' },
                tint: entry.tint ? { ...entry.tint } : undefined,
                alphaCutoff: entry.alphaCutoff,
                needsAttention: entry.needsAttention,
            };
            map.set(entry.name, textured);
        }
    }
    return map;
}

export function buildPreprocessBundle(input: {
    id?: string;
    name: string;
    sourceFilename: string;
    diagnostics: MeshDiagnostics;
    geometry: MeshGeometrySnapshot;
    materials: MaterialMap;
    operations?: PreprocessOperationLogEntry[];
    recipe?: PreprocessRecipeParams;
}): PreprocessBundleV1 {
    const now = Date.now();
    return {
        format: 'objtoschematic-preprocess',
        version: 1,
        id: input.id || `prep_${now}_${Math.random().toString(36).slice(2, 8)}`,
        name: input.name.trim() || input.sourceFilename || 'Preprocessed Model',
        savedAt: now,
        sourceFilename: input.sourceFilename || 'model',
        diagnostics: {
            ...input.diagnostics,
            dimensions: { ...input.diagnostics.dimensions },
        },
        geometry: serializeGeometrySnapshot(input.geometry),
        materials: serializeMaterialMap(input.materials),
        operations: (input.operations ?? []).map((op) => ({ ...op })),
        recipe: input.recipe ? {
            ...input.recipe,
            cropMin: { ...input.recipe.cropMin },
            cropMax: { ...input.recipe.cropMax },
            filters: input.recipe.filters ? { ...input.recipe.filters } : undefined,
        } : undefined,
    };
}

export function serializePreprocessBundleJson(bundle: PreprocessBundleV1): string {
    return JSON.stringify(bundle);
}

export function parsePreprocessBundle(jsonText: string): PreprocessBundleV1 {
    let parsed: any;
    try {
        parsed = JSON.parse(jsonText);
    } catch {
        throw new Error('Invalid preprocessing file: malformed JSON');
    }
    if (!parsed || typeof parsed !== 'object') {
        throw new Error('Invalid preprocessing file: expected JSON object');
    }
    if (parsed.format !== 'objtoschematic-preprocess' || parsed.version !== 1) {
        throw new Error('Unsupported preprocessing bundle format or version');
    }
    if (
        !parsed.geometry ||
        !Array.isArray(parsed.geometry.vertices) ||
        !Array.isArray(parsed.geometry.tris) ||
        !Array.isArray(parsed.materials)
    ) {
        throw new Error('Invalid preprocessing bundle: missing geometry or materials');
    }
    if (parsed.geometry.vertices.length === 0 || parsed.geometry.tris.length === 0) {
        throw new Error('Invalid preprocessing bundle: empty geometry');
    }
    return parsed as PreprocessBundleV1;
}

const DB_NAME = 'ObjToSchematicPreprocessDB';
const DB_VERSION = 1;
const STORE_CHECKPOINTS = 'checkpoints';
const RECIPE_STORAGE_KEY = 'ots_preprocess_recipes_v1';

const memoryCheckpoints = new Map<string, PreprocessBundleV1>();
const memoryRecipes: PreprocessRecipe[] = [];

function hasIndexedDB(): boolean {
    return typeof indexedDB !== 'undefined' && indexedDB !== null;
}

function openPreprocessDB(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(STORE_CHECKPOINTS)) {
                db.createObjectStore(STORE_CHECKPOINTS, { keyPath: 'id' });
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error || new Error('IndexedDB open failed'));
    });
}

function summarizeBundle(bundle: PreprocessBundleV1): PreprocessCheckpointSummary {
    return {
        id: bundle.id,
        name: bundle.name,
        savedAt: bundle.savedAt,
        sourceFilename: bundle.sourceFilename,
        triangleCount: bundle.geometry.tris.length,
        vertexCount: bundle.geometry.vertices.length,
        materialCount: bundle.materials.length,
        operationsCount: bundle.operations.length,
    };
}

export class PreprocessStorage {
    public static async saveCheckpoint(bundle: PreprocessBundleV1): Promise<PreprocessCheckpointSummary> {
        if (!hasIndexedDB()) {
            memoryCheckpoints.set(bundle.id, bundle);
            return summarizeBundle(bundle);
        }
        try {
            const db = await openPreprocessDB();
            await new Promise<void>((resolve, reject) => {
                const tx = db.transaction(STORE_CHECKPOINTS, 'readwrite');
                tx.objectStore(STORE_CHECKPOINTS).put(bundle);
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error || new Error('Failed to save checkpoint'));
            });
            db.close();
        } catch {
            memoryCheckpoints.set(bundle.id, bundle);
        }
        return summarizeBundle(bundle);
    }

    public static async listCheckpoints(): Promise<PreprocessCheckpointSummary[]> {
        if (!hasIndexedDB()) {
            return Array.from(memoryCheckpoints.values())
                .map(summarizeBundle)
                .sort((a, b) => b.savedAt - a.savedAt);
        }
        try {
            const db = await openPreprocessDB();
            const items = await new Promise<PreprocessBundleV1[]>((resolve, reject) => {
                const tx = db.transaction(STORE_CHECKPOINTS, 'readonly');
                const req = tx.objectStore(STORE_CHECKPOINTS).getAll();
                req.onsuccess = () => resolve((req.result as PreprocessBundleV1[]) || []);
                req.onerror = () => reject(req.error || new Error('Failed to list checkpoints'));
            });
            db.close();
            return items.map(summarizeBundle).sort((a, b) => b.savedAt - a.savedAt);
        } catch {
            return Array.from(memoryCheckpoints.values())
                .map(summarizeBundle)
                .sort((a, b) => b.savedAt - a.savedAt);
        }
    }

    public static async getCheckpoint(id: string): Promise<PreprocessBundleV1 | null> {
        if (!hasIndexedDB()) {
            return memoryCheckpoints.get(id) ?? null;
        }
        try {
            const db = await openPreprocessDB();
            const item = await new Promise<PreprocessBundleV1 | undefined>((resolve, reject) => {
                const tx = db.transaction(STORE_CHECKPOINTS, 'readonly');
                const req = tx.objectStore(STORE_CHECKPOINTS).get(id);
                req.onsuccess = () => resolve(req.result as PreprocessBundleV1 | undefined);
                req.onerror = () => reject(req.error || new Error('Failed to read checkpoint'));
            });
            db.close();
            return item ?? memoryCheckpoints.get(id) ?? null;
        } catch {
            return memoryCheckpoints.get(id) ?? null;
        }
    }

    public static async deleteCheckpoint(id: string): Promise<void> {
        memoryCheckpoints.delete(id);
        if (!hasIndexedDB()) {
            return;
        }
        try {
            const db = await openPreprocessDB();
            await new Promise<void>((resolve, reject) => {
                const tx = db.transaction(STORE_CHECKPOINTS, 'readwrite');
                tx.objectStore(STORE_CHECKPOINTS).delete(id);
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error || new Error('Failed to delete checkpoint'));
            });
            db.close();
        } catch {
            // Fallback already cleared memory map
        }
    }

    public static listRecipes(): PreprocessRecipe[] {
        if (typeof localStorage === 'undefined') {
            return [...memoryRecipes].sort((a, b) => b.savedAt - a.savedAt);
        }
        try {
            const raw = localStorage.getItem(RECIPE_STORAGE_KEY);
            if (!raw) return [];
            const parsed = JSON.parse(raw);
            if (!Array.isArray(parsed)) return [];
            return (parsed as PreprocessRecipe[]).sort((a, b) => b.savedAt - a.savedAt);
        } catch {
            return [];
        }
    }

    public static saveRecipe(name: string, params: PreprocessRecipeParams): PreprocessRecipe {
        const recipe: PreprocessRecipe = {
            id: `rcp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            name: name.trim() || 'Preset',
            savedAt: Date.now(),
            params: {
                ...params,
                cropMin: { ...params.cropMin },
                cropMax: { ...params.cropMax },
                filters: params.filters ? { ...params.filters } : undefined,
            },
        };
        if (typeof localStorage === 'undefined') {
            memoryRecipes.unshift(recipe);
            return recipe;
        }
        const existing = this.listRecipes().filter((r) => r.name !== recipe.name);
        existing.unshift(recipe);
        try {
            localStorage.setItem(RECIPE_STORAGE_KEY, JSON.stringify(existing.slice(0, 30)));
        } catch {
            memoryRecipes.unshift(recipe);
        }
        return recipe;
    }

    public static deleteRecipe(id: string): void {
        const memIdx = memoryRecipes.findIndex((r) => r.id === id);
        if (memIdx >= 0) memoryRecipes.splice(memIdx, 1);
        if (typeof localStorage === 'undefined') return;
        const next = this.listRecipes().filter((r) => r.id !== id);
        try {
            localStorage.setItem(RECIPE_STORAGE_KEY, JSON.stringify(next));
        } catch {
            // Ignore quota errors on delete
        }
    }
}
