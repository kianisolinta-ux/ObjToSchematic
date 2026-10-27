import { RGBA_255 } from '../src/colour';
import { BlockMesh } from '../src/block_mesh';
import { Vector3 } from '../src/vector';

test('nearest-colour uses the same colour-accuracy and dithering preprocessing as other algorithms', () => {
    // Exercise the private preprocessing stage without constructing an atlas or voxel mesh.
    const blockMesh = Object.create(BlockMesh.prototype) as any;
    const voxel = {
        colour: { r: 0.5, g: 0.5, b: 0.5, a: 1 },
        position: new Vector3(0, 0, 0),
    };
    const commonParams = {
        resolution: 255,
        dithering: 'ordered',
        ditheringMagnitude: 64,
    };

    const nearestColour = blockMesh._getFinalVoxelColour(voxel, {
        ...commonParams,
        blockSelectionAlgorithm: 'nearest-color',
    }) as RGBA_255;
    const chartMatch = blockMesh._getFinalVoxelColour(voxel, {
        ...commonParams,
        blockSelectionAlgorithm: 'color-chart-match',
    }) as RGBA_255;

    expect(nearestColour).toEqual({ r: 95, g: 95, b: 95, a: 255 });
    expect(nearestColour).toEqual(chartMatch);
});

test('filterSimilarBlocks removes stray noise of similar shade while preserving sharp contours', () => {
    const blockMesh = Object.create(BlockMesh.prototype) as any;
    blockMesh._blocks = new Map();
    blockMesh._blocksUsed = new Set();
    blockMesh._voxelMesh = {
        isVoxelAt: () => true,
    };

    const whiteConcreteInfo = {
        name: 'minecraft:white_concrete',
        colour: { r: 0.95, g: 0.95, b: 0.95, a: 1 },
        faces: {} as any,
    };
    const whiteWoolInfo = {
        name: 'minecraft:white_wool',
        colour: { r: 0.91, g: 0.91, b: 0.91, a: 1 },
        faces: {} as any,
    };
    const blackConcreteInfo = {
        name: 'minecraft:black_concrete',
        colour: { r: 0.05, g: 0.05, b: 0.05, a: 1 },
        faces: {} as any,
    };

    // 3x3 plane: all white concrete, except center (1, 1, 0) is white wool (stray dither speckle)
    for (let x = 0; x < 3; ++x) {
        for (let y = 0; y < 3; ++y) {
            const isCenter = x === 1 && y === 1;
            const info = isCenter ? whiteWoolInfo : whiteConcreteInfo;
            const pos = new Vector3(x, y, 0);
            blockMesh._blocks.set(pos.hash(), {
                voxel: { position: pos, colour: { r: 1, g: 1, b: 1, a: 1 } },
                blockInfo: info,
            });
            blockMesh._blocksUsed.add(info.name);
        }
    }

    // Border column of black concrete at x = 3, y in [0..2] representing a sharp contour
    for (let y = 0; y < 3; ++y) {
        const pos = new Vector3(3, y, 0);
        blockMesh._blocks.set(pos.hash(), {
            voxel: { position: pos, colour: { r: 0, g: 0, b: 0, a: 1 } },
            blockInfo: blackConcreteInfo,
        });
        blockMesh._blocksUsed.add(blackConcreteInfo.name);
    }

    expect(blockMesh._blocksUsed.size).toBe(3);

    // Filter with threshold 15 (deviation of white wool to white concrete is ~4, so within threshold)
    blockMesh._filterSimilarBlocks('nearest-color', 15, 'do-nothing');

    // Stray white wool speckle in the center should be replaced by surrounding white concrete;
    // black concrete contour remains untouched!
    expect(blockMesh._blocksUsed.size).toBe(2);
    expect(blockMesh._blocksUsed.has('minecraft:white_concrete')).toBe(true);
    expect(blockMesh._blocksUsed.has('minecraft:white_wool')).toBe(false);
    expect(blockMesh._blocksUsed.has('minecraft:black_concrete')).toBe(true);

    const centerBlock = blockMesh._blocks.get(new Vector3(1, 1, 0).hash());
    expect(centerBlock.blockInfo.name).toBe('minecraft:white_concrete');

    // Contour blocks at x = 3 must remain black concrete
    for (let y = 0; y < 3; ++y) {
        const edgeBlock = blockMesh._blocks.get(new Vector3(3, y, 0).hash());
        expect(edgeBlock.blockInfo.name).toBe('minecraft:black_concrete');
    }

    const summary = blockMesh.getBlockSummary();
    const whiteConcreteCount = summary.blocks.find((b: any) => b.name === 'minecraft:white_concrete')?.count;
    const blackConcreteCount = summary.blocks.find((b: any) => b.name === 'minecraft:black_concrete')?.count;
    expect(whiteConcreteCount).toBe(9); // 8 + 1 replaced
    expect(blackConcreteCount).toBe(3);
});

