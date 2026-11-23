import assert from 'node:assert/strict';
import test from 'node:test';

import { analyzeMeshGeometry, applyMeshEditOp, cloneMeshGeometry, MeshGeometrySnapshot } from './mesh_editor';
import { UV } from './util';
import { Vector3 } from './vector';

function makeTetrahedron(): MeshGeometrySnapshot {
    return {
        vertices: [
            new Vector3(0, 0, 0),
            new Vector3(1, 0, 0),
            new Vector3(0, 1, 0),
            new Vector3(0, 0, 1),
        ],
        normals: [
            new Vector3(0, 0, -1),
            new Vector3(0, -1, 0),
            new Vector3(-1, 0, 0),
            new Vector3(0.577, 0.577, 0.577),
        ],
        uvs: [new UV(0, 0), new UV(1, 0), new UV(0, 1)],
        tris: [
            {
                positionIndices: { x: 0, y: 1, z: 2 },
                normalIndices: { x: 0, y: 0, z: 0 },
                texcoordIndices: { x: 0, y: 1, z: 2 },
                material: 'mat',
            },
            {
                positionIndices: { x: 1, y: 2, z: 3 },
                normalIndices: { x: 3, y: 3, z: 3 },
                texcoordIndices: { x: 0, y: 1, z: 2 },
                material: 'mat',
            },
        ],
    };
}

function makeUvSphereGrid(latSteps: number, lonSteps: number): MeshGeometrySnapshot {
    const vertices: Vector3[] = [];
    const normals: Vector3[] = [];
    const uvs: UV[] = [];
    const tris: MeshGeometrySnapshot['tris'] = [];

    for (let i = 0; i <= latSteps; ++i) {
        const theta = (i / latSteps) * Math.PI;
        for (let j = 0; j <= lonSteps; ++j) {
            const phi = (j / lonSteps) * Math.PI * 2;
            const x = Math.sin(theta) * Math.cos(phi);
            const y = Math.cos(theta);
            const z = Math.sin(theta) * Math.sin(phi);
            vertices.push(new Vector3(x, y, z));
            normals.push(new Vector3(x, y, z));
            uvs.push(new UV(j / lonSteps, i / latSteps));
        }
    }

    const row = lonSteps + 1;
    for (let i = 0; i < latSteps; ++i) {
        for (let j = 0; j < lonSteps; ++j) {
            const a = i * row + j;
            const b = (i + 1) * row + j;
            const c = (i + 1) * row + (j + 1);
            const d = i * row + (j + 1);
            if (i !== 0) {
                tris.push({
                    positionIndices: { x: a, y: b, z: d },
                    normalIndices: { x: a, y: b, z: d },
                    texcoordIndices: { x: a, y: b, z: d },
                    material: 'mat',
                });
            }
            if (i !== latSteps - 1) {
                tris.push({
                    positionIndices: { x: b, y: c, z: d },
                    normalIndices: { x: b, y: c, z: d },
                    texcoordIndices: { x: b, y: c, z: d },
                    material: 'mat',
                });
            }
        }
    }
    return { vertices, normals, uvs, tris };
}

test('applyMeshEditOp scales non-uniformly and preserves centering', () => {
    const base = makeTetrahedron();
    const scaled = applyMeshEditOp(base, {
        operation: 'transform',
        scale: { x: 3, y: 1, z: 2 },
        rotateDeg: { x: 0, y: 0, z: 0 },
        flipAxis: null,
    });

    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const v of scaled.vertices) {
        minX = Math.min(minX, v.x);
        maxX = Math.max(maxX, v.x);
        minY = Math.min(minY, v.y);
        maxY = Math.max(maxY, v.y);
    }
    assert.ok(Math.abs((maxX - minX) - 3) < 1e-6);
    assert.ok(Math.abs((maxY - minY) - 1) < 1e-6);
    assert.ok(Math.abs(minX + maxX) < 1e-6);
});

test('applyMeshEditOp flipAxis reverses triangle winding and mirrors normals', () => {
    const base = makeTetrahedron();
    const flipped = applyMeshEditOp(base, {
        operation: 'transform',
        scale: { x: 1, y: 1, z: 1 },
        rotateDeg: { x: 0, y: 0, z: 0 },
        flipAxis: 'x',
    });

    assert.equal(flipped.tris[0].positionIndices.y, base.tris[0].positionIndices.z);
    assert.equal(flipped.tris[0].positionIndices.z, base.tris[0].positionIndices.y);
    assert.ok(flipped.normals[2].x > 0.9);
});

test('applyMeshEditOp flipNormals negates normals and flips winding', () => {
    const base = makeTetrahedron();
    const orig = cloneMeshGeometry(base);
    const flipped = applyMeshEditOp(orig, { operation: 'flipNormals' });
    assert.equal(flipped.tris[1].positionIndices.y, base.tris[1].positionIndices.z);
    assert.ok(Math.abs(flipped.normals[0].z - 1) < 1e-6);
});

