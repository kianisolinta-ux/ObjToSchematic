/**
 * @jest-environment jsdom
 */

import { Atlas, TAtlasBlock } from '../src/atlas';
import { AtlasPalette, EFaceVisibility } from '../src/block_assigner';
import { BlockMesh } from '../src/block_mesh';
import { Localiser } from '../src/localiser';
import { Renderer } from '../src/renderer';
import { PreviewComponent } from '../src/ui/components/preview';
import { UI } from '../src/ui/layout';
import { ColourSpace, UV } from '../src/util';
import { Vector3 } from '../src/vector';
import { VoxelMesh } from '../src/voxel_mesh';
import { TEST_PREAMBLE } from './preamble';

TEST_PREAMBLE();

beforeAll(async () => {
    await Localiser.Get.init();
});

function makeMockAtlasBlock(name: string, r: number, g: number, b: number): TAtlasBlock {
    const face = { name, texcoord: new UV(0, 0), colour: { r, g, b, a: 1 }, std: 0.02 };
    return {
        name,
        colour: { r, g, b, a: 1 },
        faces: {
            up: face,
            down: face,
            north: face,
            east: face,
            south: face,
            west: face,
        },
    };
}

test('Step 6: AtlasPalette uses linear-light contextual face averaging and exposes getContextualFaceColour', () => {
    const darkFace = { name: 'top', texcoord: new UV(0, 0), colour: { r: 0, g: 0, b: 0, a: 1 }, std: 0.01 };
    const brightFace = { name: 'side', texcoord: new UV(0, 0), colour: { r: 1, g: 1, b: 1, a: 1 }, std: 0.03 };
    const block: TAtlasBlock = {
        name: 'minecraft:test_dual',
        colour: { r: 0.2, g: 0.2, b: 0.2, a: 1 },
        faces: {
            up: darkFace,
            down: darkFace,
            north: brightFace,
            east: darkFace,
            south: darkFace,
            west: darkFace,
        },
    };

    const twoFace = AtlasPalette.getContextualFaceColour(block, EFaceVisibility.Up | EFaceVisibility.North);
    expect(twoFace.r).toBeGreaterThan(0.72);
    expect(twoFace.r).toBeLessThan(0.75);
    expect(AtlasPalette.getContextualFaceColour(block, EFaceVisibility.None)).toEqual(block.colour);
});

