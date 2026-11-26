import { RGBA } from './colour';
import { TAxis } from './util/type_util';

export const VOXEL_MODEL_FORMAT = 'ots-voxel-model' as const;
export const VOXEL_MODEL_VERSION = 1 as const;

export type TVoxelModelOverlapRule = 'first' | 'average' | 'dominant';

export interface TVoxelModelMeta {
    modelName?: string;
    constraintAxis?: TAxis;
    size?: number;
    enableAmbientOcclusion?: boolean;
    voxelOverlapRule?: TVoxelModelOverlapRule;
}

export type TVoxelTuple = [number, number, number, number, number, number, number];

export interface TVoxelModelFileV1 {
    format: typeof VOXEL_MODEL_FORMAT;
    version: typeof VOXEL_MODEL_VERSION;
    createdAt: string;
    meta: TVoxelModelMeta;
    voxels: TVoxelTuple[];
}

export interface IVoxelRecordLike {
    x: number;
    y: number;
    z: number;
    colour: RGBA;
}

export interface IParsedVoxelModel {
    meta: TVoxelModelMeta;
    voxels: IVoxelRecordLike[];
    bounds: {
        minX: number;
        minY: number;
        minZ: number;
        maxX: number;
        maxY: number;
        maxZ: number;
    };
    dimensions: {
        x: number;
        y: number;
        z: number;
    };
    desiredHeight: number;
}

function clamp01(v: number): number {
    if (!Number.isFinite(v)) {
        return 0;
    }
    return Math.max(0, Math.min(1, v));
}

function roundChannel(v: number): number {
    return Math.round(clamp01(v) * 10000) / 10000;
}

export function serializeVoxelModel(
    voxels: ReadonlyArray<{ position: { x: number; y: number; z: number }; colour: RGBA }>,
    meta: TVoxelModelMeta = {},
): string {
    const tuples: TVoxelTuple[] = new Array(voxels.length);
    for (let i = 0; i < voxels.length; ++i) {
        const v = voxels[i];
        tuples[i] = [
            Math.round(v.position.x),
            Math.round(v.position.y),
            Math.round(v.position.z),
            roundChannel(v.colour.r),
            roundChannel(v.colour.g),
            roundChannel(v.colour.b),
            roundChannel(v.colour.a),
        ];
    }

    const cleanMeta: TVoxelModelMeta = {};
    if (typeof meta.modelName === 'string' && meta.modelName.trim().length > 0) {
        cleanMeta.modelName = meta.modelName.trim();
    }
    if (meta.constraintAxis === 'x' || meta.constraintAxis === 'y' || meta.constraintAxis === 'z') {
        cleanMeta.constraintAxis = meta.constraintAxis;
    }
    if (typeof meta.size === 'number' && Number.isFinite(meta.size) && meta.size > 0) {
        cleanMeta.size = Math.round(meta.size);
    }
    if (typeof meta.enableAmbientOcclusion === 'boolean') {
        cleanMeta.enableAmbientOcclusion = meta.enableAmbientOcclusion;
    }
    if (meta.voxelOverlapRule === 'first' || meta.voxelOverlapRule === 'average' || meta.voxelOverlapRule === 'dominant') {
        cleanMeta.voxelOverlapRule = meta.voxelOverlapRule;
    }

    const payload: TVoxelModelFileV1 = {
        format: VOXEL_MODEL_FORMAT,
        version: VOXEL_MODEL_VERSION,
        createdAt: new Date().toISOString(),
        meta: cleanMeta,
        voxels: tuples,
    };

    return JSON.stringify(payload);
}

export function deriveModelNameFromVoxelFilename(filename: string): string {
    const trimmed = filename.trim();
    if (!trimmed) {
        return 'voxel_model';
    }
    const stripped = trimmed
        .replace(/\.voxels\.json$/i, '')
        .replace(/\.json$/i, '');
    return stripped || 'voxel_model';
}

export function parseVoxelModelJson(jsonText: string): IParsedVoxelModel {
    let parsed: unknown;
    try {
        parsed = JSON.parse(jsonText);
    } catch {
        throw new Error('Invalid JSON voxel model file');
    }

    if (!parsed || typeof parsed !== 'object') {
        throw new Error('Invalid voxel model payload');
    }

    const record = parsed as Partial<TVoxelModelFileV1>;
    if (record.format !== VOXEL_MODEL_FORMAT || record.version !== VOXEL_MODEL_VERSION) {
        throw new Error('Unsupported voxel model format or version');
    }
    if (!Array.isArray(record.voxels) || record.voxels.length === 0) {
        throw new Error('Voxel model file contains no voxels');
    }

    const dedup = new Map<string, IVoxelRecordLike>();
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;

    for (let i = 0; i < record.voxels.length; ++i) {
        const entry = record.voxels[i] as unknown;
        if (!Array.isArray(entry) || entry.length < 6) {
            throw new Error(`Invalid voxel entry at index ${i}`);
        }
        const x = Math.round(Number(entry[0]));
        const y = Math.round(Number(entry[1]));
        const z = Math.round(Number(entry[2]));
        const r = clamp01(Number(entry[3]));
        const g = clamp01(Number(entry[4]));
        const b = clamp01(Number(entry[5]));
        const a = entry.length >= 7 ? clamp01(Number(entry[6])) : 1;

        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
            throw new Error(`Invalid voxel coordinates at index ${i}`);
        }
        if (a <= 0) {
            continue;
        }

        const key = `${x},${y},${z}`;
        dedup.set(key, {
            x,
            y,
            z,
            colour: { r, g, b, a },
        });

        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (z < minZ) minZ = z;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
        if (z > maxZ) maxZ = z;
    }

    const voxels = Array.from(dedup.values());
    if (voxels.length === 0) {
        throw new Error('Voxel model file contains no visible voxels');
    }

    const rawMeta = (record.meta && typeof record.meta === 'object') ? record.meta : {};
    const meta: TVoxelModelMeta = {};
    if (typeof rawMeta.modelName === 'string' && rawMeta.modelName.trim().length > 0) {
        meta.modelName = rawMeta.modelName.trim();
    }
    if (rawMeta.constraintAxis === 'x' || rawMeta.constraintAxis === 'y' || rawMeta.constraintAxis === 'z') {
        meta.constraintAxis = rawMeta.constraintAxis;
    }
    if (typeof rawMeta.size === 'number' && Number.isFinite(rawMeta.size) && rawMeta.size > 0) {
        meta.size = Math.max(1, Math.round(rawMeta.size));
    }
    if (typeof rawMeta.enableAmbientOcclusion === 'boolean') {
        meta.enableAmbientOcclusion = rawMeta.enableAmbientOcclusion;
    }
    if (rawMeta.voxelOverlapRule === 'first' || rawMeta.voxelOverlapRule === 'average' || rawMeta.voxelOverlapRule === 'dominant') {
        meta.voxelOverlapRule = rawMeta.voxelOverlapRule;
    }

    const dimX = maxX - minX + 1;
    const dimY = maxY - minY + 1;
    const dimZ = maxZ - minZ + 1;
    const desiredHeight = meta.size ?? Math.max(1, dimY);

    return {
        meta,
        voxels,
        bounds: { minX, minY, minZ, maxX, maxY, maxZ },
        dimensions: { x: dimX, y: dimY, z: dimZ },
        desiredHeight,
    };
}
