import { PALETTE_ALL_RELEASE } from '../res/palettes/all';
import { Atlas } from './atlas';
import { AtlasPalette, EFaceVisibility, TBlockCollection } from './block_assigner';
import { BlockInfo } from './block_atlas';
import { Bounds } from './bounds';
import { ChunkedBufferGenerator, TBlockMeshBufferDescription } from './buffer';
import { RGBA, RGBA_255, RGBAUtil } from './colour';
import { ciede2000Distance, computeLuminanceStretchParams, PaletteLuminanceRemap, remapVoxelLuminance, selectSpatialCoherentCandidate } from './colour_algorithms';
import { AppRuntimeConstants } from './constants';
import { Ditherer } from './dither';
import { BlockMeshLighting } from './lighting';
import { LOC } from './localiser';
import { Palette } from './palette';
import { ProgressManager } from './progress';
import { canReplaceInFilterPass, computeEdgeAwareDiffusionFactor, pickBestRetainedBlock, selectRetainedBlockNamesForCap } from './smart_replace';
import { StatusHandler } from './status';
import { AppUtil, ColourSpace, TOptional } from './util';
import { ASSERT } from './util/error_util';
import { LOGF } from './util/log_util';
import { TBlockSelectionAlgorithm } from './util/type_util';
import { Vector3 } from './vector';
import { Voxel, VoxelMesh } from './voxel_mesh';
import { AssignParams, ReplaceBlockParams, TReplaceScope } from './worker_types';

interface Block {
    voxel: Voxel;
    blockInfo: BlockInfo;
}

interface GrassLikeBlock {
    hash: number;
    voxelColour: RGBA_255;
    errWeight: number;
    faceVisibility: EFaceVisibility;
}

export type FallableBehaviour = 'replace-falling' | 'replace-fallable' | 'place-string' | 'do-nothing';

export interface BlockMeshParams {
    textureAtlas: Atlas,
    blockPalette: Palette,
    colourSpace: ColourSpace,
    fallable: FallableBehaviour,
}

export class BlockMesh {
    private _blocksUsed: Set<string>;
    private _blocks: Map<number, Block>;
    //private _blocks: Block[];
    private _voxelMesh: VoxelMesh;
    private _atlas: Atlas;
    private _lighting: BlockMeshLighting;
    private _undoHistory: Array<Map<number, BlockInfo>> = [];
    private _luminanceRemap: PaletteLuminanceRemap | null = null;

    public static createFromVoxelMesh(voxelMesh: VoxelMesh, blockMeshParams: AssignParams.Input) {
        const blockMesh = new BlockMesh(voxelMesh);
        blockMesh._assignBlocks(blockMeshParams);

        //blockMesh._calculateLighting(blockMeshParams.lightThreshold);
        if (blockMeshParams.calculateLighting) {
            blockMesh._lighting.init();
            blockMesh._lighting.addSunLightValues();
            blockMesh._lighting.addEmissiveBlocks();
            blockMesh._lighting.addLightToDarkness(
                blockMeshParams.lightThreshold,
                blockMeshParams.lightingPlacement,
                blockMeshParams.lightingScope,
                blockMeshParams.lightingLightBlock,
            );
            blockMesh._lighting.dumpInfo();
        }

        return blockMesh;
    }

    private constructor(voxelMesh: VoxelMesh) {
        this._blocksUsed = new Set();
        this._blocks = new Map();
        this._voxelMesh = voxelMesh;
        this._atlas = Atlas.getVanillaAtlas()!;
        this._lighting = new BlockMeshLighting(this);
        this._undoHistory = [];
    }

    private _getAdjustedVoxelColour(voxel: Voxel, blockMeshParams: AssignParams.Input): RGBA {
        const b = blockMeshParams.brightnessOffset ?? 0;
        const s = blockMeshParams.saturationOffset ?? 0;
        const adjusted = (b === 0 && s === 0) ?
            RGBAUtil.copy(voxel.colour) :
            RGBAUtil.adjustColour(voxel.colour, b, s);
        if (this._luminanceRemap !== null) {
            return remapVoxelLuminance(adjusted, this._luminanceRemap);
        }
        return adjusted;
    }

    /**
     * Before we turn a voxel into a block we have the opportunity to alter the voxel's colour.
     * This is where the colour accuracy bands colours together and where dithering is calculated.
     */
    private _getFinalVoxelColour(voxel: Voxel, blockMeshParams: AssignParams.Input) {
        const voxelColour = this._getAdjustedVoxelColour(voxel, blockMeshParams);

        const binnedColour = RGBAUtil.bin(voxelColour, blockMeshParams.resolution);

        const ditheredColour: RGBA_255 = RGBAUtil.copy255(binnedColour);
        switch (blockMeshParams.dithering) {
            case 'off':
            case 'error-diffusion': {
                break;
            }
            case 'random': {
                Ditherer.ditherRandom(ditheredColour, blockMeshParams.ditheringMagnitude);
                break;
            }
            case 'ordered': {
                Ditherer.ditherOrdered(ditheredColour, voxel.position, blockMeshParams.ditheringMagnitude);
                break;
            }
        }

        return ditheredColour;
    }

    private _assignDichromeBlocks(
        blockMeshParams: AssignParams.Input,
        orderedBlocks: BlockInfo[],
    ) {
        ASSERT(orderedBlocks.length >= 2, 'Dichrome requires at least two blocks');
        const voxels = this._voxelMesh.getVoxels();
        const bOffset = blockMeshParams.brightnessOffset ?? 0;
        const getTone = (voxel: Voxel): number => {
            if (bOffset === 0) {
                return voxel.dichromeValue;
            }
            const adj = RGBAUtil.adjustColour(voxel.colour, bOffset, 0);
            return Math.max(0.0, Math.min(1.0, RGBAUtil.toLab(adj)[0] / 100.0));
        };

        let minTone = Infinity;
        let maxTone = -Infinity;
        for (const voxel of voxels) {
            const tone = getTone(voxel);
            minTone = Math.min(minTone, tone);
            maxTone = Math.max(maxTone, tone);
        }
        const thresholds = BlockMesh._getDichromeThresholds(
            minTone,
            maxTone,
            blockMeshParams.dichromeToneBias ?? 0,
            orderedBlocks.length,
        );
        const taskHandle = ProgressManager.Get.start('Assigning');

        this._blocks.clear();
        this._blocksUsed.clear();

        for (let voxelIndex = 0; voxelIndex < voxels.length; ++voxelIndex) {
            ProgressManager.Get.progress(taskHandle, voxelIndex / Math.max(1, voxels.length));
            const voxel = voxels[voxelIndex];
            const tone = getTone(voxel);

            // In order of increasing tone, assign the first matching bucket
            let blockIndex = orderedBlocks.length - 1;
            for (let t = 0; t < thresholds.length; ++t) {
                if (tone < thresholds[t]) {
                    blockIndex = t;
                    break;
                }
            }
            const blockInfo = orderedBlocks[blockIndex];

            this._blocks.set(voxel.position.hash(), {
                voxel: voxel,
                blockInfo: blockInfo,
            });
            this._blocksUsed.add(blockInfo.name);
        }

        ProgressManager.Get.end(taskHandle);
    }

