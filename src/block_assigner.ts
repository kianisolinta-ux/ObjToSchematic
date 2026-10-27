import { Atlas, TAtlasBlock } from './atlas';
import { RGBA, RGBA_255, RGBAUtil } from './colour';
import { AppMath } from './math';
import { Palette } from './palette';
import { AppTypes, TOptional } from './util';
import { ASSERT } from './util/error_util';
import { TBlockSelectionAlgorithm } from './util/type_util';

export type TBlockCollection = {
    blocks: Map<AppTypes.TNamespacedBlockName, TAtlasBlock>,
    cache: Map<BigInt, TAtlasBlock>,
}

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

    public constructor(atlas: Atlas, palette: Palette) {
        this._atlas = atlas;
        this._palette = palette;

        this._palette.removeMissingAtlasBlocks(this._atlas);
    }

    public createBlockCollection(blocksToExclude: AppTypes.TNamespacedBlockName[]): TBlockCollection {
        const blocksNamesToUse = this._palette.getBlocks();
        {
            // Remove excluded blocks
            for (const blockToExclude of blocksToExclude) {
                const index = blocksNamesToUse.indexOf(blockToExclude);
                if (index != -1) {
                    blocksNamesToUse.splice(index, 1);
                }
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

        ASSERT(blocksToUse.blocks.size >= 1, 'Must have at least one block cached');
        return blocksToUse;
    }

    /**
     * Convert a colour into a Minecraft block.
     * @param colour The colour that the returned block should match with.
     * @param resolution The colour accuracy, a uint8 from 1 to 255, inclusive.
     * @param blockToExclude A list of blocks that should not be used, this should be a subset of the palette blocks.
     * @returns
     */
    public getBlock(
        colour: RGBA_255,
        blockCollection: TBlockCollection,
        faceVisibility: EFaceVisibility,
        errorWeight: number,
        blockSelectionAlgorithm: TBlockSelectionAlgorithm = 'nearest-color',
    ) {
        const colourHash = RGBAUtil.hash255(colour);
        const contextHash: BigInt = (BigInt(Math.round(colourHash)) << BigInt(6)) + BigInt(faceVisibility);

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
                let contextualBlockColour = blockData.colour;
                let contextualStd = 0.0;
                if (faceVisibility !== EFaceVisibility.None) {
                    const context = AtlasPalette.getContextualFaceAverage(blockData, faceVisibility);
                    contextualBlockColour = context.colour;
                    contextualStd = context.std;
                }

                let colourError = 0.0;
                let stdPenalty = contextualStd;
                let survivalCost = 0.0;

                if (blockSelectionAlgorithm === 'character-statue') {
                    colourError = RGBAUtil.characterStatueDistance(floatColour, contextualBlockColour);
                    // Enhance smoothness weight for statues so character faces/suits avoid noisy block textures
                    stdPenalty = contextualStd * 1.5;
                    // Survival accessibility bias: penalize exotic/tedious blocks so easily obtainable blocks are preferred
                    if (AtlasPalette.EXOTIC_SURVIVAL_BLOCKS.has(blockData.name)) {
                        survivalCost = 0.10;
                    }
                } else if (blockSelectionAlgorithm === 'color-chart-match') {
                    colourError = RGBAUtil.perceptualDistance(floatColour, contextualBlockColour) / 100;
                } else {
                    colourError = RGBAUtil.squaredDistance(floatColour, contextualBlockColour);
                }

                const totalError = AppMath.lerp(errorWeight, colourError, stdPenalty) + survivalCost;
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

    public static getContextualFaceAverage(block: TAtlasBlock, faceVisibility: EFaceVisibility) {
        const averageColour: RGBA = { r: 0, g: 0, b: 0, a: 0 };
        let averageStd: number = 0.0; // Taking the average of a std is a bit naughty
        let count = 0;
        if (faceVisibility & EFaceVisibility.Up) {
            RGBAUtil.add(averageColour, block.faces.up.colour);
            averageStd += block.faces.up.std;
            ++count;
        }
        if (faceVisibility & EFaceVisibility.Down) {
            RGBAUtil.add(averageColour, block.faces.down.colour);
            averageStd += block.faces.down.std;
            ++count;
        }
        if (faceVisibility & EFaceVisibility.North) {
            RGBAUtil.add(averageColour, block.faces.north.colour);
            averageStd += block.faces.north.std;
            ++count;
        }
        if (faceVisibility & EFaceVisibility.East) {
            RGBAUtil.add(averageColour, block.faces.east.colour);
            averageStd += block.faces.east.std;
            ++count;
        }
        if (faceVisibility & EFaceVisibility.South) {
            RGBAUtil.add(averageColour, block.faces.south.colour);
            averageStd += block.faces.south.std;
            ++count;
        }
        if (faceVisibility & EFaceVisibility.West) {
            RGBAUtil.add(averageColour, block.faces.west.colour);
            averageStd += block.faces.west.std;
            ++count;
        }
        averageColour.r /= count;
        averageColour.g /= count;
        averageColour.b /= count;
        averageColour.a /= count;
        return {
            colour: averageColour,
            std: averageStd / count,
        };
    }
}
