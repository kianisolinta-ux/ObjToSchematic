import { Mesh } from '../src/mesh';
import { MeshRepairEngine, TRepairMeshOptions } from '../src/mesh_repair';
import { UV } from '../src/util';
import { Vector3 } from '../src/vector';
import { TEST_PREAMBLE } from './preamble';

TEST_PREAMBLE();

test('MeshRepairEngine generates 100% pure all-quad topology with zero triangles', () => {
    // A square plane from (0,0,0) to (1,1,0) made of 2 triangles
    const vertices = [
        new Vector3(0, 0, 0), // 0
        new Vector3(1, 0, 0), // 1
        new Vector3(1, 1, 0), // 2
        new Vector3(0, 1, 0), // 3
    ];
    const normals = [
        new Vector3(0, 0, 1),
        new Vector3(0, 0, 1),
        new Vector3(0, 0, 1),
        new Vector3(0, 0, 1),
    ];
    const uvs = [
        new UV(0, 0),
        new UV(1, 0),
        new UV(1, 1),
        new UV(0, 1),
    ];
    const tris = [
        {
            positionIndices: { x: 0, y: 1, z: 3 },
            texcoordIndices: { x: 0, y: 1, z: 3 },
            normalIndices: { x: 0, y: 1, z: 3 },
            material: 'default',
        },
        {
            positionIndices: { x: 1, y: 2, z: 3 },
            texcoordIndices: { x: 1, y: 2, z: 3 },
            normalIndices: { x: 1, y: 2, z: 3 },
            material: 'default',
        },
    ];

    const materials = new Map();
    materials.set('default', {
        type: 0,
        colour: { r: 1, g: 1, b: 1, a: 1 },
        canBeTextured: false,
        needsAttention: false,
    });

    const mesh = new Mesh(vertices, normals, uvs, tris, materials);

    const options: TRepairMeshOptions = {
        targetDensity: 1.0,
        curvatureAdaptivity: 0.8,
        smoothingIterations: 2,
        weldTolerance: 0.00005,
        sharpEdgeAngle: 45,
        minQuadQuality: 0.25,
        weldVertices: false,
        removeDegenerate: true,
        smoothSurface: true,
    };

    const result = MeshRepairEngine.repair(mesh, options);

    // Guaranteed 100% Pure Quad Topology!
    expect(result.repairedStats.quads).toBeGreaterThan(0);
    expect(result.repairedStats.triangles).toBe(0);
    expect(result.repairedStats.quadPercentage).toBe(100);

    // In the exported OBJ: EVERY face must have exactly 4 vertices (pure quad), ZERO 3-vertex triangle faces
    const obj = MeshRepairEngine.exportQuadOBJ(result.repairedMesh, result.quadsList);
    const faceLines = obj.split('\n').filter((l) => l.startsWith('f '));
    expect(faceLines.length).toBe(result.repairedStats.quads);

    for (const fLine of faceLines) {
        const tokens = fLine.trim().split(/\s+/).slice(1);
        expect(tokens.length).toBe(4); // 100% 4-vertex quads
    }
});

test('MeshRepairEngine seals holes and removes degenerate zero-area faces safely', () => {
    const vertices = [
        new Vector3(0, 0, 0),
        new Vector3(1, 0, 0),
        new Vector3(0, 1, 0),
    ];
    const tris = [
        // Valid triangle
        {
            positionIndices: { x: 0, y: 1, z: 2 },
            material: 'default',
        },
        // Degenerate triangle (x === y)
        {
            positionIndices: { x: 0, y: 0, z: 2 },
            material: 'default',
        },
    ];
    const materials = new Map();
    materials.set('default', {
        type: 0,
        colour: { r: 1, g: 1, b: 1, a: 1 },
        canBeTextured: false,
        needsAttention: false,
    });
    const mesh = new Mesh(vertices, [], [], tris, materials);

    const options: TRepairMeshOptions = {
        targetDensity: 1.0,
        curvatureAdaptivity: 0.8,
        smoothingIterations: 0,
        weldTolerance: 0.00005,
        sharpEdgeAngle: 45,
        minQuadQuality: 0.30,
        weldVertices: false,
        removeDegenerate: true,
        smoothSurface: false,
    };

    const result = MeshRepairEngine.repair(mesh, options);
    expect(result.repairedStats.degenerateFacesRemoved).toBe(1);
    expect(result.repairedStats.quadPercentage).toBe(100);
    expect(result.repairedStats.triangles).toBe(0);
});

test('MeshRepairEngine welds split neural seam vertices and creates pure quads', () => {
    // 2 triangles sharing an edge, but with duplicated coincident vertices (typical neural mesh artifact)
    const vertices = [
        new Vector3(0, 0, 0), // 0
        new Vector3(1, 0, 0), // 1
        new Vector3(0, 1, 0), // 2
        new Vector3(1, 0, 0), // 3 (duplicate of 1)
        new Vector3(1, 1, 0), // 4
        new Vector3(0, 1, 0), // 5 (duplicate of 2)
    ];
    const tris = [
        { positionIndices: { x: 0, y: 1, z: 2 }, material: 'default' },
        { positionIndices: { x: 3, y: 4, z: 5 }, material: 'default' },
    ];
    const materials = new Map();
    materials.set('default', {
        type: 0,
        colour: { r: 1, g: 1, b: 1, a: 1 },
        canBeTextured: false,
        needsAttention: false,
    });
    const mesh = new Mesh(vertices, [], [], tris, materials);

    const options: TRepairMeshOptions = {
        targetDensity: 1.0,
        curvatureAdaptivity: 0.8,
        smoothingIterations: 2,
        weldTolerance: 0.001,
        sharpEdgeAngle: 45,
        minQuadQuality: 0.30,
        weldVertices: true,
        removeDegenerate: true,
        smoothSurface: true,
    };

    const result = MeshRepairEngine.repair(mesh, options);
    expect(result.repairedStats.quadPercentage).toBe(100);
    expect(result.repairedStats.triangles).toBe(0);
    expect(result.quadsList.length).toBeGreaterThan(0);
    for (const q of result.quadsList) {
        expect(q.v.length).toBe(4);
    }
});