    private static _getDichromeThresholds(
        minTone: number,
        maxTone: number,
        toneBias: number | { x: number, y: number } | { percentages: number[] } | undefined,
        numBlocks: number,
    ): number[] {
        ASSERT(numBlocks >= 2, 'Dichrome requires at least two blocks');
        const range = Math.max(0, maxTone - minTone);
        const endpointPadding = Math.max(range * 1e-6, 1e-9);

        // Check for radial / per-tone distribution configuration
        if (typeof toneBias === 'object' && toneBias !== null && 'percentages' in toneBias && Array.isArray((toneBias as any).percentages)) {
            const rawPercentages = (toneBias as any).percentages as number[];
            const fractions: number[] = [];
            let total = 0;
            for (let i = 0; i < numBlocks; ++i) {
                const p = Math.max(0, rawPercentages[i] ?? (100 / numBlocks));
                fractions.push(p);
                total += p;
            }
            if (total <= 0) total = 1;

            const thresholds: number[] = [];
            let cumulative = 0;
            for (let i = 0; i < numBlocks - 1; ++i) {
                cumulative += fractions[i] / total;
                const clamped = Math.max(0, Math.min(1, cumulative));
                thresholds.push(minTone - endpointPadding + clamped * (range + 2 * endpointPadding));
            }
            return thresholds;
        }

        let biasX = 0;
        let biasY = 0;
        if (typeof toneBias === 'number') {
            biasX = toneBias;
        } else if (typeof toneBias === 'object' && toneBias !== null) {
            biasX = typeof (toneBias as any).x === 'number' ? (toneBias as any).x : 0;
            biasY = typeof (toneBias as any).y === 'number' ? (toneBias as any).y : 0;
        }

        const biasNormX = Math.max(-1, Math.min(1, biasX / 100));
        const biasNormY = Math.max(-1, Math.min(1, biasY / 100));
        // Gamma curve for contrast / midtone spread:
        // Y > 0: contrasts extremes (thresholds pull toward center 0.5)
        // Y < 0: expands midtones (thresholds push toward 0 and 1)
        const gamma = Math.pow(2.0, -biasNormY);

        const thresholds: number[] = [];
        for (let i = 1; i < numBlocks; ++i) {
            const base = i / numBlocks;
            // 1. Shift by horizontal bias
            const s0 = biasNormX >= 0 ?
                base + (1 - base) * biasNormX :
                base * (1 + biasNormX);
            const clamped0 = Math.max(0, Math.min(1, s0));

            // 2. Modulate by vertical curve (gamma curve centered at 0.5)
            let s: number;
            if (clamped0 <= 0) {
                s = 0;
            } else if (clamped0 >= 1) {
                s = 1;
            } else if (biasNormY === 0) {
                s = clamped0;
            } else if (clamped0 < 0.5) {
                s = 0.5 * Math.pow(2.0 * clamped0, gamma);
            } else {
                s = 1.0 - 0.5 * Math.pow(2.0 * (1.0 - clamped0), gamma);
            }

            const clamped = Math.max(0, Math.min(1, s));
            thresholds.push(minTone - endpointPadding + clamped * (range + 2 * endpointPadding));
        }
        return thresholds;
    }

    private static _getDichromeThreshold(
        minTone: number,
        maxTone: number,
        toneBias: number | { x: number, y: number } | undefined,
    ): number {
        return BlockMesh._getDichromeThresholds(minTone, maxTone, toneBias, 2)[0];
    }

    private static _getDichromeBlockPair(blocks: BlockInfo[]): { darkBlock: BlockInfo, lightBlock: BlockInfo } {
        ASSERT(blocks.length >= 2, 'Dichrome requires at least two selected palette blocks');
        return { darkBlock: blocks[0], lightBlock: blocks[blocks.length - 1] };
    }