test('Step 6: BlockMesh Assign supports edge-aware error-diffusion, brightness/saturation adjust, and maxBlockTypes cap', () => {
    const mockBlocks = new Map<string, TAtlasBlock>([
        ['minecraft:red_concrete', makeMockAtlasBlock('minecraft:red_concrete', 0.56, 0.13, 0.13)],
        ['minecraft:crimson_planks', makeMockAtlasBlock('minecraft:crimson_planks', 0.40, 0.19, 0.27)],
        ['minecraft:blue_concrete', makeMockAtlasBlock('minecraft:blue_concrete', 0.17, 0.18, 0.56)],
        ['minecraft:lime_concrete', makeMockAtlasBlock('minecraft:lime_concrete', 0.37, 0.66, 0.09)],
        ['minecraft:yellow_concrete', makeMockAtlasBlock('minecraft:yellow_concrete', 0.94, 0.69, 0.08)],
        ['minecraft:white_concrete', makeMockAtlasBlock('minecraft:white_concrete', 0.81, 0.84, 0.84)],
        ['minecraft:pink_concrete', makeMockAtlasBlock('minecraft:pink_concrete', 0.84, 0.40, 0.56)],
        ['minecraft:stone', makeMockAtlasBlock('minecraft:stone', 0.49, 0.49, 0.49)],
    ]);
    const spyAtlas = jest.spyOn(Atlas, 'load').mockReturnValue({
        getBlocks: () => mockBlocks,
        hasBlock: (n: string) => mockBlocks.has(n),
    } as unknown as Atlas);

    try {
        const voxelMesh = new VoxelMesh({ voxelOverlapRule: 'dominant', enableAmbientOcclusion: false });
        voxelMesh.addVoxel(new Vector3(0, 0, 0), { r: 0.72, g: 0.12, b: 0.12, a: 1 });
        voxelMesh.addVoxel(new Vector3(1, 0, 0), { r: 0.74, g: 0.14, b: 0.14, a: 1 });
        voxelMesh.addVoxel(new Vector3(0, 0, 1), { r: 0.12, g: 0.15, b: 0.72, a: 1 });
        voxelMesh.addVoxel(new Vector3(1, 0, 1), { r: 0.15, g: 0.72, b: 0.18, a: 1 });
        voxelMesh.addVoxel(new Vector3(0, 1, 0), { r: 0.90, g: 0.88, b: 0.20, a: 1 });
        voxelMesh.addVoxel(new Vector3(1, 1, 0), { r: 0.85, g: 0.85, b: 0.85, a: 1 });

        const mesh = BlockMesh.createFromVoxelMesh(voxelMesh, {
            textureAtlas: 'vanilla',
            blockPalette: Array.from(mockBlocks.keys()),
            blockSelectionAlgorithm: 'color-chart-match',
            dithering: 'error-diffusion',
            ditheringMagnitude: 24,
            colourSpace: ColourSpace.RGB,
            resolution: 16,
            contextualAveraging: true,
            errorWeight: 0.1,
            blockFilter: false,
            blockFilterThreshold: 20,
            fallable: 'do-nothing',
            calculateLighting: false,
            lightThreshold: 7,
            lightingPlacement: 'ordered',
            lightingScope: 'darkness',
            lightingLightBlock: 'auto',
            brightnessOffset: 10,
            saturationOffset: 15,
            maxBlockTypes: 3,
        });

        const summary = mesh.getBlockSummary();
        expect(summary.total).toBe(6);
        expect(summary.unique).toBeLessThanOrEqual(3);

        // Edge-aware guard: saturated red next to neutral white should not tint white pink even under strong dithering
        const seamMesh = new VoxelMesh({ voxelOverlapRule: 'average', enableAmbientOcclusion: false });
        seamMesh.addVoxel(new Vector3(0, 0, 0), { r: 0.85, g: 0.05, b: 0.05, a: 1 });
        seamMesh.addVoxel(new Vector3(1, 0, 0), { r: 0.82, g: 0.84, b: 0.84, a: 1 });
        const seamBlockMesh = BlockMesh.createFromVoxelMesh(seamMesh, {
            textureAtlas: 'vanilla',
            blockPalette: ['minecraft:red_concrete', 'minecraft:white_concrete', 'minecraft:pink_concrete'],
            blockSelectionAlgorithm: 'color-chart-match',
            dithering: 'error-diffusion',
            ditheringMagnitude: 64,
            colourSpace: ColourSpace.RGB,
            resolution: 64,
            contextualAveraging: true,
            errorWeight: 0.0,
            blockFilter: false,
            blockFilterThreshold: 20,
            fallable: 'do-nothing',
            calculateLighting: false,
            lightThreshold: 7,
            lightingPlacement: 'ordered',
            lightingScope: 'darkness',
            lightingLightBlock: 'auto',
            brightnessOffset: 0,
            saturationOffset: 0,
            maxBlockTypes: 0,
        });
        expect((seamBlockMesh as any)._blocks.get(new Vector3(1, 0, 0).hash()).blockInfo.name).toBe('minecraft:white_concrete');
    } finally {
        spyAtlas.mockRestore();
    }
});

