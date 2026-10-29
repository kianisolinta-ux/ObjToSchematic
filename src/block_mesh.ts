import { Atlas, TAtlasBlock } from './atlas';
import { AtlasPalette, EFaceVisibility } from './block_assigner';
import { BlockInfo } from './block_atlas';
import { ChunkedBufferGenerator, TBlockMeshBufferDescription } from './buffer';
import { RGBA, RGBA_255, RGBAUtil } from './colour';
import { AppRuntimeConstants } from './constants';
import { Ditherer } from './dither';
import { BlockMeshLighting } from './lighting';
import { LOC } from './localiser';
import { PALETTE_ALL_RELEASE } from '../res/palettes/all';
import { Palette } from './palette';
import { ProgressManager } from './progress';
import { StatusHandler } from './status';
import { ColourSpace, TOptional } from './util';
import { AppError, ASSERT } from './util/error_util';
import { LOGF } from './util/log_util';
import { TBlockSelectionAlgorithm } from './util/type_util';
import { Vector3 } from './vector';
import { Voxel, VoxelMesh } from './voxel_mesh';
import { AssignParams } from './worker_types';

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

    public static createFromVoxelMesh(voxelMesh: VoxelMesh, blockMeshParams: AssignParams.Input) {
        const blockMesh = new BlockMesh(voxelMesh);
        blockMesh._assignBlocks(blockMeshParams);

        //blockMesh._calculateLighting(blockMeshParams.lightThreshold);
        if (blockMeshParams.calculateLighting) {
            blockMesh._lighting.init();
            blockMesh._lighting.addSunLightValues();
            blockMesh._lighting.addEmissiveBlocks();
            blockMesh._lighting.addLightToDarkness(blockMeshParams.lightThreshold);
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
    }

    /**
     * Before we turn a voxel into a block we have the opportunity to alter the voxel's colour.
     * This is where the colour accuracy bands colours together and where dithering is calculated.
     */
    private _getFinalVoxelColour(voxel: Voxel, blockMeshParams: AssignParams.Input) {
        const voxelColour = RGBAUtil.copy(voxel.colour);

        const binnedColour = RGBAUtil.bin(voxelColour, blockMeshParams.resolution);

        const ditheredColour: RGBA_255 = RGBAUtil.copy255(binnedColour);
        switch (blockMeshParams.dithering) {
            case 'off': {
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

    private _assignBlocks(blockMeshParams: AssignParams.Input) {
        const atlas = Atlas.load(blockMeshParams.textureAtlas);
        ASSERT(atlas !== undefined, 'Could not load atlas');
        this._atlas = atlas;

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

        let countFalling = 0;
        const taskHandle = ProgressManager.Get.start('Assigning');

        if (blockMeshParams.blockFilter) {
            // STEP 1: Filter phase (clean initial model first before dithering)
            for (let voxelIndex = 0; voxelIndex < voxels.length; ++voxelIndex) {
                ProgressManager.Get.progress(taskHandle, (voxelIndex / voxels.length) * 0.4);
                const voxel = voxels[voxelIndex];
                const voxelColour = RGBAUtil.copy(voxel.colour);
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
                'do-nothing',
            );

            // STEP 2: Dithering and remaining parameters layered on top of the filtered result
            const grassLikeBlocksBuffer: GrassLikeBlock[] = [];
            this._blocksUsed.clear();

            for (let voxelIndex = 0; voxelIndex < voxels.length; ++voxelIndex) {
                ProgressManager.Get.progress(taskHandle, 0.4 + (voxelIndex / voxels.length) * 0.6);
                const voxel = voxels[voxelIndex];
                const hash = voxel.position.hash();
                const currentBlock = this._blocks.get(hash);
                ASSERT(currentBlock !== undefined);

                let finalBlock = currentBlock.blockInfo;
                const faceVisibility = blockMeshParams.contextualAveraging ?
                    this._voxelMesh.getFaceVisibility(voxel.position) :
                    VoxelMesh.getFullFaceVisibility();

                const finalColour = RGBAUtil.toRGBA255(finalBlock.colour);
                if (blockMeshParams.dithering !== 'off') {
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

                if (shouldReplaceBlock) {
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
            for (let voxelIndex = 0; voxelIndex < voxels.length; ++voxelIndex) {
                ProgressManager.Get.progress(taskHandle, voxelIndex / voxels.length);

                const voxel = voxels[voxelIndex];
                const voxelColour = this._getFinalVoxelColour(voxel, blockMeshParams);
                const faceVisibility = blockMeshParams.contextualAveraging ?
                    this._voxelMesh.getFaceVisibility(voxel.position) :
                    VoxelMesh.getFullFaceVisibility();
                let block = atlasPalette.getBlock(voxelColour, allBlockCollection, faceVisibility, blockMeshParams.errorWeight, blockMeshParams.blockSelectionAlgorithm);

                const isBlockFallable = AppRuntimeConstants.Get.FALLABLE_BLOCKS.has(block.name);
                const isBlockSupported = this._voxelMesh.isVoxelAt(Vector3.add(voxel.position, new Vector3(0, -1, 0)));

                if (isBlockFallable && !isBlockSupported) {
                    ++countFalling;
                }

                const shouldReplaceBlock =
                    (blockMeshParams.fallable === 'replace-fallable' && isBlockFallable) ||
                    (blockMeshParams.fallable === 'replace-falling' && isBlockFallable && !isBlockSupported);

                if (shouldReplaceBlock) {
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

        if (blockMeshParams.blockSelectionAlgorithm === 'character-statue') {
            const pruneResult = this._pruneRareOutlierBlocks(blockMeshParams.fallable);
            if (pruneResult.prunedTypes > 0) {
                StatusHandler.info(LOC('assign.pruned_rare_blocks', {
                    types: pruneResult.prunedTypes,
                    blocks: pruneResult.prunedBlocks,
                }));
            }
        }

        if (blockMeshParams.fallable === 'do-nothing' && countFalling > 0) {
            StatusHandler.warning(LOC('assign.falling_blocks', { count: countFalling }));
        }
    }

    /**
     * Consolidates rare outlier block types that appear in insignificant quantities into
     * the dominant blocks in the model. This is critical for character statues and survival builds
     * where players do not want to hunt down/craft a block type for just a handful of voxels.
     */
    public _pruneRareOutlierBlocks(fallable: FallableBehaviour): { prunedTypes: number, prunedBlocks: number } {
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
                const voxelColour = blockEntry.voxel.colour;

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

                // Choose best dominant block considering color perceptual distance + local neighbor cohesion
                let bestDominant = dominantInfos[0];
                let minScore = Infinity;

                for (const dom of dominantInfos) {
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

    private _getColourDistance(colourA: RGBA, colourB: RGBA, algorithm: TBlockSelectionAlgorithm): number {
        if (algorithm === 'character-statue') {
            return RGBAUtil.characterStatueDistance(colourA, colourB) * 100;
        }
        return RGBAUtil.perceptualDistance(colourA, colourB);
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
                    if (replacementInfo !== undefined) {
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
        const voxel = this._voxelMesh.getVoxelAt(pos);
        ASSERT(voxel !== undefined, 'Missing voxel');
        const minError = Infinity;
        let bestBlock: TAtlasBlock | undefined;
        AppRuntimeConstants.Get.EMISSIVE_BLOCKS.forEach((emissiveBlockName) => {
            const emissiveBlockData = this._atlas.getBlocks().get(emissiveBlockName);
            if (emissiveBlockData) {
                const error = RGBAUtil.squaredDistance(emissiveBlockData.colour, voxel.colour);
                if (error < minError) {
                    bestBlock = emissiveBlockData;
                }
            }
        });

        if (bestBlock !== undefined) {
            const blockIndex = 0; //this._voxelMesh.getVoxelIndex(pos);
            ASSERT(blockIndex !== undefined, 'Setting emissive block of block that doesn\'t exist');

            const block = this._blocks.get(pos.hash());
            ASSERT(block !== undefined);

            block.blockInfo = bestBlock;
            this._blocksUsed.add(bestBlock.name);
            return true;
        }

        throw new AppError(LOC('assign.block_palette_missing_light_blocks'));
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

    public isEmissiveBlock(block: Block) {
        return AppRuntimeConstants.Get.EMISSIVE_BLOCKS.has(block.blockInfo.name);
    }

    public isTransparentBlock(block: Block) {
        return AppRuntimeConstants.Get.TRANSPARENT_BLOCKS.has(block.blockInfo.name);
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