    private _assignBlocks(blockMeshParams: AssignParams.Input) {
        const atlas = Atlas.load(
            blockMeshParams.blockSelectionAlgorithm === 'dichrome' ?
                'vanilla' :
                blockMeshParams.textureAtlas,
        );
        ASSERT(atlas !== undefined, 'Could not load atlas');
        this._atlas = atlas;

        if (blockMeshParams.blockSelectionAlgorithm === 'dichrome') {
            ASSERT(blockMeshParams.blockPalette.length >= 2, 'Dichrome requires at least two selected palette blocks');
            const selectedBlocks = blockMeshParams.blockPalette.map((blockName) => {
                const namespacedBlock = AppUtil.Text.namespaceBlock(blockName);
                const block = atlas.getBlocks().get(namespacedBlock);
                ASSERT(block !== undefined, `Dichrome block is unavailable in the texture atlas: ${namespacedBlock}`);
                return block as BlockInfo;
            });
            this._assignDichromeBlocks(blockMeshParams, selectedBlocks);
            return;
        }

        const palette = Palette.create();
        if (blockMeshParams.blockPalette.length === 0) {
            palette.add(PALETTE_ALL_RELEASE);
        } else {
            palette.add(blockMeshParams.blockPalette);
        }
        ASSERT(palette !== undefined, 'Could not load palette');

        const atlasPalette = new AtlasPalette(atlas, palette);
        const allBlockCollection = atlasPalette.createBlockCollection([]);
        const nonFallableBlockCollection = atlasPalette.createBlockCollection(Array.from(AppRuntimeConstants.Get.FALLABLE_BLOCKS));
        const voxels = this._voxelMesh.getVoxels();

        this._luminanceRemap = null;
        if (blockMeshParams.blockSelectionAlgorithm === 'palette-quantized') {
            const b = blockMeshParams.brightnessOffset ?? 0;
            const s = blockMeshParams.saturationOffset ?? 0;
            const rawColours = voxels.map((v) =>
                (b === 0 && s === 0) ? v.colour : RGBAUtil.adjustColour(v.colour, b, s),
            );
            const paletteColours = Array.from(allBlockCollection.blocks.values()).map((blk) => blk.colour);
            this._luminanceRemap = computeLuminanceStretchParams(rawColours, paletteColours, 0.65);
        }

        let countFalling = 0;
        const taskHandle = ProgressManager.Get.start('Assigning');
        const useErrorDiffusion = blockMeshParams.dithering === 'error-diffusion';

        const orderedVoxels = useErrorDiffusion ?
            voxels.slice().sort((a, b) => {
                if (a.position.y !== b.position.y) return a.position.y - b.position.y;
                if (a.position.z !== b.position.z) return a.position.z - b.position.z;
                const serpentine = ((a.position.y + a.position.z) & 1) === 0 ? 1 : -1;
                return (a.position.x - b.position.x) * serpentine;
            }) :
            voxels;

        const diffusionErrors = useErrorDiffusion ? new Map<number, [number, number, number]>() : undefined;
        const diffusionStrength = Math.max(0, Math.min(1, (blockMeshParams.ditheringMagnitude ?? 32) / 64));

        const applyErrorDiffusion = (voxel: Voxel, baseColour: RGBA_255, faceVisibility: EFaceVisibility): { block: BlockInfo; targetColour: RGBA_255 } => {
            const hash = voxel.position.hash();
            const targetColour = RGBAUtil.copy255(baseColour);
            const accErr = diffusionErrors?.get(hash);
            if (accErr) {
                targetColour.r = Math.round(Math.max(0, Math.min(255, targetColour.r + accErr[0])));
                targetColour.g = Math.round(Math.max(0, Math.min(255, targetColour.g + accErr[1])));
                targetColour.b = Math.round(Math.max(0, Math.min(255, targetColour.b + accErr[2])));
                diffusionErrors!.delete(hash);
            }

            let chosen = atlasPalette.getBlock(
                targetColour,
                allBlockCollection,
                faceVisibility,
                blockMeshParams.errorWeight,
                blockMeshParams.blockSelectionAlgorithm,
            );

            const isBlockFallable = AppRuntimeConstants.Get.FALLABLE_BLOCKS.has(chosen.name);
            const isBlockSupported = this._voxelMesh.isVoxelAt(Vector3.add(voxel.position, new Vector3(0, -1, 0)));
            const shouldReplaceBlock =
                (blockMeshParams.fallable === 'replace-fallable' && isBlockFallable) ||
                (blockMeshParams.fallable === 'replace-falling' && isBlockFallable && !isBlockSupported);
            if (shouldReplaceBlock) {
                chosen = atlasPalette.getBlock(
                    targetColour,
                    nonFallableBlockCollection,
                    faceVisibility,
                    blockMeshParams.errorWeight,
                    blockMeshParams.blockSelectionAlgorithm,
                );
            }

            const matchedColour = blockMeshParams.contextualAveraging ?
                AtlasPalette.getContextualFaceColour(chosen, faceVisibility) :
                chosen.colour;
            const errR = Math.max(-48, Math.min(48, (targetColour.r - matchedColour.r * 255) * diffusionStrength));
            const errG = Math.max(-48, Math.min(48, (targetColour.g - matchedColour.g * 255) * diffusionStrength));
            const errB = Math.max(-48, Math.min(48, (targetColour.b - matchedColour.b * 255) * diffusionStrength));
            const baseFloatColour = RGBAUtil.fromRGBA255(baseColour);

            const dirX = ((voxel.position.y + voxel.position.z) & 1) === 0 ? 1 : -1;
            const pushErr = (nx: number, ny: number, nz: number, weight: number) => {
                const nPos = new Vector3(nx, ny, nz);
                const nVoxel = this._voxelMesh.getVoxelAt(nPos);
                if (!nVoxel) {
                    return;
                }
                const nFloatColour = (blockMeshParams.brightnessOffset || blockMeshParams.saturationOffset) ?
                    this._getAdjustedVoxelColour(nVoxel, blockMeshParams) :
                    nVoxel.colour;
                const edgeFactor = computeEdgeAwareDiffusionFactor(baseFloatColour, nFloatColour);
                const scaledWeight = weight * edgeFactor;
                const nHash = nPos.hash();
                const prev = diffusionErrors!.get(nHash) ?? [0, 0, 0];
                diffusionErrors!.set(nHash, [
                    Math.max(-48, Math.min(48, prev[0] + errR * scaledWeight)),
                    Math.max(-48, Math.min(48, prev[1] + errG * scaledWeight)),
                    Math.max(-48, Math.min(48, prev[2] + errB * scaledWeight)),
                ]);
            };

            pushErr(voxel.position.x + dirX, voxel.position.y, voxel.position.z, 7 / 16);
            pushErr(voxel.position.x, voxel.position.y, voxel.position.z + 1, 5 / 16);
            pushErr(voxel.position.x, voxel.position.y + 1, voxel.position.z, 4 / 16);

            return { block: chosen, targetColour };
        };

        if (blockMeshParams.blockFilter) {
            // STEP 1: Filter phase (clean initial model first before dithering)
            for (let voxelIndex = 0; voxelIndex < voxels.length; ++voxelIndex) {
                ProgressManager.Get.progress(taskHandle, (voxelIndex / voxels.length) * 0.4);
                const voxel = voxels[voxelIndex];
                const voxelColour = this._getAdjustedVoxelColour(voxel, blockMeshParams);
                const binnedColour = RGBAUtil.bin(voxelColour, blockMeshParams.resolution);
                const baseColour255: RGBA_255 = RGBAUtil.copy255(binnedColour);
                const faceVisibility = blockMeshParams.contextualAveraging ?
                    this._voxelMesh.getFaceVisibility(voxel.position) :
                    VoxelMesh.getFullFaceVisibility();
                const block = atlasPalette.getBlock(baseColour255, allBlockCollection, faceVisibility, blockMeshParams.errorWeight, blockMeshParams.blockSelectionAlgorithm);

                this._blocks.set(voxel.position.hash(), {
                    voxel: voxel,
                    blockInfo: block,
                });
                this._blocksUsed.add(block.name);
            }

            // Apply spatial filter on the initial un-dithered model to consolidate similar shades and accentuate contours
            this._filterSimilarBlocks(
                blockMeshParams.blockSelectionAlgorithm,
                blockMeshParams.blockFilterThreshold,
                blockMeshParams.fallable,
            );

            // STEP 2: Dithering and remaining parameters layered on top of the filtered result
            const grassLikeBlocksBuffer: GrassLikeBlock[] = [];
            this._blocksUsed.clear();

            for (let voxelIndex = 0; voxelIndex < orderedVoxels.length; ++voxelIndex) {
                ProgressManager.Get.progress(taskHandle, 0.4 + (voxelIndex / orderedVoxels.length) * 0.6);
                const voxel = orderedVoxels[voxelIndex];
                const hash = voxel.position.hash();
                const currentBlock = this._blocks.get(hash);
                ASSERT(currentBlock !== undefined);

                let finalBlock = currentBlock.blockInfo;
                const faceVisibility = blockMeshParams.contextualAveraging ?
                    this._voxelMesh.getFaceVisibility(voxel.position) :
                    VoxelMesh.getFullFaceVisibility();

                const step2BaseColour = blockMeshParams.contextualAveraging ?
                    AtlasPalette.getContextualFaceColour(finalBlock, faceVisibility) :
                    finalBlock.colour;
                let finalColour = RGBAUtil.toRGBA255(step2BaseColour);
                if (useErrorDiffusion) {
                    const diffused = applyErrorDiffusion(voxel, finalColour, faceVisibility);
                    finalBlock = diffused.block;
                    finalColour = diffused.targetColour;
                } else if (blockMeshParams.dithering !== 'off') {
                    if (blockMeshParams.dithering === 'random') {
                        Ditherer.ditherRandom(finalColour, blockMeshParams.ditheringMagnitude);
                    } else if (blockMeshParams.dithering === 'ordered') {
                        Ditherer.ditherOrdered(finalColour, voxel.position, blockMeshParams.ditheringMagnitude);
                    }
                    finalBlock = atlasPalette.getBlock(
                        finalColour,
                        allBlockCollection,
                        faceVisibility,
                        blockMeshParams.errorWeight,
                        blockMeshParams.blockSelectionAlgorithm,
                    );
                }

                const isBlockFallable = AppRuntimeConstants.Get.FALLABLE_BLOCKS.has(finalBlock.name);
                const isBlockSupported = this._voxelMesh.isVoxelAt(Vector3.add(voxel.position, new Vector3(0, -1, 0)));

                if (isBlockFallable && !isBlockSupported) {
                    ++countFalling;
                }

                const shouldReplaceBlock =
                    (blockMeshParams.fallable === 'replace-fallable' && isBlockFallable) ||
                    (blockMeshParams.fallable === 'replace-falling' && isBlockFallable && !isBlockSupported);

                if (!useErrorDiffusion && shouldReplaceBlock) {
                    finalBlock = atlasPalette.getBlock(
                        finalColour,
                        nonFallableBlockCollection,
                        faceVisibility,
                        blockMeshParams.errorWeight,
                        blockMeshParams.blockSelectionAlgorithm,
                    );
                }

                if (AppRuntimeConstants.Get.GRASS_LIKE_BLOCKS.has(finalBlock.name)) {
                    grassLikeBlocksBuffer.push({
                        hash: hash,
                        voxelColour: finalColour,
                        errWeight: blockMeshParams.errorWeight,
                        faceVisibility: faceVisibility,
                    });
                }

                currentBlock.blockInfo = finalBlock;
                this._blocksUsed.add(finalBlock.name);
            }

            if (grassLikeBlocksBuffer.length > 0) {
                const nonGrassLikeBlockCollection = atlasPalette.createBlockCollection(Array.from(AppRuntimeConstants.Get.GRASS_LIKE_BLOCKS));
                for (let index = 0; index < grassLikeBlocksBuffer.length; index++) {
                    const examined = grassLikeBlocksBuffer[index];
                    const examinedBlock = this._blocks.get(examined.hash);
                    ASSERT(examinedBlock, 'Missing examined block');

                    const topBlockPosition = Vector3.add(examinedBlock.voxel.position, new Vector3(0, 1, 0));
                    const topBlock = this._blocks.get(topBlockPosition.hash());
                    if (topBlock !== undefined) {
                        if (!AppRuntimeConstants.Get.TRANSPARENT_BLOCKS.has(topBlock.blockInfo.name)) {
                            const block = atlasPalette.getBlock(
                                examined.voxelColour,
                                nonGrassLikeBlockCollection,
                                examined.faceVisibility,
                                examined.errWeight,
                                blockMeshParams.blockSelectionAlgorithm,
                            );
                            examinedBlock.blockInfo = block;
                            this._blocks.set(examined.hash, examinedBlock);
                            this._blocksUsed.add(block.name);
                        }
                    }
                }
            }
        } else {
            // Standard assignment without filter
            const grassLikeBlocksBuffer: GrassLikeBlock[] = [];
            for (let voxelIndex = 0; voxelIndex < orderedVoxels.length; ++voxelIndex) {
                ProgressManager.Get.progress(taskHandle, voxelIndex / orderedVoxels.length);

                const voxel = orderedVoxels[voxelIndex];
                const faceVisibility = blockMeshParams.contextualAveraging ?
                    this._voxelMesh.getFaceVisibility(voxel.position) :
                    VoxelMesh.getFullFaceVisibility();

                let voxelColour: RGBA_255;
                let block: BlockInfo;
                if (useErrorDiffusion) {
                    const base = RGBAUtil.copy255(RGBAUtil.bin(this._getAdjustedVoxelColour(voxel, blockMeshParams), blockMeshParams.resolution));
                    const diffused = applyErrorDiffusion(voxel, base, faceVisibility);
                    block = diffused.block;
                    voxelColour = diffused.targetColour;
                } else {
                    voxelColour = this._getFinalVoxelColour(voxel, blockMeshParams);
                    block = atlasPalette.getBlock(voxelColour, allBlockCollection, faceVisibility, blockMeshParams.errorWeight, blockMeshParams.blockSelectionAlgorithm);
                }

                const isBlockFallable = AppRuntimeConstants.Get.FALLABLE_BLOCKS.has(block.name);
                const isBlockSupported = this._voxelMesh.isVoxelAt(Vector3.add(voxel.position, new Vector3(0, -1, 0)));

                if (isBlockFallable && !isBlockSupported) {
                    ++countFalling;
                }

                const shouldReplaceBlock =
                    (blockMeshParams.fallable === 'replace-fallable' && isBlockFallable) ||
                    (blockMeshParams.fallable === 'replace-falling' && isBlockFallable && !isBlockSupported);

                if (!useErrorDiffusion && shouldReplaceBlock) {
                    block = atlasPalette.getBlock(voxelColour, nonFallableBlockCollection, faceVisibility, blockMeshParams.errorWeight, blockMeshParams.blockSelectionAlgorithm);
                }

                if (AppRuntimeConstants.Get.GRASS_LIKE_BLOCKS.has(block.name)) {
                    grassLikeBlocksBuffer.push({
                        hash: voxel.position.hash(),
                        voxelColour: voxelColour,
                        errWeight: blockMeshParams.errorWeight,
                        faceVisibility: faceVisibility,
                    });
                }

                this._blocks.set(voxel.position.hash(), {
                    voxel: voxel,
                    blockInfo: block,
                });
                this._blocksUsed.add(block.name);
            }

            if (grassLikeBlocksBuffer.length > 0) {
                const nonGrassLikeBlockCollection = atlasPalette.createBlockCollection(Array.from(AppRuntimeConstants.Get.GRASS_LIKE_BLOCKS));
                for (let index = 0; index < grassLikeBlocksBuffer.length; index++) {
                    ProgressManager.Get.progress(taskHandle, index / grassLikeBlocksBuffer.length);
                    const examined = grassLikeBlocksBuffer[index];
                    const examinedBlock = this._blocks.get(examined.hash);
                    ASSERT(examinedBlock, 'Missing examined block');

                    const topBlockPosition = Vector3.add(examinedBlock.voxel.position, new Vector3(0, 1, 0));
                    const topBlock = this._blocks.get(topBlockPosition.hash());
                    if (topBlock !== undefined) {
                        if (!AppRuntimeConstants.Get.TRANSPARENT_BLOCKS.has(topBlock.blockInfo.name)) {
                            const block = atlasPalette.getBlock(
                                examined.voxelColour,
                                nonGrassLikeBlockCollection,
                                examined.faceVisibility,
                                examined.errWeight,
                                blockMeshParams.blockSelectionAlgorithm,
                            );
                            examinedBlock.blockInfo = block;
                            this._blocks.set(examined.hash, examinedBlock);
                            this._blocksUsed.add(block.name);
                        }
                    }
                }
            }
        }
        ProgressManager.Get.end(taskHandle);

        if (blockMeshParams.blockSelectionAlgorithm === 'spatial-coherent') {
            this._refineSpatiallyCoherent(
                atlasPalette,
                allBlockCollection,
                nonFallableBlockCollection,
                blockMeshParams,
            );
        }

        if (blockMeshParams.blockSelectionAlgorithm === 'character-statue') {
            const pruneResult = this._pruneRareOutlierBlocks(blockMeshParams.fallable, blockMeshParams);
            if (pruneResult.prunedTypes > 0) {
                StatusHandler.info(LOC('assign.pruned_rare_blocks', {
                    types: pruneResult.prunedTypes,
                    blocks: pruneResult.prunedBlocks,
                }));
            }
        }

        const maxTypes = blockMeshParams.maxBlockTypes ?? 0;
        if (maxTypes >= 2) {
            const capResult = this._capMaxBlockTypes(maxTypes, blockMeshParams.fallable, blockMeshParams);
            if (capResult.reducedTypes > 0) {
                StatusHandler.info(LOC('assign.capped_block_types', {
                    cap: capResult.keptTypes,
                    merged: capResult.replacedBlocks,
                    removed: capResult.reducedTypes,
                }));
            }
        }

        if (blockMeshParams.fallable === 'do-nothing' && countFalling > 0) {
            StatusHandler.warning(LOC('assign.falling_blocks', { count: countFalling }));
        }
    }