test('Step 6: BlockMesh smart replace supports hidden/surface scopes, batch auto-palette with neighbour cohesion, and undo', () => {
    const stone = { name: 'minecraft:stone', colour: { r: 0.5, g: 0.5, b: 0.5, a: 1 }, faces: {} as any };
    const deepslate = { name: 'minecraft:deepslate', colour: { r: 0.35, g: 0.35, b: 0.38, a: 1 }, faces: {} as any };
    const diorite = { name: 'minecraft:diorite', colour: { r: 0.82, g: 0.82, b: 0.82, a: 1 }, faces: {} as any };
    const dirt = { name: 'minecraft:dirt', colour: { r: 0.55, g: 0.38, b: 0.25, a: 1 }, faces: {} as any };
    const blockMap = new Map<string, any>([
        [stone.name, stone],
        [deepslate.name, deepslate],
        [diorite.name, diorite],
        [dirt.name, dirt],
    ]);

    const blockMesh = Object.create(BlockMesh.prototype) as any;
    blockMesh._atlas = { getBlocks: () => blockMap };
    blockMesh._blocks = new Map();
    blockMesh._blocksUsed = new Set(['minecraft:stone']);
    blockMesh._bufferChunks = [];

    // 3x3x3 cube of stone -> 1 interior hidden voxel at (1,1,1), 26 surface voxels
    for (let x = 0; x <= 2; ++x) {
        for (let y = 0; y <= 2; ++y) {
            for (let z = 0; z <= 2; ++z) {
                const pos = new Vector3(x, y, z);
                const voxColour = (x === 1 && y === 1 && z === 1) ? dirt.colour : stone.colour;
                blockMesh._blocks.set(pos.hash(), {
                    voxel: { position: pos, colour: voxColour },
                    blockInfo: stone,
                });
            }
        }
    }

    const resHidden = BlockMesh.prototype.replaceBlockType.call(blockMesh, 'minecraft:stone', 'minecraft:deepslate', {
        scope: 'hidden',
        mode: 'swap',
    });
    expect(resHidden.replacedCount).toBe(1);
    expect(resHidden.canUndo).toBe(true);
    expect(blockMesh._blocks.get(new Vector3(1, 1, 1).hash()).blockInfo.name).toBe('minecraft:deepslate');
    expect(blockMesh._blocks.get(new Vector3(0, 0, 0).hash()).blockInfo.name).toBe('minecraft:stone');

    const resAuto = BlockMesh.prototype.replaceBlockType.call(blockMesh, 'minecraft:deepslate', '', {
        scope: 'hidden',
        mode: 'auto-palette',
        activePalette: ['minecraft:deepslate', 'minecraft:dirt', 'minecraft:diorite'],
    });
    expect(resAuto.replacedCount).toBe(1);
    expect(blockMesh._blocks.get(new Vector3(1, 1, 1).hash()).blockInfo.name).toBe('minecraft:dirt');

    // Surface scope only modifies outer shell (26 voxels) while leaving interior (1,1,1) as dirt
    const resSurface = BlockMesh.prototype.replaceBlockType.call(blockMesh, 'minecraft:stone', 'minecraft:diorite', {
        scope: 'surface',
        mode: 'swap',
    });
    expect(resSurface.replacedCount).toBe(26);
    expect(blockMesh._blocks.get(new Vector3(1, 1, 1).hash()).blockInfo.name).toBe('minecraft:dirt');
    expect(blockMesh._blocks.get(new Vector3(0, 0, 0).hash()).blockInfo.name).toBe('minecraft:diorite');

    // Batch sourceBlocks replaces multiple block types at once in auto-palette mode and undoes in one step
    const resBatch = BlockMesh.prototype.replaceBlockType.call(blockMesh, 'minecraft:dirt', '', {
        scope: 'all',
        mode: 'auto-palette',
        sourceBlocks: ['minecraft:dirt', 'minecraft:diorite'],
        activePalette: ['minecraft:stone', 'minecraft:deepslate', 'minecraft:dirt', 'minecraft:diorite'],
    });
    expect(resBatch.replacedCount).toBe(27);
    expect(resBatch.sourceName).toContain('(+1)');
    expect(blockMesh._blocks.get(new Vector3(0, 0, 0).hash()).blockInfo.name).toBe('minecraft:stone');

    const undoBatch = BlockMesh.prototype.undoLastReplace.call(blockMesh);
    expect(undoBatch.replacedCount).toBe(27);
    expect(blockMesh._blocks.get(new Vector3(0, 0, 0).hash()).blockInfo.name).toBe('minecraft:diorite');
    expect(blockMesh._blocks.get(new Vector3(1, 1, 1).hash()).blockInfo.name).toBe('minecraft:dirt');

    BlockMesh.prototype.undoLastReplace.call(blockMesh); // undo surface
    const undo1 = BlockMesh.prototype.undoLastReplace.call(blockMesh);
    expect(undo1.replacedCount).toBe(1);
    expect(undo1.canUndo).toBe(true);
    expect(blockMesh._blocks.get(new Vector3(1, 1, 1).hash()).blockInfo.name).toBe('minecraft:deepslate');

    const undo2 = BlockMesh.prototype.undoLastReplace.call(blockMesh);
    expect(undo2.replacedCount).toBe(1);
    expect(undo2.canUndo).toBe(false);
    expect(blockMesh._blocks.get(new Vector3(1, 1, 1).hash()).blockInfo.name).toBe('minecraft:stone');
});

