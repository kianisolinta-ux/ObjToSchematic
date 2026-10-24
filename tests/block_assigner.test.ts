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
    const atlasBlocks = new Map(blockData.map((block) => [block.name, block]));
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
