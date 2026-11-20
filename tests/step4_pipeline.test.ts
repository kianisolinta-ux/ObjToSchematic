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
import { Vector3 } from '../src/vector';
import { VoxelMesh } from '../src/voxel_mesh';
import { TEST_PREAMBLE } from './preamble';

TEST_PREAMBLE();

test('Step 4: VoxelMesh.removeFloatingIslands prunes stray voxels and tightens bounds before hollowing', () => {
    const vm = new VoxelMesh({ voxelOverlapRule: 'average', enableAmbientOcclusion: false });
    for (let x = 0; x < 4; ++x) {
        for (let y = 0; y < 4; ++y) {
            for (let z = 0; z < 4; ++z) {
                vm.addVoxel(new Vector3(x, y, z), { r: 0.7, g: 0.7, b: 0.7, a: 1 });
            }
        }
    }
    // Two distant floating noise specks
    vm.addVoxel(new Vector3(20, 20, 20), { r: 1, g: 0, b: 0, a: 1 });
    vm.addVoxel(new Vector3(21, 20, 20), { r: 1, g: 0, b: 0, a: 1 });
    expect(vm.getVoxelCount()).toBe(66);

    const cleaned = vm.removeFloatingIslands(4);
    expect(cleaned.removedCount).toBe(2);
    expect(cleaned.removedComponents).toBe(1);
    expect(cleaned.keptCount).toBe(64);
    expect(vm.getBounds().max.toArray()).toEqual([3, 3, 3]);

    const hollowed = vm.hollow(1);
    expect(hollowed.removedCount).toBe(8);
    expect(hollowed.keptCount).toBe(56);
});

test('Step 4: Litematic writes Regions[name].Position according to anchor option', async () => {
    const blockMesh = Object.create(BlockMesh.prototype) as any;
    blockMesh._blocks = new Map();
    blockMesh._blocksUsed = new Set();
    blockMesh._voxelMesh = {
        getBounds: () => new Bounds(new Vector3(0, 0, 0), new Vector3(10, 4, 8)),
    };
    const stone = {
        name: 'minecraft:stone',
        colour: { r: 0.5, g: 0.5, b: 0.5, a: 1 },
        faces: {} as any,
    };
    blockMesh._blocks.set(new Vector3(0, 0, 0).hash(), {
        voxel: { position: new Vector3(0, 0, 0), colour: stone.colour },
        blockInfo: stone,
    });
    blockMesh._blocks.set(new Vector3(10, 4, 8).hash(), {
        voxel: { position: new Vector3(10, 4, 8), colour: stone.colour },
        blockInfo: stone,
    });

    const exporter = new Litematic();
    const resCenterBase = exporter.export(blockMesh, {
        name: 'AnchorTest',
        regionName: 'MainRegion',
        anchor: 'center-base',
        timestampMs: 1700000000000,
    });
    expect(resCenterBase.type).toBe('single');
    if (resCenterBase.type === 'single') {
        const parsed = await nbt.parse(gunzipSync(resCenterBase.content));
        const pos: any = (parsed.parsed.value.Regions?.value as any).MainRegion.value.Position.value;
        // Size is 11x5x9 -> center-base = (-5, 0, -4)
        expect(pos.x.value).toBe(-5);
        expect(pos.y.value).toBe(0);
        expect(pos.z.value).toBe(-4);
    }

    const resCenter = exporter.export(blockMesh, {
        name: 'AnchorCenterTest',
        regionName: 'CenterRegion',
        anchor: 'center',
        timestampMs: 1700000000000,
    });
    if (resCenter.type === 'single') {
        const parsed = await nbt.parse(gunzipSync(resCenter.content));
        const pos: any = (parsed.parsed.value.Regions?.value as any).CenterRegion.value.Position.value;
        expect(pos.x.value).toBe(-5);
        expect(pos.y.value).toBe(-2);
        expect(pos.z.value).toBe(-4);
    }
});
