import { AtlasPalette, EFaceVisibility } from '../src/block_assigner';
import { RGBAUtil } from '../src/colour';
import { Palette } from '../src/palette';

test('Color Chart Match selects a block using the Color Chart perceptual metric', () => {
    // These atlas colours make RGB distance prefer oak planks, while CIE76 Delta E prefers gold.
    const blockData = [
        {
            name: 'minecraft:gold_block',
            colour: { r: 0.9663449754901964, g: 0.8169424019607848, b: 0.2416666666666671, a: 1 },
        },
        {
            name: 'minecraft:oak_planks',
            colour: { r: 0.6360906862745104, g: 0.513020833333333, b: 0.3083486519607845, a: 1 },
        },
    ];
    const atlasBlocks = new Map<string, typeof blockData[number]>();
    blockData.forEach((block) => atlasBlocks.set(block.name, block));
    const atlas = {
        getBlocks: () => atlasBlocks,
        hasBlock: (name: string) => atlasBlocks.has(name),
    };

    const palette = Palette.create();
    palette.add(['minecraft:gold_block', 'minecraft:oak_planks']);
    const atlasPalette = new AtlasPalette(atlas as any, palette);
    const targetColour = RGBAUtil.bin({
        r: 122 / 255,
        g: 186 / 255,
        b: 2 / 255,
        a: 1,
    }, 255);

    const rgbChoice = atlasPalette.getBlock(
        targetColour,
        atlasPalette.createBlockCollection([]),
        EFaceVisibility.None,
        0,
    );
    const chartChoice = atlasPalette.getBlock(
        targetColour,
        atlasPalette.createBlockCollection([]),
        EFaceVisibility.None,
        0,
        'color-chart-match',
    );

    expect(rgbChoice.name).toBe('minecraft:oak_planks');
    expect(chartChoice.name).toBe('minecraft:gold_block');
});

test('Character Statue algorithm avoids exotic survival blocks in favor of accessible alternatives', () => {
    // Two blocks with identical or very close green colors: emerald block (exotic) vs lime concrete (accessible)
    const blockData = [
        {
            name: 'minecraft:emerald_block',
            colour: { r: 0.1, g: 0.85, b: 0.3, a: 1 },
        },
        {
            name: 'minecraft:lime_concrete',
            colour: { r: 0.12, g: 0.82, b: 0.28, a: 1 },
        },
    ];
    const atlasBlocks = new Map<string, typeof blockData[number]>();
    blockData.forEach((block) => atlasBlocks.set(block.name, block));
    const atlas = {
        getBlocks: () => atlasBlocks,
        hasBlock: (name: string) => atlasBlocks.has(name),
    };

    const palette = Palette.create();
    palette.add(['minecraft:emerald_block', 'minecraft:lime_concrete']);
    const atlasPalette = new AtlasPalette(atlas as any, palette);
    const targetColour = RGBAUtil.bin({
        r: 0.1,
        g: 0.85,
        b: 0.3,
        a: 1,
    }, 255);

    // Standard nearest-color picks the exact emerald block
    const nearestChoice = atlasPalette.getBlock(
        targetColour,
        atlasPalette.createBlockCollection([]),
        EFaceVisibility.None,
        0,
        'nearest-color',
    );
    expect(nearestChoice.name).toBe('minecraft:emerald_block');

    // character-statue penalizes exotic blocks to make survival statue construction feasible
    const statueChoice = atlasPalette.getBlock(
        targetColour,
        atlasPalette.createBlockCollection([]),
        EFaceVisibility.None,
        0,
        'character-statue',
    );
    expect(statueChoice.name).toBe('minecraft:lime_concrete');
});

test('Character Statue algorithm preserves vivid neon superhero saturation and lightness contours', () => {
    // Vibrant superhero neon blue voxel: candidate A is washed out dull stone, candidate B is vivid blue concrete
    const blockData = [
        {
            name: 'minecraft:light_gray_concrete',
            colour: { r: 0.55, g: 0.55, b: 0.58, a: 1 },
        },
        {
            name: 'minecraft:blue_concrete',
            colour: { r: 0.18, g: 0.25, b: 0.72, a: 1 },
        },
    ];
    const atlasBlocks = new Map<string, typeof blockData[number]>();
    blockData.forEach((block) => atlasBlocks.set(block.name, block));
    const atlas = {
        getBlocks: () => atlasBlocks,
        hasBlock: (name: string) => atlasBlocks.has(name),
    };

    const palette = Palette.create();
    palette.add(['minecraft:light_gray_concrete', 'minecraft:blue_concrete']);
    const atlasPalette = new AtlasPalette(atlas as any, palette);
    const vividBlue = RGBAUtil.bin({
        r: 0.15,
        g: 0.20,
        b: 0.85,
        a: 1,
    }, 255);

    const statueChoice = atlasPalette.getBlock(
        vividBlue,
        atlasPalette.createBlockCollection([]),
        EFaceVisibility.None,
        0,
        'character-statue',
    );
    expect(statueChoice.name).toBe('minecraft:blue_concrete');
});