test('filterSimilarBlocks does not merge blocks when distance exceeds threshold', () => {
    const blockMesh = Object.create(BlockMesh.prototype) as any;
    blockMesh._blocks = new Map();
    blockMesh._blocksUsed = new Set();
    blockMesh._voxelMesh = {
        isVoxelAt: () => true,
    };

    const blockAInfo = {
        name: 'minecraft:stone',
        colour: { r: 0.5, g: 0.5, b: 0.5, a: 1 },
        faces: {} as any,
    };
    const blockBInfo = {
        name: 'minecraft:andesite',
        colour: { r: 0.6, g: 0.6, b: 0.6, a: 1 },
        faces: {} as any,
    };

    const posA = new Vector3(0, 0, 0);
    const posB = new Vector3(1, 0, 0);
    blockMesh._blocks.set(posA.hash(), {
        voxel: { position: posA, colour: { r: 0.5, g: 0.5, b: 0.5, a: 1 } },
        blockInfo: blockAInfo,
    });
    blockMesh._blocks.set(posB.hash(), {
        voxel: { position: posB, colour: { r: 0.6, g: 0.6, b: 0.6, a: 1 } },
        blockInfo: blockBInfo,
    });
    blockMesh._blocksUsed.add(blockAInfo.name);
    blockMesh._blocksUsed.add(blockBInfo.name);

    // Threshold 1 is smaller than distance between 0.5 and 0.6 (~10)
    blockMesh._filterSimilarBlocks('nearest-color', 1, 'do-nothing');

    expect(blockMesh._blocksUsed.size).toBe(2);
    expect(blockMesh._blocksUsed.has(blockAInfo.name)).toBe(true);
    expect(blockMesh._blocksUsed.has(blockBInfo.name)).toBe(true);
});

test('filterSimilarBlocks works with color-chart-match to clean dither noise without eroding dichrom contours', () => {
    const blockMesh = Object.create(BlockMesh.prototype) as any;
    blockMesh._blocks = new Map();
    blockMesh._blocksUsed = new Set();
    blockMesh._voxelMesh = {
        isVoxelAt: () => true,
    };

    const lightBlueConcrete = {
        name: 'minecraft:light_blue_concrete',
        colour: { r: 0.18, g: 0.58, b: 0.81, a: 1 },
        faces: {} as any,
    };
    const cyanConcrete = {
        name: 'minecraft:cyan_concrete',
        colour: { r: 0.15, g: 0.52, b: 0.65, a: 1 },
        faces: {} as any,
    };
    const orangeConcrete = {
        name: 'minecraft:orange_concrete',
        colour: { r: 0.88, g: 0.40, b: 0.05, a: 1 },
        faces: {} as any,
    };

    // 3x3 plane: mostly cyan concrete, with an isolated light blue speckle at center (similar shade)
    for (let x = 0; x < 3; ++x) {
        for (let y = 0; y < 3; ++y) {
            const isCenter = x === 1 && y === 1;
            const info = isCenter ? lightBlueConcrete : cyanConcrete;
            const pos = new Vector3(x, y, 0);
            blockMesh._blocks.set(pos.hash(), {
                voxel: { position: pos, colour: { r: 0.2, g: 0.5, b: 0.7, a: 1 } },
                blockInfo: info,
            });
            blockMesh._blocksUsed.add(info.name);
        }
    }

    // Border column of orange concrete (contrasting dichrom colour, contour)
    for (let y = 0; y < 3; ++y) {
        const pos = new Vector3(3, y, 0);
        blockMesh._blocks.set(pos.hash(), {
            voxel: { position: pos, colour: { r: 0.9, g: 0.4, b: 0.1, a: 1 } },
            blockInfo: orangeConcrete,
        });
        blockMesh._blocksUsed.add(orangeConcrete.name);
    }

    // Filter with color-chart-match and threshold 18 (light blue vs cyan Delta E is ~10-15)
    blockMesh._filterSimilarBlocks('color-chart-match', 18, 'do-nothing');

    // Center speckle should be replaced by cyan concrete; orange concrete contour remains intact
    const centerBlock = blockMesh._blocks.get(new Vector3(1, 1, 0).hash());
    expect(centerBlock.blockInfo.name).toBe('minecraft:cyan_concrete');

    for (let y = 0; y < 3; ++y) {
        const edgeBlock = blockMesh._blocks.get(new Vector3(3, y, 0).hash());
        expect(edgeBlock.blockInfo.name).toBe('minecraft:orange_concrete');
    }
});

