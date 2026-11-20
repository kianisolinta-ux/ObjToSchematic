import assert from 'node:assert/strict';
import test from 'node:test';

import {
    collectGltfPrimitives,
    composeTRS,
    computeNormalMatrix3,
    decodeColorAccessor,
    detectImageMimeType,
    expandPrimitiveTriangleIndices,
    identityMat4,
    linearFactorToSrgbRGBA,
    linearToSrgbChannel,
    multiplyMat4,
    transformNormal,
    transformPoint,
} from './gltf_utils';

test('composeTRS and multiplyMat4 combine parent translation with child rotation and scale', () => {
    const parent = composeTRS([10, 0, 0], undefined, undefined);
    // 90 deg rotation around Y: q = [0, sin(pi/4), 0, cos(pi/4)]
    const s = Math.SQRT1_2;
    const child = composeTRS([0, 2, 0], [0, s, 0, s], [2, 3, 4]);
    const world = multiplyMat4(parent, child);

    const [x, y, z] = transformPoint(world, 1, 0, 0);
    // Local (1,0,0) * scale (2,3,4) = (2,0,0); rotated +90 deg around Y -> (0, 0, -2); + translate (10,2,0)
    assert.ok(Math.abs(x - 10) < 1e-5);
    assert.ok(Math.abs(y - 2) < 1e-5);
    assert.ok(Math.abs(z - (-2)) < 1e-5);
});

test('computeNormalMatrix3 handles non-uniform scaling and detects negative determinant', () => {
    const nonUniform = composeTRS([0, 0, 0], undefined, [2, 1, 1]);
    const { m3, det } = computeNormalMatrix3(nonUniform);
    assert.ok(det > 0);
    // Slope normal (1, 1, 0) scaled by (2, 1, 1) becomes (0.5, 1, 0) normalized
    const [nx, ny, nz] = transformNormal(m3, 1, 1, 0);
    const expectedLen = Math.hypot(0.5, 1, 0);
    assert.ok(Math.abs(nx - 0.5 / expectedLen) < 1e-5);
    assert.ok(Math.abs(ny - 1.0 / expectedLen) < 1e-5);
    assert.ok(Math.abs(nz) < 1e-5);

    const mirrored = composeTRS(undefined, undefined, [-1, 1, 1]);
    const mirroredRes = computeNormalMatrix3(mirrored);
    assert.ok(mirroredRes.det < 0);
});

test('collectGltfPrimitives traverses scene hierarchy, skips cycles, and falls back to raw meshes', () => {
    const nodeA: any = { translation: [1, 0, 0], children: [1] };
    const nodeB: any = { translation: [0, 5, 0], mesh: 0, children: [0] }; // cycle back to 0
    const gltf = {
        scene: 0,
        scenes: [{ nodes: [0] }],
        nodes: [nodeA, nodeB],
        meshes: [{ primitives: [{ id: 'p0' }] }],
    };

    const collected = collectGltfPrimitives(gltf);
    assert.equal(collected.length, 1);
    assert.equal(collected[0].primitive.id, 'p0');
    const [x, y, z] = transformPoint(collected[0].worldMatrix, 0, 0, 0);
    assert.deepEqual([x, y, z], [1, 5, 0]);

    // Fallback when no scenes/nodes exist
    const rawOnly = {
        meshes: { m0: { primitives: [{ id: 'raw' }] } },
    };
    const fallback = collectGltfPrimitives(rawOnly);
    assert.equal(fallback.length, 1);
    assert.equal(fallback[0].primitive.id, 'raw');
    assert.deepEqual(fallback[0].worldMatrix, identityMat4());
});

test('collectGltfPrimitives picks up orphan nodes when scene has no nodes', () => {
    const gltf = {
        nodes: [
            { translation: [3, 0, 0], children: [1] },
            { translation: [0, 4, 0], mesh: 0 },
        ],
        meshes: [{ primitives: [{ id: 'orphan' }] }],
    };
    const collected = collectGltfPrimitives(gltf);
    assert.equal(collected.length, 1);
    const [x, y, z] = transformPoint(collected[0].worldMatrix, 0, 0, 0);
    assert.deepEqual([x, y, z], [3, 4, 0]);
});

test('expandPrimitiveTriangleIndices supports TRIANGLES, TRIANGLE_STRIP, TRIANGLE_FAN, and skips LINES', () => {
    assert.deepEqual(expandPrimitiveTriangleIndices([0, 1, 2, 3, 4, 5], 6, 4), [0, 1, 2, 3, 4, 5]);
    assert.deepEqual(expandPrimitiveTriangleIndices([0, 1, 2, 3], 4, 5), [0, 1, 2, 2, 1, 3]);
    assert.deepEqual(expandPrimitiveTriangleIndices(undefined, 4, 6), [0, 1, 2, 0, 2, 3]);
    assert.deepEqual(expandPrimitiveTriangleIndices([0, 1, 2, 3], 4, 1), []);
});

test('linearToSrgbChannel and linearFactorToSrgbRGBA convert linear glTF values to sRGB', () => {
    assert.equal(linearToSrgbChannel(0), 0);
    assert.equal(linearToSrgbChannel(1), 1);
    // Mid-grey linear ~0.214 -> sRGB ~0.5
    assert.ok(Math.abs(linearToSrgbChannel(0.214041) - 0.5) < 0.01);

    const opaque = linearFactorToSrgbRGBA([1, 0.214041, 0, 0.25], true);
    assert.equal(opaque.a, 1);
    assert.ok(Math.abs(opaque.g - 0.5) < 0.01);

    const blended = linearFactorToSrgbRGBA([1, 1, 1, 0.4], false);
    assert.ok(Math.abs(blended.a - 0.4) < 1e-6);
});

test('decodeColorAccessor decodes Float32 VEC3 and Uint8/Uint16 VEC4 normalized colours', () => {
    const f32 = decodeColorAccessor({
        value: new Float32Array([1, 0, 0.214041]),
        components: 3,
    });
    assert.equal(f32.length, 1);
    assert.equal(f32[0].r, 1);
    assert.equal(f32[0].g, 0);
    assert.ok(Math.abs(f32[0].b - 0.5) < 0.01);
    assert.equal(f32[0].a, 1);

    const u8 = decodeColorAccessor({
        value: new Uint8Array([255, 0, 0, 128]),
        type: 'VEC4',
        componentType: 5121,
    });
    assert.equal(u8.length, 1);
    assert.equal(u8[0].r, 1);
    assert.ok(Math.abs(u8[0].a - 128 / 255) < 1e-4);

    const u16 = decodeColorAccessor({
        value: new Uint16Array([0, 65535, 0, 65535]),
        count: 1,
        componentType: 5123,
    });
    assert.equal(u16.length, 1);
    assert.equal(u16[0].g, 1);
    assert.equal(u16[0].a, 1);
});

test('detectImageMimeType recognizes PNG, JPEG, WEBP magic bytes and respects declared MIME', () => {
    assert.equal(detectImageMimeType(new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D])), 'image/png');
    assert.equal(detectImageMimeType(new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0])), 'image/jpeg');
    assert.equal(
        detectImageMimeType(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])),
        'image/webp',
    );
    assert.equal(detectImageMimeType(new Uint8Array([0, 0, 0, 0]), ' image/PNG '), 'image/png');
});
