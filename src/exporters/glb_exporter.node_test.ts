import assert from 'node:assert/strict';
import test from 'node:test';

import { GlbMaterialLike, serializeGlbFromMeshData, srgbToLinearChannel } from './glb_serializer';

function parseGlbChunks(glb: Uint8Array): { json: any; bin: Uint8Array } {
    const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
    assert.equal(view.getUint32(0, true), 0x46546C67); // 'glTF'
    assert.equal(view.getUint32(4, true), 2);
    assert.equal(view.getUint32(8, true), glb.byteLength);

    const jsonLen = view.getUint32(12, true);
    assert.equal(view.getUint32(16, true), 0x4E4F534A); // 'JSON'
    const jsonText = Buffer.from(glb.subarray(20, 20 + jsonLen)).toString('utf8').trimEnd();
    const json = JSON.parse(jsonText);

    const binOffset = 20 + jsonLen;
    const binLen = view.getUint32(binOffset, true);
    assert.equal(view.getUint32(binOffset + 4, true), 0x004E4942); // 'BIN\0'
    const bin = glb.subarray(binOffset + 8, binOffset + 8 + binLen);
    return { json, bin };
}

test('srgbToLinearChannel handles bounds and midtones accurately', () => {
    assert.equal(srgbToLinearChannel(0), 0);
    assert.equal(srgbToLinearChannel(1), 1);
    assert.ok(Math.abs(srgbToLinearChannel(0.5) - 0.21404114) < 1e-5);
});

test('serializeGlbFromMeshData writes valid GLB 2.0 header, chunks, textures, and attributes', () => {
    const pngBase64 = 'data:image/png;base64,' + Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]).toString('base64');
    const materials = new Map<string, GlbMaterialLike>();
    materials.set('SolidMat', {
        type: 0,
        colour: { r: 0.5, g: 0.25, b: 0.75, a: 1 },
    });
    materials.set('TexMat', {
        type: 1,
        diffuse: { filetype: 'png', raw: pngBase64 },
        interpolation: 'nearest',
        extension: 'repeat',
        transparency: { type: 'UseDiffuseMapAlphaChannel' },
        alphaCutoff: 0.4,
    });

    const { glbBytes, stats } = serializeGlbFromMeshData(
        {
            vertices: [
                { x: 0, y: 2, z: 0 },
                { x: 1, y: 2, z: 0 },
                { x: 0, y: 3, z: 0 },
                { x: 2, y: 2, z: 1 },
                { x: 3, y: 2, z: 1 },
                { x: 2, y: 3, z: 1 },
            ],
            normals: [],
            uvs: [
                { u: 0.1, v: 0.2 },
                { u: 0.9, v: 0.2 },
                { u: 0.5, v: 0.8 },
            ],
            vertexColours: [
                { r: 1, g: 0, b: 0, a: 1 },
                { r: 0, g: 1, b: 0, a: 1 },
                { r: 0, g: 0, b: 1, a: 1 },
            ],
            tris: [
                {
                    material: 'SolidMat',
                    positionIndices: { x: 0, y: 1, z: 2 },
                    vertexColourIndices: { x: 0, y: 1, z: 2 },
                },
                {
                    material: 'TexMat',
                    positionIndices: { x: 3, y: 4, z: 5 },
                    texcoordIndices: { x: 0, y: 1, z: 2 },
                },
            ],
        },
        materials,
        { modelName: 'TestCube' },
    );

    assert.equal(stats.keptTriangles, 2);
    assert.equal(glbBytes.byteLength % 4, 0);

    const { json, bin } = parseGlbChunks(glbBytes);
    assert.equal(json.asset.version, '2.0');
    assert.equal(json.meshes[0].name, 'TestCube');
    assert.equal(json.meshes[0].primitives.length, 2);
    assert.equal(json.materials.length, 2);
    assert.equal(json.images.length, 1);
    assert.equal(json.images[0].mimeType, 'image/png');
    assert.equal(json.samplers[0].magFilter, 9728); // nearest
    assert.equal(json.samplers[0].wrapS, 10497); // repeat
    assert.equal(json.materials[1].alphaMode, 'MASK');
    assert.ok(Math.abs(json.materials[1].alphaCutoff - 0.4) < 1e-6);

    // Every bufferView offset & total BIN length is 4-byte aligned
    assert.equal(bin.byteLength, json.buffers[0].byteLength);
    for (const bv of json.bufferViews) {
        assert.equal(bv.byteOffset % 4, 0);
        assert.ok(bv.byteOffset + bv.byteLength <= bin.byteLength);
    }

    // Check flipped UV in primitive 1
    const texPrim = json.meshes[0].primitives[1];
    assert.ok(texPrim.attributes.TEXCOORD_0 !== undefined);
    const uvAcc = json.accessors[texPrim.attributes.TEXCOORD_0];
    const uvBv = json.bufferViews[uvAcc.bufferView];
    const uvData = new Float32Array(bin.buffer, bin.byteOffset + uvBv.byteOffset, uvAcc.count * 2);
    // Mesh v = 0.2 -> glTF v = 0.8
    assert.ok(Math.abs(uvData[0] - 0.1) < 1e-5);
    assert.ok(Math.abs(uvData[1] - 0.8) < 1e-5);

    // Check POSITION min/max exists on every primitive
    for (const prim of json.meshes[0].primitives) {
        const posAcc = json.accessors[prim.attributes.POSITION];
        assert.equal(posAcc.min.length, 3);
        assert.equal(posAcc.max.length, 3);
    }
});
