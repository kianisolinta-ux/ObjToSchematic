import { parse } from '@loaders.gl/core';
import { GLTFLoader } from '@loaders.gl/gltf';
import { PNG } from 'pngjs';

import { RGBA, RGBAColours, RGBAUtil } from '../colour';
import { LOC } from '../localiser';
import { MaterialMap, MaterialType, Mesh, Tri } from '../mesh';
import { StatusHandler } from '../status';
import { TTransparencyOptions } from '../texture';
import { UV } from '../util';
import { Vector3 } from '../vector';
import { IImporter } from './base_importer';
import {
    collectGltfPrimitives,
    computeNormalMatrix3,
    decodeColorAccessor,
    detectImageMimeType,
    expandPrimitiveTriangleIndices,
    linearFactorToSrgbRGBA,
    transformNormal,
    transformPoint,
} from './gltf_utils';

export class GltfLoader extends IImporter {
    public override import(file: File): Promise<Mesh> {
        StatusHandler.warning(LOC('import.gltf_experimental'));

        return parse(file, GLTFLoader, { loadImages: true })
            .then(async (gltf: any) => {
                await this._prepareGltfImages(gltf);
                return this._handleGLTF(gltf);
            });
    }

    private async _prepareGltfImages(gltf: any): Promise<void> {
        const sources = new Set<any>();

        const collectSource = (src: any) => {
            if (src && typeof src === 'object') {
                sources.add(src);
            }
        };

        if (Array.isArray(gltf?.images)) {
            gltf.images.forEach(collectSource);
        }
        if (Array.isArray(gltf?.textures)) {
            gltf.textures.forEach((tex: any) => collectSource(tex?.source));
        }

        const primitives = collectGltfPrimitives(gltf);
        for (const { primitive } of primitives) {
            const pbr = primitive?.material?.pbrMetallicRoughness;
            collectSource(pbr?.baseColorTexture?.texture?.source);
        }

        for (const source of Array.from(sources)) {
            const rawBytes: Uint8Array | undefined =
                source?.bufferView?.data ||
                source?.data;

            const mime = rawBytes ? detectImageMimeType(rawBytes, source?.mimeType) : (source?.mimeType || '');
            if (mime === 'image/png' || mime === 'image/jpeg') {
                continue;
            }

            // Transcode WebP or already-decoded browser ImageBitmap / HTMLImageElement / RGBA data to PNG offline
            let pngBytes: Uint8Array | null = null;
            if (rawBytes && mime === 'image/webp') {
                pngBytes = await this._decodeImageBytesToPng(rawBytes, mime);
            } else if (source?.image) {
                pngBytes = await this._encodeDecodedImageToPng(source.image);
            }

            if (pngBytes && pngBytes.length > 0) {
                source.bufferView = { ...(source.bufferView || {}), data: pngBytes };
                source.mimeType = 'image/png';
            }
        }
    }

    private async _decodeImageBytesToPng(bytes: Uint8Array, mimeType: string): Promise<Uint8Array | null> {
        try {
            if (typeof createImageBitmap === 'function' && typeof Blob !== 'undefined') {
                const copy = new Uint8Array(bytes.byteLength);
                copy.set(bytes);
                const bitmap = await createImageBitmap(new Blob([copy], { type: mimeType }));
                const png = await this._bitmapOrImageToPng(bitmap, bitmap.width, bitmap.height);
                bitmap.close?.();
                return png;
            }
        } catch {
            // Fall through
        }
        return null;
    }

    private async _encodeDecodedImageToPng(image: any): Promise<Uint8Array | null> {
        if (!image) {
            return null;
        }
        if (image.data && typeof image.width === 'number' && typeof image.height === 'number') {
            return this._rgbaToPngBytes(image.data, image.width, image.height);
        }
        if (typeof image.width === 'number' && typeof image.height === 'number') {
            return await this._bitmapOrImageToPng(image, image.width, image.height);
        }
        return null;
    }

    private async _bitmapOrImageToPng(drawable: any, width: number, height: number): Promise<Uint8Array | null> {
        if (width <= 0 || height <= 0) {
            return null;
        }
        try {
            if (typeof OffscreenCanvas !== 'undefined') {
                const canvas = new OffscreenCanvas(width, height);
                const ctx = canvas.getContext('2d');
                if (!ctx) return null;
                ctx.drawImage(drawable, 0, 0);
                if (typeof canvas.convertToBlob === 'function') {
                    const blob = await canvas.convertToBlob({ type: 'image/png' });
                    return new Uint8Array(await blob.arrayBuffer());
                }
                const imgData = ctx.getImageData(0, 0, width, height);
                return this._rgbaToPngBytes(imgData.data, width, height);
            }
            if (typeof document !== 'undefined') {
                const canvas = document.createElement('canvas');
                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                if (!ctx) return null;
                ctx.drawImage(drawable, 0, 0);
                const imgData = ctx.getImageData(0, 0, width, height);
                return this._rgbaToPngBytes(imgData.data, width, height);
            }
        } catch {
            return null;
        }
        return null;
    }