test('applyMeshEditOp recomputeNormals and flatNormals assign valid unit normals', () => {
    const base = makeTetrahedron();
    const smooth = applyMeshEditOp(base, { operation: 'recomputeNormals' });
    for (const n of smooth.normals) {
        assert.ok(Math.abs(n.magnitude() - 1) < 1e-5);
    }
    assert.equal(smooth.tris[0].normalIndices?.x, smooth.tris[0].positionIndices.x);

    const flat = applyMeshEditOp(base, { operation: 'flatNormals' });
    assert.equal(flat.normals.length, flat.tris.length);
    for (let i = 0; i < flat.tris.length; ++i) {
        const tri = flat.tris[i];
        assert.equal(tri.normalIndices?.x, tri.normalIndices?.y);
        assert.equal(tri.normalIndices?.y, tri.normalIndices?.z);
        assert.ok(Math.abs(flat.normals[i].magnitude() - 1) < 1e-5);
    }
});

test('analyzeMeshGeometry detects components, degenerate triangles, missing normals, and OOB UVs', () => {
    const mesh: MeshGeometrySnapshot = {
        vertices: [
            new Vector3(0, 0, 0),
            new Vector3(2, 0, 0),
            new Vector3(0, 2, 0),
            new Vector3(10, 0, 0),
            new Vector3(11, 0, 0),
            new Vector3(10, 1, 0),
        ],
        normals: [new Vector3(0, 0, 1)],
        uvs: [new UV(0, 0), new UV(1.4, 0), new UV(0, 1)],
        tris: [
            {
                positionIndices: { x: 0, y: 1, z: 2 },
                normalIndices: { x: 0, y: 0, z: 0 },
                texcoordIndices: { x: 0, y: 1, z: 2 },
                material: 'a',
            },
            {
                positionIndices: { x: 3, y: 4, z: 5 },
                material: 'a',
            },
            {
                positionIndices: { x: 0, y: 0, z: 1 },
                material: 'a',
            },
        ],
    };

    const diag = analyzeMeshGeometry(mesh);
    assert.equal(diag.vertexCount, 6);
    assert.equal(diag.triangleCount, 3);
    assert.equal(diag.connectedComponents, 2);
    assert.equal(diag.degenerateTriangles, 1);
    assert.equal(diag.missingNormalTriangles, 2);
    assert.equal(diag.hasOobUVs, true);
    assert.equal(diag.dimensions.x, 11);
});

test('applyMeshEditOp weldVertices, putOnGround, normalizeSize, decimate, cleanRepair, and cropBounds work properly', () => {
    const dup: MeshGeometrySnapshot = {
        vertices: [
            new Vector3(0, 1, 0),
            new Vector3(2, 1, 0),
            new Vector3(0, 3, 0),
            new Vector3(0.0001, 1.0001, 0),
            new Vector3(2.0001, 1.0001, 0),
            new Vector3(0, 1, 2),
        ],
        normals: [new Vector3(0, 1, 0)],
        uvs: [new UV(0, 0)],
        tris: [
            { positionIndices: { x: 0, y: 1, z: 2 }, material: 'mat' },
            { positionIndices: { x: 3, y: 4, z: 5 }, material: 'mat' },
        ],
    };

    const welded = applyMeshEditOp(dup, { operation: 'weldVertices', weldTolerance: 0.005 });
    assert.equal(welded.vertices.length, 4);
    assert.equal(analyzeMeshGeometry(welded).connectedComponents, 1);

    const grounded = applyMeshEditOp(welded, { operation: 'putOnGround' });
    const gDiag = analyzeMeshGeometry(grounded);
    assert.ok(Math.abs(gDiag.minY) < 1e-6);

    const normalized = applyMeshEditOp(grounded, { operation: 'normalizeSize' });
    const nDiag = analyzeMeshGeometry(normalized);
    assert.ok(Math.abs(nDiag.dimensions.y - 1.0) < 1e-5);

    const sphere = makeUvSphereGrid(10, 14);
    const decimated = applyMeshEditOp(sphere, { operation: 'decimate', decimateRatio: 0.35 });
    assert.ok(decimated.tris.length < sphere.tris.length);
    assert.ok(decimated.tris.length >= 4);

    const cropped = applyMeshEditOp(sphere, {
        operation: 'cropBounds',
        cropMin: { x: 0, y: 0.5, z: 0 },
        cropMax: { x: 1, y: 1, z: 1 },
    });
    assert.ok(cropped.tris.length > 0 && cropped.tris.length < sphere.tris.length);

    const cleaned = applyMeshEditOp(dup, {
        operation: 'cleanRepair',
        forceRecomputeNormals: true,
        removeSmallIslands: false,
    });
    assert.equal(analyzeMeshGeometry(cleaned).missingNormalTriangles, 0);
});
