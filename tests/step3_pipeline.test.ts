/**
 * @jest-environment jsdom
 */

import { parse } from '@loaders.gl/core';
import { GLTFLoader } from '@loaders.gl/gltf';
import { PNG } from 'pngjs';
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
import { exportMeshToGlb } from '../src/exporters/glb_exporter';
import { Litematic } from '../src/exporters/litematic_exporter';
import { GltfLoader } from '../src/importers/gltf_loader';
import { MaterialMap, MaterialType, Mesh, Tri } from '../src/mesh';
import { UV } from '../src/util';
import { Vector3 } from '../src/vector';
import { VoxelMesh } from '../src/voxel_mesh';
import { TEST_PREAMBLE } from './preamble';

TEST_PREAMBLE();

function createSolidPngDataUrl(r: number, g: number, b: number, a: number): string {
    const png = new PNG({ width: 2, height: 2 });
    for (let i = 0; i < 4; ++i) {
        png.data[i * 4 + 0] = r;
        png.data[i * 4 + 1] = g;
        png.data[i * 4 + 2] = b;
        png.data[i * 4 + 3] = a;
    }
    return 'data:image/png;base64,' + PNG.sync.write(png).toString('base64');
}

test('Step 3: exportMeshToGlb repairs degenerate tris, grounds/centers mesh, and round-trips through GltfLoader', async () => {
    const vertices = [
        new Vector3(10, 5, 10),
        new Vector3(12, 5, 10),
        new Vector3(10, 7, 10),
        new Vector3(0, 0, 0),
        new Vector3(1, 0, 0),
        new Vector3(2, 0, 0),
    ];
    const normals: Vector3[] = [];
    const uvs = [
        new UV(0.25, 0.25),
        new UV(0.75, 0.25),
        new UV(0.25, 0.75),
    ];
    const vertexColours = [
        { r: 1, g: 0.5, b: 0.25, a: 1 },
        { r: 0.25, g: 1, b: 0.5, a: 1 },
        { r: 0.5, g: 0.25, b: 1, a: 1 },
    ];
    const tris: Tri[] = [
        {
            material: 'HeroTex',
            positionIndices: { x: 0, y: 1, z: 2 },
            texcoordIndices: { x: 0, y: 1, z: 2 },
            vertexColourIndices: { x: 0, y: 1, z: 2 },
        },
        // Collinear degenerate triangle that must be stripped
        {
            material: 'HeroTex',
            positionIndices: { x: 3, y: 4, z: 5 },
        },
    ];

    const materials: MaterialMap = new Map();
    materials.set('HeroTex', {
        type: MaterialType.textured,
        diffuse: { filetype: 'png', raw: createSolidPngDataUrl(200, 120, 60, 255) },
        interpolation: 'linear',
        extension: 'clamp',
        transparency: { type: 'None' },
        tint: { r: 0.8, g: 0.9, b: 1.0, a: 1 },
        needsAttention: false,
    });

    const sourceMesh = new Mesh(vertices, normals, uvs, tris, materials, vertexColours);
    const { glbBytes, stats } = exportMeshToGlb(sourceMesh, { modelName: 'FixedHero' });

    expect(stats.originalTriangles).toBe(2);
    expect(stats.keptTriangles).toBe(1);
    expect(stats.removedDegenerateTriangles).toBe(1);
    expect(stats.fixedNormals).toBe(3);

    const ab = glbBytes.slice().buffer;
    if (typeof (globalThis as any).Response === 'undefined') {
        (globalThis as any).Response = class ResponseMock {};
    }
    const parsedGltf = await parse(ab, GLTFLoader, {
        gltf: { loadBuffers: true, postProcess: true, loadImages: false },
    });
    const loader = new GltfLoader();
    const reloaded: Mesh = (loader as any)._handleGLTF(parsedGltf);

    expect(reloaded.getTriangleCount()).toBe(1);
    const bounds = reloaded.getBounds();
    expect(bounds.min.y).toBeCloseTo(0, 4);
    expect((bounds.min.x + bounds.max.x) * 0.5).toBeCloseTo(0, 4);
    expect((bounds.min.z + bounds.max.z) * 0.5).toBeCloseTo(0, 4);

    // UVs and vertex colours survived GLB round-trip
    const reloadedUVs = reloaded.getUVs(0);
    expect(reloadedUVs.uv0.u).toBeCloseTo(0.25, 4);
    expect(reloadedUVs.uv0.v).toBeCloseTo(0.25, 4);
    expect(reloadedUVs.uv2.v).toBeCloseTo(0.75, 4);

    const reloadedCols = reloaded.getVertexColours(0);
    expect(reloadedCols.c0?.r).toBeCloseTo(1, 2);
    expect(reloadedCols.c0?.g).toBeCloseTo(0.5, 2);
    expect(reloadedCols.c0?.b).toBeCloseTo(0.25, 2);

    // Texture and tint preserved
    const mat = reloaded.getMaterialByName('HeroTex_0');
    expect(mat?.type).toBe(MaterialType.textured);
    if (mat?.type === MaterialType.textured) {
        expect(mat.diffuse?.filetype).toBe('png');
        expect(mat.tint?.r).toBeCloseTo(0.8, 2);
    }
});

