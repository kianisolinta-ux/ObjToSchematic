/**
 * @jest-environment jsdom
 */

import * as nbt from 'prismarine-nbt';
import { TextDecoder, TextEncoder } from 'util';
import { gunzipSync } from 'zlib';

if (typeof (globalThis as any).TextDecoder === 'undefined') {
    (globalThis as any).TextDecoder = TextDecoder;
}
if (typeof (globalThis as any).TextEncoder === 'undefined') {
    (globalThis as any).TextEncoder = TextEncoder;
}

import { BlockMesh } from '../src/block_mesh';
import { Bounds } from '../src/bounds';
import { Litematic } from '../src/exporters/litematic_exporter';
import { Localiser } from '../src/localiser';
import { Renderer } from '../src/renderer';
import { PreviewComponent } from '../src/ui/components/preview';
import { Vector3 } from '../src/vector';
import { TEST_PREAMBLE } from './preamble';

TEST_PREAMBLE();

beforeAll(async () => {
    await Localiser.Get.init();
});

test('Step 5: BlockMesh.replaceBlockType swaps blocks directly and updates summary', () => {
    const stone = { name: 'minecraft:stone', colour: { r: 0.5, g: 0.5, b: 0.5, a: 1 }, faces: {} as any };
    const diorite = { name: 'minecraft:diorite', colour: { r: 0.8, g: 0.8, b: 0.8, a: 1 }, faces: {} as any };
    const oakPlanks = { name: 'minecraft:oak_planks', colour: { r: 0.64, g: 0.51, b: 0.31, a: 1 }, faces: {} as any };
    const blockMap = new Map<string, any>([
        [stone.name, stone],
        [diorite.name, diorite],
        [oakPlanks.name, oakPlanks],
    ]);
    const atlas = { getBlocks: () => blockMap };

    const blockMesh = Object.create(BlockMesh.prototype) as any;
    blockMesh._atlas = atlas;
    blockMesh._blocks = new Map();
    blockMesh._blocksUsed = new Set(['minecraft:stone', 'minecraft:diorite']);
    blockMesh._bufferChunks = [{ dummy: true }];
    blockMesh._voxelMesh = {
        getBounds: () => new Bounds(new Vector3(0, 0, 0), new Vector3(2, 0, 0)),
    };

    blockMesh._blocks.set(new Vector3(0, 0, 0).hash(), {
        voxel: { position: new Vector3(0, 0, 0), colour: stone.colour },
        blockInfo: { name: stone.name, colour: stone.colour, faces: stone.faces },
    });
    blockMesh._blocks.set(new Vector3(1, 0, 0).hash(), {
        voxel: { position: new Vector3(1, 0, 0), colour: stone.colour },
        blockInfo: { name: stone.name, colour: stone.colour, faces: stone.faces },
    });
    blockMesh._blocks.set(new Vector3(2, 0, 0).hash(), {
        voxel: { position: new Vector3(2, 0, 0), colour: diorite.colour },
        blockInfo: { name: diorite.name, colour: diorite.colour, faces: diorite.faces },
    });

    const res = BlockMesh.prototype.replaceBlockType.call(blockMesh, 'minecraft:stone', 'oak_planks');
    expect(res.replacedCount).toBe(2);
    expect(res.targetName).toBe('minecraft:oak_planks');
    expect(blockMesh._bufferChunks).toEqual([]);

    const summary = BlockMesh.prototype.getBlockSummary.call(blockMesh);
    expect(summary.total).toBe(3);
    expect(summary.unique).toBe(2);
    expect(summary.blocks.map((b: any) => `${b.name}:${b.count}`)).toEqual([
        'minecraft:oak_planks:2',
        'minecraft:diorite:1',
    ]);
});

