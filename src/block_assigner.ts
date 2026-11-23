import { Atlas, TAtlasBlock } from './atlas';
import { RGBA, RGBA_255, RGBAUtil } from './colour';
import { ciede2000Distance } from './colour_algorithms';
import { AppMath } from './math';
import { Palette } from './palette';
import { AppTypes, TOptional } from './util';
import { ASSERT } from './util/error_util';
import { TBlockSelectionAlgorithm } from './util/type_util';

export type TBlockCollection = {
    blocks: Map<AppTypes.TNamespacedBlockName, TAtlasBlock>,
    cache: Map<bigint, TAtlasBlock>,
}

export type TBlockCandidateScore = {
    block: TAtlasBlock;
    colourError: number;
    stdPenalty: number;
};

/* eslint-disable */
export enum EFaceVisibility {
    None = 0,
    Up = 1 << 0,
    Down = 1 << 1,
    North = 1 << 2,
    East = 1 << 3,
    South = 1 << 4,
    West = 1 << 5,
}
/* eslint-enable */

/**
 * A new instance of AtlasPalette is created each time
 * a new voxel mesh is voxelised.
 */
export class AtlasPalette {
    public static readonly EXOTIC_SURVIVAL_BLOCKS = new Set<string>([
        'minecraft:ancient_debris',
        'minecraft:netherite_block',
        'minecraft:beacon',
        'minecraft:crying_obsidian',
        'minecraft:respawn_anchor',
        'minecraft:lodestone',
        'minecraft:conduit',
        'minecraft:emerald_block',
        'minecraft:diamond_block',
        'minecraft:dragon_egg',
        'minecraft:enchanting_table',
        'minecraft:sponge',
        'minecraft:wet_sponge',
        'minecraft:shulker_box',
        'minecraft:white_shulker_box',
        'minecraft:orange_shulker_box',
        'minecraft:magenta_shulker_box',
        'minecraft:light_blue_shulker_box',
        'minecraft:yellow_shulker_box',
        'minecraft:lime_shulker_box',
        'minecraft:pink_shulker_box',
        'minecraft:gray_shulker_box',
        'minecraft:light_gray_shulker_box',
        'minecraft:cyan_shulker_box',
        'minecraft:purple_shulker_box',
        'minecraft:blue_shulker_box',
        'minecraft:brown_shulker_box',
        'minecraft:green_shulker_box',
        'minecraft:red_shulker_box',
        'minecraft:black_shulker_box',
    ]);

    private _atlas: Atlas;
    private _palette: Palette;
    private _topCandidatesCache = new WeakMap<TBlockCollection, Map<bigint, TBlockCandidateScore[]>>();

    public constructor(atlas: Atlas, palette: Palette) {
        this._atlas = atlas;
        this._palette = palette;

        this._palette.removeMissingAtlasBlocks(this._atlas);
    }

    public createBlockCollection(blocksToExclude: AppTypes.TNamespacedBlockName[]): TBlockCollection {
        const allPaletteBlocks = this._palette.getBlocks();
        let blocksNamesToUse = allPaletteBlocks;
        if (blocksToExclude.length > 0) {
            // Remove excluded blocks
            const filtered = blocksNamesToUse.filter((block) => !blocksToExclude.includes(block));
            // If excluding these blocks leaves at least one block, use the filtered list;
            // otherwise, fall back to all palette blocks so the collection is never empty.
            if (filtered.length > 0) {
                blocksNamesToUse = filtered;
            }
        }

        const blocksToUse: TBlockCollection = {
            blocks: new Map(),
            cache: new Map(),
        };

        const atlasBlocks = this._atlas.getBlocks();
        {
            // Only add block data for blocks in the palette
            atlasBlocks.forEach((atlasBlock, blockName) => {
                if (blocksNamesToUse.includes(blockName)) {
                    blocksToUse.blocks.set(blockName, atlasBlock);
                }
            });
        }

        // Fallback 1: If filtered blocks were not found in atlas, try any palette blocks present in atlas
        if (blocksToUse.blocks.size === 0) {
            atlasBlocks.forEach((atlasBlock, blockName) => {
                if (allPaletteBlocks.includes(blockName)) {
                    blocksToUse.blocks.set(blockName, atlasBlock);
                }
            });
        }

        // Fallback 2: If palette was completely empty or invalid, take any available atlas block so assignment never crashes
        if (blocksToUse.blocks.size === 0) {
            const firstAtlasBlock = atlasBlocks.values().next().value;
            if (firstAtlasBlock) {
                blocksToUse.blocks.set(firstAtlasBlock.name, firstAtlasBlock);
            }
        }

        ASSERT(blocksToUse.blocks.size >= 1, 'Must have at least one block cached');
        return blocksToUse;
    }

