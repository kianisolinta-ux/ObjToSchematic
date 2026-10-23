import { PALETTE_ALL_RELEASE } from '../res/palettes/all';
import { BlockMesh } from './block_mesh';
import { AppConfig } from './config';
import { AppConstants } from './constants';
import { GeometryTemplates } from './geometry';
import { Mesh, SolidMaterial, TexturedMaterial } from './mesh';
import { OcclusionManager } from './occlusion';
import { ProgressManager } from './progress';
import { AttributeData } from './render_buffer';
import { AppUtil } from './util';
import { ASSERT } from './util/error_util';
import { Vector3 } from './vector';
import { VoxelMesh } from './voxel_mesh';
import { RenderNextVoxelMeshChunkParams } from './worker_types';

export type TMeshBuffer = {
    position: { numComponents: 3, data: Float32Array },
    texcoord: { numComponents: 2, data: Float32Array },
    normal: { numComponents: 3, data: Float32Array },
    indices: { numComponents: 3, data: Uint32Array },
};

export type TMeshBufferDescription = {
    material: SolidMaterial | (TexturedMaterial)
    buffer: TMeshBuffer,
    numElements: number,
    materialName: string,
};

export type TVoxelMeshBuffer = {
    position: { numComponents: 3, data: Float32Array, },
    colour: { numComponents: 4, data: Float32Array },
    occlusion: { numComponents: 4, data: Float32Array },
    texcoord: { numComponents: 2, data: Float32Array },
    normal: { numComponents: 3, data: Float32Array },
    indices: { numComponents: 3, data: Uint32Array },
};

export type TVoxelMeshBufferDescription = {
    buffer: TVoxelMeshBuffer,
    numElements: number,
}

export type TBlockMeshBuffer = {
    position: { numComponents: 3, data: Float32Array, },
    colour: { numComponents: 4, data: Float32Array },
    occlusion: { numComponents: 4, data: Float32Array },
    texcoord: { numComponents: 2, data: Float32Array },
    normal: { numComponents: 3, data: Float32Array },
    blockTexcoord: { numComponents: 2, data: Float32Array },
    blockPosition: { numComponents: 3, data: Float32Array, },
    blockTypeId: { numComponents: 1, data: Float32Array, },
    colourError: { numComponents: 1, data: Float32Array, },
    lighting: { numComponents: 1, data: Float32Array },
    indices: { numComponents: 3, data: Uint32Array },
};

export type TBlockMeshBufferDescription = {
    buffer: TBlockMeshBuffer,
    numElements: number,
}

// Shader varyings use mediump floats by default. Keep IDs small and exact so
// block selection does not depend on a GPU's precision for large hash values.
const BLOCK_TYPE_IDS = new Map<string, number>();
PALETTE_ALL_RELEASE.forEach((name, index) => BLOCK_TYPE_IDS.set(name, index + 1));

// Compare colours perceptually rather than by raw RGB distance. The input
// channels are sRGB values in the normalized [0, 1] range.
function rgbToLab(r: number, g: number, b: number): [number, number, number] {
    const toLinear = (channel: number) => channel <= 0.04045 ?
        channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4);
    const red = toLinear(r);
    const green = toLinear(g);
    const blue = toLinear(b);

    const x = (red * 0.4124 + green * 0.3576 + blue * 0.1805) / 0.95047;
    const y = red * 0.2126 + green * 0.7152 + blue * 0.0722;
    const z = (red * 0.0193 + green * 0.1192 + blue * 0.9505) / 1.08883;
    const pivot = (value: number) => value > 0.008856 ?
        Math.pow(value, 1 / 3) : 7.787 * value + 16 / 116;
    const fx = pivot(x);
    const fy = pivot(y);
    const fz = pivot(z);

    return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

function perceptualColourDifference(a: { r: number, g: number, b: number },
    b: { r: number, g: number, b: number }): number {
    const labA = rgbToLab(a.r, a.g, a.b);
    const labB = rgbToLab(b.r, b.g, b.b);
    const dl = labA[0] - labB[0];
    const da = labA[1] - labB[1];
    const db = labA[2] - labB[2];

    return Math.sqrt(dl * dl + da * da + db * db);
}