test('Step 6: PreviewComponent ranks target blocks by Oklab similarity, supports surface scope, batch Auto-fit, and Undo', () => {
    const prevRenderer = (Renderer as any)._instance;
    const prevUI = (UI as any)._instance;
    (Renderer as any)._instance = {
        setSelectedBlockNames: jest.fn(),
        getActiveMeshType: jest.fn().mockReturnValue(2),
        isSliceViewerEnabled: jest.fn().mockReturnValue(false),
    };
    const replaceSpy = jest.fn();
    (UI as any)._instance = {
        getActivePaletteBlocks: () => ['minecraft:white_concrete', 'minecraft:stone', 'minecraft:diorite', 'minecraft:obsidian'],
        replaceBlockInModel: replaceSpy,
    };

    const spyHexMap = jest.spyOn(Atlas, 'getVanillaColourHexMap').mockReturnValue(new Map([
        ['minecraft:white_concrete', '#cfd5d6'],
        ['minecraft:stone', '#7d7d7d'],
        ['minecraft:diorite', '#bcbcbc'],
        ['minecraft:obsidian', '#14121d'],
    ]));

    try {
        const previewComp = new PreviewComponent();
        document.body.innerHTML = previewComp.generateHTML();
        previewComp.registerEvents();
        previewComp.finalise();

        previewComp.updateSummary({
            total: 20,
            unique: 2,
            blocks: [
                { name: 'minecraft:white_wool', count: 15, hexColour: '#e9ecec', percentage: 75 },
                { name: 'minecraft:black_wool', count: 5, hexColour: '#141519', percentage: 25 },
            ],
        });

        const compId = (previewComp as any)._getId();
        const dstSelect = document.getElementById(`${compId}-replace-dst`) as HTMLSelectElement;
        const firstOptgroup = dstSelect.querySelector('optgroup');
        expect(firstOptgroup?.label).toBeTruthy();
        expect(firstOptgroup?.children.length).toBeGreaterThan(0);
        // Top match for white_wool should include % similarity and favour white/light blocks over obsidian
        const firstOption = firstOptgroup!.children[0] as HTMLOptionElement;
        expect(firstOption.textContent).toMatch(/\(\d+%\)/);
        expect(firstOption.value).not.toBe('minecraft:obsidian');

        // Switching source to black_wool updates target dropdown dynamically
        const srcSelect = document.getElementById(`${compId}-replace-src`) as HTMLSelectElement;
        srcSelect.value = 'minecraft:black_wool';
        srcSelect.dispatchEvent(new Event('change'));
        const updatedFirstOpt = (document.getElementById(`${compId}-replace-dst`) as HTMLSelectElement)
            .querySelector('optgroup option') as HTMLOptionElement;
        expect(updatedFirstOpt.value).toBe('minecraft:obsidian');

        const undoBtn = document.getElementById(`${compId}-replace-undo-btn`) as HTMLButtonElement;
        expect(undoBtn.disabled).toBe(true);
        previewComp.setCanUndoReplace(true);
        expect(undoBtn.disabled).toBe(false);

        const scopeSel = document.getElementById(`${compId}-replace-scope`) as HTMLSelectElement;
        expect(scopeSel.querySelector('option[value="surface"]')).not.toBeNull();
        scopeSel.value = 'hidden';
        scopeSel.dispatchEvent(new Event('change'));

        const autoBtn = document.getElementById(`${compId}-replace-auto-btn`) as HTMLButtonElement;
        autoBtn.click();
        expect(replaceSpy).toHaveBeenCalledWith('minecraft:black_wool', '', {
            scope: 'hidden',
            mode: 'auto-palette',
        });

        // Checking 2 blocks switches both Auto-fit and Replace labels to show count and runs batch sourceBlocks
        const checkboxes = document.querySelectorAll<HTMLInputElement>('.preview-block-checkbox');
        checkboxes.forEach((cb) => {
            cb.checked = true;
            cb.dispatchEvent(new Event('change', { bubbles: true }));
        });
        expect(autoBtn.textContent).toContain('(2)');
        const replaceBtn = document.getElementById(`${compId}-replace-btn`) as HTMLButtonElement;
        expect(replaceBtn.textContent).toContain('(2)');

        scopeSel.value = 'surface';
        scopeSel.dispatchEvent(new Event('change'));
        autoBtn.click();
        expect(replaceSpy).toHaveBeenLastCalledWith('minecraft:white_wool', '', {
            scope: 'surface',
            mode: 'auto-palette',
            sourceBlocks: ['minecraft:white_wool', 'minecraft:black_wool'],
        });

        replaceBtn.click();
        expect(replaceSpy).toHaveBeenLastCalledWith('minecraft:white_wool', dstSelect.value, {
            scope: 'surface',
            mode: 'swap',
            sourceBlocks: ['minecraft:white_wool', 'minecraft:black_wool'],
        });

        undoBtn.click();
        expect(replaceSpy).toHaveBeenLastCalledWith('', '', { mode: 'undo' });
    } finally {
        spyHexMap.mockRestore();
        (Renderer as any)._instance = prevRenderer;
        (UI as any)._instance = prevUI;
    }
});

