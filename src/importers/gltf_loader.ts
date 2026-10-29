import { parse } from '@loaders.gl/core';
import { GLTFLoader } from '@loaders.gl/gltf';

import { RGBAColours, RGBAUtil } from '../colour';
import { LOC } from '../localiser';
import { MaterialMap, MaterialType, Mesh, Tri } from '../mesh';
import { StatusHandler } from '../status';
import { UV } from '../util';
import { Vector3 } from '../vector';
import { IImporter } from './base_importer';

export class GltfLoader extends IImporter {
    public override import(file: File): Promise<Mesh> {
        StatusHandler.warning(LOC('import.gltf_experimental'));

        return new Promise<Mesh>((resolve, reject) => {
            parse(file, GLTFLoader, { loadImages: true })
                .then((gltf: any) => {
                    resolve(this._handleGLTF(gltf));
                })
                .catch((err: any) => {
                    reject(err);
                });
        });
    }

    private _handleGLTF(gltf: any): Mesh {
        const meshVertices: Vector3[] = [];
        const meshNormals: Vector3[] = [];
        const meshTexcoords: UV[] = [];
        const meshTriangles: Tri[] = [];
        const meshMaterials: MaterialMap = new Map();

        meshMaterials.set('NONE', {
            type: MaterialType.solid,
            colour: RGBAUtil.copy(RGBAColours.WHITE),
            needsAttention: false,
            canBeTextured: false,
        });

        let materialIndex = 0; // New variable to create unique material identifiers

        Object.values(gltf.meshes).forEach((mesh: any) => {
            Object.values(mesh.primitives).forEach((primitive: any) => {
                const attributes = primitive.attributes;

                const vertexOffset = meshVertices.length;
                const normalOffset = meshNormals.length;
                const texcoordOffset = meshTexcoords.length;

                // Handling vertices
                if (attributes.POSITION !== undefined) {
                    const positions = attributes.POSITION.value as Float32Array;
                    for (let i = 0; i < positions.length; i += 3) {
                        meshVertices.push(new Vector3(
                            positions[i + 0],
                            positions[i + 1],
                            positions[i + 2],
                        ));
                    }
                }

                // Handling normals
                if (attributes.NORMAL !== undefined) {
                    const normals = attributes.NORMAL.value as Float32Array;
                    for (let i = 0; i < normals.length; i += 3) {
                        const nx = normals[i + 0];
                        const ny = normals[i + 1];
                        const nz = normals[i + 2];
                        const norm = new Vector3(nx, ny, nz);
                        if (norm.isNumber() && norm.magnitude() > 0.0001) {
                            norm.normalise();
                        } else {
                            norm.set(0, 1, 0);
                        }
                        meshNormals.push(norm);
                    }
                }

                // Handling texture coordinates
                if (attributes.TEXCOORD_0 !== undefined) {
                    const texcoords = attributes.TEXCOORD_0.value as Float32Array;
                    for (let i = 0; i < texcoords.length; i += 2) {
                        meshTexcoords.push(new UV(
                            texcoords[i + 0],
                            1.0 - texcoords[i + 1],
                        ));
                    }
                }

                // Material
                let materialBaseName = 'NONE';
                if (primitive.material) {
                    materialBaseName = primitive.material.name || 'Material';
                }

                const materialNameToUse = materialBaseName + '_' + materialIndex; // Unique material identifier
                materialIndex++; // Increment material index

                // Handling materials
                if (primitive.material) {
                    const pbr = primitive.material.pbrMetallicRoughness;
                    if (pbr !== undefined) {
                        const diffuseTexture = pbr.baseColorTexture;
                        let loadedTexture = false;

                        if (diffuseTexture !== undefined && diffuseTexture.texture !== undefined) {
                            const source = diffuseTexture.texture.source;
                            const imageData: Uint8Array | undefined =
                                source?.bufferView?.data ||
                                source?.image?.data ||
                                source?.data;

                            if (imageData && imageData.length > 0) {
                                let mimeType: string = source?.mimeType || '';
                                if (!mimeType) {
                                    if (imageData[0] === 0x89 && imageData[1] === 0x50 && imageData[2] === 0x4E && imageData[3] === 0x47) {
                                        mimeType = 'image/png';
                                    } else if (imageData[0] === 0xFF && imageData[1] === 0xD8 && imageData[2] === 0xFF) {
                                        mimeType = 'image/jpeg';
                                    }
                                }

                                if (mimeType === 'image/png' || mimeType === 'image/jpeg') {
                                    try {
                                        const base64 = Buffer.from(imageData).toString('base64');

                                        meshMaterials.set(materialNameToUse, {
                                            type: MaterialType.textured,
                                            diffuse: {
                                                filetype: mimeType === 'image/jpeg' ? 'jpg' : 'png',
                                                raw: (mimeType === 'image/jpeg' ? 'data:image/jpeg;base64,' : 'data:image/png;base64,') + base64,
                                            },
                                            extension: 'clamp',
                                            interpolation: 'linear',
                                            needsAttention: false,
                                            transparency: { type: 'None' },
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
                            const factor = pbr.baseColorFactor;
                            const solidColour = (Array.isArray(factor) && factor.length >= 3) ? {
                                r: Number.isFinite(factor[0]) ? factor[0] : 1,
                                g: Number.isFinite(factor[1]) ? factor[1] : 1,
                                b: Number.isFinite(factor[2]) ? factor[2] : 1,
                                a: (factor.length >= 4 && Number.isFinite(factor[3])) ? factor[3] : 1,
                            } : RGBAUtil.copy(RGBAColours.WHITE);

                            meshMaterials.set(materialNameToUse, {
                                type: MaterialType.solid,
                                colour: solidColour,
                                needsAttention: false,
                                canBeTextured: true,
                            });
                        }
                    }
                }

                // Indices
                const hasIndices = primitive.indices !== undefined && primitive.indices.value !== undefined;
                const positionCount = attributes.POSITION !== undefined ? (attributes.POSITION.value.length / 3) : 0;
                const indices: ArrayLike<number> = hasIndices ?
                    primitive.indices.value :
                    Array.from({ length: positionCount }, (_, k) => k);

                const hasTexcoords = attributes.TEXCOORD_0 !== undefined;
                const hasNormals = attributes.NORMAL !== undefined;

                for (let i = 0; i < Math.floor(indices.length / 3); ++i) {
                    const tri: Tri = {
                        material: materialNameToUse,
                        positionIndices: {
                            x: vertexOffset + indices[i * 3 + 0],
                            y: vertexOffset + indices[i * 3 + 1],
                            z: vertexOffset + indices[i * 3 + 2],
                        },
                    };
                    if (hasTexcoords) {
                        tri.texcoordIndices = {
                            x: texcoordOffset + indices[i * 3 + 0],
                            y: texcoordOffset + indices[i * 3 + 1],
                            z: texcoordOffset + indices[i * 3 + 2],
                        };
                    }
                    if (hasNormals) {
                        tri.normalIndices = {
                            x: normalOffset + indices[i * 3 + 0],
                            y: normalOffset + indices[i * 3 + 1],
                            z: normalOffset + indices[i * 3 + 2],
                        };
                    }
                    meshTriangles.push(tri);
                }
            });
        });

        return new Mesh(
            meshVertices,
            meshNormals,
            meshTexcoords,
            meshTriangles,
            meshMaterials,
        );
    }
}
