/**
 * @jest-environment jsdom
 */

import { PNG } from 'pngjs';

import { BufferGenerator } from '../src/buffer';
import { GltfLoader } from '../src/importers/gltf_loader';
import { MaterialType, Mesh, Tri } from '../src/mesh';
import { VectorComponent } from '../src/ui/components/vector';
import { UV } from '../src/util';
import { Vector3 } from '../src/vector';
import { VoxelMesh } from '../src/voxel_mesh';
import { IVoxeliser } from '../src/voxelisers/base-voxeliser';
import { TEST_PREAMBLE } from './preamble';

TEST_PREAMBLE();

function createTestPngBytes(rgbaPixels: [number, number, number, number][]): Uint8Array {
    const png = new PNG({ width: rgbaPixels.length, height: 1 });
    rgbaPixels.forEach((px, i) => {
        png.data[i * 4 + 0] = px[0];
        png.data[i * 4 + 1] = px[1];
        png.data[i * 4 + 2] = px[2];
        png.data[i * 4 + 3] = px[3];
    });
    return new Uint8Array(PNG.sync.write(png));
}

class TestColourVoxeliser extends IVoxeliser {
    protected override _voxelise(): VoxelMesh {
        return new VoxelMesh({ voxelOverlapRule: 'average', enableAmbientOcclusion: false });
    }

    public sampleColour(mesh: Mesh, triIndex: number, location: Vector3) {
        const tri = mesh.getUVTriangle(triIndex);
        const matName = mesh.getMaterialByTriangle(triIndex);
        return this._getVoxelColour(mesh, tri, matName, location, false);
    }
}

test('GltfLoader applies parent-child TRS transforms, inverse-transpose normals, and flips mirrored winding', () => {
    const loader = new GltfLoader();
    const s = Math.SQRT1_2;
    const gltf = {
        scene: 0,
        scenes: [{ nodes: [0] }],
        nodes: [
            {
                translation: [10, 0, 0],
                children: [1],
            },
            {
                rotation: [0, s, 0, s], // +90 deg around Y
                scale: [2, 1, 1],
                mesh: 0,
            },
            {
                scale: [-1, 1, 1], // Negative determinant -> flip winding
                mesh: 1,
            },
        ],
        meshes: [
            {
                primitives: [{
                    attributes: {
                        POSITION: { value: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 0]) },
                        NORMAL: { value: new Float32Array([1, 1, 0, 1, 1, 0, 1, 1, 0]) },
                    },
                    indices: { value: new Uint16Array([0, 1, 2]) },
                }],
            },
            {
                primitives: [{
                    attributes: {
                        POSITION: { value: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]) },
                    },
                    indices: { value: new Uint16Array([0, 1, 2]) },
                }],
            },
        ],
    };

    // Include node 2 in active scene
    gltf.scenes[0].nodes.push(2);

    const mesh: Mesh = (loader as any)._handleGLTF(gltf);
    expect(mesh._tris.length).toBe(2);

    // Vertex 0: local (1,0,0) * scale (2,1,1) = (2,0,0) -> rotY(+90) = (0,0,-2) -> + (10,0,0) = (10,0,-2)
    expect(mesh._vertices[0].x).toBeCloseTo(10, 5);
    expect(mesh._vertices[0].y).toBeCloseTo(0, 5);
    expect(mesh._vertices[0].z).toBeCloseTo(-2, 5);

    // Normal (1,1,0) -> inverse-transpose scale (0.5, 1, 0) -> rotY(+90) = (0, 1, -0.5) normalized
    const normLen = Math.hypot(0, 1, -0.5);
    expect(mesh._normals[0].x).toBeCloseTo(0, 5);
    expect(mesh._normals[0].y).toBeCloseTo(1 / normLen, 5);
    expect(mesh._normals[0].z).toBeCloseTo(-0.5 / normLen, 5);

    // Second triangle belongs to mirrored node 2 -> winding [0, 1, 2] flipped to [0, 2, 1] -> offset 3 => [3, 5, 4]
    expect(mesh._tris[1].positionIndices).toEqual({ x: 3, y: 5, z: 4 });
});

