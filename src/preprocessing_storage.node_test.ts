import assert from 'node:assert/strict';
import test from 'node:test';

import type { MaterialMap, MaterialType } from './mesh';
import { analyzeMeshGeometry, MeshGeometrySnapshot } from './mesh_editor';
import {
    buildPreprocessBundle,
    deserializeGeometrySnapshot,
    deserializeMaterialMap,
    parsePreprocessBundle,
    PreprocessStorage,
    serializePreprocessBundleJson,
} from './preprocessing_storage';
import { UV } from './util';
import { Vector3 } from './vector';

function makeSampleGeom(): MeshGeometrySnapshot {
    return {
        vertices: [
            new Vector3(0, 0, 0),
            new Vector3(2, 0, 0),
            new Vector3(0, 2, 0),
        ],
        normals: [new Vector3(0, 0, 1)],
        uvs: [new UV(0, 0), new UV(1, 0), new UV(0, 1)],
        tris: [
            {
                positionIndices: { x: 0, y: 1, z: 2 },
                normalIndices: { x: 0, y: 0, z: 0 },
                texcoordIndices: { x: 0, y: 1, z: 2 },
                material: 'skin',
            },
        ],
    };
}

function makeSampleMaterials(): MaterialMap {
    const map: MaterialMap = new Map();
    map.set('skin', {
        type: 1 as MaterialType.textured,
        diffuse: { filetype: 'png', raw: 'data:image/png;base64,AAAA' },
        interpolation: 'nearest',
        extension: 'clamp',
        transparency: { type: 'None' },
        needsAttention: false,
    });
    map.set('trim', {
        type: 0 as MaterialType.solid,
        colour: { r: 0.8, g: 0.2, b: 0.1, a: 1 },
        canBeTextured: true,
        needsAttention: false,
    });
    return map;
}

test('PreprocessBundleV1 serializes, validates, and round-trips geometry & materials accurately', () => {
    const geom = makeSampleGeom();
    const mats = makeSampleMaterials();
    const diag = analyzeMeshGeometry(geom);

    const bundle = buildPreprocessBundle({
        name: 'Clean Head v1',
        sourceFilename: 'skull.obj',
        diagnostics: diag,
        geometry: geom,
        materials: mats,
        operations: [{ timestamp: 1000, label: 'Weld vertices' }],
        recipe: {
            weldTolerance: 0.001,
            decimateRatio: 0.75,
            minIslandTriangles: 16,
            forceSmoothNormals: true,
            cropMin: { x: 0, y: 0, z: 0 },
            cropMax: { x: 1, y: 1, z: 1 },
        },
    });

    const json = serializePreprocessBundleJson(bundle);
    const parsed = parsePreprocessBundle(json);

    assert.equal(parsed.name, 'Clean Head v1');
    assert.equal(parsed.sourceFilename, 'skull.obj');
    assert.equal(parsed.operations.length, 1);

    const restoredGeom = deserializeGeometrySnapshot(parsed.geometry);
    assert.equal(restoredGeom.vertices.length, 3);
    assert.ok(restoredGeom.vertices[1] instanceof Vector3);
    assert.ok(restoredGeom.uvs[2] instanceof UV);
    assert.equal(restoredGeom.tris[0].material, 'skin');

    const restoredMats = deserializeMaterialMap(parsed.materials);
    assert.equal(restoredMats.size, 2);
    assert.equal(restoredMats.get('trim')?.type, 0);
    assert.equal(restoredMats.get('skin')?.type, 1);
});

test('parsePreprocessBundle rejects malformed or invalid bundles', () => {
    assert.throws(() => parsePreprocessBundle('not json'));
    assert.throws(() => parsePreprocessBundle('{"format":"wrong","version":1}'));
    assert.throws(() => parsePreprocessBundle('{"format":"objtoschematic-preprocess","version":1,"geometry":{"vertices":[],"tris":[]},"materials":[]}'));
});

test('PreprocessStorage saves, lists, gets, and deletes checkpoints and recipes in offline fallback', async () => {
    const geom = makeSampleGeom();
    const mats = makeSampleMaterials();
    const bundle = buildPreprocessBundle({
        id: 'ckpt_test_1',
        name: 'Test Checkpoint',
        sourceFilename: 'test.glb',
        diagnostics: analyzeMeshGeometry(geom),
        geometry: geom,
        materials: mats,
    });

    const summary = await PreprocessStorage.saveCheckpoint(bundle);
    assert.equal(summary.id, 'ckpt_test_1');
    assert.equal(summary.triangleCount, 1);

    const list = await PreprocessStorage.listCheckpoints();
    assert.ok(list.some((item) => item.id === 'ckpt_test_1'));

    const loaded = await PreprocessStorage.getCheckpoint('ckpt_test_1');
    assert.equal(loaded?.name, 'Test Checkpoint');

    await PreprocessStorage.deleteCheckpoint('ckpt_test_1');
    const afterDelete = await PreprocessStorage.getCheckpoint('ckpt_test_1');
    assert.equal(afterDelete, null);

    const recipe = PreprocessStorage.saveRecipe('Low-Poly Smooth', {
        weldTolerance: 0.002,
        decimateRatio: 0.5,
        minIslandTriangles: 24,
        forceSmoothNormals: true,
        cropMin: { x: 0, y: 0.2, z: 0 },
        cropMax: { x: 1, y: 1, z: 1 },
    });
    assert.ok(PreprocessStorage.listRecipes().some((r) => r.id === recipe.id));
    PreprocessStorage.deleteRecipe(recipe.id);
    assert.ok(!PreprocessStorage.listRecipes().some((r) => r.id === recipe.id));
});