    private _rgbaToPngBytes(rgba: ArrayLike<number>, width: number, height: number): Uint8Array {
        const png = new PNG({ width, height });
        const len = Math.min(png.data.length, rgba.length);
        for (let i = 0; i < len; ++i) {
            png.data[i] = rgba[i];
        }
        return new Uint8Array(PNG.sync.write(png));
    }

    private _handleGLTF(gltf: any): Mesh {
        const meshVertices: Vector3[] = [];
        const meshNormals: Vector3[] = [];
        const meshTexcoords: UV[] = [];
        const meshVertexColours: RGBA[] = [];
        const meshTriangles: Tri[] = [];
        const meshMaterials: MaterialMap = new Map();

        meshMaterials.set('NONE', {
            type: MaterialType.solid,
            colour: RGBAUtil.copy(RGBAColours.WHITE),
            needsAttention: false,
            canBeTextured: false,
        });

        let materialIndex = 0;
        const collectedPrimitives = collectGltfPrimitives(gltf);

        for (const { primitive, worldMatrix } of collectedPrimitives) {
            const attributes = primitive.attributes || {};
            if (attributes.POSITION === undefined || attributes.POSITION.value === undefined) {
                continue;
            }

            const { m3: normalMat3, det } = computeNormalMatrix3(worldMatrix);
            const flipWinding = det < 0;

            const vertexOffset = meshVertices.length;
            const normalOffset = meshNormals.length;
            const texcoordOffset = meshTexcoords.length;
            const colourOffset = meshVertexColours.length;

            // Handling vertices transformed by node world matrix
            const positions = attributes.POSITION.value as ArrayLike<number>;
            const positionCount = Math.floor(positions.length / 3);
            for (let i = 0; i + 2 < positions.length; i += 3) {
                const [tx, ty, tz] = transformPoint(
                    worldMatrix,
                    positions[i + 0],
                    positions[i + 1],
                    positions[i + 2],
                );
                meshVertices.push(new Vector3(
                    Number.isFinite(tx) ? tx : 0,
                    Number.isFinite(ty) ? ty : 0,
                    Number.isFinite(tz) ? tz : 0,
                ));
            }

            // Handling normals transformed by inverse-transpose 3x3 world matrix
            let normalCount = 0;
            if (attributes.NORMAL !== undefined && attributes.NORMAL.value !== undefined) {
                const normals = attributes.NORMAL.value as ArrayLike<number>;
                for (let i = 0; i + 2 < normals.length; i += 3) {
                    const [tx, ty, tz] = transformNormal(
                        normalMat3,
                        normals[i + 0],
                        normals[i + 1],
                        normals[i + 2],
                    );
                    meshNormals.push(new Vector3(tx, ty, tz));
                    ++normalCount;
                }
            }

            // Handling texture coordinates
            let texcoordCount = 0;
            if (attributes.TEXCOORD_0 !== undefined && attributes.TEXCOORD_0.value !== undefined) {
                const texcoords = attributes.TEXCOORD_0.value as ArrayLike<number>;
                for (let i = 0; i + 1 < texcoords.length; i += 2) {
                    meshTexcoords.push(new UV(
                        texcoords[i + 0],
                        1.0 - texcoords[i + 1],
                    ));
                    ++texcoordCount;
                }
            }

            // Handling COLOR_0 vertex colours
            const decodedColours = decodeColorAccessor(attributes.COLOR_0);
            for (const c of decodedColours) {
                meshVertexColours.push(c);
            }
            const hasVertexColours = decodedColours.length > 0;

            // Material
            let materialBaseName = 'NONE';
            if (primitive.material) {
                materialBaseName = primitive.material.name || 'Material';
            }

            const materialNameToUse = materialBaseName + '_' + materialIndex;
            materialIndex++;

            const gltfMaterial = primitive.material;
            const alphaMode: string = gltfMaterial?.alphaMode || 'OPAQUE';
            const alphaCutoff: number = typeof gltfMaterial?.alphaCutoff === 'number' && Number.isFinite(gltfMaterial.alphaCutoff) ?
                gltfMaterial.alphaCutoff :
                0.5;
            const pbr = gltfMaterial?.pbrMetallicRoughness;
            const tintRGBA = linearFactorToSrgbRGBA(pbr?.baseColorFactor, alphaMode === 'OPAQUE');
            const hasTint =
                Math.abs(tintRGBA.r - 1) > 1e-4 ||
                Math.abs(tintRGBA.g - 1) > 1e-4 ||
                Math.abs(tintRGBA.b - 1) > 1e-4 ||
                Math.abs(tintRGBA.a - 1) > 1e-4;

            let loadedTexture = false;
            const diffuseTexture = pbr?.baseColorTexture;

            if (diffuseTexture !== undefined && diffuseTexture.texture !== undefined) {
                const source = diffuseTexture.texture.source;
                let imageData: Uint8Array | undefined =
                    source?.bufferView?.data ||
                    source?.data;

                let mimeType = imageData ? detectImageMimeType(imageData, source?.mimeType) : '';

                // Synchronously encode raw RGBA decoded image if bufferView bytes aren't attached
                if (
                    (!imageData || (mimeType !== 'image/png' && mimeType !== 'image/jpeg')) &&
                    source?.image?.data && source?.image?.width && source?.image?.height
                ) {
                    imageData = this._rgbaToPngBytes(source.image.data, source.image.width, source.image.height);
                    mimeType = 'image/png';
                }

                if (imageData && imageData.length > 0) {
                    if (mimeType === 'image/png' || mimeType === 'image/jpeg') {
                        try {
                            const base64 = Buffer.from(imageData).toString('base64');
                            let transparency: TTransparencyOptions = { type: 'None' };
                            let materialAlphaCutoff: number | undefined;
                            if (alphaMode === 'MASK') {
                                transparency = { type: 'UseDiffuseMapAlphaChannel' };
                                materialAlphaCutoff = alphaCutoff;
                            } else if (alphaMode === 'BLEND') {
                                transparency = { type: 'UseDiffuseMapAlphaChannel' };
                            }

                            meshMaterials.set(materialNameToUse, {
                                type: MaterialType.textured,
                                diffuse: {
                                    filetype: mimeType === 'image/jpeg' ? 'jpg' : 'png',
                                    raw: (mimeType === 'image/jpeg' ? 'data:image/jpeg;base64,' : 'data:image/png;base64,') + base64,
                                },
                                extension: 'clamp',
                                interpolation: 'linear',
                                needsAttention: false,
                                transparency,
                                tint: hasTint ? tintRGBA : undefined,
                                alphaCutoff: materialAlphaCutoff,
                            });
                            loadedTexture = true;
                        } catch {
                            // Fallback to solid
                        }
                    } else {
                        StatusHandler.warning(LOC('import.unsupported_image_type', {
                            file_name: diffuseTexture.texture.source?.id || 'texture',
                            file_type: mimeType || 'unknown',
                        }));
                    }
                }
            }

            if (!loadedTexture) {
                meshMaterials.set(materialNameToUse, {
                    type: MaterialType.solid,
                    colour: tintRGBA,
                    needsAttention: false,
                    canBeTextured: texcoordCount > 0,
                });
            }

            // Indices (supports TRIANGLES, TRIANGLE_STRIP, TRIANGLE_FAN)
            const rawIndices: ArrayLike<number> | undefined = primitive.indices?.value;
            const mode: number = typeof primitive.mode === 'number' ? primitive.mode : 4;
            const expandedIndices = expandPrimitiveTriangleIndices(rawIndices, positionCount, mode);

            const hasTexcoords = texcoordCount > 0;
            const hasNormals = normalCount > 0;

            for (let i = 0; i + 2 < expandedIndices.length; i += 3) {
                const i0 = expandedIndices[i + 0];
                const i1 = flipWinding ? expandedIndices[i + 2] : expandedIndices[i + 1];
                const i2 = flipWinding ? expandedIndices[i + 1] : expandedIndices[i + 2];

                if (
                    i0 < 0 || i0 >= positionCount ||
                    i1 < 0 || i1 >= positionCount ||
                    i2 < 0 || i2 >= positionCount
                ) {
                    continue;
                }

                const tri: Tri = {
                    material: materialNameToUse,
                    positionIndices: {
                        x: vertexOffset + i0,
                        y: vertexOffset + i1,
                        z: vertexOffset + i2,
                    },
                };
                if (hasTexcoords && i0 < texcoordCount && i1 < texcoordCount && i2 < texcoordCount) {
                    tri.texcoordIndices = {
                        x: texcoordOffset + i0,
                        y: texcoordOffset + i1,
                        z: texcoordOffset + i2,
                    };
                }
                if (hasNormals && i0 < normalCount && i1 < normalCount && i2 < normalCount) {
                    tri.normalIndices = {
                        x: normalOffset + i0,
                        y: normalOffset + i1,
                        z: normalOffset + i2,
                    };
                }
                if (hasVertexColours && i0 < decodedColours.length && i1 < decodedColours.length && i2 < decodedColours.length) {
                    tri.vertexColourIndices = {
                        x: colourOffset + i0,
                        y: colourOffset + i1,
                        z: colourOffset + i2,
                    };
                }
                meshTriangles.push(tri);
            }
        }

        return new Mesh(
            meshVertices,
            meshNormals,
            meshTexcoords,
            meshTriangles,
            meshMaterials,
            meshVertexColours.length > 0 ? meshVertexColours : undefined,
        );
    }
}
