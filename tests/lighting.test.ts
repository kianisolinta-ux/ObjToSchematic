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

    test('torch placement skips a candidate when every attachment cell is occupied without replacing blocks', () => {
        const blockMesh = createMockBlockMesh();
        const basePos = new Vector3(2, 2, 2);
        const occupied = [
            basePos,
            new Vector3(2, 3, 2),
            new Vector3(2, 2, 3),
            new Vector3(2, 2, 1),
            new Vector3(3, 2, 2),
            new Vector3(1, 2, 2),
        ];
        occupied.forEach((pos) => {
            blockMesh._blocks.set(pos.hash(), {
                voxel: { position: pos, colour: { r: 0.5, g: 0.5, b: 0.5, a: 1 } },
                blockInfo: { name: 'minecraft:stone', colour: { r: 0.5, g: 0.5, b: 0.5, a: 1 }, faces: {} as any },
            });
        });

        const result = blockMesh.setLightBlock(basePos, 'minecraft:torch');
        expect(result.placed).toBe(false);
        expect(blockMesh.getBlockAt(basePos).blockInfo.name).toBe('minecraft:stone');
        expect(blockMesh.getBlocks().some((block: any) => block.blockInfo.name.startsWith('minecraft:torch'))).toBe(false);
        expect(blockMesh.getBlocks().some((block: any) => block.blockInfo.name === 'minecraft:glowstone')).toBe(false);
    });

    test('wall torch facing points out from the support block on all four sides', () => {
        const scenarios = [
            { facing: 'south', target: new Vector3(0, 0, 1), blocked: [] as Vector3[] },
            { facing: 'north', target: new Vector3(0, 0, -1), blocked: [new Vector3(0, 0, 1)] },
            { facing: 'east', target: new Vector3(1, 0, 0), blocked: [new Vector3(0, 0, 1), new Vector3(0, 0, -1)] },
            { facing: 'west', target: new Vector3(-1, 0, 0), blocked: [new Vector3(0, 0, 1), new Vector3(0, 0, -1), new Vector3(1, 0, 0)] },
        ];

        scenarios.forEach((scenario) => {
            const blockMesh = createMockBlockMesh();
            const basePos = new Vector3(2, 2, 2);
            const occupied = [new Vector3(0, 1, 0), ...scenario.blocked];
            [basePos, ...occupied.map((offset) => Vector3.add(basePos, offset))].forEach((pos) => {
                blockMesh._blocks.set(pos.hash(), {
                    voxel: { position: pos, colour: { r: 0.5, g: 0.5, b: 0.5, a: 1 } },
                    blockInfo: { name: 'minecraft:stone', colour: { r: 0.5, g: 0.5, b: 0.5, a: 1 }, faces: {} as any },
                });
            });

            const result = blockMesh.setLightBlock(basePos, 'minecraft:torch');
            const torchPos = Vector3.add(basePos, scenario.target);
            expect(result.placed).toBe(true);
            expect(result.position).toEqual(torchPos);
            expect(blockMesh.getBlockAt(torchPos).blockInfo.name).toBe(`minecraft:wall_torch[facing=${scenario.facing}]`);
            expect(blockMesh.getBlockAt(basePos).blockInfo.name).toBe('minecraft:stone');
        });
    });

    test('wall torches prefer the outer negative-X and negative-Z boundary cells', () => {
        const scenarios = [
            {
                basePos: new Vector3(-10, 5, 0),
                expectedPos: new Vector3(-11, 5, 0),
                expectedBlock: 'minecraft:wall_torch[facing=west]',
            },
            {
                basePos: new Vector3(0, 5, -10),
                expectedPos: new Vector3(0, 5, -11),
                expectedBlock: 'minecraft:wall_torch[facing=north]',
            },
        ];

        scenarios.forEach((scenario) => {
            const blockMesh = createMockBlockMesh();
            blockMesh._voxelMesh.getBounds = () => ({
                min: new Vector3(-10, 0, -10),
                max: new Vector3(10, 10, 10),
                getDimensions: () => new Vector3(20, 10, 20),
            });

            const ceilingPos = Vector3.add(scenario.basePos, new Vector3(0, 1, 0));
            [scenario.basePos, ceilingPos].forEach((pos) => {
                blockMesh._blocks.set(pos.hash(), {
                    voxel: { position: pos, colour: { r: 0.5, g: 0.5, b: 0.5, a: 1 } },
                    blockInfo: { name: 'minecraft:stone', colour: { r: 0.5, g: 0.5, b: 0.5, a: 1 }, faces: {} as any },
                });
            });

            const result = blockMesh.setLightBlock(scenario.basePos, 'minecraft:torch');
            expect(result.placed).toBe(true);
            expect(result.position).toEqual(scenario.expectedPos);
            expect(blockMesh.getBlockAt(scenario.expectedPos).blockInfo.name).toBe(scenario.expectedBlock);
        });
    });

    test('floor and wall torches are transparent to propagated light', () => {
        const blockMesh = createMockBlockMesh();
        expect(blockMesh.isTransparentBlock({ blockInfo: { name: 'minecraft:torch' } })).toBe(true);
        expect(blockMesh.isTransparentBlock({ blockInfo: { name: 'minecraft:wall_torch[facing=east]' } })).toBe(true);
        expect(blockMesh.isTransparentBlock({ blockInfo: { name: 'minecraft:stone' } })).toBe(false);
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

    test('block light propagates through empty columns between separated model parts', () => {
        const blockMesh = createMockBlockMesh();
        const supportPos = new Vector3(0, 0, 0);
        const distantPos = new Vector3(4, 0, 0);
        [supportPos, distantPos].forEach((pos) => {
            blockMesh._blocks.set(pos.hash(), {
                voxel: { position: pos, colour: { r: 0.5, g: 0.5, b: 0.5, a: 1 } },
                blockInfo: { name: 'minecraft:stone', colour: { r: 0.5, g: 0.5, b: 0.5, a: 1 }, faces: {} as any },
            });
        });
        blockMesh._voxelMesh.getBounds = () => ({
            min: new Vector3(0, 0, 0),
            max: new Vector3(4, 0, 0),
            getDimensions: () => new Vector3(4, 0, 0),
        });

        const lighting = blockMesh._lighting;
        lighting.init();

        // Start a level-14 torch source at (0, 1, 0), then propagate through
        // the empty columns x=1..3 before the light reaches the distant block.
        const torchPos = new Vector3(0, 1, 0);
        (lighting as any)._blockLightValues.set(torchPos.hash(), 14);
        const updates = [
            new Vector3(1, 0, 0),
            new Vector3(-1, 0, 0),
            new Vector3(0, 1, 0),
            new Vector3(0, -1, 0),
            new Vector3(0, 0, 1),
            new Vector3(0, 0, -1),
        ].map((offset) => ({
            pos: Vector3.add(torchPos, offset),
            sunLightValue: 0,
            blockLightValue: 13,
            from: 6 as any,
        }));
        (lighting as any)._handleBlockLightUpdates(updates);

        // Manhattan distance from the source to the target block is five.
        expect(lighting.getBlockLightLevel(distantPos)).toBe(9);
    });

    test('threshold and scope select the intended surface supports', () => {
        const blockMesh = createMockBlockMesh();
        const sunnyPos = new Vector3(0, 0, 0);
        const shadedPos = new Vector3(30, 0, 0);
        [sunnyPos, shadedPos].forEach((pos) => {
            blockMesh._blocks.set(pos.hash(), {
                voxel: { position: pos, colour: { r: 0.5, g: 0.5, b: 0.5, a: 1 } },
                blockInfo: { name: 'minecraft:stone', colour: { r: 0.5, g: 0.5, b: 0.5, a: 1 }, faces: {} as any },
            });
        });
        blockMesh._voxelMesh.getBounds = () => ({
            min: new Vector3(0, 0, 0),
            max: new Vector3(30, 0, 0),
            getDimensions: () => new Vector3(30, 0, 0),
        });

        const lighting = blockMesh._lighting;
        lighting.init();
        (lighting as any)._sunLightValues.set(sunnyPos.hash(), 15);
        (lighting as any)._blockLightValues.set(sunnyPos.hash(), 4);
        (lighting as any)._blockLightValues.set(shadedPos.hash(), 5);

        // Darkness includes sunlight and uses a strict "below threshold" test.
        // The sunny position is skipped; the shaded block is exactly at the
        // threshold and is skipped too.
        lighting.addLightToDarkness(5, 'ordered', 'darkness', 'minecraft:torch');
        expect(blockMesh.getBlocks().some((block: any) => block.blockInfo.name.startsWith('minecraft:torch'))).toBe(false);

        // All-surface ignores daylight but still respects artificial block
        // light and the same threshold. Only the sunny block has block light 4.
        lighting.addLightToDarkness(5, 'ordered', 'all_surface', 'minecraft:torch');
        const placedTorches = blockMesh.getBlocks().filter((block: any) => block.blockInfo.name.startsWith('minecraft:torch'));
        expect(placedTorches).toHaveLength(1);
        expect(placedTorches[0].voxel.position).toEqual(new Vector3(0, 1, 0));

        // A zero threshold explicitly disables additional light placement.
        const zeroThresholdMesh = createMockBlockMesh();
        const zeroSupport = new Vector3(0, 0, 0);
        zeroThresholdMesh._blocks.set(zeroSupport.hash(), {
            voxel: { position: zeroSupport, colour: { r: 0.5, g: 0.5, b: 0.5, a: 1 } },
            blockInfo: { name: 'minecraft:stone', colour: { r: 0.5, g: 0.5, b: 0.5, a: 1 }, faces: {} as any },
        });
        zeroThresholdMesh._lighting.init();
        zeroThresholdMesh._lighting.addLightToDarkness(0, 'ordered', 'all_surface', 'minecraft:torch');
        expect(zeroThresholdMesh.getBlocks().some((block: any) => block.blockInfo.name.startsWith('minecraft:torch'))).toBe(false);
    });

    test('ordered and random placement use different candidate traversal strategies', () => {
        const runPlacement = (placement: 'ordered' | 'random') => {
            const blockMesh = createMockBlockMesh();
            const supportPositions = [0, 30, 60].map((x) => new Vector3(x, 0, 0));
            supportPositions.forEach((pos) => {
                blockMesh._blocks.set(pos.hash(), {
                    voxel: { position: pos, colour: { r: 0.5, g: 0.5, b: 0.5, a: 1 } },
                    blockInfo: { name: 'minecraft:stone', colour: { r: 0.5, g: 0.5, b: 0.5, a: 1 }, faces: {} as any },
                });
            });
            blockMesh._voxelMesh.getBounds = () => ({
                min: new Vector3(0, 0, 0),
                max: new Vector3(60, 0, 0),
                getDimensions: () => new Vector3(60, 0, 0),
            });
            const visited: number[] = [];
            const originalSetLightBlock = blockMesh.setLightBlock.bind(blockMesh);
            blockMesh.setLightBlock = (pos: Vector3, choice: string) => {
                visited.push(pos.x);
                return originalSetLightBlock(pos, choice);
            };
            blockMesh._lighting.init();

            const originalRandom = Math.random;
            try {
                if (placement === 'random') {
                    Math.random = () => 0;
                }
                blockMesh._lighting.addLightToDarkness(1, placement, 'all_surface', 'minecraft:torch');
            } finally {
                Math.random = originalRandom;
            }
            return visited;
        };

        expect(runPlacement('ordered')).toEqual([0, 30, 60]);
        // Deterministic Fisher-Yates with Math.random() = 0, followed by pop().
        expect(runPlacement('random')).toEqual([0, 60, 30]);
    });

    test('block mesh bounds include torch cells outside the original voxel bounds', () => {
        const blockMesh = createMockBlockMesh();
        const torchPos = new Vector3(-1, 12, 11);
        blockMesh._blocks.set(torchPos.hash(), {
            voxel: { position: torchPos, colour: { r: 1, g: 0.85, b: 0.35, a: 1 } },
            blockInfo: { name: 'minecraft:torch', colour: { r: 1, g: 0.85, b: 0.35, a: 1 }, faces: {} as any },
        });

        const bounds = blockMesh.getBounds();
        expect(bounds.min).toEqual(new Vector3(-1, 0, 0));
        expect(bounds.max).toEqual(new Vector3(10, 12, 11));
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

