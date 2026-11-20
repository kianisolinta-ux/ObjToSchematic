import { NBT, TagType } from 'prismarine-nbt';

import { BlockMesh } from '../block_mesh';
import { AppConstants } from '../constants';
import { ceilToNearest } from '../math';
import { AppTypes, AppUtil } from '../util';
import { ASSERT } from '../util/error_util';
import { saveNBT } from '../util/nbt_util';
import { Vector3 } from '../vector';
import { IExporter, TStructureExport } from './base_exporter';
import { computeLitematicRegionPosition, TLitematicAnchor } from './litematic_anchor';
import {
    rotateBlockNameFacingY,
    rotateBoundsSizeY,
    rotateLocalBlockCoordY,
    TLitematicRotationY,
} from './litematic_transform';

type BlockID = number;
type long = [number, number];
type BlockMapping = Map<AppTypes.TNamespacedBlockName, BlockID>;

export interface LitematicExportOptions {
    name?: string;
    author?: string;
    description?: string;
    regionName?: string;
    timestampMs?: number;
    anchor?: TLitematicAnchor;
    rotationY?: TLitematicRotationY;
}

export class Litematic extends IExporter {
    public override getFormatFilter() {
        return {
            name: 'Litematic',
            extension: 'litematic',
        };
    }

    public override export(blockMesh: BlockMesh, options?: LitematicExportOptions): TStructureExport {
        const nbt = this._convertToNBT(blockMesh, options);
        return { type: 'single', extension: '.litematic', content: saveNBT(nbt) };
    }

    /**
     * Create a mapping from block names to their respecitve index in the block state palette.
     */
    private _createBlockMapping(blockMesh: BlockMesh, rotationY: TLitematicRotationY): BlockMapping {
        const blockMapping: BlockMapping = new Map();
        blockMapping.set('minecraft:air', 0);

        for (const block of blockMesh.getBlocks()) {
            const rawNamespaced = AppUtil.Text.namespaceBlock(block.blockInfo.name);
            const namespaced = rotateBlockNameFacingY(rawNamespaced, rotationY);
            if (!blockMapping.has(namespaced)) {
                blockMapping.set(namespaced, blockMapping.size);
            }
            if (rotationY === 0 && !blockMapping.has(block.blockInfo.name)) {
                blockMapping.set(block.blockInfo.name, blockMapping.get(namespaced)!);
            }
        }

        return blockMapping;
    }

    /**
     * Pack the blocks into a buffer that's the dimensions of the block mesh.
     */
    private _createBlockBuffer(blockMesh: BlockMesh, blockMapping: BlockMapping, rotationY: TLitematicRotationY): Uint32Array {
        const bounds = blockMesh.getBounds();
        const rawSize = Vector3.sub(bounds.max, bounds.min).add(1);
        const rotSize = rotateBoundsSizeY(rawSize, rotationY);

        const buffer = new Uint32Array(rotSize.x * rotSize.y * rotSize.z);

        blockMesh.getBlocks().forEach((block) => {
            const indexVector = Vector3.sub(block.voxel.position, bounds.min);
            const rotatedCoord = rotateLocalBlockCoordY(indexVector.x, indexVector.y, indexVector.z, rawSize, rotationY);
            const bufferIndex = (rotSize.z * rotSize.x * rotatedCoord.y) + (rotSize.x * rotatedCoord.z) + rotatedCoord.x; // XZY ordering

            const rawNamespaced = AppUtil.Text.namespaceBlock(block.blockInfo.name);
            const namespaced = rotateBlockNameFacingY(rawNamespaced, rotationY);
            let mappingIndex = blockMapping.get(namespaced) ?? blockMapping.get(block.blockInfo.name);
            if (mappingIndex === undefined) {
                mappingIndex = blockMapping.size;
                blockMapping.set(namespaced, mappingIndex);
            }

            buffer[bufferIndex] = mappingIndex;
        });

        return buffer;
    }