test('MeshRepairEngine seals large holes (>128 boundary edges) typical of Tripo3D character cuts', () => {
    // Generate an open cylinder with 160 perimeter boundary vertices (exceeds old 128 hard limit)
    const N = 160;
    const vertices: Vector3[] = [];
    const tris = [];

    // Bottom ring
    for (let i = 0; i < N; ++i) {
        const theta = (i / N) * 2 * Math.PI;
        vertices.push(new Vector3(Math.cos(theta), 0, Math.sin(theta)));
    }
    // Top ring
    for (let i = 0; i < N; ++i) {
        const theta = (i / N) * 2 * Math.PI;
        vertices.push(new Vector3(Math.cos(theta), 2, Math.sin(theta)));
    }

    // Cylinder side triangles
    for (let i = 0; i < N; ++i) {
        const b0 = i;
        const b1 = (i + 1) % N;
        const t0 = N + i;
        const t1 = N + ((i + 1) % N);

        tris.push({ positionIndices: { x: b0, y: b1, z: t1 }, material: 'default' });
        tris.push({ positionIndices: { x: b0, y: t1, z: t0 }, material: 'default' });
    }

    const materials = new Map();
    materials.set('default', { type: 0, colour: { r: 1, g: 1, b: 1, a: 1 }, canBeTextured: false, needsAttention: false });
    const mesh = new Mesh(vertices, [], [], tris, materials);

    const options: TRepairMeshOptions = {
        targetDensity: 1.0,
        curvatureAdaptivity: 0.8,
        smoothingIterations: 1,
        weldTolerance: 0.0008,
        sharpEdgeAngle: 45,
        minQuadQuality: 0.30,
        weldVertices: true,
        removeDegenerate: true,
        smoothSurface: true,
    };

    const result = MeshRepairEngine.repair(mesh, options);
    // Both large 160-edge holes (top and bottom caps) must be sealed!
    expect(result.repairedStats.holesSealed).toBeGreaterThanOrEqual(2);
    expect(result.repairedStats.triangles).toBe(0);
    expect(result.repairedStats.quadPercentage).toBe(100);
    expect(result.quadsList.length).toBeGreaterThan(0);
});

test('MeshRepairEngine preserves UV seams without atlas stretching or color streak corruption', () => {
    // Two triangles sharing an edge along x=0.5, but belonging to separate UV islands:
    // Left triangle: x in [0, 0.5], UVs in [0.05, 0.25] (Island 1)
    // Right triangle: x in [0.5, 1.0], UVs in [0.75, 0.95] (Island 2)
    const vertices = [
        new Vector3(0.0, 0.0, 0.0), // 0
        new Vector3(0.5, 0.0, 0.0), // 1
        new Vector3(0.0, 1.0, 0.0), // 2
        new Vector3(0.5, 0.0, 0.0), // 3 (duplicate position of 1 on seam)
        new Vector3(1.0, 0.0, 0.0), // 4
        new Vector3(0.5, 1.0, 0.0), // 5
    ];
    const uvs = [
        new UV(0.05, 0.05), // 0 (Island 1)
        new UV(0.25, 0.05), // 1 (Island 1)
        new UV(0.05, 0.95), // 2 (Island 1)
        new UV(0.75, 0.05), // 3 (Island 2)
        new UV(0.95, 0.05), // 4 (Island 2)
        new UV(0.75, 0.95), // 5 (Island 2)
    ];
    const tris = [
        {
            positionIndices: { x: 0, y: 1, z: 2 },
            texcoordIndices: { x: 0, y: 1, z: 2 },
            material: 'mat1',
        },
        {
            positionIndices: { x: 3, y: 4, z: 5 },
            texcoordIndices: { x: 3, y: 4, z: 5 },
            material: 'mat1',
        },
    ];

    const materials = new Map();
    materials.set('mat1', { type: 1, colour: { r: 1, g: 1, b: 1, a: 1 }, canBeTextured: true, needsAttention: false });
    const mesh = new Mesh(vertices, [], uvs, tris, materials);

    const options: TRepairMeshOptions = {
        targetDensity: 1.0,
        curvatureAdaptivity: 0.8,
        smoothingIterations: 0,
        weldTolerance: 0.001,
        sharpEdgeAngle: 45,
        minQuadQuality: 0.30,
        weldVertices: true,
        removeDegenerate: true,
        smoothSurface: false,
    };

    const result = MeshRepairEngine.repair(mesh, options);
    expect(result.repairedStats.quadPercentage).toBe(100);
    expect(result.repairedStats.triangles).toBe(0);

    // Verify that the output mesh has preserved distinct UVs on both sides of the seam
    const repUVs = result.repairedMesh._uvs;
    expect(repUVs.length).toBeGreaterThan(0);

    const hasIsland1UV = repUVs.some((uv) => uv.u <= 0.35);
    const hasIsland2UV = repUVs.some((uv) => uv.u >= 0.65);
    expect(hasIsland1UV).toBe(true);
    expect(hasIsland2UV).toBe(true);

    // Verify that every quad face has valid vt indices
    for (const q of result.quadsList) {
        expect(q.vt).toBeDefined();
        expect(q.vt!.length).toBe(4);
        for (const vtIdx of q.vt!) {
            expect(vtIdx).toBeGreaterThanOrEqual(0);
            expect(vtIdx).toBeLessThan(repUVs.length);
        }
    }
});