test('Step 5: Litematic export rotates dimensions, anchor Position, and wall_torch facing', async () => {
    const blockMesh = Object.create(BlockMesh.prototype) as any;
    blockMesh._blocks = new Map();
    blockMesh._blocksUsed = new Set();
    blockMesh._voxelMesh = {
        getBounds: () => new Bounds(new Vector3(0, 0, 0), new Vector3(10, 4, 4)),
    };
    const stone = {
        name: 'minecraft:stone',
        colour: { r: 0.5, g: 0.5, b: 0.5, a: 1 },
        faces: {} as any,
    };
    const torch = {
        name: 'minecraft:wall_torch[facing=north]',
        colour: { r: 1, g: 0.9, b: 0.3, a: 1 },
        faces: {} as any,
    };
    blockMesh._blocks.set(new Vector3(0, 0, 0).hash(), {
        voxel: { position: new Vector3(0, 0, 0), colour: stone.colour },
        blockInfo: stone,
    });
    blockMesh._blocks.set(new Vector3(10, 4, 4).hash(), {
        voxel: { position: new Vector3(10, 4, 4), colour: torch.colour },
        blockInfo: torch,
    });

    const exporter = new Litematic();
    const out = exporter.export(blockMesh, {
        name: 'RotTest',
        regionName: 'Main',
        anchor: 'center-base',
        rotationY: 90,
        timestampMs: 1700000000000,
    });

    expect(out.type).toBe('single');
    if (out.type === 'single') {
        const parsed = await nbt.parse(gunzipSync(out.content));
        const region: any = (parsed.parsed.value.Regions?.value as any).Main.value;
        // Original size: 11x5x5 -> rotated 90 CW -> 5x5x11
        expect(region.Size.value.x.value).toBe(5);
        expect(region.Size.value.y.value).toBe(5);
        expect(region.Size.value.z.value).toBe(11);
        // Center base of 5x5x11 -> (-2, 0, -5)
        expect(region.Position.value.x.value).toBe(-2);
        expect(region.Position.value.y.value).toBe(0);
        expect(region.Position.value.z.value).toBe(-5);

        const palette: any[] = region.BlockStatePalette.value.value;
        const torchEntry = palette.find((p) => p.Name?.value === 'minecraft:wall_torch');
        expect(torchEntry).toBeDefined();
        expect(torchEntry.Properties.value.facing.value).toBe('east');
    }
});

test('Step 5: PreviewComponent switches cleanly between All and active Slice Layer counts', () => {
    const prevInstance = (Renderer as any)._instance;
    (Renderer as any)._instance = {
        setSelectedBlockNames: jest.fn(),
        getActiveMeshType: jest.fn().mockReturnValue(2),
        isSliceViewerEnabled: jest.fn().mockReturnValue(true),
        getSliceLayerStats: jest.fn().mockReturnValue({
            layerNumber: 2,
            totalLayers: 4,
            sliceY: 1,
            minY: 0,
            maxY: 3,
            blocksOnLayer: 5,
            blocksUpToLayer: 12,
            totalBlocks: 40,
        }),
        getSliceLayerBlockSummary: jest.fn().mockReturnValue({
            sliceY: 1,
            total: 5,
            unique: 1,
            blocks: [{ name: 'minecraft:oak_planks', count: 5, hexColour: '#a2824e', percentage: 100 }],
        }),
    };

    try {
        const previewComp = new PreviewComponent();
        document.body.innerHTML = previewComp.generateHTML();
        previewComp.registerEvents();
        previewComp.finalise();

        previewComp.updateSummary({
            total: 40,
            unique: 2,
            blocks: [
                { name: 'minecraft:stone', count: 35, hexColour: '#888888', percentage: 87.5 },
                { name: 'minecraft:oak_planks', count: 5, hexColour: '#a2824e', percentage: 12.5 },
            ],
        });

        const compId = (previewComp as any)._getId();
        const totalEl = () => document.getElementById(`${compId}-stats-total`)?.textContent || '';
        expect(totalEl()).toContain('40');

        const layerBtn = document.getElementById(`${compId}-scope-layer`) as HTMLButtonElement;
        layerBtn.click();
        expect(totalEl()).toContain('5');
        expect(document.getElementById(`${compId}-list`)?.textContent).toContain('oak_planks');
        expect(document.getElementById(`${compId}-list`)?.textContent).not.toContain('stone');

        const allBtn = document.getElementById(`${compId}-scope-all`) as HTMLButtonElement;
        allBtn.click();
        expect(totalEl()).toContain('40');
    } finally {
        (Renderer as any)._instance = prevInstance;
    }
});
