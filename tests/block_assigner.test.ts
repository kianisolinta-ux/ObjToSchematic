import { Atlas } from '../src/atlas';
import { AtlasPalette, EFaceVisibility } from '../src/block_assigner';
import { RGBAUtil } from '../src/colour';
import { Palette } from '../src/palette';

test('Color Chart Match selects a block using the Color Chart perceptual metric', () => {
    const atlas = Atlas.load('vanilla');
    if (atlas === undefined) {
        throw new Error('Could not load the vanilla atlas');
    }

    const palette = Palette.create();
    palette.add(['minecraft:gold_block', 'minecraft:oak_planks']);
    const atlasPalette = new AtlasPalette(atlas, palette);
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