    private _getContextHash(
        colour: RGBA_255,
        faceVisibility: EFaceVisibility,
        errorWeight: number,
        blockSelectionAlgorithm: TBlockSelectionAlgorithm,
    ): bigint {
        const colourHash = BigInt(RGBAUtil.hash255(colour));
        let algoIdNum = 0;
        switch (blockSelectionAlgorithm) {
            case 'character-statue': algoIdNum = 1; break;
            case 'color-chart-match': algoIdNum = 2; break;
            case 'ciede2000': algoIdNum = 3; break;
            case 'spatial-coherent': algoIdNum = 4; break;
            case 'palette-quantized': algoIdNum = 5; break;
            default: algoIdNum = 0; break;
        }
        const errWeightInt = BigInt(Math.max(0, Math.min(200, Math.round(errorWeight * 100))));
        return (colourHash << BigInt(20)) + (errWeightInt << BigInt(10)) + (BigInt(faceVisibility) << BigInt(4)) + BigInt(algoIdNum);
    }

    private _scoreBlock(
        floatColour: RGBA,
        blockData: TAtlasBlock,
        faceVisibility: EFaceVisibility,
        errorWeight: number,
        blockSelectionAlgorithm: TBlockSelectionAlgorithm,
    ): { totalError: number; colourError: number; stdPenalty: number } {
        let contextualBlockColour = blockData.colour;
        let contextualStd = 0.0;
        let faceVariance = 0.0;
        if (faceVisibility !== EFaceVisibility.None && blockData.faces) {
            const context = AtlasPalette.getContextualFaceAverage(blockData, faceVisibility);
            contextualBlockColour = context.colour;
            contextualStd = context.std;
            faceVariance = context.faceVariance;
        }

        let colourError = 0.0;
        let stdPenalty = contextualStd;
        let survivalCost = 0.0;

        if (blockSelectionAlgorithm === 'character-statue') {
            colourError = RGBAUtil.characterStatueDistance(floatColour, contextualBlockColour);
            // Enhance smoothness weight for statues so character faces/suits avoid noisy block textures
            stdPenalty = (contextualStd + faceVariance * 0.65) * 1.5;
            if (AtlasPalette.EXOTIC_SURVIVAL_BLOCKS.has(blockData.name)) {
                survivalCost = 0.10;
            }
        } else if (blockSelectionAlgorithm === 'ciede2000') {
            colourError = ciede2000Distance(floatColour, contextualBlockColour);
            stdPenalty = (contextualStd + faceVariance * 0.65) * 0.9;
        } else if (
            blockSelectionAlgorithm === 'color-chart-match' ||
            blockSelectionAlgorithm === 'spatial-coherent' ||
            blockSelectionAlgorithm === 'palette-quantized'
        ) {
            colourError = RGBAUtil.oklabWeightedDistance(floatColour, contextualBlockColour);
            stdPenalty = contextualStd + faceVariance * 0.75;
        } else {
            colourError = RGBAUtil.squaredDistance(floatColour, contextualBlockColour);
            stdPenalty = contextualStd + faceVariance * 0.5;
        }

        const totalError = AppMath.lerp(errorWeight, colourError, stdPenalty) + survivalCost;
        return { totalError, colourError, stdPenalty };
    }

    /**
     * Convert a colour into a Minecraft block.
     */
    public getBlock(
        colour: RGBA_255,
        blockCollection: TBlockCollection,
        faceVisibility: EFaceVisibility,
        errorWeight: number,
        blockSelectionAlgorithm: TBlockSelectionAlgorithm = 'nearest-color',
    ) {
        const contextHash = this._getContextHash(colour, faceVisibility, errorWeight, blockSelectionAlgorithm);

        // If we've already calculated the block associated with this colour, return it.
        const cachedBlock = blockCollection.cache.get(contextHash);
        if (cachedBlock !== undefined) {
            return cachedBlock;
        }

        // Find the best matching block using the selected colour metric.
        let minError = Infinity;
        let blockChoice: TOptional<TAtlasBlock>;
        const floatColour = RGBAUtil.fromRGBA255(colour);
        {
            blockCollection.blocks.forEach((blockData) => {
                const { totalError } = this._scoreBlock(floatColour, blockData, faceVisibility, errorWeight, blockSelectionAlgorithm);
                if (totalError < minError) {
                    minError = totalError;
                    blockChoice = blockData;
                }
            });
        }

        if (blockChoice !== undefined) {
            blockCollection.cache.set(contextHash, blockChoice);
            return blockChoice;
        }

        ASSERT(false, 'Unreachable, always at least one possible block');
    }