type TMaterialID = string;

export class ChunkedBufferGenerator {
    public static fromVoxelMesh(voxelMesh: VoxelMesh, params: RenderNextVoxelMeshChunkParams.Input, chunkIndex: number): TVoxelMeshBufferDescription & { moreVoxelsToBuffer: boolean, progress: number } {
        const numTotalVoxels = voxelMesh.getVoxelCount();
        const voxelsStartIndex = chunkIndex * AppConfig.Get.VOXEL_BUFFER_CHUNK_SIZE;
        const voxelsEndIndex = Math.min((chunkIndex + 1) * AppConfig.Get.VOXEL_BUFFER_CHUNK_SIZE, numTotalVoxels);
        ASSERT(voxelsStartIndex < numTotalVoxels, 'Invalid voxel start index');

        const numBufferVoxels = voxelsEndIndex - voxelsStartIndex;
        const newBuffer: TVoxelMeshBuffer = BufferGenerator.createVoxelMeshBuffer(numBufferVoxels);

        const cube: AttributeData = GeometryTemplates.getBoxBufferData(new Vector3(0, 0, 0));
        const voxels = voxelMesh.getVoxels();

        // Build position buffer
        for (let i = 0; i < numBufferVoxels; ++i) {
            const voxel = voxels[i + voxelsStartIndex];
            const voxelPositionArray = voxel.position.toArray();

            for (let j = 0; j < AppConstants.VoxelMeshBufferComponentOffsets.POSITION; ++j) {
                newBuffer.position.data[i * AppConstants.VoxelMeshBufferComponentOffsets.POSITION + j] = cube.custom.position[j] + voxelPositionArray[j % 3];
            }
        }

        // Build colour buffer
        for (let i = 0; i < numBufferVoxels; ++i) {
            const voxel = voxels[i + voxelsStartIndex];
            newBuffer.colour.data[i * 96 + 0] = voxel.colour.r;
            newBuffer.colour.data[i * 96 + 1] = voxel.colour.g;
            newBuffer.colour.data[i * 96 + 2] = voxel.colour.b;
            newBuffer.colour.data[i * 96 + 3] = voxel.colour.a;

            AppUtil.Array.repeatedFill(newBuffer.colour.data, i * 96, 4, 24);
        }

        // Build normal buffer
        {
            newBuffer.normal.data.set(cube.custom.normal, 0);
            AppUtil.Array.repeatedFill(newBuffer.normal.data, 0, 72, numBufferVoxels);
        }

        // Build texcoord buffer
        {
            newBuffer.texcoord.data.set(cube.custom.texcoord, 0);
            AppUtil.Array.repeatedFill(newBuffer.texcoord.data, 0, 48, numBufferVoxels);
        }


        // Build indices buffer
        for (let i = 0; i < numBufferVoxels; ++i) {
            for (let j = 0; j < AppConstants.VoxelMeshBufferComponentOffsets.INDICES; ++j) {
                newBuffer.indices.data[i * AppConstants.VoxelMeshBufferComponentOffsets.INDICES + j] = cube.indices[j] + (i * AppConstants.INDICES_PER_VOXEL);
            }
        }

        // Build occlusion buffer
        if (params.enableAmbientOcclusion) {
            const voxelOcclusionArray = new Float32Array(96);

            for (let i = 0; i < numBufferVoxels; ++i) {
                const voxel = voxels[i + voxelsStartIndex];
                OcclusionManager.Get.getOcclusions(voxelOcclusionArray, voxel.position, voxelMesh);

                newBuffer.occlusion.data.set(voxelOcclusionArray, i * AppConstants.VoxelMeshBufferComponentOffsets.OCCLUSION);
            }
        }

        return {
            buffer: newBuffer,
            numElements: newBuffer.indices.data.length,
            moreVoxelsToBuffer: voxelsEndIndex !== numTotalVoxels,
            progress: voxelsStartIndex / numTotalVoxels,
        };
    }