    private _createBlockStates(blockMesh: BlockMesh, blockMapping: BlockMapping, rotationY: TLitematicRotationY) {
        const buffer = this._encodeBlockBuffer(blockMesh, blockMapping, rotationY);

        const numBytes = buffer.length;
        const numBits = numBytes * 8;

        const blockStates = new Array<long>(Math.ceil(numBits / 64));

        let index = 0;
        for (let i = numBits; i > 0; i -= 64) {
            const rightBaseIndexBit = i - 32;
            const rightBaseIndexByte = rightBaseIndexBit / 8;

            let right = 0;
            right = (right << 8) + buffer[rightBaseIndexByte + 0];
            right = (right << 8) + buffer[rightBaseIndexByte + 1];
            right = (right << 8) + buffer[rightBaseIndexByte + 2];
            right = (right << 8) + buffer[rightBaseIndexByte + 3];

            const leftBaseIndexBit = i - 64;
            const leftBaseIndexByte = leftBaseIndexBit / 8;

            let left = 0;
            left = (left << 8) + buffer[leftBaseIndexByte + 0];
            left = (left << 8) + buffer[leftBaseIndexByte + 1];
            left = (left << 8) + buffer[leftBaseIndexByte + 2];
            left = (left << 8) + buffer[leftBaseIndexByte + 3];

            blockStates[index++] = [left, right];
        }

        return blockStates;
    }

    private _encodeBlockBuffer(blockMesh: BlockMesh, blockMapping: BlockMapping, rotationY: TLitematicRotationY) {
        const blockBuffer = this._createBlockBuffer(blockMesh, blockMapping, rotationY);

        const paletteSize = blockMapping.size;
        const stride = Math.max(2, Math.ceil(Math.log2(paletteSize)));
        ASSERT(stride >= 1, `Stride too small: ${stride}`);

        const expectedLengthBits = blockBuffer.length * stride;
        const requiredLengthBits = ceilToNearest(expectedLengthBits, 64);
        const startOffsetBits = requiredLengthBits - expectedLengthBits;

        const requiredLengthBytes = requiredLengthBits / 8;
        const buffer = Buffer.alloc(requiredLengthBytes);

        // Write first few offset bits
        const fullBytesToWrite = Math.floor(startOffsetBits / 8);
        for (let i = 0; i < fullBytesToWrite; ++i) {
            buffer[i] = 0;
        }

        const remainingBitsToWrite = startOffsetBits - (fullBytesToWrite * 8);
        let currentByte = 0;
        let bitsWrittenToByte = remainingBitsToWrite;
        let nextBufferWriteIndex = fullBytesToWrite;

        for (let i = blockBuffer.length - 1; i >= 0; --i) {
            for (let j = 0; j < stride; ++j) {
                if (bitsWrittenToByte === 8) {
                    buffer[nextBufferWriteIndex] = currentByte;
                    ++nextBufferWriteIndex;
                    currentByte = 0; // Shouldn't be actually necessary to reset
                    bitsWrittenToByte = 0;
                }

                const bitToAddToByte = (blockBuffer[i] >> (stride - j - 1)) & 1;
                currentByte = (currentByte << 1) + bitToAddToByte;
                ++bitsWrittenToByte;
            }
        }

        // Write remaining partially filled byte
        buffer[nextBufferWriteIndex] = currentByte;
        ++nextBufferWriteIndex;
        currentByte = 0; // Shouldn't be actually necessary to reset
        bitsWrittenToByte = 0;

        return buffer;
    }

    private _createBlockStatePalette(blockMapping: BlockMapping) {
        const indexToName = new Map<number, string>();
        blockMapping.forEach((index, blockName) => {
            if (!indexToName.has(index)) {
                indexToName.set(index, AppUtil.Text.namespaceBlock(blockName));
            }
        });

        const blockStatePalette = new Array(indexToName.size);
        indexToName.forEach((blockName, index) => {
            const bracketIdx = blockName.indexOf('[');
            if (bracketIdx !== -1) {
                const rawName = blockName.substring(0, bracketIdx);
                const rawProps = blockName.substring(bracketIdx + 1, blockName.length - 1);
                const propsCompound: any = {};
                rawProps.split(',').forEach((pair) => {
                    const [k, v] = pair.split('=');
                    if (k && v) {
                        propsCompound[k.trim()] = {
                            type: TagType.String,
                            value: v.trim(),
                        };
                    }
                });
                blockStatePalette[index] = {
                    Name: { type: TagType.String, value: AppUtil.Text.namespaceBlock(rawName) },
                    Properties: { type: TagType.Compound, value: propsCompound },
                };
            } else {
                blockStatePalette[index] = { Name: { type: TagType.String, value: blockName } };
            }
        });
        blockStatePalette[0] = { Name: { type: TagType.String, value: 'minecraft:air' } };

        return blockStatePalette;
    }