    private _capMaxBlockTypes(
        maxTypes: number,
        fallable: FallableBehaviour,
        blockMeshParams: AssignParams.Input,
    ): { keptTypes: number; reducedTypes: number; replacedBlocks: number } {
        const counts = new Map<string, number>();
        const sampleInfos = new Map<string, BlockInfo>();
        const sampleColours = new Map<string, RGBA>();

        this._blocks.forEach((b) => {
            const name = b.blockInfo.name;
            counts.set(name, (counts.get(name) ?? 0) + 1);
            if (!sampleInfos.has(name)) {
                sampleInfos.set(name, b.blockInfo);
                sampleColours.set(name, b.blockInfo.colour);
            }
        });

        if (counts.size <= maxTypes) {
            return { keptTypes: counts.size, reducedTypes: 0, replacedBlocks: 0 };
        }

        const retainedNames = selectRetainedBlockNamesForCap(counts, sampleColours, maxTypes);
        const retainedInfos: BlockInfo[] = [];
        retainedNames.forEach((name) => {
            const info = sampleInfos.get(name);
            if (info) retainedInfos.push(info);
        });
        if (retainedInfos.length === 0) {
            return { keptTypes: counts.size, reducedTypes: 0, replacedBlocks: 0 };
        }

        const nonFallableRetained = retainedInfos.filter((b) => !AppRuntimeConstants.Get.FALLABLE_BLOCKS.has(b.name));
        const offsets = [
            new Vector3(1, 0, 0), new Vector3(-1, 0, 0),
            new Vector3(0, 1, 0), new Vector3(0, -1, 0),
            new Vector3(0, 0, 1), new Vector3(0, 0, -1),
        ];

        let replacedBlocks = 0;
        this._blocks.forEach((entry) => {
            if (retainedNames.has(entry.blockInfo.name)) {
                return;
            }

            const pos = entry.voxel.position;
            const neighborCounts = new Map<string, number>();
            for (const offset of offsets) {
                const neighbor = this._blocks.get(Vector3.add(pos, offset).hash());
                if (neighbor && retainedNames.has(neighbor.blockInfo.name)) {
                    const nName = neighbor.blockInfo.name;
                    neighborCounts.set(nName, (neighborCounts.get(nName) ?? 0) + 1);
                }
            }

            let candidatePool = retainedInfos;
            if (nonFallableRetained.length > 0) {
                if (fallable === 'replace-fallable') {
                    candidatePool = nonFallableRetained;
                } else if (fallable === 'replace-falling' && !this._voxelMesh.isVoxelAt(Vector3.add(pos, new Vector3(0, -1, 0)))) {
                    candidatePool = nonFallableRetained;
                }
            }

            const adjusted = this._getAdjustedVoxelColour(entry.voxel, blockMeshParams);
            entry.blockInfo = pickBestRetainedBlock(adjusted, candidatePool, neighborCounts);
            ++replacedBlocks;
        });

        this._blocksUsed.clear();
        this._blocks.forEach((b) => {
            this._blocksUsed.add(b.blockInfo.name);
        });

        return {
            keptTypes: this._blocksUsed.size,
            reducedTypes: Math.max(0, counts.size - this._blocksUsed.size),
            replacedBlocks,
        };
    }

