import assert from 'node:assert/strict';
import test from 'node:test';

import { MeshGeometrySnapshot } from './mesh_editor';
import {
    addSnapshotLayer,
    applyEditToActiveModelLayer,
    createInitialModelLayersState,
    deleteModelLayer,
    getOriginalModelLayer,
    mergeVisibleModelLayers,
    mergeVisiblePartsIntoSingleLayer,
    replaceWorkingLayersWithSplitParts,
    restoreLayerToWorking,
    splitGeometryByMaterial,
    splitGeometryIntoConnectedParts,
    toggleModelLayerSolo,
    toggleModelLayerVisibility,
} from './model_layers';
import { UV } from './util';
import { Vector3 } from './vector';

function makeTwoPartMesh(): MeshGeometrySnapshot {
    return {
        vertices: [
            // Island A (material matA)
            new Vector3(0, 0, 0),
            new Vector3(1, 0, 0),
            new Vector3(0, 1, 0),
            // Island B (material matB, disconnected far away)
            new Vector3(10, 0, 0),
            new Vector3(11, 0, 0),
            new Vector3(10, 1, 0),
        ],
        normals: [new Vector3(0, 0, 1)],
        uvs: [new UV(0, 0), new UV(1, 0), new UV(0, 1)],
        tris: [
            {
                positionIndices: { x: 0, y: 1, z: 2 },
                normalIndices: { x: 0, y: 0, z: 0 },
                texcoordIndices: { x: 0, y: 1, z: 2 },
                material: 'matA',
            },
            {
                positionIndices: { x: 3, y: 4, z: 5 },
                normalIndices: { x: 0, y: 0, z: 0 },
                texcoordIndices: { x: 0, y: 1, z: 2 },
                material: 'matB',
            },
        ],
    };
}

test('createInitialModelLayersState creates locked original ref and editable working layer', () => {
    const geom = makeTwoPartMesh();
    const state = createInitialModelLayersState(geom);
    assert.equal(state.layers.length, 2);
    const orig = getOriginalModelLayer(state);
    assert.ok(orig);
    assert.equal(orig.locked, true);
    assert.equal(orig.visible, false);

    const active = state.layers.find((l) => l.id === state.activeLayerId);
    assert.ok(active);
    assert.equal(active.locked, false);
    assert.equal(active.visible, true);
});

test('splitting connected islands creates independent editable parts, solo/visibility filter works, and merging preserves geometry', () => {
    const geom = makeTwoPartMesh();
    let state = createInitialModelLayersState(geom);

    const parts = splitGeometryIntoConnectedParts(geom);
    assert.equal(parts.length, 2);
    state = replaceWorkingLayersWithSplitParts(state, parts);

    const partLayers = state.layers.filter((l) => l.kind === 'part');
    assert.equal(partLayers.length, 2);

    // Edit only Part 1 (translate along Y)
    const editRes = applyEditToActiveModelLayer(state, {
        operation: 'translate',
        offset: { x: 0, y: 5, z: 0 },
    });
    assert.equal(editRes.edited, true);
    state = editRes.state;

    // Merged visible should contain Part 1 translated + Part 2 untouched
    const mergedBoth = mergeVisibleModelLayers(state.layers);
    assert.ok(mergedBoth);
    assert.equal(mergedBoth.tris.length, 2);
    assert.ok(mergedBoth.vertices.some((v) => Math.abs(v.y - 5) < 1e-5));
    assert.ok(mergedBoth.vertices.some((v) => Math.abs(v.x - 10) < 1e-5 && Math.abs(v.y) < 1e-5));

    // Solo Part 2 isolates only Part 2
    state = toggleModelLayerSolo(state, partLayers[1].id);
    const soloMerged = mergeVisibleModelLayers(state.layers);
    assert.ok(soloMerged);
    assert.equal(soloMerged.tris.length, 1);
    assert.ok(soloMerged.vertices.every((v) => v.x >= 9));

    // Un-solo and hide Part 1
    state = toggleModelLayerSolo(state, partLayers[1].id);
    state = toggleModelLayerVisibility(state, partLayers[0].id);
    const hiddenMerged = mergeVisibleModelLayers(state.layers);
    assert.ok(hiddenMerged);
    assert.equal(hiddenMerged.tris.length, 1);
});

test('splitGeometryByMaterial groups triangles by material and mergeVisiblePartsIntoSingleLayer flattens', () => {
    const geom = makeTwoPartMesh();
    const matParts = splitGeometryByMaterial(geom);
    assert.equal(matParts.length, 2);
    assert.equal(matParts[0].name, 'Mat: matA');
    assert.equal(matParts[1].name, 'Mat: matB');

    let state = createInitialModelLayersState(geom);
    state = replaceWorkingLayersWithSplitParts(state, matParts);
    state = mergeVisiblePartsIntoSingleLayer(state, 'Combined');
    assert.equal(state.layers.filter((l) => l.kind === 'working').length, 1);
    const active = state.layers.find((l) => l.id === state.activeLayerId);
    assert.equal(active?.triangleCount, 2);
});

test('snapshot and rollback to Original Ref cleanly restores broken geometry edits', () => {
    const geom = makeTwoPartMesh();
    let state = createInitialModelLayersState(geom);

    // Save a snapshot
    const snap = addSnapshotLayer(state, geom, 'Checkpoint 1');
    state = snap.state;
    assert.equal(state.layers.length, 3);

    // Modify active working layer destructively (translate + scale)
    state = applyEditToActiveModelLayer(state, {
        operation: 'transform',
        scale: { x: 4, y: 4, z: 4 },
    }).state;
    const modifiedMerged = mergeVisibleModelLayers(state.layers)!;
    assert.ok(modifiedMerged.vertices.some((v) => Math.abs(v.x) > 15));

    // Rollback from Original Reference layer
    const restored = restoreLayerToWorking(state, state.originalLayerId);
    assert.ok(restored.restoredId);
    state = restored.state;
    const restoredMerged = mergeVisibleModelLayers(state.layers)!;
    assert.equal(restoredMerged.tris.length, 2);
    assert.ok(restoredMerged.vertices.some((v) => Math.abs(v.x - 11) < 1e-5));

    // Deleting original layer is forbidden, deleting snapshot succeeds
    const afterTryDelOrig = deleteModelLayer(state, state.originalLayerId);
    assert.equal(afterTryDelOrig.layers.length, state.layers.length);

    const afterDelSnap = deleteModelLayer(state, snap.layer.id);
    assert.equal(afterDelSnap.layers.length, 2);
});