test('GltfLoader expands TRIANGLE_STRIP (5) and TRIANGLE_FAN (6)', () => {
    const loader = new GltfLoader();
    const gltf = {
        meshes: [
            {
                primitives: [
                    {
                        mode: 5, // TRIANGLE_STRIP
                        attributes: {
                            POSITION: { value: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]) },
                        },
                        indices: { value: new Uint16Array([0, 1, 2, 3]) },
                    },
                    {
                        mode: 6, // TRIANGLE_FAN
                        attributes: {
                            POSITION: { value: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]) },
                        },
                    },
                ],
            },
        ],
    };

    const mesh: Mesh = (loader as any)._handleGLTF(gltf);
    expect(mesh._tris.length).toBe(4);
    expect(mesh._tris[0].positionIndices).toEqual({ x: 0, y: 1, z: 2 });
    expect(mesh._tris[1].positionIndices).toEqual({ x: 2, y: 1, z: 3 });
    // Fan second primitive offset by 4
    expect(mesh._tris[2].positionIndices).toEqual({ x: 4, y: 5, z: 6 });
    expect(mesh._tris[3].positionIndices).toEqual({ x: 4, y: 6, z: 7 });
});

test('GltfLoader imports COLOR_0 vertex colours, baseColorFactor tint, alphaMode, and raw RGBA textures', () => {
    const loader = new GltfLoader();
    const pngBytes = createTestPngBytes([
        [0, 255, 0, 51],   // alpha = 0.2 (< cutoff 0.5)
        [255, 255, 255, 204], // alpha = 0.8 (>= cutoff 0.5)
    ]);

    const gltf = {
        meshes: [{
            primitives: [
                {
                    attributes: {
                        POSITION: { value: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]) },
                        TEXCOORD_0: { value: new Float32Array([0, 0, 1, 0, 0, 1]) },
                        COLOR_0: {
                            components: 4,
                            value: new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255]),
                            componentType: 5121,
                        },
                    },
                    material: {
                        name: 'MaskedTintMat',
                        alphaMode: 'MASK',
                        alphaCutoff: 0.5,
                        pbrMetallicRoughness: {
                            baseColorFactor: [1, 0.214041, 0, 1],
                            baseColorTexture: {
                                texture: {
                                    source: {
                                        mimeType: 'image/png',
                                        bufferView: { data: pngBytes },
                                    },
                                },
                            },
                        },
                    },
                },
                {
                    attributes: {
                        POSITION: { value: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]) },
                        TEXCOORD_0: { value: new Float32Array([0, 0, 1, 0, 0, 1]) },
                    },
                    material: {
                        name: 'RawRgbaOpaqueMat',
                        alphaMode: 'OPAQUE',
                        pbrMetallicRoughness: {
                            baseColorTexture: {
                                texture: {
                                    source: {
                                        image: {
                                            width: 1,
                                            height: 1,
                                            data: new Uint8Array([100, 150, 200, 25]),
                                        },
                                    },
                                },
                            },
                        },
                    },
                },
            ],
        }],
    };

    const mesh: Mesh = (loader as any)._handleGLTF(gltf);
    expect(mesh._vertexColours?.length).toBe(3);
    expect(mesh._tris[0].vertexColourIndices).toEqual({ x: 0, y: 1, z: 2 });

    const mat0 = mesh.getMaterialByName('MaskedTintMat_0');
    expect(mat0?.type).toBe(MaterialType.textured);
    if (mat0?.type === MaterialType.textured) {
        expect(mat0.transparency).toEqual({ type: 'UseDiffuseMapAlphaChannel' });
        expect(mat0.alphaCutoff).toBeCloseTo(0.5);
        expect(mat0.tint?.r).toBeCloseTo(1);
        expect(mat0.tint?.g).toBeCloseTo(0.5, 1);
        expect(mat0.tint?.b).toBeCloseTo(0);
    }

    const mat1 = mesh.getMaterialByName('RawRgbaOpaqueMat_1');
    expect(mat1?.type).toBe(MaterialType.textured);
    if (mat1?.type === MaterialType.textured) {
        expect(mat1.transparency).toEqual({ type: 'None' });
        expect(mat1.diffuse?.raw.startsWith('data:image/png;base64,')).toBe(true);
    }

    // Load textures & verify sampling respects tint, OPAQUE, and MASK alphaCutoff
    (mesh as any)._loadTextures();
    // Pixel 0 at u=0.25 has alpha=0.2 -> masked out (a = 0)
    const maskedOut = mesh.sampleTextureMaterial('MaskedTintMat_0', new UV(0.1, 0.5));
    expect(maskedOut.a).toBe(0);
    // Pixel 1 at u=0.9 has white pixel * tint (1, ~0.5, 0) and alpha=0.8 >= 0.5 -> opaque 1.0
    const maskedIn = mesh.sampleTextureMaterial('MaskedTintMat_0', new UV(0.9, 0.5));
    expect(maskedIn.r).toBeCloseTo(1, 2);
    expect(maskedIn.g).toBeCloseTo(0.5, 1);
    expect(maskedIn.b).toBeCloseTo(0, 2);
    expect(maskedIn.a).toBe(1);

    // OPAQUE material ignores low source alpha (25/255) and forces a = 1
    const opaqueSample = mesh.sampleTextureMaterial('RawRgbaOpaqueMat_1', new UV(0.5, 0.5));
    expect(opaqueSample.a).toBe(1);
});