    /**
     * Consolidates rare outlier block types that appear in insignificant quantities into
     * the dominant blocks in the model. This is critical for character statues and survival builds
     * where players do not want to hunt down/craft a block type for just a handful of voxels.
     */
    public _pruneRareOutlierBlocks(
        fallable: FallableBehaviour,
        blockMeshParams?: Pick<AssignParams.Input, 'brightnessOffset' | 'saturationOffset'>,
    ): { prunedTypes: number, prunedBlocks: number } {
        if (this._blocks.size === 0) {
            return { prunedTypes: 0, prunedBlocks: 0 };
        }

        const totalVoxels = this._blocks.size;

        // 1. Calculate frequency histogram of block types
        const blockCounts = new Map<string, number>();
        const blockSample = new Map<string, BlockInfo>();

        this._blocks.forEach((b) => {
            const name = b.blockInfo.name;
            blockCounts.set(name, (blockCounts.get(name) ?? 0) + 1);
            if (!blockSample.has(name)) {
                blockSample.set(name, b.blockInfo);
            }
        });

        const uniqueBlockCount = blockCounts.size;
        if (uniqueBlockCount <= 1) {
            // Only one block type in the model
            return { prunedTypes: 0, prunedBlocks: 0 };
        }

        // 2. Determine outlier threshold
        // Insignificant blocks: count < threshold
        // Adaptive threshold: min 3 blocks, up to ~0.8% of model or max 30 blocks.
        const minThreshold = totalVoxels < 100 ? 2 :
            Math.max(4, Math.min(30, Math.ceil(totalVoxels * 0.008)));

        // Sort blocks by count descending
        const sortedBlocks = Array.from(blockCounts.entries()).sort((a, b) => b[1] - a[1]);

        // Dominant blocks: the primary blocks that make up the main body of the statue.
        // Always protect at least the top block, and all blocks with count >= minThreshold.
        const dominantBlockNames = new Set<string>();
        for (let i = 0; i < sortedBlocks.length; ++i) {
            const [name, count] = sortedBlocks[i];
            if (i === 0 || count >= minThreshold) {
                dominantBlockNames.add(name);
            }
        }

        // Outlier block types to prune
        const outlierBlockNames = new Set<string>();
        sortedBlocks.forEach(([name]) => {
            if (!dominantBlockNames.has(name)) {
                outlierBlockNames.add(name);
            }
        });

        if (outlierBlockNames.size === 0) {
            return { prunedTypes: 0, prunedBlocks: 0 };
        }

        // Precompute candidate dominant block infos
        const dominantInfos: BlockInfo[] = [];
        dominantBlockNames.forEach((name) => {
            const info = blockSample.get(name);
            if (info) dominantInfos.push(info);
        });

        if (dominantInfos.length === 0) {
            return { prunedTypes: 0, prunedBlocks: 0 };
        }

        const nonFallableDominant = dominantInfos.filter((b) => !AppRuntimeConstants.Get.FALLABLE_BLOCKS.has(b.name));

        let prunedBlocksCount = 0;
        const offsets = [
            new Vector3(1, 0, 0), new Vector3(-1, 0, 0),
            new Vector3(0, 1, 0), new Vector3(0, -1, 0),
            new Vector3(0, 0, 1), new Vector3(0, 0, -1),
        ];

        // 3. For each voxel with an outlier block, replace with the best dominant block
        this._blocks.forEach((blockEntry) => {
            if (outlierBlockNames.has(blockEntry.blockInfo.name)) {
                const voxelPos = blockEntry.voxel.position;
                const voxelColour = (blockMeshParams?.brightnessOffset || blockMeshParams?.saturationOffset) ?
                    this._getAdjustedVoxelColour(blockEntry.voxel, blockMeshParams as AssignParams.Input) :
                    blockEntry.voxel.colour;

                // Check neighbor dominant blocks to reward local contour cohesion
                const neighborDominantCounts = new Map<string, number>();
                for (const offset of offsets) {
                    const neighborPos = Vector3.add(voxelPos, offset);
                    const neighbor = this._blocks.get(neighborPos.hash());
                    if (neighbor && dominantBlockNames.has(neighbor.blockInfo.name)) {
                        const nName = neighbor.blockInfo.name;
                        neighborDominantCounts.set(nName, (neighborDominantCounts.get(nName) ?? 0) + 1);
                    }
                }

                let candidatePool = dominantInfos;
                if (nonFallableDominant.length > 0) {
                    if (fallable === 'replace-fallable') {
                        candidatePool = nonFallableDominant;
                    } else if (
                        fallable === 'replace-falling' &&
                        this._voxelMesh &&
                        !this._voxelMesh.isVoxelAt(Vector3.add(voxelPos, new Vector3(0, -1, 0)))
                    ) {
                        candidatePool = nonFallableDominant;
                    }
                }

                // Choose best dominant block considering color perceptual distance + local neighbor cohesion
                let bestDominant = candidatePool[0];
                let minScore = Infinity;

                for (const dom of candidatePool) {
                    const dist = RGBAUtil.characterStatueDistance(voxelColour, dom.colour);
                    const localBonus = (neighborDominantCounts.get(dom.name) ?? 0) * 0.05;
                    const score = dist - localBonus;
                    if (score < minScore) {
                        minScore = score;
                        bestDominant = dom;
                    }
                }

                blockEntry.blockInfo = bestDominant;
                ++prunedBlocksCount;
            }
        });

        // 4. Update _blocksUsed
        this._blocksUsed.clear();
        this._blocks.forEach((b) => {
            this._blocksUsed.add(b.blockInfo.name);
        });

        return {
            prunedTypes: outlierBlockNames.size,
            prunedBlocks: prunedBlocksCount,
        };
    }

    private static readonly _NEIGHBOR_OFFSETS: { dx: number, dy: number, dz: number, weight: number }[] = (() => {
        const offsets: { dx: number, dy: number, dz: number, weight: number }[] = [];
        for (let dx = -2; dx <= 2; ++dx) {
            for (let dy = -2; dy <= 2; ++dy) {
                for (let dz = -2; dz <= 2; ++dz) {
                    if (dx === 0 && dy === 0 && dz === 0) {
                        continue;
                    }
                    const distSq = dx * dx + dy * dy + dz * dz;
                    // Spherical neighborhood up to distance sqrt(5) ~ 2.24 (56 neighbors)
                    if (distSq <= 5) {
                        const dist = Math.sqrt(distSq);
                        offsets.push({ dx, dy, dz, weight: 1.0 / dist });
                    }
                }
            }
        }
        return offsets;
    })();

    private _refineSpatiallyCoherent(
        atlasPalette: AtlasPalette,
        allBlockCollection: TBlockCollection,
        nonFallableBlockCollection: TBlockCollection,
        blockMeshParams: AssignParams.Input,
    ) {
        if (this._blocks.size <= 1) {
            return;
        }
        const offsets = [
            new Vector3(1, 0, 0), new Vector3(-1, 0, 0),
            new Vector3(0, 1, 0), new Vector3(0, -1, 0),
            new Vector3(0, 0, 1), new Vector3(0, 0, -1),
        ];

        for (let pass = 0; pass < 2; ++pass) {
            const nextAssignments = new Map<number, BlockInfo>();

            this._blocks.forEach((entry, hash) => {
                const pos = entry.voxel.position;
                const centerAdjusted = this._getAdjustedVoxelColour(entry.voxel, blockMeshParams);
                const binned = RGBAUtil.bin(centerAdjusted, blockMeshParams.resolution);
                const faceVisibility = blockMeshParams.contextualAveraging ?
                    this._voxelMesh.getFaceVisibility(pos) :
                    VoxelMesh.getFullFaceVisibility();

                const isFallableCurrent = AppRuntimeConstants.Get.FALLABLE_BLOCKS.has(entry.blockInfo.name);
                const isSupported = this._voxelMesh.isVoxelAt(Vector3.add(pos, new Vector3(0, -1, 0)));
                const mustAvoidFallable =
                    blockMeshParams.fallable === 'replace-fallable' ||
                    (blockMeshParams.fallable === 'replace-falling' && !isSupported);
                const collection = (mustAvoidFallable && isFallableCurrent) ?
                    nonFallableBlockCollection :
                    (mustAvoidFallable ? nonFallableBlockCollection : allBlockCollection);

                const topCandidates = atlasPalette.getTopCandidates(
                    binned,
                    collection,
                    faceVisibility,
                    blockMeshParams.errorWeight,
                    6,
                    'spatial-coherent',
                );
                if (topCandidates.length <= 1) {
                    return;
                }

                const neighborScores: Array<{ name: string; colourSimilarity: number }> = [];
                for (let i = 0; i < offsets.length; ++i) {
                    const nEntry = this._blocks.get(Vector3.add(pos, offsets[i]).hash());
                    if (!nEntry) continue;
                    const nColour = this._getAdjustedVoxelColour(nEntry.voxel, blockMeshParams);
                    const cDist = RGBAUtil.oklabDistance(centerAdjusted, nColour);
                    if (cDist <= 0.095) {
                        neighborScores.push({
                            name: nEntry.blockInfo.name,
                            colourSimilarity: Math.max(0.1, 1.0 - cDist / 0.095),
                        });
                    }
                }
                if (neighborScores.length === 0) {
                    return;
                }

                const wrappedCandidates = topCandidates.map((c) => ({
                    name: c.block.name,
                    colourError: c.colourError,
                    stdPenalty: c.stdPenalty,
                    block: c.block,
                }));
                const winner = selectSpatialCoherentCandidate(
                    wrappedCandidates,
                    neighborScores,
                    blockMeshParams.errorWeight,
                    0.065,
                );
                if (winner.name !== entry.blockInfo.name) {
                    nextAssignments.set(hash, winner.block);
                }
            });

            if (nextAssignments.size === 0) {
                break;
            }
            nextAssignments.forEach((info, hash) => {
                const b = this._blocks.get(hash);
                if (b) b.blockInfo = info;
            });
        }

        this._blocksUsed.clear();
        this._blocks.forEach((b) => this._blocksUsed.add(b.blockInfo.name));
    }

