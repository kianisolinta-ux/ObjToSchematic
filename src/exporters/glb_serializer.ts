import { RGBA } from '../colour';
import { MeshRepairOptions, MeshRepairStats, RawMeshData, RepairedMeshData, repairMeshData } from '../mesh_repair';

export interface GlbExportOptions extends MeshRepairOptions {
    /** Node/mesh name stored inside the glTF JSON. Defaults to 'RepairedModel'. */
    modelName?: string;
}

export interface GlbExportResult {
    glbBytes: Uint8Array;
    stats: MeshRepairStats;
}

export interface GlbSolidMaterialLike {
    type: 0; // MaterialType.solid
    colour: RGBA;
}

export interface GlbTexturedMaterialLike {
    type: 1; // MaterialType.textured
    diffuse?: {
        raw: string;
        filetype: 'png' | 'jpg';
    };
    interpolation: 'linear' | 'nearest';
    extension: 'clamp' | 'repeat';
    transparency:
        | { type: 'None' }
        | { type: 'UseDiffuseMapAlphaChannel' }
        | { type: 'UseAlphaValue'; alpha: number }
        | { type: 'UseAlphaMap'; alpha?: { raw: string; filetype: 'png' | 'jpg' } };
    tint?: RGBA;
    alphaCutoff?: number;
}

export type GlbMaterialLike = GlbSolidMaterialLike | GlbTexturedMaterialLike;

/**
 * Exact inverse of linearToSrgbChannel in src/importers/gltf_utils.ts.
 * Converts sRGB [0, 1] colour components back into glTF linear [0, 1].
 */
export function srgbToLinearChannel(srgb: number): number {
    if (!Number.isFinite(srgb)) {
        return 1.0;
    }
    const c = Math.max(0.0, Math.min(1.0, srgb));
    if (c <= 0.0) {
        return 0.0;
    }
    if (c >= 1.0) {
        return 1.0;
    }
    if (c <= 0.04045) {
        return c / 12.92;
    }
    return Math.pow((c + 0.055) / 1.055, 2.4);
}

function decodeBase64DataUrl(dataUrl: string): Uint8Array | null {
    if (!dataUrl) {
        return null;
    }
    const commaIdx = dataUrl.indexOf(',');
    const b64 = commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : dataUrl;
    if (!b64) {
        return null;
    }
    if (typeof Buffer !== 'undefined') {
        return new Uint8Array(Buffer.from(b64, 'base64'));
    }
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; ++i) {
        out[i] = bin.charCodeAt(i);
    }
    return out;
}

function alignTo4(n: number): number {
    return (n + 3) & ~3;
}

class BinaryChunkBuilder {
    private _chunks: Uint8Array[] = [];
    private _byteLength = 0;

    public get byteLength(): number {
        return this._byteLength;
    }

    public append(bytes: Uint8Array): { byteOffset: number; byteLength: number } {
        const padBefore = alignTo4(this._byteLength) - this._byteLength;
        if (padBefore > 0) {
            this._chunks.push(new Uint8Array(padBefore));
            this._byteLength += padBefore;
        }
        const byteOffset = this._byteLength;
        this._chunks.push(bytes);
        this._byteLength += bytes.byteLength;
        return { byteOffset, byteLength: bytes.byteLength };
    }

    public toPaddedUint8Array(): Uint8Array {
        const total = alignTo4(this._byteLength);
        const out = new Uint8Array(total);
        let offset = 0;
        for (const chunk of this._chunks) {
            out.set(chunk, offset);
            offset += chunk.byteLength;
        }
        return out;
    }
}

/**
 * Serializes repaired mesh data and material map into a self-contained binary glTF 2.0 (.glb).
 */