test('Step 6: _pruneRareOutlierBlocks enforces fallable replacement and batch swap skips identical targets', () => {
    const blockMesh = Object.create(BlockMesh.prototype) as any;
    const stone = makeMockAtlasBlock('minecraft:stone', 0.5, 0.5, 0.5);
    const sand = makeMockAtlasBlock('minecraft:sand', 0.85, 0.80, 0.62);
    const birch = makeMockAtlasBlock('minecraft:birch_planks', 0.78, 0.70, 0.45);
    const redWool = makeMockAtlasBlock('minecraft:red_wool', 0.65, 0.15, 0.15);

    blockMesh._atlas = {
        getBlocks: () => new Map([
            [stone.name, stone],
            [sand.name, sand],
            [birch.name, birch],
            [redWool.name, redWool],
        ]),
    };
    blockMesh._blocks = new Map();
    blockMesh._blocksUsed = new Set([sand.name, stone.name, birch.name]);
    blockMesh._bufferChunks = [];

    let idx = 0;
    for (let i = 0; i < 60; ++i) {
        const p = new Vector3(idx++, 0, 0);
        blockMesh._blocks.set(p.hash(), { voxel: { position: p, colour: sand.colour }, blockInfo: sand });
    }
    for (let i = 0; i < 38; ++i) {
        const p = new Vector3(idx++, 0, 0);
        blockMesh._blocks.set(p.hash(), { voxel: { position: p, colour: stone.colour }, blockInfo: stone });
    }
    for (let i = 0; i < 2; ++i) {
        const p = new Vector3(idx++, 0, 0);
        // Colour closer to sand, yet replace-fallable must pick non-fallable dominant stone
        blockMesh._blocks.set(p.hash(), { voxel: { position: p, colour: birch.colour }, blockInfo: birch });
    }

    const pruneRes = BlockMesh.prototype._pruneRareOutlierBlocks.call(blockMesh, 'replace-fallable');
    expect(pruneRes.prunedTypes).toBe(1);
    expect(pruneRes.prunedBlocks).toBe(2);
    expect(blockMesh._blocks.get(new Vector3(98, 0, 0).hash()).blockInfo.name).toBe('minecraft:stone');

    // Batch swap merging stone + sand -> stone skips voxels already stone (replacedCount = 60, not 100)
    const swapRes = BlockMesh.prototype.replaceBlockType.call(blockMesh, 'minecraft:sand', 'minecraft:stone', {
        scope: 'all',
        mode: 'swap',
        sourceBlocks: ['minecraft:stone', 'minecraft:sand'],
    });
    expect(swapRes.replacedCount).toBe(60);
});