    private _getColourDistance(colourA: RGBA, colourB: RGBA, algorithm: TBlockSelectionAlgorithm): number {
        if (algorithm === 'character-statue') {
            return RGBAUtil.characterStatueDistance(colourA, colourB) * 100;
        }
        if (algorithm === 'ciede2000') {
            return ciede2000Distance(colourA, colourB) * 100;
        }
        if (
            algorithm === 'color-chart-match' ||
            algorithm === 'spatial-coherent' ||
            algorithm === 'palette-quantized'
        ) {
            return RGBAUtil.oklabWeightedDistance(colourA, colourB) * 165;
        }
        return RGBAUtil.oklabDistance(colourA, colourB) * 165;
    }

    private _filterSimilarBlocks(algorithm: TBlockSelectionAlgorithm, threshold: number, fallable: FallableBehaviour) {
        if (this._blocks.size === 0) {
            return;
        }

        // Cache block infos and global frequencies for stable tie-breaking
        const blockInfoMap = new Map<string, BlockInfo>();
        const globalCounts = new Map<string, number>();
        this._blocks.forEach((block) => {
            const name = block.blockInfo.name;
            globalCounts.set(name, (globalCounts.get(name) ?? 0) + 1);
            if (!blockInfoMap.has(name)) {
                blockInfoMap.set(name, block.blockInfo);
            }
        });

        const uniqueNames = Array.from(blockInfoMap.keys());
        if (uniqueNames.length <= 1) {
            return;
        }

        // Precompute pairwise colour distance matrix for fast lookup
        const distMatrix = new Map<string, Map<string, number>>();
        for (let i = 0; i < uniqueNames.length; ++i) {
            const nameA = uniqueNames[i];
            const colourA = blockInfoMap.get(nameA)!.colour;
            let row = distMatrix.get(nameA);
            if (!row) {
                row = new Map<string, number>();
                distMatrix.set(nameA, row);
            }
            row.set(nameA, 0);

            for (let j = i + 1; j < uniqueNames.length; ++j) {
                const nameB = uniqueNames[j];
                const colourB = blockInfoMap.get(nameB)!.colour;
                const dist = this._getColourDistance(colourA, colourB, algorithm);
                row.set(nameB, dist);

                let rowB = distMatrix.get(nameB);
                if (!rowB) {
                    rowB = new Map<string, number>();
                    distMatrix.set(nameB, rowB);
                }
                rowB.set(nameA, dist);
            }
        }

        const getDist = (a: string, b: string): number => {
            if (a === b) return 0;
            return distMatrix.get(a)?.get(b) ?? Infinity;
        };

        const offsets = BlockMesh._NEIGHBOR_OFFSETS;
        let totalVoxelsReplaced = 0;

        // Perform up to 3 synchronous (double-buffered) passes of spatial filtering.
        // Pass 1 cleans isolated speckles and boundary spikes.
        // Pass 2 removes 2-3 voxel clumps while strictly preserving contours.
        // Pass 3 resolves any remaining ripple artifacts in similar color families.
        const MAX_PASSES = 3;
        for (let pass = 0; pass < MAX_PASSES; ++pass) {
            const replacements = new Map<number, BlockInfo>();

            this._blocks.forEach((block, hash) => {
                const currentInfo = block.blockInfo;
                const currentName = currentInfo.name;
                const pos = block.voxel.position;

                // Center voxel gets base weight. A small inertia (1.05) ensures
                // perfectly tied boundaries remain stable and do not oscillate.
                const candidateWeights = new Map<string, number>();
                candidateWeights.set(currentName, 1.05);

                for (let i = 0; i < offsets.length; ++i) {
                    const offset = offsets[i];
                    const nx = pos.x + offset.dx;
                    const ny = pos.y + offset.dy;
                    const nz = pos.z + offset.dz;
                    const nHash = new Vector3(nx, ny, nz).hash();

                    const nBlock = this._blocks.get(nHash);
                    if (nBlock === undefined) {
                        continue;
                    }

                    const nName = nBlock.blockInfo.name;
                    const dist = getDist(currentName, nName);

                    // Strictly gate by threshold: distinct contours/materials are excluded and never bled
                    if (dist <= threshold) {
                        candidateWeights.set(nName, (candidateWeights.get(nName) ?? 0) + offset.weight);
                    }
                }

                const currentWeight = candidateWeights.get(currentName) ?? 1.05;

                let bestName = currentName;
                let bestWeight = currentWeight;

                candidateWeights.forEach((weight, name) => {
                    if (name === currentName) {
                        return;
                    }
                    if (weight > bestWeight) {
                        bestWeight = weight;
                        bestName = name;
                    } else if (weight === bestWeight && bestName !== currentName) {
                        const countBest = globalCounts.get(bestName) ?? 0;
                        const countCandidate = globalCounts.get(name) ?? 0;
                        if (countCandidate > countBest || (countCandidate === countBest && name.localeCompare(bestName) < 0)) {
                            bestName = name;
                        }
                    }
                });

                if (bestName !== currentName && bestWeight > currentWeight) {
                    // Respect fallable block constraints if fallable replacement is requested
                    const isWinnerFallable = AppRuntimeConstants.Get.FALLABLE_BLOCKS.has(bestName);
                    if (isWinnerFallable && (fallable === 'replace-falling' || fallable === 'replace-fallable')) {
                        const isSupported = this._voxelMesh.isVoxelAt(Vector3.add(pos, new Vector3(0, -1, 0)));
                        if (fallable === 'replace-fallable' || !isSupported) {
                            return;
                        }
                    }

                    const replacementInfo = blockInfoMap.get(bestName);
                    if (
                        replacementInfo !== undefined &&
                        canReplaceInFilterPass(block.voxel.colour, currentInfo.colour, replacementInfo.colour, threshold)
                    ) {
                        replacements.set(hash, replacementInfo);
                    }
                }
            });

            if (replacements.size === 0) {
                break;
            }

            // Apply buffered replacements
            replacements.forEach((newInfo, hash) => {
                const block = this._blocks.get(hash);
                if (block !== undefined) {
                    block.blockInfo = newInfo;
                }
            });

            totalVoxelsReplaced += replacements.size;
        }

        // Recompute set of used blocks
        this._blocksUsed.clear();
        this._blocks.forEach((block) => {
            this._blocksUsed.add(block.blockInfo.name);
        });

        if (totalVoxelsReplaced > 0) {
            StatusHandler.info(LOC('assign.filtered_blocks', { merged: totalVoxelsReplaced, count: totalVoxelsReplaced }));
        }
    }

    // Face order: ['north', 'south', 'up', 'down', 'east', 'west']
    public getBlockLighting(position: Vector3) {
        // TODO: Shouldn't only use sunlight value, take max of either
        return [
            this._lighting.getMaxLightLevel(new Vector3(1, 0, 0).add(position)),
            this._lighting.getMaxLightLevel(new Vector3(-1, 0, 0).add(position)),
            this._lighting.getMaxLightLevel(new Vector3(0, 1, 0).add(position)),
            this._lighting.getMaxLightLevel(new Vector3(0, -1, 0).add(position)),
            this._lighting.getMaxLightLevel(new Vector3(0, 0, 1).add(position)),
            this._lighting.getMaxLightLevel(new Vector3(0, 0, -1).add(position)),
        ];
    }

    public setEmissiveBlock(pos: Vector3): boolean {
        return this.setSpecificEmissiveBlock(pos, 'minecraft:glowstone');
    }

    public setSpecificEmissiveBlock(pos: Vector3, blockName: string): boolean {
        const namespaced = AppUtil.Text.namespaceBlock(blockName);
        const blockData = this._atlas.getBlocks().get(namespaced) ?? this._atlas.getBlocks().get(blockName);

        const block = this._blocks.get(pos.hash());
        ASSERT(block !== undefined, 'Target block does not exist');

        if (blockData !== undefined) {
            block.blockInfo = blockData;
            this._blocksUsed.add(blockData.name);
            return true;
        }

        const template = this._findEmissiveTemplate();
        block.blockInfo = {
            name: namespaced,
            colour: template.colour,
            faces: template.faces,
        };
        this._blocksUsed.add(namespaced);
        return true;
    }

    private _findEmissiveTemplate(): { faces: any, colour: RGBA } {
        const glowstone = this._atlas.getBlocks().get('minecraft:glowstone');
        if (glowstone) {
            return { faces: glowstone.faces, colour: glowstone.colour };
        }
        let result: { faces: any, colour: RGBA } | undefined;
        AppRuntimeConstants.Get.EMISSIVE_BLOCKS.forEach((emissiveName) => {
            if (!result) {
                const blockData = this._atlas.getBlocks().get(emissiveName);
                if (blockData) {
                    result = { faces: blockData.faces, colour: blockData.colour };
                }
            }
        });
        if (result) {
            return result;
        }
        const fallback = this._atlas.getBlocks().values().next().value;
        ASSERT(fallback !== undefined, 'No atlas blocks available');
        return { faces: fallback.faces, colour: fallback.colour };
    }

