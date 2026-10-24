/**
 * @jest-environment jsdom
 */

import { PALETTE_ALL_RELEASE } from '../res/palettes/all';
import { Renderer } from '../src/renderer';
import { PaletteComponent } from '../src/ui/components/palette';
import { PreviewComponent } from '../src/ui/components/preview';
import { TEST_PREAMBLE } from './preamble';

describe('Preview and Palette Optimize Flow', () => {
    beforeAll(() => {
        TEST_PREAMBLE();
        (Renderer as any)._instance = {
            setSelectedBlockNames: jest.fn(),
            getActiveMeshType: jest.fn().mockReturnValue(2),
            clearBlockMesh: jest.fn(),
            setModelToUse: jest.fn(),
        };
    });

    test('PaletteComponent disableBlocks disables exact and normalized blocks', () => {
        const paletteComp = new PaletteComponent();
        document.body.innerHTML = paletteComp.generateHTML();
        paletteComp.registerEvents();
        paletteComp.finalise();

        expect(paletteComp.getValue().count()).toBe(PALETTE_ALL_RELEASE.length);

        // Try disabling 5 blocks (mix of exact and with/without prefix)
        const toDisable = [
            'minecraft:acacia_log',
            'birch_planks',
            'minecraft:black_concrete',
            'minecraft:smooth_stone',
            'calcite',
        ];

        const disabledCount = paletteComp.disableBlocks(toDisable);
        expect(disabledCount).toBe(5);
        expect(paletteComp.getValue().count()).toBe(PALETTE_ALL_RELEASE.length - 5);

        // Verify that disabled blocks are no longer in palette
        const remainingBlocks = paletteComp.getValue().getBlocks();
        expect(remainingBlocks).not.toContain('minecraft:acacia_log');
        expect(remainingBlocks).not.toContain('minecraft:birch_planks');
        expect(remainingBlocks).not.toContain('minecraft:black_concrete');
        expect(remainingBlocks).not.toContain('minecraft:smooth_stone');
        expect(remainingBlocks).not.toContain('minecraft:calcite');
    });

    test('PreviewComponent Take selection threshold logic', () => {
        const previewComp = new PreviewComponent();
        document.body.innerHTML = previewComp.generateHTML();
        previewComp.registerEvents();
        previewComp.finalise();

        const sampleSummary = {
            total: 1000,
            unique: 5,
            blocks: [
                { name: 'minecraft:stone', count: 700, hexColour: '#888888', percentage: 70.0 },
                { name: 'minecraft:dirt', count: 200, hexColour: '#664422', percentage: 20.0 },
                { name: 'minecraft:cobblestone', count: 80, hexColour: '#777777', percentage: 8.0 },
                { name: 'minecraft:gravel', count: 15, hexColour: '#aaaaaa', percentage: 1.5 },
                { name: 'minecraft:sand', count: 5, hexColour: '#eedd99', percentage: 0.5 },
            ],
        };

        previewComp.updateSummary(sampleSummary);

        // Access private fields/methods for testing
        const comp = previewComp as any;

        // Initially no checkboxes are checked
        expect(comp._checkedBlocks.size).toBe(0);

        // Set threshold to 2.0% and click Take
        comp._setThreshold(2.0);
        comp._handleTake();

        // Should select gravel (1.5%) and sand (0.5%), total 2 blocks
        expect(comp._checkedBlocks.size).toBe(2);
        expect(comp._checkedBlocks.has('minecraft:gravel')).toBe(true);
        expect(comp._checkedBlocks.has('minecraft:sand')).toBe(true);

        // Changing Min without clicking Take must NOT change checked blocks
        comp._setThreshold(0.2);
        expect(comp._checkedBlocks.size).toBe(2);

        // Now clicking Take with Min = 0.2% should first clear, then reselect:
        // No blocks < 0.2%, so 0 blocks
        comp._handleTake();
        expect(comp._checkedBlocks.size).toBe(0);

        // Now set to 10% and Take
        comp._setThreshold(10.0);
        comp._handleTake();
        // Cobblestone (8%), gravel (1.5%), sand (0.5%) -> 3 blocks
        expect(comp._checkedBlocks.size).toBe(3);
        expect(comp._checkedBlocks.has('minecraft:cobblestone')).toBe(true);
        expect(comp._checkedBlocks.has('minecraft:gravel')).toBe(true);
        expect(comp._checkedBlocks.has('minecraft:sand')).toBe(true);
    });

    test('PaletteComponent disableBlocks handles all atlas variant suffixes cleanly', () => {
        const paletteComp = new PaletteComponent();
        document.body.innerHTML = paletteComp.generateHTML();
        paletteComp.registerEvents();
        paletteComp.finalise();

        const variantsToDisable = [
            'minecraft:oak_log_horizontal',
            'minecraft:smooth_stone_slab_double',
            'minecraft:frosted_ice_0',
            'minecraft:suspicious_sand_2',
            'minecraft:suspicious_gravel_1',
            'minecraft:quartz_pillar_horizontal',
            'minecraft:purpur_pillar_horizontal',
        ];

        const disabledCount = paletteComp.disableBlocks(variantsToDisable);
        expect(disabledCount).toBe(7);

        const remaining = paletteComp.getValue().getBlocks();
        expect(remaining).not.toContain('minecraft:oak_log');
        expect(remaining).not.toContain('minecraft:smooth_stone');
        expect(remaining).not.toContain('minecraft:ice');
        expect(remaining).not.toContain('minecraft:sand');
        expect(remaining).not.toContain('minecraft:gravel');
        expect(remaining).not.toContain('minecraft:quartz_pillar');
        expect(remaining).not.toContain('minecraft:purpur_pillar');
    });

    test('PreviewComponent manual checkbox change event adds and removes from _checkedBlocks', () => {
        const previewComp = new PreviewComponent();
        document.body.innerHTML = previewComp.generateHTML();
        previewComp.registerEvents();
        previewComp.finalise();

        previewComp.updateSummary({
            total: 100,
            unique: 2,
            blocks: [
                { name: 'minecraft:white_wool', count: 60, hexColour: '#ffffff', percentage: 60.0 },
                { name: 'minecraft:black_wool', count: 40, hexColour: '#000000', percentage: 40.0 },
            ],
        });

        const comp = previewComp as any;
        expect(comp._checkedBlocks.size).toBe(0);

        const checkboxes = document.querySelectorAll<HTMLInputElement>('.preview-block-checkbox');
        expect(checkboxes.length).toBe(2);

        // Manually check white_wool
        checkboxes[0].checked = true;
        checkboxes[0].dispatchEvent(new Event('change', { bubbles: true }));

        expect(comp._checkedBlocks.size).toBe(1);
        expect(comp._checkedBlocks.has('minecraft:white_wool')).toBe(true);

        // Manually check black_wool
        checkboxes[1].checked = true;
        checkboxes[1].dispatchEvent(new Event('change', { bubbles: true }));

        expect(comp._checkedBlocks.size).toBe(2);
        expect(comp._checkedBlocks.has('minecraft:black_wool')).toBe(true);

        // Manually uncheck white_wool
        checkboxes[0].checked = false;
        checkboxes[0].dispatchEvent(new Event('change', { bubbles: true }));

        expect(comp._checkedBlocks.size).toBe(1);
        expect(comp._checkedBlocks.has('minecraft:white_wool')).toBe(false);
        expect(comp._checkedBlocks.has('minecraft:black_wool')).toBe(true);
    });
});

