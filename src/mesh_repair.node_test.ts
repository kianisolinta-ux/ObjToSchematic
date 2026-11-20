import assert from 'node:assert/strict';
import test from 'node:test';

import { repairMeshData } from './mesh_repair';

test('repairMeshData removes degenerate/NaN/OOB triangles and compacts vertices', () => {
    const repaired = repairMeshData({
        vertices: [
            { x: 0, y: 1, z: 0 },     // 0 - valid tri
            { x: 2, y: 1, z: 0 },     // 1 - valid tri
            { x: 0, y: 3, z: 0 },     // 2 - valid tri
            { x: 99, y: 99, z: 99 },  // 3 - orphaned
            { x: NaN, y: 0, z: 0 },   // 4 - NaN
            { x: 0, y: 0, z: 0 },     // 5 - collinear
            { x: 1, y: 0, z: 0 },     // 6 - collinear
            { x: 2, y: 0, z: 0 },     // 7 - collinear
        ],
        normals: [],
        uvs: [
            { u: 0, v: 0 },
            { u: NaN, v: 0.5 },
            { u: 1, v: 1 },
        ],
        tris: [
            // Valid triangle with NaN UV and missing normals
            {
                material: 'MatA',
                positionIndices: { x: 0, y: 1, z: 2 },
                texcoordIndices: { x: 0, y: 1, z: 2 },
            },
            // Duplicate vertex index
            {
                material: 'MatA',
                positionIndices: { x: 0, y: 0, z: 1 },
            },
            // Out of bounds index
            {
                material: 'MatA',
                positionIndices: { x: 0, y: 1, z: 999 },
            },
            // NaN vertex
            {
                material: 'MatA',
                positionIndices: { x: 0, y: 1, z: 4 },
            },
            // Collinear zero-area
            {
                material: 'MatA',
                positionIndices: { x: 5, y: 6, z: 7 },
            },
        ],
    });

    assert.equal(repaired.stats.originalTriangles, 5);
    assert.equal(repaired.stats.keptTriangles, 1);
    assert.equal(repaired.stats.removedInvalidIndexTriangles, 1);
    assert.equal(repaired.stats.removedDegenerateTriangles, 3);
    assert.equal(repaired.stats.keptVertices, 3);
    assert.equal(repaired.stats.fixedNormals, 3);
    assert.equal(repaired.stats.fixedUVs, 1);

    // Grounded Y=0 and centered XZ=0
    const ys = repaired.vertices.map((v) => v.y);
    const xs = repaired.vertices.map((v) => v.x);
    assert.ok(Math.abs(Math.min(...ys)) < 1e-6);
    assert.ok(Math.abs((Math.min(...xs) + Math.max(...xs)) * 0.5) < 1e-6);

    // Computed smooth normal along +Z for CCW (0,1,0)->(2,1,0)->(0,3,0)
    const n = repaired.normals[0];
    assert.ok(Math.abs(n.z - 1) < 1e-5);
});

test('repairMeshData removes small disconnected triangle islands while keeping main body', () => {
    // Main body: 3 connected triangles sharing vertices at (0,0,0)..(2,2,0)
    // Stray island: 1 disconnected triangle far away at x=50
    const repaired = repairMeshData({
        vertices: [
            { x: 0, y: 0, z: 0 }, // 0
            { x: 1, y: 0, z: 0 }, // 1
            { x: 0, y: 1, z: 0 }, // 2
            { x: 1, y: 1, z: 0 }, // 3
            { x: 2, y: 0, z: 0 }, // 4
            // Island at x=50
            { x: 50, y: 0, z: 0 }, // 5
            { x: 51, y: 0, z: 0 }, // 6
            { x: 50, y: 1, z: 0 }, // 7
        ],
        normals: [],
        uvs: [],
        tris: [
            { material: 'MatA', positionIndices: { x: 0, y: 1, z: 2 } },
            { material: 'MatA', positionIndices: { x: 1, y: 3, z: 2 } },
            { material: 'MatA', positionIndices: { x: 1, y: 4, z: 3 } },
            { material: 'MatA', positionIndices: { x: 5, y: 6, z: 7 } },
        ],
    }, {
        removeSmallIslands: true,
        minIslandTriangles: 2,
    });

    assert.equal(repaired.stats.keptTriangles, 3);
    assert.equal(repaired.stats.removedIslandTriangles, 1);
    assert.equal(repaired.stats.removedIslandComponents, 1);
    assert.equal(repaired.stats.keptVertices, 5);
    // Max X of centered main body should be 1 (from width 2), NOT 25+ from island
    const maxX = Math.max(...repaired.vertices.map((v) => v.x));
    assert.ok(maxX <= 1.01);
});