export function serializeGlbFromMeshData(
    meshData: RawMeshData | RepairedMeshData,
    materials: Map<string, GlbMaterialLike>,
    options: GlbExportOptions = {},
): GlbExportResult {
    const repaired = ('stats' in meshData) ?
        meshData :
        repairMeshData(meshData, options);

    if (repaired.tris.length === 0) {
        throw new Error('Cannot export GLB: mesh has no valid triangles after repair');
    }

    const bin = new BinaryChunkBuilder();
    const bufferViews: any[] = [];
    const accessors: any[] = [];
    const gltfMaterials: any[] = [];
    const images: any[] = [];
    const samplers: any[] = [];
    const textures: any[] = [];

    const addBufferView = (bytes: Uint8Array, target?: number): number => {
        const { byteOffset, byteLength } = bin.append(bytes);
        const bv: any = {
            buffer: 0,
            byteOffset,
            byteLength,
        };
        if (target !== undefined) {
            bv.target = target;
        }
        const idx = bufferViews.length;
        bufferViews.push(bv);
        return idx;
    };

    const addAccessor = (
        bufferView: number,
        componentType: number,
        count: number,
        type: 'SCALAR' | 'VEC2' | 'VEC3' | 'VEC4',
        min?: number[],
        max?: number[],
    ): number => {
        const acc: any = {
            bufferView,
            componentType,
            count,
            type,
        };
        if (min && max) {
            acc.min = min;
            acc.max = max;
        }
        const idx = accessors.length;
        accessors.push(acc);
        return idx;
    };

    // Group triangles by material name preserving appearance order
    const trisByMaterial = new Map<string, number[]>();
    for (let i = 0; i < repaired.tris.length; ++i) {
        const matName = repaired.tris[i].material || 'NONE';
        let list = trisByMaterial.get(matName);
        if (!list) {
            list = [];
            trisByMaterial.set(matName, list);
        }
        list.push(i);
    }

    const primitives: any[] = [];

    for (const [matName, triIndices] of Array.from(trisByMaterial.entries())) {
        const mat = materials.get(matName);

        const pbr: any = {
            metallicFactor: 0.0,
            roughnessFactor: 1.0,
        };
        const gltfMat: any = {
            name: matName,
            pbrMetallicRoughness: pbr,
            doubleSided: true,
        };

        if (mat && mat.type === 1 && mat.diffuse?.raw) {
            const imgBytes = decodeBase64DataUrl(mat.diffuse.raw);
            if (imgBytes && imgBytes.byteLength > 0) {
                const mimeType = mat.diffuse.filetype === 'jpg' ? 'image/jpeg' : 'image/png';
                const imgBvIdx = addBufferView(imgBytes);
                const imgIdx = images.length;
                images.push({
                    bufferView: imgBvIdx,
                    mimeType,
                });

                const filter = mat.interpolation === 'nearest' ? 9728 : 9729;
                const wrap = mat.extension === 'clamp' ? 33071 : 10497;
                const samplerIdx = samplers.length;
                samplers.push({
                    magFilter: filter,
                    minFilter: filter,
                    wrapS: wrap,
                    wrapT: wrap,
                });

                const texIdx = textures.length;
                textures.push({
                    sampler: samplerIdx,
                    source: imgIdx,
                });

                pbr.baseColorTexture = { index: texIdx };
                if (mat.tint) {
                    pbr.baseColorFactor = [
                        srgbToLinearChannel(mat.tint.r),
                        srgbToLinearChannel(mat.tint.g),
                        srgbToLinearChannel(mat.tint.b),
                        Math.max(0, Math.min(1, mat.tint.a)),
                    ];
                }
                if (mat.transparency.type === 'UseDiffuseMapAlphaChannel') {
                    if (mat.alphaCutoff !== undefined) {
                        gltfMat.alphaMode = 'MASK';
                        gltfMat.alphaCutoff = mat.alphaCutoff;
                    } else {
                        gltfMat.alphaMode = 'BLEND';
                    }
                } else {
                    gltfMat.alphaMode = 'OPAQUE';
                }
            }
        } else if (mat && mat.type === 0) {
            pbr.baseColorFactor = [
                srgbToLinearChannel(mat.colour.r),
                srgbToLinearChannel(mat.colour.g),
                srgbToLinearChannel(mat.colour.b),
                Math.max(0, Math.min(1, mat.colour.a)),
            ];
            if (mat.colour.a < 0.999) {
                gltfMat.alphaMode = 'BLEND';
            }
        } else {
            pbr.baseColorFactor = [1, 1, 1, 1];
        }

        const matIndex = gltfMaterials.length;
        gltfMaterials.push(gltfMat);

        // Deduplicate vertices per (posIdx, normIdx, uvIdx, colIdx) tuple so attributes stay aligned
        const primPositions: number[] = [];
        const primNormals: number[] = [];
        const primUVs: number[] = [];
        const primColours: number[] = [];
        const primIndices: number[] = [];
        const tupleToLocalIdx = new Map<string, number>();

        const hasUVs = triIndices.some((tIdx) => repaired.tris[tIdx].texcoordIndices !== undefined);
        const hasColours = Boolean(
            repaired.vertexColours &&
            triIndices.some((tIdx) => repaired.tris[tIdx].vertexColourIndices !== undefined),
        );

        let minX = Infinity;
        let minY = Infinity;
        let minZ = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        let maxZ = -Infinity;

        const pushCorner = (
            pIdx: number,
            nIdx: number | undefined,
            uvIdx: number | undefined,
            cIdx: number | undefined,
        ) => {
            const key = `${pIdx}:${nIdx ?? -1}:${uvIdx ?? -1}:${cIdx ?? -1}`;
            const existing = tupleToLocalIdx.get(key);
            if (existing !== undefined) {
                primIndices.push(existing);
                return;
            }

            const localIdx = primPositions.length / 3;
            tupleToLocalIdx.set(key, localIdx);

            const pos = repaired.vertices[pIdx];
            primPositions.push(pos.x, pos.y, pos.z);
            if (pos.x < minX) minX = pos.x;
            if (pos.y < minY) minY = pos.y;
            if (pos.z < minZ) minZ = pos.z;
            if (pos.x > maxX) maxX = pos.x;
            if (pos.y > maxY) maxY = pos.y;
            if (pos.z > maxZ) maxZ = pos.z;

            const norm = (nIdx !== undefined && repaired.normals[nIdx]) ?
                repaired.normals[nIdx] :
                { x: 0, y: 1, z: 0 };
            primNormals.push(norm.x, norm.y, norm.z);

            if (hasUVs) {
                const uv = (uvIdx !== undefined && repaired.uvs[uvIdx]) ?
                    repaired.uvs[uvIdx] :
                    { u: 0, v: 0 };
                // Flip V back to glTF convention (loader does 1.0 - v)
                primUVs.push(uv.u, 1.0 - uv.v);
            }

            if (hasColours) {
                const col = (cIdx !== undefined && repaired.vertexColours?.[cIdx]) ?
                    repaired.vertexColours[cIdx] :
                    { r: 1, g: 1, b: 1, a: 1 };
                primColours.push(
                    srgbToLinearChannel(col.r),
                    srgbToLinearChannel(col.g),
                    srgbToLinearChannel(col.b),
                    Math.max(0, Math.min(1, col.a)),
                );
            }

            primIndices.push(localIdx);
        };

        for (const tIdx of triIndices) {
            const tri = repaired.tris[tIdx];
            pushCorner(tri.positionIndices.x, tri.normalIndices?.x, tri.texcoordIndices?.x, tri.vertexColourIndices?.x);
            pushCorner(tri.positionIndices.y, tri.normalIndices?.y, tri.texcoordIndices?.y, tri.vertexColourIndices?.y);
            pushCorner(tri.positionIndices.z, tri.normalIndices?.z, tri.texcoordIndices?.z, tri.vertexColourIndices?.z);
        }

        const vertexCount = primPositions.length / 3;
        const posArr = new Float32Array(primPositions);
        const normArr = new Float32Array(primNormals);
        const idxArr = new Uint32Array(primIndices);

        const posBv = addBufferView(new Uint8Array(posArr.buffer, posArr.byteOffset, posArr.byteLength), 34962);
        const normBv = addBufferView(new Uint8Array(normArr.buffer, normArr.byteOffset, normArr.byteLength), 34962);
        const idxBv = addBufferView(new Uint8Array(idxArr.buffer, idxArr.byteOffset, idxArr.byteLength), 34963);

        const attributes: Record<string, number> = {
            POSITION: addAccessor(posBv, 5126, vertexCount, 'VEC3', [minX, minY, minZ], [maxX, maxY, maxZ]),
            NORMAL: addAccessor(normBv, 5126, vertexCount, 'VEC3'),
        };

        if (hasUVs) {
            const uvArr = new Float32Array(primUVs);
            const uvBv = addBufferView(new Uint8Array(uvArr.buffer, uvArr.byteOffset, uvArr.byteLength), 34962);
            attributes.TEXCOORD_0 = addAccessor(uvBv, 5126, vertexCount, 'VEC2');
        }

        if (hasColours) {
            const colArr = new Float32Array(primColours);
            const colBv = addBufferView(new Uint8Array(colArr.buffer, colArr.byteOffset, colArr.byteLength), 34962);
            attributes.COLOR_0 = addAccessor(colBv, 5126, vertexCount, 'VEC4');
        }

        const indicesAcc = addAccessor(idxBv, 5125, primIndices.length, 'SCALAR');

        primitives.push({
            attributes,
            indices: indicesAcc,
            material: matIndex,
            mode: 4,
        });
    }

    const binChunk = bin.toPaddedUint8Array();
    const gltfJson: any = {
        asset: {
            version: '2.0',
            generator: 'ObjToSchematic Offline Mesh Repair',
        },
        scene: 0,
        scenes: [{ nodes: [0] }],
        nodes: [{ mesh: 0, name: options.modelName || 'RepairedModel' }],
        meshes: [{ name: options.modelName || 'RepairedModel', primitives }],
        materials: gltfMaterials,
        accessors,
        bufferViews,
        buffers: [{ byteLength: binChunk.byteLength }],
    };

    if (images.length > 0) {
        gltfJson.images = images;
    }
    if (textures.length > 0) {
        gltfJson.textures = textures;
    }
    if (samplers.length > 0) {
        gltfJson.samplers = samplers;
    }

    const jsonString = JSON.stringify(gltfJson);
    const jsonBytes = typeof TextEncoder !== 'undefined' ?
        new TextEncoder().encode(jsonString) :
        new Uint8Array(Buffer.from(jsonString, 'utf8'));

    const jsonPaddedLen = alignTo4(jsonBytes.byteLength);
    const totalLen = 12 + 8 + jsonPaddedLen + 8 + binChunk.byteLength;

    const out = new Uint8Array(totalLen);
    const view = new DataView(out.buffer);

    // GLB Header
    view.setUint32(0, 0x46546C67, true); // 'glTF'
    view.setUint32(4, 2, true);          // version 2
    view.setUint32(8, totalLen, true);   // total file length

    // Chunk 0: JSON
    view.setUint32(12, jsonPaddedLen, true);
    view.setUint32(16, 0x4E4F534A, true); // 'JSON'
    out.set(jsonBytes, 20);
    for (let i = jsonBytes.byteLength; i < jsonPaddedLen; ++i) {
        out[20 + i] = 0x20; // ASCII space padding per glTF 2.0 spec
    }

    // Chunk 1: BIN
    const binHeaderOffset = 20 + jsonPaddedLen;
    view.setUint32(binHeaderOffset, binChunk.byteLength, true);
    view.setUint32(binHeaderOffset + 4, 0x004E4942, true); // 'BIN\0'
    out.set(binChunk, binHeaderOffset + 8);

    return {
        glbBytes: out,
        stats: repaired.stats,
    };
}
