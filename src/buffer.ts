import { PALETTE_ALL_RELEASE } from '../res/palettes/all';
import { BlockMesh } from './block_mesh';
import { RGBAUtil } from './colour';
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
    wireframeIndices?: Uint32Array,
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

        const voxelChunkBuffer = (chunkIndex * AppConfig.Get.VOXEL_BUFFER_CHUNK_SIZE < blockMesh.getVoxelMesh().getVoxelCount()) ?
            blockMesh.getVoxelMesh().getChunkedBuffer(chunkIndex) :
            undefined;
        const requiredPositionComponents = numBufferBlocks * AppConstants.VoxelMeshBufferComponentOffsets.POSITION;
        const requiredColourComponents = numBufferBlocks * AppConstants.VoxelMeshBufferComponentOffsets.COLOUR;
        const requiredOcclusionComponents = numBufferBlocks * AppConstants.VoxelMeshBufferComponentOffsets.OCCLUSION;
        const requiredTexcoordComponents = numBufferBlocks * AppConstants.VoxelMeshBufferComponentOffsets.TEXCOORD;
        const requiredNormalComponents = numBufferBlocks * AppConstants.VoxelMeshBufferComponentOffsets.NORMAL;
        const requiredIndexComponents = numBufferBlocks * AppConstants.VoxelMeshBufferComponentOffsets.INDICES;
        const sourceGeometry = voxelChunkBuffer?.buffer;
        const canReuseVoxelGeometry = sourceGeometry !== undefined &&
            sourceGeometry.position.data.length >= requiredPositionComponents &&
            sourceGeometry.colour.data.length >= requiredColourComponents &&
            sourceGeometry.occlusion.data.length >= requiredOcclusionComponents &&
            sourceGeometry.texcoord.data.length >= requiredTexcoordComponents &&
            sourceGeometry.normal.data.length >= requiredNormalComponents &&
            sourceGeometry.indices.data.length >= requiredIndexComponents;
        const newBuffer = BufferGenerator.createBlockMeshBuffer(numBufferBlocks, sourceGeometry);

        if (!canReuseVoxelGeometry) {
            const cube = GeometryTemplates.getBoxBufferData(new Vector3(0, 0, 0));
            for (let i = 0; i < numBufferBlocks; ++i) {
                const block = blocks[blocksStartIndex + i];
                const blockPos = block.voxel.position;
                const name = block.blockInfo.name;
                const wallFacing = name.startsWith('minecraft:wall_torch[facing=') ?
                    name.substring('minecraft:wall_torch[facing='.length, name.length - 1) : undefined;
                const isFloorTorch = name === 'minecraft:torch';
                const isWallTorch = wallFacing === 'north' || wallFacing === 'south' ||
                    wallFacing === 'east' || wallFacing === 'west';

                if (!isFloorTorch && !isWallTorch) {
                    for (let j = 0; j < 72; j += 3) {
                        const target = i * 72 + j;
                        newBuffer.position.data[target + 0] = cube.custom.position[j + 0] + blockPos.x;
                        newBuffer.position.data[target + 1] = cube.custom.position[j + 1] + blockPos.y;
                        newBuffer.position.data[target + 2] = cube.custom.position[j + 2] + blockPos.z;
                    }
                    continue;
                }

                let axisX = 0;
                let axisY = 1;
                let axisZ = 0;
                let acrossX = 1;
                let acrossY = 0;
                let acrossZ = 0;
                const stemLength = 0.7;
                const stemWidth = 0.09;
                let centreX = blockPos.x;
                let centreY = blockPos.y - 0.5 + stemLength / 2;
                let centreZ = blockPos.z;

                if (isWallTorch) {
                    let outwardX = 0;
                    let outwardZ = 0;
                    if (wallFacing === 'north') outwardZ = -1;
                    if (wallFacing === 'south') outwardZ = 1;
                    if (wallFacing === 'east') outwardX = 1;
                    if (wallFacing === 'west') outwardX = -1;

                    axisX = outwardX * 0.32;
                    axisY = Math.sqrt(1 - 0.32 * 0.32);
                    axisZ = outwardZ * 0.32;
                    acrossX = -outwardZ;
                    acrossZ = outwardX;
                    centreX = blockPos.x - outwardX * 0.46 + axisX * (stemLength / 2);
                    centreY = blockPos.y - 0.5 + axisY * (stemLength / 2);
                    centreZ = blockPos.z - outwardZ * 0.46 + axisZ * (stemLength / 2);
                }

                // The third basis vector completes the rotated local coordinate frame.
                const depthX = acrossY * axisZ - acrossZ * axisY;
                const depthY = acrossZ * axisX - acrossX * axisZ;
                const depthZ = acrossX * axisY - acrossY * axisX;

                for (let j = 0; j < 72; j += 3) {
                    const target = i * 72 + j;
                    const localX = cube.custom.position[j + 0];
                    const localY = cube.custom.position[j + 1];
                    const localZ = cube.custom.position[j + 2];

                    newBuffer.position.data[target + 0] = centreX +
                        acrossX * localX * stemWidth + axisX * localY * stemLength + depthX * localZ * stemWidth;
                    newBuffer.position.data[target + 1] = centreY +
                        axisY * localY * stemLength + depthY * localZ * stemWidth;
                    newBuffer.position.data[target + 2] = centreZ +
                        acrossZ * localX * stemWidth + axisZ * localY * stemLength + depthZ * localZ * stemWidth;

                    const normalX = cube.custom.normal[j + 0];
                    const normalY = cube.custom.normal[j + 1];
                    const normalZ = cube.custom.normal[j + 2];
                    newBuffer.normal.data[target + 0] = acrossX * normalX + axisX * normalY + depthX * normalZ;
                    newBuffer.normal.data[target + 1] = axisY * normalY + depthY * normalZ;
                    newBuffer.normal.data[target + 2] = acrossZ * normalX + axisZ * normalY + depthZ * normalZ;
                }
            }
        }

        const faceOrder = ['north', 'south', 'up', 'down', 'east', 'west'];
        let insertIndex = 0;
        let lightingInsertIndex = 0;
        let colourErrorInsertIndex = 0;

        //const blockPositionArray = new Float32Array(3);
        for (let i = 0; i < numBufferBlocks; ++i) {
            const blockIndex = i + blocksStartIndex;
            const blockLighting = blockMesh.getBlockLighting(blocks[blockIndex].voxel.position);
            const voxelColour = blocks[blockIndex].voxel.colour;
            const blockData = blocks[blockIndex].blockInfo;

            for (let f = 0; f < AppConstants.FACES_PER_VOXEL; ++f) {
                const faceName = faceOrder[f];
                const faceLighting = lightingRamp.get(blockLighting[f] ?? 15) ?? 1.0;

                const faceInfo = blockData.faces[faceName];
                const texcoord = faceInfo.texcoord;
                for (let v = 0; v < AppConstants.VERTICES_PER_FACE; ++v) {
                    newBuffer.blockTexcoord.data[insertIndex++] = texcoord.u;
                    newBuffer.blockTexcoord.data[insertIndex++] = texcoord.v;

                    newBuffer.lighting.data[lightingInsertIndex++] = faceLighting;
                }
                const faceColour = (faceInfo as any)?.colour ?? blockData.colour;
                const deltaE = RGBAUtil.perceptualDistance(voxelColour, faceColour);
                // Minecraft palettes have a discrete gamut. A typical close match in Minecraft (like green concrete,
                // emerald block, lime wool, etc.) has a CIELAB Delta E between 10 and 25.
                // A normalizer of Delta E 65 ensures close matches map to green/lime-green (0.0 .. 0.35),
                // fair compromises map to yellow/amber, and only severe mismatches saturate to red (> 0.85).
                const faceColourError = Math.min(1.0, deltaE / 65.0);
                for (let v = 0; v < AppConstants.VERTICES_PER_FACE; ++v) {
                    newBuffer.colourError.data[colourErrorInsertIndex++] = faceColourError;
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
        }

        return {
            buffer: newBuffer,
            numElements: newBuffer.indices.data.length,
            moreBlocksToBuffer: blocksEndIndex !== numTotalBlocks,
            progress: blocksEndIndex / numTotalBlocks,
        };
    }
}