test('filterSimilarBlocks cleans multi-voxel noise clumps of similar shades', () => {
    const blockMesh = Object.create(BlockMesh.prototype) as any;
    blockMesh._blocks = new Map();
    blockMesh._blocksUsed = new Set();
    blockMesh._voxelMesh = {
        isVoxelAt: () => true,
    };

    const stone = {
        name: 'minecraft:stone',
        colour: { r: 0.5, g: 0.5, b: 0.5, a: 1 },
        faces: {} as any,
    };
    const andesite = {
        name: 'minecraft:andesite',
        colour: { r: 0.55, g: 0.55, b: 0.55, a: 1 },
        faces: {} as any,
    };

    // 5x5 plane of stone with a 2-voxel clump of andesite at (2,2) and (2,3)
    for (let x = 0; x < 5; ++x) {
        for (let y = 0; y < 5; ++y) {
            const isClump = (x === 2 && y === 2) || (x === 2 && y === 3);
            const info = isClump ? andesite : stone;
            const pos = new Vector3(x, y, 0);
            blockMesh._blocks.set(pos.hash(), {
                voxel: { position: pos, colour: { r: 0.5, g: 0.5, b: 0.5, a: 1 } },
                blockInfo: info,
            });
            blockMesh._blocksUsed.add(info.name);
        }
    }

    expect(blockMesh._blocksUsed.size).toBe(2);

    // Stone vs andesite Delta E is ~10; with threshold 20, the 2-voxel clump should be cleanly eliminated
    blockMesh._filterSimilarBlocks('nearest-color', 20, 'do-nothing');

    expect(blockMesh._blocksUsed.size).toBe(1);
    expect(blockMesh._blocksUsed.has('minecraft:stone')).toBe(true);
    expect(blockMesh._blocksUsed.has('minecraft:andesite')).toBe(false);
});

test('_pruneRareOutlierBlocks consolidates insignificant rare blocks into dominant palette blocks', () => {
    const blockMesh = Object.create(BlockMesh.prototype) as any;
    blockMesh._blocks = new Map();
    blockMesh._blocksUsed = new Set();

    const redConcrete = {
        name: 'minecraft:red_concrete',
        colour: { r: 0.8, g: 0.1, b: 0.1, a: 1 },
        faces: {} as any,
    };
    const yellowConcrete = {
        name: 'minecraft:yellow_concrete',
        colour: { r: 0.9, g: 0.8, b: 0.1, a: 1 },
        faces: {} as any,
    };
    const purpurBlock = {
        name: 'minecraft:purpur_block',
        colour: { r: 0.65, g: 0.4, b: 0.65, a: 1 },
        faces: {} as any,
    };

    // 100 voxels total:
    // 80 voxels red concrete (dominant)
    // 18 voxels yellow concrete (dominant contour)
    // 2 voxels purpur block (rare outlier below threshold)
    let idx = 0;
    for (let i = 0; i < 80; ++i) {
        const pos = new Vector3(idx++, 0, 0);
        blockMesh._blocks.set(pos.hash(), {
            voxel: { position: pos, colour: redConcrete.colour },
            blockInfo: redConcrete,
        });
        blockMesh._blocksUsed.add(redConcrete.name);
    }
    for (let i = 0; i < 18; ++i) {
        const pos = new Vector3(idx++, 0, 0);
        blockMesh._blocks.set(pos.hash(), {
            voxel: { position: pos, colour: yellowConcrete.colour },
            blockInfo: yellowConcrete,
        });
        blockMesh._blocksUsed.add(yellowConcrete.name);
    }
    for (let i = 0; i < 2; ++i) {
        const pos = new Vector3(idx++, 0, 0);
        blockMesh._blocks.set(pos.hash(), {
            voxel: { position: pos, colour: purpurBlock.colour },
            blockInfo: purpurBlock,
        });
        blockMesh._blocksUsed.add(purpurBlock.name);
    }

    expect(blockMesh._blocksUsed.size).toBe(3);
    expect(blockMesh._blocksUsed.has('minecraft:purpur_block')).toBe(true);

    const result = blockMesh._pruneRareOutlierBlocks('do-nothing');

    expect(result.prunedTypes).toBe(1);
    expect(result.prunedBlocks).toBe(2);
    expect(blockMesh._blocksUsed.size).toBe(2);
    expect(blockMesh._blocksUsed.has('minecraft:purpur_block')).toBe(false);
    expect(blockMesh._blocksUsed.has('minecraft:red_concrete')).toBe(true);
    expect(blockMesh._blocksUsed.has('minecraft:yellow_concrete')).toBe(true);
});