test('Step 3: VoxelMesh.hollow strips internal voxels and preserves outer shell bounds', () => {
    const vm = new VoxelMesh({ voxelOverlapRule: 'average', enableAmbientOcclusion: false });
    for (let x = 0; x < 5; ++x) {
        for (let y = 0; y < 5; ++y) {
            for (let z = 0; z < 5; ++z) {
                vm.addVoxel(new Vector3(x, y, z), { r: 0.6, g: 0.4, b: 0.2, a: 1 });
            }
        }
    }
    expect(vm.getVoxelCount()).toBe(125);

    const result = vm.hollow(1);
    expect(result.removedCount).toBe(27);
    expect(result.keptCount).toBe(98);
    expect(vm.getVoxelCount()).toBe(98);
    expect(vm.getBounds().min.toArray()).toEqual([0, 0, 0]);
    expect(vm.getBounds().max.toArray()).toEqual([4, 4, 4]);
    expect(vm.isVoxelAt(new Vector3(2, 2, 2))).toBe(false);
    expect(vm.isVoxelAt(new Vector3(0, 0, 0))).toBe(true);
});

test('Step 3: Litematic writes custom Name, RegionName, Author, Description, and timestamps', async () => {
    const blockMesh = Object.create(BlockMesh.prototype) as any;
    blockMesh._blocks = new Map();
    blockMesh._blocksUsed = new Set();
    blockMesh._voxelMesh = {
        getBounds: () => new Bounds(new Vector3(0, 0, 0), new Vector3(1, 1, 1)),
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
    blockMesh._blocks.set(new Vector3(1, 1, 1).hash(), {
        voxel: { position: new Vector3(1, 1, 1), colour: stone.colour },
        blockInfo: stone,
    });

    const exporter = new Litematic();
    const res = exporter.export(blockMesh, {
        name: 'DragonStatue',
        regionName: 'DragonRegion',
        author: 'ObjToSchematic',
        timestampMs: 1700000000000,
    });
    expect(res.type).toBe('single');
    if (res.type === 'single') {
        const raw = gunzipSync(res.content);
        const parsed = await nbt.parse(raw);
        const meta: any = parsed.parsed.value.Metadata?.value;
        const regions: any = parsed.parsed.value.Regions?.value;
        expect(meta.Name.value).toBe('DragonStatue');
        expect(meta.Author.value).toBe('ObjToSchematic');
        expect(meta.Description.value).toContain('2x2x2');
        expect(meta.TotalBlocks.value).toBe(2);
        expect(regions.DragonRegion).toBeDefined();
        expect(regions.Unnamed).toBeUndefined();
    }
});