    public static fromBlockMesh(blockMesh: BlockMesh, chunkIndex: number): TBlockMeshBufferDescription & { moreBlocksToBuffer: boolean, progress: number } {
        const blocks = blockMesh.getBlocks();

        const lightingRamp = new Map<number, number>();
        lightingRamp.set(15, 40 / 40);
        lightingRamp.set(14, 40 / 40);
        lightingRamp.set(13, 39 / 40);
        lightingRamp.set(12, 37 / 40);
        lightingRamp.set(11, 35 / 40);
        lightingRamp.set(10, 32 / 40);
        lightingRamp.set(9, 29 / 40);
        lightingRamp.set(8, 26 / 40);
        lightingRamp.set(7, 23 / 40);
        lightingRamp.set(6, 20 / 40);
        lightingRamp.set(5, 17 / 40);
        lightingRamp.set(4, 14 / 40);
        lightingRamp.set(3, 12 / 40);
        lightingRamp.set(2, 9 / 40);
        lightingRamp.set(1, 7 / 40);
        lightingRamp.set(0, 5 / 40);

        const numTotalBlocks = blocks.length;
        const blocksStartIndex = chunkIndex * AppConfig.Get.VOXEL_BUFFER_CHUNK_SIZE;
        const blocksEndIndex = Math.min((chunkIndex + 1) * AppConfig.Get.VOXEL_BUFFER_CHUNK_SIZE, numTotalBlocks);
        ASSERT(blocksStartIndex < numTotalBlocks, 'Invalid block start index');

        const numBufferBlocks = blocksEndIndex - blocksStartIndex;

        const voxelChunkBuffer = blockMesh.getVoxelMesh().getChunkedBuffer(chunkIndex);
        const newBuffer = BufferGenerator.createBlockMeshBuffer(numBufferBlocks, voxelChunkBuffer.buffer);

        const faceOrder = ['north', 'south', 'up', 'down', 'east', 'west'];
        let insertIndex = 0;
        let lightingInsertIndex = 0;

        //const blockPositionArray = new Float32Array(3);
        for (let i = 0; i < numBufferBlocks; ++i) {
            const blockIndex = i + blocksStartIndex;
            const blockLighting = blockMesh.getBlockLighting(blocks[blockIndex].voxel.position);

            for (let f = 0; f < AppConstants.FACES_PER_VOXEL; ++f) {
                const faceName = faceOrder[f];
                const faceLighting = lightingRamp.get(blockLighting[f] ?? 15) ?? 1.0;

                const texcoord = blocks[blockIndex].blockInfo.faces[faceName].texcoord;
                for (let v = 0; v < AppConstants.VERTICES_PER_FACE; ++v) {
                    newBuffer.blockTexcoord.data[insertIndex++] = texcoord.u;
                    newBuffer.blockTexcoord.data[insertIndex++] = texcoord.v;

                    newBuffer.lighting.data[lightingInsertIndex++] = faceLighting;
                }
            }

            //const blockPosition = blocks[blockIndex].voxel.position.toArray();
            //blocks[blockIndex].voxel.position.intoArray(blockPositionArray, 0);

            newBuffer.blockPosition.data[i * 72 + 0] = blocks[blockIndex].voxel.position.x;
            newBuffer.blockPosition.data[i * 72 + 1] = blocks[blockIndex].voxel.position.y;
            newBuffer.blockPosition.data[i * 72 + 2] = blocks[blockIndex].voxel.position.z;
            AppUtil.Array.repeatedFill(newBuffer.blockPosition.data, i * 72, 3, 24);

            const blockTypeId = BufferGenerator.getBlockTypeId(blocks[blockIndex].blockInfo.name);
            newBuffer.blockTypeId.data.fill(blockTypeId, i * 24, (i + 1) * 24);

            // CIE76 Delta E is a better approximation of visible colour mismatch
            // than Euclidean RGB distance. Saturate the chart at Delta E 30 so
            // clearly wrong blocks cannot still appear reassuringly green.
            const voxelColour = blocks[blockIndex].voxel.colour;
            const blockColour = blocks[blockIndex].blockInfo.colour;
            const deltaE = perceptualColourDifference(voxelColour, blockColour);
            const colourError = Math.min(1, deltaE / 30);
            newBuffer.colourError.data.fill(colourError, i * 24, (i + 1) * 24);
        }

        return {
            buffer: newBuffer,
            numElements: newBuffer.indices.data.length,
            moreBlocksToBuffer: voxelChunkBuffer.moreVoxelsToBuffer,
            progress: voxelChunkBuffer.progress,
        };
    }
}

