import { GltfLoader } from '../src/importers/gltf_loader';
import { MaterialType, Mesh, Tri } from '../src/mesh';
import { Triangle } from '../src/triangle';
import { UV } from '../src/util';
import { Vector3 } from '../src/vector';
import { TEST_PREAMBLE } from './preamble';

TEST_PREAMBLE();

test('Vector3.normalise handles zero magnitude without NaN', () => {
    const zeroVec = new Vector3(0, 0, 0);
    zeroVec.normalise();
    expect(zeroVec.isNumber()).toBe(true);
    expect(isNaN(zeroVec.x)).toBe(false);
    expect(isNaN(zeroVec.y)).toBe(false);
    expect(isNaN(zeroVec.z)).toBe(false);
    expect(zeroVec.magnitude()).toBeCloseTo(1.0);
});

test('Triangle.getNormal handles degenerate triangles without NaN', () => {
    const v0 = new Vector3(0, 0, 0);
    const v1 = new Vector3(0, 0, 0);
    const v2 = new Vector3(1, 1, 1);
    const tri = new Triangle(v0, v1, v2);
    const normal = tri.getNormal();
    expect(normal.isNumber()).toBe(true);
    expect(normal.magnitude()).toBeCloseTo(1.0);
});

test('Mesh.getNormals produces normalized finite vectors even with corrupted or zero normals', () => {
    const vertices = [
        new Vector3(0, 0, 0),
        new Vector3(1, 0, 0),
        new Vector3(0, 1, 0),
    ];
    // Normals with magnitude 0 and magnitude > 1
    const normals = [
        new Vector3(0, 0, 0),
        new Vector3(5, 0, 0),
        new Vector3(NaN, NaN, NaN),
    ];
    const uvs = [new UV(0, 0), new UV(1, 0), new UV(0, 1)];
    const tris: Tri[] = [{
        material: 'mat1',
        positionIndices: { x: 0, y: 1, z: 2 },
        normalIndices: { x: 0, y: 1, z: 2 },
        texcoordIndices: { x: 0, y: 1, z: 2 },
    }];
    const materials = new Map();
    materials.set('mat1', {
        type: MaterialType.solid,
        colour: { r: 1, g: 1, b: 1, a: 1 },
        needsAttention: false,
        canBeTextured: true,
    });

    const mesh = new Mesh(vertices, normals, uvs, tris, materials);
    const triNormals = mesh.getNormals(0);

    expect(triNormals.v0.isNumber()).toBe(true);
    expect(triNormals.v0.magnitude()).toBeCloseTo(1.0);

    expect(triNormals.v1.isNumber()).toBe(true);
    expect(triNormals.v1.magnitude()).toBeCloseTo(1.0);

    expect(triNormals.v2.isNumber()).toBe(true);
    expect(triNormals.v2.magnitude()).toBeCloseTo(1.0);
});

test('GltfLoader handles multi-primitive models with separate offsets and unnormalized normals', () => {
    const loader = new GltfLoader();
    const fakeGltf = {
        meshes: {
            mesh0: {
                primitives: [
                    {
                        attributes: {
                            POSITION: { value: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]) },
                            NORMAL: { value: new Float32Array([0, 0, 0, 3, 0, 0, 0, 2, 0]) },
                            TEXCOORD_0: { value: new Float32Array([0, 0, 1, 0, 0, 1]) },
                        },
                        indices: { value: new Uint16Array([0, 1, 2]) },
                    },
                    {
                        attributes: {
                            POSITION: { value: new Float32Array([1, 1, 0, 2, 1, 0, 1, 2, 0]) },
                            NORMAL: { value: new Float32Array([0, 0, 4, 0, 5, 0, 6, 0, 0]) },
                            TEXCOORD_0: { value: new Float32Array([0.5, 0.5, 1, 0.5, 0.5, 1]) },
                        },
                        indices: { value: new Uint16Array([0, 1, 2]) },
                    },
                ],
            },
        },
    };

    const mesh = (loader as any)._handleGLTF(fakeGltf);
    expect(mesh._vertices.length).toBe(6);
    expect(mesh._normals.length).toBe(6);
    expect(mesh._uvs.length).toBe(6);
    expect(mesh._tris.length).toBe(2);

    // First primitive
    expect(mesh._tris[0].positionIndices).toEqual({ x: 0, y: 1, z: 2 });
    expect(mesh._tris[0].normalIndices).toEqual({ x: 0, y: 1, z: 2 });
    expect(mesh._tris[0].texcoordIndices).toEqual({ x: 0, y: 1, z: 2 });

    // Second primitive should be offset by 3, NOT cross-indexed
    expect(mesh._tris[1].positionIndices).toEqual({ x: 3, y: 4, z: 5 });
    expect(mesh._tris[1].normalIndices).toEqual({ x: 3, y: 4, z: 5 });
    expect(mesh._tris[1].texcoordIndices).toEqual({ x: 3, y: 4, z: 5 });

    // All normals in second primitive should be finite and unit length
    for (let i = 0; i < 6; i++) {
        expect(mesh._normals[i].isNumber()).toBe(true);
        expect(mesh._normals[i].magnitude()).toBeCloseTo(1.0);
    }
});