export class BufferGenerator {
    public static getBlockTypeId(name: string): number {
        let id = BLOCK_TYPE_IDS.get(name);
        if (id === undefined) {
            id = BLOCK_TYPE_IDS.size + 1;
            BLOCK_TYPE_IDS.set(name, id);
        }
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
            const wireframeLines: number[] = [];

            let insertIndex = 0;
            for (let triIndex = 0; triIndex < numTris; ++triIndex) {
                ProgressManager.Get.progress(taskHandle, trianglesHandled / numTris);

                const material = mesh.getMaterialByTriangle(triIndex);
                if (material === materialName) {
                    ++trianglesHandled;

                    const uiTriangle = mesh.getUVTriangle(triIndex);
                    const tri = mesh._tris[triIndex];

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

                    // Wireframe lines: exclude hidden interior diagonal edges of quad faces
                    const v0 = insertIndex * 3 + 0;
                    const v1 = insertIndex * 3 + 1;
                    const v2 = insertIndex * 3 + 2;

                    if (!tri || tri.hiddenEdge !== 'xy') {
                        wireframeLines.push(v0, v1);
                    }
                    if (!tri || tri.hiddenEdge !== 'yz') {
                        wireframeLines.push(v1, v2);
                    }
                    if (!tri || tri.hiddenEdge !== 'zx') {
                        wireframeLines.push(v2, v0);
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
                wireframeIndices: new Uint32Array(wireframeLines),
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

    public static createBlockMeshBuffer(numBlocks: number, voxelMeshBuffer?: TVoxelMeshBuffer): TBlockMeshBuffer {
        const requiredPositions = numBlocks * AppConstants.VoxelMeshBufferComponentOffsets.POSITION;
        const requiredIndices = numBlocks * AppConstants.VoxelMeshBufferComponentOffsets.INDICES;

        let position = voxelMeshBuffer?.position.data;
        let colour = voxelMeshBuffer?.colour.data;
        let occlusion = voxelMeshBuffer?.occlusion.data;
        let texcoord = voxelMeshBuffer?.texcoord.data;
        let normal = voxelMeshBuffer?.normal.data;
        let indices = voxelMeshBuffer?.indices.data;

        if (!position || position.length < requiredPositions || !indices || indices.length < requiredIndices || !colour || !occlusion || !texcoord || !normal) {
            const cube: AttributeData = GeometryTemplates.getBoxBufferData(new Vector3(0, 0, 0));
            position = new Float32Array(requiredPositions);
            colour = new Float32Array(numBlocks * AppConstants.VoxelMeshBufferComponentOffsets.COLOUR);
            occlusion = new Float32Array(numBlocks * AppConstants.VoxelMeshBufferComponentOffsets.OCCLUSION).fill(1.0);
            texcoord = new Float32Array(numBlocks * AppConstants.VoxelMeshBufferComponentOffsets.TEXCOORD);
            normal = new Float32Array(numBlocks * AppConstants.VoxelMeshBufferComponentOffsets.NORMAL);
            indices = new Uint32Array(requiredIndices);

            for (let i = 0; i < numBlocks; ++i) {
                for (let j = 0; j < 72; ++j) {
                    position[i * 72 + j] = cube.custom.position[j];
                    normal[i * 72 + j] = cube.custom.normal[j];
                }
                for (let j = 0; j < 48; ++j) {
                    texcoord[i * 48 + j] = cube.custom.texcoord[j];
                }
                for (let j = 0; j < 36; ++j) {
                    indices[i * 36 + j] = cube.indices[j] + (i * AppConstants.INDICES_PER_VOXEL);
                }
                for (let j = 0; j < 96; ++j) {
                    colour[i * 96 + j] = 1.0;
                }
            }
        }

        return {
            position: {
                numComponents: AppConstants.ComponentSize.POSITION,
                data: position,
            },
            colour: {
                numComponents: AppConstants.ComponentSize.COLOUR,
                data: colour,
            },
            occlusion: {
                numComponents: AppConstants.ComponentSize.OCCLUSION,
                data: occlusion,
            },
            texcoord: {
                numComponents: AppConstants.ComponentSize.TEXCOORD,
                data: texcoord,
            },
            normal: {
                numComponents: AppConstants.ComponentSize.NORMAL,
                data: normal,
            },
            indices: {
                numComponents: AppConstants.ComponentSize.INDICES,
                data: indices,
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