    public getTopCandidates(
        colour: RGBA_255,
        blockCollection: TBlockCollection,
        faceVisibility: EFaceVisibility,
        errorWeight: number,
        topK = 6,
        blockSelectionAlgorithm: TBlockSelectionAlgorithm = 'spatial-coherent',
    ): TBlockCandidateScore[] {
        const contextHash = this._getContextHash(colour, faceVisibility, errorWeight, blockSelectionAlgorithm);
        let cacheMap = this._topCandidatesCache.get(blockCollection);
        if (!cacheMap) {
            cacheMap = new Map();
            this._topCandidatesCache.set(blockCollection, cacheMap);
        }
        const cached = cacheMap.get(contextHash);
        if (cached !== undefined) {
            return cached;
        }

        const floatColour = RGBAUtil.fromRGBA255(colour);
        const scored: Array<TBlockCandidateScore & { totalError: number }> = [];
        blockCollection.blocks.forEach((blockData) => {
            const { totalError, colourError, stdPenalty } = this._scoreBlock(
                floatColour,
                blockData,
                faceVisibility,
                errorWeight,
                blockSelectionAlgorithm,
            );
            scored.push({
                block: blockData,
                colourError,
                stdPenalty,
                totalError,
            });
        });

        scored.sort((a, b) => a.totalError - b.totalError);
        const result = scored.slice(0, Math.max(1, topK)).map((item) => ({
            block: item.block,
            colourError: item.colourError,
            stdPenalty: item.stdPenalty,
        }));
        cacheMap.set(contextHash, result);
        return result;
    }

    public static getContextualFaceAverage(block: TAtlasBlock, faceVisibility: EFaceVisibility) {
        let averageStd: number = 0.0;
        const visibleColours: RGBA[] = [];
        let count = 0;
        if (faceVisibility & EFaceVisibility.Up) {
            visibleColours.push(block.faces.up.colour);
            averageStd += block.faces.up.std;
            ++count;
        }
        if (faceVisibility & EFaceVisibility.Down) {
            visibleColours.push(block.faces.down.colour);
            averageStd += block.faces.down.std;
            ++count;
        }
        if (faceVisibility & EFaceVisibility.North) {
            visibleColours.push(block.faces.north.colour);
            averageStd += block.faces.north.std;
            ++count;
        }
        if (faceVisibility & EFaceVisibility.East) {
            visibleColours.push(block.faces.east.colour);
            averageStd += block.faces.east.std;
            ++count;
        }
        if (faceVisibility & EFaceVisibility.South) {
            visibleColours.push(block.faces.south.colour);
            averageStd += block.faces.south.std;
            ++count;
        }
        if (faceVisibility & EFaceVisibility.West) {
            visibleColours.push(block.faces.west.colour);
            averageStd += block.faces.west.std;
            ++count;
        }
        const averageColour = visibleColours.length > 0 ?
            RGBAUtil.averageLinear(...visibleColours) :
            RGBAUtil.copy(block.colour);

        let faceVariance = 0.0;
        if (visibleColours.length >= 2) {
            for (let i = 0; i < visibleColours.length; ++i) {
                const fc = visibleColours[i];
                const dr = fc.r - averageColour.r;
                const dg = fc.g - averageColour.g;
                const db = fc.b - averageColour.b;
                faceVariance += Math.sqrt(dr * dr + dg * dg + db * db);
            }
            faceVariance /= visibleColours.length;
        }

        return {
            colour: averageColour,
            std: count > 0 ? averageStd / count : 0.0,
            faceVariance,
        };
    }

    public static getContextualFaceColour(
        block: {
            colour: RGBA;
            faces?: Partial<Record<'up' | 'down' | 'north' | 'east' | 'south' | 'west', object>>;
        },
        faceVisibility: EFaceVisibility,
    ): RGBA {
        const upFace = block.faces?.up as { colour?: RGBA } | undefined;
        if (faceVisibility === EFaceVisibility.None || !block.faces || !upFace?.colour) {
            return block.colour;
        }
        return AtlasPalette.getContextualFaceAverage(block as TAtlasBlock, faceVisibility).colour;
    }
}