    private static _toNbtLong(ms: number): long {
        const safeMs = Math.max(0, Math.floor(ms));
        const high = Math.floor(safeMs / 4294967296);
        const low = safeMs - high * 4294967296;
        // NBT longs are signed 32-bit pairs in prismarine-nbt
        return [high | 0, low | 0];
    }

    private _convertToNBT(blockMesh: BlockMesh, options?: LitematicExportOptions) {
        const rotationY: TLitematicRotationY = options?.rotationY ?? 0;
        const bounds = blockMesh.getBounds();
        const rawSizeVector = Vector3.sub(bounds.max, bounds.min).add(1);
        const rotSize = rotateBoundsSizeY(rawSizeVector, rotationY);
        const sizeVector = new Vector3(rotSize.x, rotSize.y, rotSize.z);

        const bufferSize = sizeVector.x * sizeVector.y * sizeVector.z;
        const blockMapping = this._createBlockMapping(blockMesh, rotationY);

        const blockStates = this._createBlockStates(blockMesh, blockMapping, rotationY);
        const blockStatePalette = this._createBlockStatePalette(blockMapping);
        const numBlocks = blockMesh.getBlocks().length;

        const cleanName = (options?.name ?? '').trim();
        const regionKey = (options?.regionName ?? cleanName).trim() || 'Unnamed';
        const author = (options?.author ?? (cleanName ? 'ObjToSchematic' : '')).trim();
        const description = (
            options?.description ??
            (cleanName ? `${sizeVector.x}x${sizeVector.y}x${sizeVector.z}, ${numBlocks} blocks` : '')
        ).trim();
        const ts: long = options?.timestampMs !== undefined ?
            Litematic._toNbtLong(options.timestampMs) :
            (cleanName ? Litematic._toNbtLong(Date.now()) : [0, 0]);
        const regionPos = computeLitematicRegionPosition(sizeVector, options?.anchor ?? 'min-corner');

        const nbt: NBT = {
            type: TagType.Compound,
            name: 'Litematic',
            value: {
                Metadata: {
                    type: TagType.Compound, value: {
                        Author: { type: TagType.String, value: author },
                        Description: { type: TagType.String, value: description },
                        Size: {
                            type: TagType.Compound, value: {
                                x: { type: TagType.Int, value: sizeVector.x },
                                y: { type: TagType.Int, value: sizeVector.y },
                                z: { type: TagType.Int, value: sizeVector.z },
                            },
                        },
                        Name: { type: TagType.String, value: cleanName },
                        RegionCount: { type: TagType.Int, value: 1 },
                        TimeCreated: { type: TagType.Long, value: ts },
                        TimeModified: { type: TagType.Long, value: ts },
                        TotalBlocks: { type: TagType.Int, value: numBlocks },
                        TotalVolume: { type: TagType.Int, value: bufferSize },
                    },
                },
                Regions: {
                    type: TagType.Compound,
                    value: {
                        [regionKey]: {
                            type: TagType.Compound,
                            value: {
                                BlockStates: { type: TagType.LongArray, value: blockStates },
                                PendingBlockTicks: { type: TagType.List, value: { type: TagType.Int, value: [] } },
                                Position: {
                                    type: TagType.Compound, value: {
                                        x: { type: TagType.Int, value: regionPos.x },
                                        y: { type: TagType.Int, value: regionPos.y },
                                        z: { type: TagType.Int, value: regionPos.z },
                                    },
                                },
                                BlockStatePalette: { type: TagType.List, value: { type: TagType.Compound, value: blockStatePalette } },
                                Size: {
                                    type: TagType.Compound, value: {
                                        x: { type: TagType.Int, value: sizeVector.x },
                                        y: { type: TagType.Int, value: sizeVector.y },
                                        z: { type: TagType.Int, value: sizeVector.z },
                                    },
                                },
                                PendingFluidTicks: { type: TagType.List, value: { type: TagType.Int, value: [] } },
                                TileEntities: { type: TagType.List, value: { type: TagType.Int, value: [] } },
                                Entities: { type: TagType.List, value: { type: TagType.Int, value: [] } },
                            },
                        },
                    },
                },
                MinecraftDataVersion: { type: TagType.Int, value: AppConstants.DATA_VERSION },
                Version: { type: TagType.Int, value: 5 },
            },
        };

        return nbt;
    }
}
