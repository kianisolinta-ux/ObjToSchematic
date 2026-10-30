import { BlockMesh } from '../src/block_mesh';
import { BlockMeshLighting } from '../src/lighting';
import { Vector3 } from '../src/vector';
import { NBTExporter } from '../src/exporters/nbt_exporter';
import { Litematic } from '../src/exporters/litematic_exporter';

describe('Lighting Settings and Torch Placement', () => {
    function createMockBlockMesh() {
        const blockMesh = Object.create(BlockMesh.prototype) as any;
        blockMesh._blocks = new Map();
        blockMesh._blocksUsed = new Set();
        blockMesh._atlas = {
            getBlocks: () => new Map([
                ['minecraft:stone', { name: 'minecraft:stone', colour: { r: 0.5, g: 0.5, b: 0.5, a: 1 }, faces: {} as any }],
                ['minecraft:glowstone', { name: 'minecraft:glowstone', colour: { r: 0.9, g: 0.8, b: 0.3, a: 1 }, faces: {} as any }],
                ['minecraft:sea_lantern', { name: 'minecraft:sea_lantern', colour: { r: 0.7, g: 0.9, b: 0.9, a: 1 }, faces: {} as any }],
            ]),
        };
        blockMesh._voxelMesh = {
            getBounds: () => ({
                min: new Vector3(0, 0, 0),
                max: new Vector3(10, 10, 10),
                getDimensions: () => new Vector3(10, 10, 10),
            }),
            getVoxelAt: (pos: Vector3) => ({ position: pos, colour: { r: 0.5, g: 0.5, b: 0.5, a: 1 } }),
        };
        blockMesh._lighting = new BlockMeshLighting(blockMesh);
        return blockMesh;
    }

    test('isSurfaceBlock correctly detects surface vs interior blocks', () => {
        const blockMesh = createMockBlockMesh();

        // 3x3x3 solid cube
        for (let x = 0; x < 3; ++x) {
            for (let y = 0; y < 3; ++y) {
                for (let z = 0; z < 3; ++z) {
                    const pos = new Vector3(x, y, z);
                    blockMesh._blocks.set(pos.hash(), {
                        voxel: { position: pos, colour: { r: 0.5, g: 0.5, b: 0.5, a: 1 } },
                        blockInfo: { name: 'minecraft:stone', colour: { r: 0.5, g: 0.5, b: 0.5, a: 1 }, faces: {} as any },
                    });
                }
            }
        }

        // Center (1, 1, 1) is completely surrounded by neighbors -> NOT surface
        expect(blockMesh.isSurfaceBlock(new Vector3(1, 1, 1))).toBe(false);

        // Corner (0, 0, 0) and face centers (1, 1, 2) have air neighbors -> ARE surface
        expect(blockMesh.isSurfaceBlock(new Vector3(0, 0, 0))).toBe(true);
        expect(blockMesh.isSurfaceBlock(new Vector3(1, 1, 2))).toBe(true);
    });

    test('torch placement creates floor torch when air is above', () => {
        const blockMesh = createMockBlockMesh();
        const basePos = new Vector3(2, 2, 2);
        blockMesh._blocks.set(basePos.hash(), {
            voxel: { position: basePos, colour: { r: 0.5, g: 0.5, b: 0.5, a: 1 } },
            blockInfo: { name: 'minecraft:stone', colour: { r: 0.5, g: 0.5, b: 0.5, a: 1 }, faces: {} as any },
        });

        const result = blockMesh.setLightBlock(basePos, 'minecraft:torch');
        expect(result.placed).toBe(true);
        expect(result.position).toEqual(new Vector3(2, 3, 2));

        // Original block at (2, 2, 2) remains solid stone
        const baseBlock = blockMesh.getBlockAt(basePos);
        expect(baseBlock).toBeDefined();
        expect(baseBlock.blockInfo.name).toBe('minecraft:stone');

        // Added block above at (2, 3, 2) is floor torch
        const torchBlock = blockMesh.getBlockAt(new Vector3(2, 3, 2));
        expect(torchBlock).toBeDefined();
        expect(torchBlock.blockInfo.name).toBe('minecraft:torch');
        expect(blockMesh.getBlockPalette()).toContain('minecraft:torch');
    });

    test('torch placement creates wall torch when space above is occupied', () => {
        const blockMesh = createMockBlockMesh();
        const basePos = new Vector3(2, 2, 2);
        const ceilingPos = new Vector3(2, 3, 2);

        blockMesh._blocks.set(basePos.hash(), {
            voxel: { position: basePos, colour: { r: 0.5, g: 0.5, b: 0.5, a: 1 } },
            blockInfo: { name: 'minecraft:stone', colour: { r: 0.5, g: 0.5, b: 0.5, a: 1 }, faces: {} as any },
        });
        blockMesh._blocks.set(ceilingPos.hash(), {
            voxel: { position: ceilingPos, colour: { r: 0.5, g: 0.5, b: 0.5, a: 1 } },
            blockInfo: { name: 'minecraft:stone', colour: { r: 0.5, g: 0.5, b: 0.5, a: 1 }, faces: {} as any },
        });

        const result = blockMesh.setLightBlock(basePos, 'minecraft:torch');
        expect(result.placed).toBe(true);
        // Space above is occupied, attaches to south side (+z): (2, 2, 3)
        expect(result.position).toEqual(new Vector3(2, 2, 3));

        const wallTorchBlock = blockMesh.getBlockAt(new Vector3(2, 2, 3));
        expect(wallTorchBlock).toBeDefined();
        expect(wallTorchBlock.blockInfo.name).toBe('minecraft:wall_torch[facing=south]');
    });

    test('setting specific emissive block replaces the block', () => {
        const blockMesh = createMockBlockMesh();
        const pos = new Vector3(1, 1, 1);
        blockMesh._blocks.set(pos.hash(), {
            voxel: { position: pos, colour: { r: 0.5, g: 0.5, b: 0.5, a: 1 } },
            blockInfo: { name: 'minecraft:stone', colour: { r: 0.5, g: 0.5, b: 0.5, a: 1 }, faces: {} as any },
        });

        const result = blockMesh.setLightBlock(pos, 'minecraft:sea_lantern');
        expect(result.placed).toBe(true);
        expect(result.position).toEqual(pos);

        const block = blockMesh.getBlockAt(pos);
        expect(block.blockInfo.name).toBe('minecraft:sea_lantern');
    });

    test('setting auto light block places minecraft:glowstone (not magma)', () => {
        const blockMesh = createMockBlockMesh();
        const pos = new Vector3(1, 1, 1);
        blockMesh._blocks.set(pos.hash(), {
            voxel: { position: pos, colour: { r: 0.1, g: 0.1, b: 0.1, a: 1 } },
            blockInfo: { name: 'minecraft:stone', colour: { r: 0.5, g: 0.5, b: 0.5, a: 1 }, faces: {} as any },
        });

        const result = blockMesh.setLightBlock(pos, 'auto');
        expect(result.placed).toBe(true);
        expect(result.position).toEqual(pos);

        const block = blockMesh.getBlockAt(pos);
        expect(block.blockInfo.name).toBe('minecraft:glowstone');
        expect(block.blockInfo.name).not.toBe('minecraft:magma_block');
    });

    test('addLightToDarkness with all_surface scope and random vs ordered placement', () => {
        const blockMesh = createMockBlockMesh();

        // 10-block line along X
        for (let x = 0; x < 10; ++x) {
            const pos = new Vector3(x, 0, 0);
            blockMesh._blocks.set(pos.hash(), {
                voxel: { position: pos, colour: { r: 0.5, g: 0.5, b: 0.5, a: 1 } },
                blockInfo: { name: 'minecraft:stone', colour: { r: 0.5, g: 0.5, b: 0.5, a: 1 }, faces: {} as any },
            });
        }

        const lighting = blockMesh._lighting;
        lighting.init();
        lighting.addLightToDarkness(10, 'ordered', 'all_surface', 'minecraft:torch');

        const placedTorches = blockMesh.getBlocks().filter((b: any) => b.blockInfo.name.startsWith('minecraft:torch'));
        expect(placedTorches.length).toBeGreaterThan(0);
        // Floor torches should be placed at y = 1
        expect(placedTorches.every((b: any) => b.voxel.position.y === 1)).toBe(true);
    });

    test('exporters properly handle wall_torch block state properties', () => {
        const blockMesh = createMockBlockMesh();
        const basePos = new Vector3(0, 0, 0);
        const wallTorchPos = new Vector3(0, 0, 1);

        blockMesh._blocks.set(basePos.hash(), {
            voxel: { position: basePos, colour: { r: 0.5, g: 0.5, b: 0.5, a: 1 } },
            blockInfo: { name: 'minecraft:stone', colour: { r: 0.5, g: 0.5, b: 0.5, a: 1 }, faces: {} as any },
        });
        blockMesh._blocks.set(wallTorchPos.hash(), {
            voxel: { position: wallTorchPos, colour: { r: 1.0, g: 0.85, b: 0.35, a: 1 } },
            blockInfo: { name: 'minecraft:wall_torch[facing=south]', colour: { r: 1.0, g: 0.85, b: 0.35, a: 1 }, faces: {} as any },
        });

        const nbtExporter = new NBTExporter();
        const nbtExport = nbtExporter.export(blockMesh);
        expect(nbtExport).toBeDefined();

        const litematicExporter = new Litematic();
        const litematicExport = litematicExporter.export(blockMesh);
        expect(litematicExport).toBeDefined();
    });

    test('ComboboxComponent supports maxVisibleItems and correct light block options order', () => {
        const { PALETTE_ALL_RELEASE } = require('../res/palettes/all');
        const { ComboboxComponent } = require('../src/ui/components/combobox');

        const combobox = new ComboboxComponent()
            .setMaxVisibleItems(10)
            .addItems([
                {
                    displayText: 'Auto (minecraft:glowstone)',
                    payload: 'auto',
                },
                {
                    displayText: 'minecraft:torch',
                    payload: 'minecraft:torch',
                },
                ...PALETTE_ALL_RELEASE.map((b: string) => ({
                    displayText: b,
                    payload: b,
                })),
            ])
            .setDefaultValue('auto');

        expect(combobox.getValue()).toBe('auto');

        const html = combobox._generateInnerHTML();
        expect(html).toContain('custom-combobox-wrapper');
        expect(html).toContain('custom-combobox-dropdown');
        expect(html).toContain('max-height: 320px');
        expect(html).toContain('Auto (minecraft:glowstone)');
        expect(html).toContain('minecraft:torch');
        expect(html).toContain('minecraft:stone');
    });
});