export class BufferGenerator {
    public static getBlockTypeId(name: string): number {
        const id = BLOCK_TYPE_IDS.get(name);
        ASSERT(id !== undefined, `Unknown block type ID: ${name}`);
        return id;
    }

    public static fromMesh(mesh: Mesh): TMeshBufferDescription[] {
        const numTris = mesh.getTriangleCount();

        // Count the number of triangles that use each material
        const materialTriangleCount = new Map<TMaterialID, number>();
        {
            for (let triIndex = 0; triIndex < numTris; ++triIndex) {
                const materialName = mesh.getMaterialByTriangle(triIndex);
                const triangleCount = materialTriangleCount.get(materialName) ?? 0;
                materialTriangleCount.set(materialName, triangleCount + 1);
            }
        }

        const materialBuffers: TMeshBufferDescription[] = [];

        let trianglesHandled = 0;
        const taskHandle = ProgressManager.Get.start('MeshBuffer');

        // Create the buffers for each material and fill with data from the triangles
        materialTriangleCount.forEach((triangleCount: number, materialName: string) => {
            const materialBuffer: TMeshBuffer = BufferGenerator.createMaterialBuffer(triangleCount);

            let insertIndex = 0;
            for (let triIndex = 0; triIndex < numTris; ++triIndex) {
                ProgressManager.Get.progress(taskHandle, trianglesHandled / numTris);

                const material = mesh.getMaterialByTriangle(triIndex);
                if (material === materialName) {
                    ++trianglesHandled;

                    const uiTriangle = mesh.getUVTriangle(triIndex);

                    // Position
                    {
                        materialBuffer.position.data.set(uiTriangle.v0.toArray(), insertIndex * 9 + 0);
                        materialBuffer.position.data.set(uiTriangle.v1.toArray(), insertIndex * 9 + 3);
                        materialBuffer.position.data.set(uiTriangle.v2.toArray(), insertIndex * 9 + 6);
                    }

                    // Texcoord
                    {
                        materialBuffer.texcoord.data.set([uiTriangle.uv0.u, uiTriangle.uv0.v], insertIndex * 6 + 0);
                        materialBuffer.texcoord.data.set([uiTriangle.uv1.u, uiTriangle.uv1.v], insertIndex * 6 + 2);
                        materialBuffer.texcoord.data.set([uiTriangle.uv2.u, uiTriangle.uv2.v], insertIndex * 6 + 4);
                    }

                    // Normal
                    {
                        materialBuffer.normal.data.set(uiTriangle.n0.toArray(), insertIndex * 9 + 0);
                        materialBuffer.normal.data.set(uiTriangle.n1.toArray(), insertIndex * 9 + 3);
                        materialBuffer.normal.data.set(uiTriangle.n2.toArray(), insertIndex * 9 + 6);
                    }

                    // Indices
                    {
                        materialBuffer.indices.data.set([
                            insertIndex * 3 + 0,
                            insertIndex * 3 + 1,
                            insertIndex * 3 + 2,
                        ], insertIndex * 3);
                    }

                    ++insertIndex;
                }
            }

            const material = mesh.getMaterialByName(materialName);
            ASSERT(material !== undefined);

            materialBuffers.push({
                buffer: materialBuffer,
                material: material,
                numElements: materialBuffer.indices.data.length,
                materialName: materialName,
            });
        });

        ProgressManager.Get.end(taskHandle);

        return materialBuffers;
    }