test('IVoxeliser and BufferGenerator preserve and interpolate COLOR_0 vertex colours', () => {
    const vertices = [
        new Vector3(0, 0, 0),
        new Vector3(2, 0, 0),
        new Vector3(0, 2, 0),
    ];
    const normals = [new Vector3(0, 0, 1), new Vector3(0, 0, 1), new Vector3(0, 0, 1)];
    const uvs = [new UV(0, 0), new UV(1, 0), new UV(0, 1)];
    const vertexColours = [
        { r: 1, g: 0, b: 0, a: 1 },
        { r: 0, g: 1, b: 0, a: 1 },
        { r: 0, g: 0, b: 1, a: 1 },
    ];
    const tris: Tri[] = [{
        material: 'solidTint',
        positionIndices: { x: 0, y: 1, z: 2 },
        normalIndices: { x: 0, y: 1, z: 2 },
        texcoordIndices: { x: 0, y: 1, z: 2 },
        vertexColourIndices: { x: 0, y: 1, z: 2 },
    }];
    const materials = new Map();
    materials.set('solidTint', {
        type: MaterialType.solid,
        colour: { r: 0.5, g: 1, b: 1, a: 1 },
        canBeTextured: false,
        needsAttention: false,
    });

    const mesh = new Mesh(vertices, normals, uvs, tris, materials, vertexColours);

    // Centroid (2/3, 2/3, 0) has equal barycentric weights (1/3, 1/3, 1/3)
    const voxeliser = new TestColourVoxeliser();
    const sampled = voxeliser.sampleColour(mesh, 0, new Vector3(2 / 3, 2 / 3, 0));
    expect(sampled.r).toBeCloseTo(0.5 * (1 / 3), 2);
    expect(sampled.g).toBeCloseTo(1.0 * (1 / 3), 2);
    expect(sampled.b).toBeCloseTo(1.0 * (1 / 3), 2);
    expect(sampled.a).toBeCloseTo(1.0, 2);

    // BufferGenerator.fromMesh populates .colour attribute buffer
    const buffers = BufferGenerator.fromMesh(mesh);
    expect(buffers.length).toBe(1);
    expect(Array.from(buffers[0].buffer.colour.data)).toEqual([
        1, 0, 0, 1,
        0, 1, 0, 1,
        0, 0, 1, 1,
    ]);

    // Default buffer fills colour with 1.0
    const emptyBuf = BufferGenerator.createMaterialBuffer(1);
    expect(Array.from(emptyBuf.colour.data)).toEqual(new Array(12).fill(1.0));
});

test('VectorComponent parses floats, clamps bounds, and syncs DOM inputs', () => {
    const comp = new VectorComponent();
    const wrapper = document.createElement('div');
    wrapper.innerHTML = comp.generateHTML();
    document.body.appendChild(wrapper);
    comp.registerEvents();

    const received: Vector3[] = [];
    comp.addValueChangedListener((val) => received.push(val.copy()));

    const yInput = document.getElementById((comp as any)._getValueId('y')) as HTMLInputElement;
    expect(yInput.step).toBe('any');

    yInput.value = '22.5';
    yInput.dispatchEvent(new Event('change'));
    expect(comp.getValue().y).toBeCloseTo(22.5, 4);

    comp.setValue(new Vector3(15.25, 45.5, -10));
    const xInput = document.getElementById((comp as any)._getValueId('x')) as HTMLInputElement;
    expect(xInput.value).toBe('15.25');
    expect(yInput.value).toBe('45.5');
    expect(received.length).toBeGreaterThanOrEqual(2);

    document.body.removeChild(wrapper);
});
