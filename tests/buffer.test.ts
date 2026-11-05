import { AttributeData, MergeAttributeData } from '../src/render_buffer';
import { ChunkedBufferGenerator } from '../src/buffer';
import { GeometryTemplates } from '../src/geometry';
import { Vector3 } from '../src/vector';
import { TEST_PREAMBLE } from './preamble';

test('MergeAttributeData #1', () => {
    TEST_PREAMBLE();

    const a: AttributeData = {
        indices: new Uint32Array([0, 1, 2]),
        custom: {
            position: [1, 2, 3, 4, 5, 6, 7, 8, 9],
            colour: [1, 0, 0, 0, 1, 0, 0, 0, 1],
        },
    };
    const b = MergeAttributeData(a);
    expect(JSON.stringify(a)).toEqual(JSON.stringify(b));
});

test('MergeAttributeData #2', () => {
    TEST_PREAMBLE();

    const a: AttributeData = {
        indices: new Uint32Array([0, 1, 2]),
        custom: {
            position: [1, 2, 3, 4, 5, 6, 7, 8, 9],
            colour: [1, 0, 0, 0, 1, 0, 0, 0, 1],
        },
    };
    const b: AttributeData = {
        indices: new Uint32Array([0, 1, 2]),
        custom: {
            position: [10, 11, 12, 13, 14, 15, 16, 17, 18],
            colour: [0, 1, 1, 1, 0, 1, 1, 1, 0],
        },
    };
    const cActual = MergeAttributeData(a, b);
    const cExpect: AttributeData = {
        indices: new Uint32Array([0, 1, 2, 3, 4, 5]),
        custom: {
            position: [
                1, 2, 3, 4, 5, 6, 7, 8, 9,
                10, 11, 12, 13, 14, 15, 16, 17, 18,
            ],
            colour: [
                1, 0, 0, 0, 1, 0, 0, 0, 1,
                0, 1, 1, 1, 0, 1, 1, 1, 0,
            ],
        },
    };
    expect(JSON.stringify(cActual)).toEqual(JSON.stringify(cExpect));
});

test('MergeAttributeData #3', () => {
    TEST_PREAMBLE();

    const a: AttributeData = {
        indices: new Uint32Array([0, 1]),
        custom: {
            data: [1, 2],
        },
    };
    const b: AttributeData = {
        indices: new Uint32Array([0, 1]),
        custom: {
            data: [3, 4],
        },
    };
    const c: AttributeData = {
        indices: new Uint32Array([0, 1]),
        custom: {
            data: [5, 6],
        },
    };
    const dActual = MergeAttributeData(a, b, c);
    const dExpect: AttributeData = {
        indices: new Uint32Array([0, 1, 2, 3, 4, 5]),
        custom: {
            data: [1, 2, 3, 4, 5, 6],
        },
    };
    expect(JSON.stringify(dActual)).toEqual(JSON.stringify(dExpect));
});

test('chunked block buffers place appended torches at world coordinates with a narrow upright shape', () => {
    TEST_PREAMBLE();

    const unitCube = GeometryTemplates.getBoxBufferData(new Vector3(0, 0, 0));
    const sourceVoxelBuffer: any = {
        position: { numComponents: 3, data: Float32Array.from(unitCube.custom.position) },
        colour: { numComponents: 4, data: new Float32Array(96).fill(1) },
        occlusion: { numComponents: 4, data: new Float32Array(96).fill(1) },
        texcoord: { numComponents: 2, data: Float32Array.from(unitCube.custom.texcoord) },
        normal: { numComponents: 3, data: Float32Array.from(unitCube.custom.normal) },
        indices: { numComponents: 3, data: Uint32Array.from(unitCube.indices) },
    };
    const colour = { r: 0.5, g: 0.5, b: 0.5, a: 1 };
    const torchColour = { r: 1, g: 0.85, b: 0.35, a: 1 };
    const face = { texcoord: { u: 0, v: 0 }, colour };
    const faces: any = { north: face, south: face, up: face, down: face, east: face, west: face };
    const blocks = [
        {
            voxel: { position: new Vector3(10, 5, 10), colour },
            blockInfo: { name: 'minecraft:stone', colour, faces },
        },
        {
            voxel: { position: new Vector3(10, 6, 10), colour: torchColour },
            blockInfo: { name: 'minecraft:torch', colour: torchColour, faces },
        },
    ];
    const voxelMesh: any = {
        getVoxelCount: () => 1,
        getChunkedBuffer: () => ({ buffer: sourceVoxelBuffer }),
    };
    const blockMesh: any = {
        getBlocks: () => blocks,
        getVoxelMesh: () => voxelMesh,
        getBlockLighting: () => [15, 15, 15, 15, 15, 15],
    };

    const result = ChunkedBufferGenerator.fromBlockMesh(blockMesh, 0);
    const positions = result.buffer.position.data;
    const torchMin = { x: Infinity, y: Infinity, z: Infinity };
    const torchMax = { x: -Infinity, y: -Infinity, z: -Infinity };
    for (let i = 72; i < 144; i += 3) {
        torchMin.x = Math.min(torchMin.x, positions[i + 0]);
        torchMin.y = Math.min(torchMin.y, positions[i + 1]);
        torchMin.z = Math.min(torchMin.z, positions[i + 2]);
        torchMax.x = Math.max(torchMax.x, positions[i + 0]);
        torchMax.y = Math.max(torchMax.y, positions[i + 1]);
        torchMax.z = Math.max(torchMax.z, positions[i + 2]);
    }

    expect(torchMin.x).toBeCloseTo(9.955);
    expect(torchMax.x).toBeCloseTo(10.045);
    expect(torchMin.y).toBeCloseTo(5.5);
    expect(torchMax.y).toBeCloseTo(6.2);
    expect(torchMin.z).toBeCloseTo(9.955);
    expect(torchMax.z).toBeCloseTo(10.045);
});