    /*
    public static fromVoxelMesh(voxelMesh: VoxelMesh, params: RenderVoxelMeshParams.Input): TVoxelMeshBufferDescription {
        const numVoxels = voxelMesh.getVoxelCount();
        const newBuffer: TVoxelMeshBuffer = this.createVoxelMeshBuffer(numVoxels);

        const cube: AttributeData = GeometryTemplates.getBoxBufferData(new Vector3(0, 0, 0));
        const voxels = voxelMesh.getVoxels();

        const taskHandle = ProgressManager.Get.start('VoxelMeshBuffer');
        for (let i = 0; i < numVoxels; ++i) {
            ProgressManager.Get.progress(taskHandle, i / numVoxels);

            const voxel = voxels[i];
            const voxelColourArray = [voxel.colour.r, voxel.colour.g, voxel.colour.b, voxel.colour.a];
            const voxelPositionArray = voxel.position.toArray();

            for (let j = 0; j < AppConstants.VoxelMeshBufferComponentOffsets.POSITION; ++j) {
                newBuffer.position.data[i * AppConstants.VoxelMeshBufferComponentOffsets.POSITION + j] = cube.custom.position[j] + voxelPositionArray[j % 3];
            }

            for (let j = 0; j < AppConstants.VoxelMeshBufferComponentOffsets.COLOUR; ++j) {
                newBuffer.colour.data[i * AppConstants.VoxelMeshBufferComponentOffsets.COLOUR + j] = voxelColourArray[j % 4];
            }

            for (let j = 0; j < AppConstants.VoxelMeshBufferComponentOffsets.NORMAL; ++j) {
                newBuffer.normal.data[i * AppConstants.VoxelMeshBufferComponentOffsets.NORMAL + j] = cube.custom.normal[j];
            }

            for (let j = 0; j < AppConstants.VoxelMeshBufferComponentOffsets.TEXCOORD; ++j) {
                newBuffer.texcoord.data[i * AppConstants.VoxelMeshBufferComponentOffsets.TEXCOORD + j] = cube.custom.texcoord[j];
            }

            for (let j = 0; j < AppConstants.VoxelMeshBufferComponentOffsets.INDICES; ++j) {
                newBuffer.indices.data[i * AppConstants.VoxelMeshBufferComponentOffsets.INDICES + j] = cube.indices[j] + (i * AppConstants.INDICES_PER_VOXEL);
            }

            if (params.enableAmbientOcclusion) {
                const voxelOcclusionArray = OcclusionManager.Get.getOcclusions(voxel.position, voxelMesh);
                for (let j = 0; j < AppConstants.VoxelMeshBufferComponentOffsets.OCCLUSION; ++j) {
                    newBuffer.occlusion.data[i * AppConstants.VoxelMeshBufferComponentOffsets.OCCLUSION + j] = voxelOcclusionArray[j];
                }
            }
        }
        ProgressManager.Get.end(taskHandle);

        return {
            buffer: newBuffer,
            numElements: newBuffer.indices.data.length,
        };
    }
    */

    /*
    public static fromBlockMesh(blockMesh: BlockMesh): TBlockMeshBufferDescription {
        const blocks = blockMesh.getBlocks();
        const numBlocks = blocks.length;

        const newBuffer = this.createBlockMeshBuffer(numBlocks, blockMesh.getVoxelMesh().getBuffer().buffer);

        const faceOrder = ['north', 'south', 'up', 'down', 'east', 'west'];
        let insertIndex = 0;

        const taskHandle = ProgressManager.Get.start('BlockMeshBuffer');
        for (let i = 0; i < numBlocks; ++i) {
            ProgressManager.Get.progress(taskHandle, i / numBlocks);

            for (let f = 0; f < AppConstants.FACES_PER_VOXEL; ++f) {
                const faceName = faceOrder[f];
                const texcoord = blocks[i].blockInfo.faces[faceName].texcoord;
                for (let v = 0; v < AppConstants.VERTICES_PER_FACE; ++v) {
                    newBuffer.blockTexcoord.data[insertIndex++] = texcoord.u;
                    newBuffer.blockTexcoord.data[insertIndex++] = texcoord.v;
                }
            }
        }
        ProgressManager.Get.end(taskHandle);

        return {
            buffer: newBuffer,
            numElements: newBuffer.indices.data.length,
        };
    }
    */