    private _addTorchBlock(position: Vector3, name: string, template: { faces: any, colour: RGBA }, torchColour: RGBA) {
        this._blocks.set(position.hash(), {
            voxel: {
                position: position.copy(),
                colour: torchColour,
                collisions: 1,
                neighbours: 0,
                dichromeValue: 1.0,
            },
            blockInfo: {
                name: name,
                colour: torchColour,
                faces: template.faces,
            },
        });
        this._blocksUsed.add(name);
    }

    private _placeTorch(candidatePos: Vector3): { placed: boolean, position: Vector3 } {
        // The candidate is the ordinary support block. It must never be replaced.
        if (!this._blocks.has(candidatePos.hash())) {
            return { placed: false, position: candidatePos.copy() };
        }

        const template = this._findEmissiveTemplate();
        const torchColour: RGBA = { r: 1.0, g: 0.85, b: 0.35, a: 1.0 };

        // Floor torch: occupy the air cell directly above the support block.
        const upPos = Vector3.add(candidatePos, new Vector3(0, 1, 0));
        if (!this._blocks.has(upPos.hash())) {
            this._addTorchBlock(upPos, 'minecraft:torch', template, torchColour);
            return { placed: true, position: upPos };
        }

        // Wall torches lean outwards from the support. Prefer cells beyond the
        // model's outer bounds instead of always selecting the first free
        // direction (+Z). This matters at corners and on negative-X/-Z faces:
        // a fixed direction order can put a torch into an interior gap while
        // leaving the visible outer face without one.
        const wallOptions = [
            { offset: new Vector3(0, 0, 1), facing: 'south' },
            { offset: new Vector3(0, 0, -1), facing: 'north' },
            { offset: new Vector3(1, 0, 0), facing: 'east' },
            { offset: new Vector3(-1, 0, 0), facing: 'west' },
        ];
        const bounds = this._voxelMesh.getBounds();
        const centreX = (bounds.min.x + bounds.max.x) / 2;
        const centreZ = (bounds.min.z + bounds.max.z) / 2;

        const availableWallPositions = wallOptions
            .map((option) => {
                const position = Vector3.add(candidatePos, option.offset);
                const outsideBounds =
                    position.x < bounds.min.x || position.x > bounds.max.x ||
                    position.z < bounds.min.z || position.z > bounds.max.z;
                const distanceFromCentre =
                    Math.pow(position.x - centreX, 2) +
                    Math.pow(position.z - centreZ, 2);

                return {
                    ...option,
                    position,
                    outsideBounds,
                    distanceFromCentre,
                    lightLevel: this._lighting.getMaxLightLevel(position),
                };
            })
            .filter((option) => !this._blocks.has(option.position.hash()))
            .sort((a, b) => {
                if (a.outsideBounds !== b.outsideBounds) {
                    return Number(b.outsideBounds) - Number(a.outsideBounds);
                }
                return 0;
            });

        const bestWallPosition = availableWallPositions[0];
        if (bestWallPosition !== undefined) {
            const torchName = `minecraft:wall_torch[facing=${bestWallPosition.facing}]`;
            this._addTorchBlock(bestWallPosition.position, torchName, template, torchColour);
            return { placed: true, position: bestWallPosition.position };
        }

        // No legal attachment cell exists. Keep the support block and skip this candidate.
        return { placed: false, position: candidatePos.copy() };
    }

    public setLightBlock(pos: Vector3, lightBlockChoice: string): { placed: boolean, position: Vector3 } {
        if (lightBlockChoice === 'minecraft:torch') {
            return this._placeTorch(pos);
        } else if (lightBlockChoice === 'auto') {
            const success = this.setEmissiveBlock(pos);
            return { placed: success, position: pos };
        } else {
            const success = this.setSpecificEmissiveBlock(pos, lightBlockChoice);
            return { placed: success, position: pos };
        }
    }

    public isSurfaceBlock(pos: Vector3): boolean {
        const offsets = [
            new Vector3(1, 0, 0),
            new Vector3(-1, 0, 0),
            new Vector3(0, 1, 0),
            new Vector3(0, -1, 0),
            new Vector3(0, 0, 1),
            new Vector3(0, 0, -1),
        ];
        for (const offset of offsets) {
            const nPos = Vector3.add(pos, offset);
            if (!this._blocks.has(nPos.hash())) {
                return true;
            }
        }
        return false;
    }

    public getBlockAt(pos: Vector3): TOptional<Block> {
        return this._blocks.get(pos.hash());
    }

    public getBlocks(): Block[] {
        return Array.from(this._blocks.values());
    }

    public getBlockPalette(): string[] {
        const uniqueBlocks = new Set<string>();
        this._blocks.forEach((block) => {
            uniqueBlocks.add(block.blockInfo.name);
        });
        return Array.from(uniqueBlocks);
    }

    public getBounds(): Bounds {
        const voxelBounds = this._voxelMesh.getBounds();
        const bounds = new Bounds(voxelBounds.min.copy(), voxelBounds.max.copy());
        this._blocks.forEach((block) => bounds.extendByPoint(block.voxel.position));
        return bounds;
    }

    public getVoxelMesh() {
        ASSERT(this._voxelMesh !== undefined, 'Block mesh has no voxel mesh');
        return this._voxelMesh;
    }

    public getAtlas() {
        return this._atlas;
    }

    public getBlockSummary(): {
        total: number;
        unique: number;
        blocks: {
            name: string;
            count: number;
            hexColour: string;
            percentage: number;
        }[];
        } {
        const counts = new Map<string, { count: number, hexColour: string }>();
        let total = 0;
        this._blocks.forEach((block) => {
            const name = block.blockInfo.name;
            const existing = counts.get(name);
            if (existing) {
                existing.count++;
            } else {
                counts.set(name, {
                    count: 1,
                    hexColour: RGBAUtil.toHexString(block.blockInfo.colour),
                });
            }
            total++;
        });

        const blocks: {
            name: string;
            count: number;
            hexColour: string;
            percentage: number;
        }[] = [];

        counts.forEach((info, name) => {
            blocks.push({
                name: name,
                count: info.count,
                hexColour: info.hexColour,
                percentage: total > 0 ? (info.count / total) * 100 : 0,
            });
        });

        blocks.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

        return {
            total: total,
            unique: blocks.length,
            blocks: blocks,
        };
    }

    public canUndoReplace(): boolean {
        return (this._undoHistory?.length ?? 0) > 0;
    }

    private _isBlockInReplaceScope(block: Block, scope: TReplaceScope, sliceY?: number): boolean {
        if (scope === 'layer' && sliceY !== undefined) {
            return block.voxel.position.y === sliceY;
        }
        if (scope === 'hidden' || scope === 'surface') {
            const p = block.voxel.position;
            const isEnclosed = this._blocks.has(new Vector3(p.x + 1, p.y, p.z).hash()) &&
                this._blocks.has(new Vector3(p.x - 1, p.y, p.z).hash()) &&
                this._blocks.has(new Vector3(p.x, p.y + 1, p.z).hash()) &&
                this._blocks.has(new Vector3(p.x, p.y - 1, p.z).hash()) &&
                this._blocks.has(new Vector3(p.x, p.y, p.z + 1).hash()) &&
                this._blocks.has(new Vector3(p.x, p.y, p.z - 1).hash());
            return scope === 'hidden' ? isEnclosed : !isEnclosed;
        }
        return true;
    }