    public static createMaterialBuffer(triangleCount: number): TMeshBuffer {
        return {
            position: {
                numComponents: 3,
                data: new Float32Array(triangleCount * 3 * 3),
            },
            texcoord: {
                numComponents: 2,
                data: new Float32Array(triangleCount * 3 * 2),
            },
            normal: {
                numComponents: 3,
                data: new Float32Array(triangleCount * 3 * 3),
            },
            indices: {
                numComponents: 3,
                data: new Uint32Array(triangleCount * 3),
            },
        };
    }

    public static createVoxelMeshBuffer(numVoxels: number): TVoxelMeshBuffer {
        return {
            position: {
                numComponents: 3,
                data: new Float32Array(numVoxels * AppConstants.VoxelMeshBufferComponentOffsets.POSITION),
            },
            colour: {
                numComponents: 4,
                data: new Float32Array(numVoxels * AppConstants.VoxelMeshBufferComponentOffsets.COLOUR),
            },
            occlusion: {
                numComponents: 4,
                data: new Float32Array(numVoxels * AppConstants.VoxelMeshBufferComponentOffsets.OCCLUSION).fill(1.0),
            },
            texcoord: {
                numComponents: 2,
                data: new Float32Array(numVoxels * AppConstants.VoxelMeshBufferComponentOffsets.TEXCOORD),
            },
            normal: {
                numComponents: 3,
                data: new Float32Array(numVoxels * AppConstants.VoxelMeshBufferComponentOffsets.NORMAL),
            },
            indices: {
                numComponents: 3,
                data: new Uint32Array(numVoxels * AppConstants.VoxelMeshBufferComponentOffsets.INDICES),
            },
        };
    }

    public static createBlockMeshBuffer(numBlocks: number, voxelMeshBuffer: TVoxelMeshBuffer): TBlockMeshBuffer {
        return {
            position: {
                numComponents: AppConstants.ComponentSize.POSITION,
                data: voxelMeshBuffer.position.data,
            },
            colour: {
                numComponents: AppConstants.ComponentSize.COLOUR,
                data: voxelMeshBuffer.colour.data,
            },
            occlusion: {
                numComponents: AppConstants.ComponentSize.OCCLUSION,
                data: voxelMeshBuffer.occlusion.data,
            },
            texcoord: {
                numComponents: AppConstants.ComponentSize.TEXCOORD,
                data: voxelMeshBuffer.texcoord.data,
            },
            normal: {
                numComponents: AppConstants.ComponentSize.NORMAL,
                data: voxelMeshBuffer.normal.data,
            },
            indices: {
                numComponents: AppConstants.ComponentSize.INDICES,
                data: voxelMeshBuffer.indices.data,
            },
            blockTexcoord: {
                numComponents: AppConstants.ComponentSize.TEXCOORD,
                data: new Float32Array(numBlocks * AppConstants.VoxelMeshBufferComponentOffsets.TEXCOORD),
            },
            blockPosition: {
                numComponents: AppConstants.ComponentSize.POSITION,
                data: new Float32Array(numBlocks * AppConstants.VoxelMeshBufferComponentOffsets.POSITION),
            },
            blockTypeId: {
                numComponents: 1,
                data: new Float32Array(numBlocks * 24),
            },
            colourError: {
                numComponents: 1,
                data: new Float32Array(numBlocks * 24),
            },
            lighting: {
                numComponents: AppConstants.ComponentSize.LIGHTING,
                data: new Float32Array(numBlocks * AppConstants.VoxelMeshBufferComponentOffsets.LIGHTING),
            },
        };
    }
}