    /**
     * Replaces matching occurrences of `sourceBlock` (or `options.sourceBlocks`) in this BlockMesh
     * with `targetBlock` (or auto-fits per-voxel best palette matches with spatial neighbor cohesion),
     * supporting scope filtering ('all' | 'layer' | 'surface' | 'hidden') and 1-click Undo history.
     */
    public replaceBlockType(
        sourceBlock: string,
        targetBlock: string,
        options?: {
            scope?: TReplaceScope;
            sliceY?: number;
            mode?: 'swap' | 'auto-palette';
            activePalette?: string[];
            sourceBlocks?: string[];
        },
    ): ReplaceBlockParams.Output {
        if (!this._undoHistory) {
            this._undoHistory = [];
        }

        const scope: TReplaceScope = options?.scope ?? 'all';
        const mode = options?.mode ?? 'swap';
        const rawSources = (options?.sourceBlocks && options.sourceBlocks.length > 0) ?
            options.sourceBlocks :
            (sourceBlock.trim() ? [sourceBlock] : []);
        const sourceSet = new Set<string>();
        const rawSourceSet = new Set<string>();
        const sourceList: string[] = [];
        for (const raw of rawSources) {
            const trimmed = raw.trim();
            if (!trimmed) continue;
            const ns = AppUtil.Text.namespaceBlock(trimmed);
            if (!sourceSet.has(ns)) {
                sourceSet.add(ns);
                sourceList.push(ns);
            }
            rawSourceSet.add(trimmed);
        }
        const sourceNamespaced = sourceList[0] ?? AppUtil.Text.namespaceBlock(sourceBlock.trim());
        const atlasBlocks = this._atlas.getBlocks();

        let targetData: BlockInfo | undefined;
        const autoCandidates: BlockInfo[] = [];

        if (mode === 'auto-palette') {
            const rawPool = options?.activePalette && options.activePalette.length > 0 ?
                options.activePalette :
                PALETTE_ALL_RELEASE;
            const seen = new Set<string>();
            for (const name of rawPool) {
                const ns = AppUtil.Text.namespaceBlock(name.trim());
                if (sourceSet.has(ns) || seen.has(ns)) continue;
                const info = atlasBlocks.get(ns) ?? atlasBlocks.get(name.trim());
                if (info) {
                    seen.add(ns);
                    autoCandidates.push(info as BlockInfo);
                }
            }
            if (autoCandidates.length === 0) {
                atlasBlocks.forEach((info, name) => {
                    const ns = AppUtil.Text.namespaceBlock(name);
                    if (!sourceSet.has(ns)) {
                        autoCandidates.push(info as BlockInfo);
                    }
                });
            }
            if (autoCandidates.length === 0) {
                return {
                    replacedCount: 0,
                    sourceName: sourceNamespaced,
                    targetName: sourceNamespaced,
                    canUndo: this._undoHistory.length > 0,
                };
            }
        } else {
            const targetNamespaced = AppUtil.Text.namespaceBlock(targetBlock.trim());
            targetData = (atlasBlocks.get(targetNamespaced) ?? atlasBlocks.get(targetBlock.trim())) as BlockInfo | undefined;
            ASSERT(targetData !== undefined, `Target block '${targetNamespaced}' not found in atlas`);

            if (sourceSet.size <= 1 && sourceNamespaced === targetData.name) {
                return {
                    replacedCount: 0,
                    sourceName: sourceNamespaced,
                    targetName: targetData.name,
                    canUndo: this._undoHistory.length > 0,
                };
            }
        }

        const neighborOffsets = mode === 'auto-palette' ? [
            new Vector3(1, 0, 0), new Vector3(-1, 0, 0),
            new Vector3(0, 1, 0), new Vector3(0, -1, 0),
            new Vector3(0, 0, 1), new Vector3(0, 0, -1),
        ] : [];

        const prevSnapshot = new Map<number, BlockInfo>();
        let replacedCount = 0;
        const rebuiltUsed = new Set<string>();
        const targetNamesUsed = new Map<string, number>();

        this._blocks.forEach((block, hash) => {
            const currentNamespaced = AppUtil.Text.namespaceBlock(block.blockInfo.name);
            const matchesSource = sourceSet.has(currentNamespaced) || rawSourceSet.has(block.blockInfo.name);
            const isSameSwapTarget = mode === 'swap' && targetData !== undefined && currentNamespaced === targetData.name;
            if (matchesSource && !isSameSwapTarget && this._isBlockInReplaceScope(block, scope, options?.sliceY)) {
                prevSnapshot.set(hash, block.blockInfo);

                let replacement: BlockInfo;
                if (mode === 'auto-palette') {
                    const neighborCounts = new Map<string, number>();
                    const pos = block.voxel.position;
                    for (let i = 0; i < neighborOffsets.length; ++i) {
                        const nBlock = this._blocks.get(Vector3.add(pos, neighborOffsets[i]).hash());
                        if (!nBlock) continue;
                        const nNs = AppUtil.Text.namespaceBlock(nBlock.blockInfo.name);
                        if (sourceSet.has(nNs) || rawSourceSet.has(nBlock.blockInfo.name)) continue;
                        neighborCounts.set(nBlock.blockInfo.name, (neighborCounts.get(nBlock.blockInfo.name) ?? 0) + 1);
                    }
                    replacement = pickBestRetainedBlock(block.voxel.colour, autoCandidates, neighborCounts);
                } else {
                    replacement = targetData!;
                }

                block.blockInfo = {
                    name: replacement.name,
                    colour: replacement.colour,
                    faces: replacement.faces,
                };
                targetNamesUsed.set(replacement.name, (targetNamesUsed.get(replacement.name) ?? 0) + 1);
                replacedCount++;
            }
            rebuiltUsed.add(block.blockInfo.name);
        });

        this._blocksUsed = rebuiltUsed;
        if (replacedCount > 0) {
            this._undoHistory.push(prevSnapshot);
            if (this._undoHistory.length > 10) {
                this._undoHistory.shift();
            }
            this._bufferChunks = [];
        }

        const summarySource = sourceList.length > 1 ?
            `${sourceNamespaced} (+${sourceList.length - 1})` :
            sourceNamespaced;

        let summaryTarget = targetData ? targetData.name : sourceNamespaced;
        if (mode === 'auto-palette' && targetNamesUsed.size > 0) {
            const top = Array.from(targetNamesUsed.entries()).sort((a, b) => b[1] - a[1])[0];
            summaryTarget = targetNamesUsed.size > 1 ?
                `${top[0]} (+${targetNamesUsed.size - 1})` :
                top[0];
        }

        return {
            replacedCount,
            sourceName: summarySource,
            targetName: summaryTarget,
            canUndo: this._undoHistory.length > 0,
        };
    }

    public undoLastReplace(): ReplaceBlockParams.Output {
        if (!this._undoHistory || this._undoHistory.length === 0) {
            return {
                replacedCount: 0,
                sourceName: '',
                targetName: '',
                canUndo: false,
                undone: true,
            };
        }

        const snapshot = this._undoHistory.pop()!;
        let restored = 0;
        snapshot.forEach((prevInfo, hash) => {
            const block = this._blocks.get(hash);
            if (block) {
                block.blockInfo = prevInfo;
                restored++;
            }
        });

        const rebuiltUsed = new Set<string>();
        this._blocks.forEach((b) => rebuiltUsed.add(b.blockInfo.name));
        this._blocksUsed = rebuiltUsed;
        if (restored > 0) {
            this._bufferChunks = [];
        }

        return {
            replacedCount: restored,
            sourceName: '',
            targetName: '',
            canUndo: this._undoHistory.length > 0,
            undone: true,
        };
    }

    public isEmissiveBlock(block: Block) {
        return AppRuntimeConstants.Get.EMISSIVE_BLOCKS.has(block.blockInfo.name);
    }

    public isTransparentBlock(block: Block) {
        const name = block.blockInfo.name;
        const isTorch = name === 'minecraft:torch' ||
            name === 'minecraft:wall_torch' ||
            name.startsWith('minecraft:wall_torch[');
        return isTorch || AppRuntimeConstants.Get.TRANSPARENT_BLOCKS.has(name);
    }

    /*
    private _buffer?: TBlockMeshBufferDescription;
    public getBuffer(): TBlockMeshBufferDescription {
        //ASSERT(this._renderParams, 'Called BlockMesh.getBuffer() without setting render params');
        if (this._buffer === undefined) {
            this._buffer = BufferGenerator.fromBlockMesh(this);
            //this._recreateBuffer = false;
        }
        return this._buffer;
    }
    */

    private _bufferChunks: Array<TBlockMeshBufferDescription & { moreBlocksToBuffer: boolean, progress: number }> = [];
    public getChunkedBuffer(chunkIndex: number): TBlockMeshBufferDescription & { moreBlocksToBuffer: boolean, progress: number } {
        if (this._bufferChunks[chunkIndex] === undefined) {
            LOGF(`[BlockMesh]: getChunkedBuffer: ci: ${chunkIndex} not cached`);
            this._bufferChunks[chunkIndex] = ChunkedBufferGenerator.fromBlockMesh(this, chunkIndex);
        } else {
            LOGF(`[BlockMesh]: getChunkedBuffer: ci: ${chunkIndex} not cached`);
        }
        return this._bufferChunks[chunkIndex];
    }

    public getAllChunkedBuffers() {
        return this._bufferChunks;
    }
}
