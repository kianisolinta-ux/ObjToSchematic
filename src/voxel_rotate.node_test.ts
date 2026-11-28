import assert from 'node:assert/strict';
import test from 'node:test';

import { VoxelColourRecord } from './voxel_postprocess';
import { rotateVoxelRecords } from './voxel_rotate';

function boundsOf(voxels: readonly VoxelColourRecord[]) {
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    for (const v of voxels) {
        if (v.x < minX) minX = v.x;
        if (v.y < minY) minY = v.y;
        if (v.z < minZ) minZ = v.z;
        if (v.x > maxX) maxX = v.x;
        if (v.y > maxY) maxY = v.y;
        if (v.z > maxZ) maxZ = v.z;
    }
    return {
        dimX: maxX - minX + 1,
        dimY: maxY - minY + 1,
        dimZ: maxZ - minZ + 1,
    };
}

function makeAsymmetricBox(): VoxelColourRecord[] {
    const voxels: VoxelColourRecord[] = [];
    // 2 x 3 x 5 asymmetric box + corner marker
    for (let x = 0; x < 2; ++x) {
        for (let y = 0; y < 3; ++y) {
            for (let z = 0; z < 5; ++z) {
                const isCorner = x === 1 && y === 2 && z === 4;
                voxels.push({
                    x,
                    y,
                    z,
                    colour: isCorner ?
                        { r: 1, g: 0, b: 0, a: 1 } :
                        { r: 0.2, g: 0.6, b: 0.9, a: 1 },
                });
            }
        }
    }
    return voxels;
}

test('rotateVoxelRecords handles empty input and 0/360 degree identity rotations', () => {
    assert.deepEqual(rotateVoxelRecords([], { x: 90, y: 45, z: 0 }), []);

    const box = makeAsymmetricBox();
    const zeroRot = rotateVoxelRecords(box, { x: 0, y: 0, z: 0 });
    const fullTurn = rotateVoxelRecords(box, { x: 360, y: -360, z: 720 });

    assert.equal(zeroRot.length, box.length);
    assert.equal(fullTurn.length, box.length);
    assert.deepEqual(zeroRot, box);
    assert.deepEqual(fullTurn, box);
});

test('rotateVoxelRecords performs exact lossless 90-degree rotations along X, Y, and Z axes', () => {
    const box = makeAsymmetricBox(); // dims 2 x 3 x 5

    // 90 deg around Y swaps X and Z -> dims 5 x 3 x 2
    const rotY90 = rotateVoxelRecords(box, { x: 0, y: 90, z: 0 });
    assert.equal(rotY90.length, box.length);
    assert.deepEqual(boundsOf(rotY90), { dimX: 5, dimY: 3, dimZ: 2 });

    // 90 deg around X swaps Y and Z -> dims 2 x 5 x 3
    const rotX90 = rotateVoxelRecords(box, { x: 90, y: 0, z: 0 });
    assert.equal(rotX90.length, box.length);
    assert.deepEqual(boundsOf(rotX90), { dimX: 2, dimY: 5, dimZ: 3 });

    // 90 deg around Z swaps X and Y -> dims 3 x 2 x 5
    const rotZ90 = rotateVoxelRecords(box, { x: 0, y: 0, z: 90 });
    assert.equal(rotZ90.length, box.length);
    assert.deepEqual(boundsOf(rotZ90), { dimX: 3, dimY: 2, dimZ: 5 });

    // Check uniqueness (no collapsed duplicate coordinates)
    const keys = new Set(rotY90.map((v) => `${v.x},${v.y},${v.z}`));
    assert.equal(keys.size, box.length);
});

test('rotateVoxelRecords produces hole-free rotated plate at arbitrary angles (45 deg and compound)', () => {
    // 1-voxel thick 9x9 horizontal plate at y=0
    const plate: VoxelColourRecord[] = [];
    for (let x = 0; x < 9; ++x) {
        for (let z = 0; z < 9; ++z) {
            plate.push({ x, y: 0, z, colour: { r: 0.4, g: 0.8, b: 0.3, a: 1 } });
        }
    }

    const rotated45 = rotateVoxelRecords(plate, { x: 0, y: 45, z: 0 });
    const keys = new Set(rotated45.map((v) => `${v.x},${v.y},${v.z}`));
    assert.equal(keys.size, rotated45.length);
    assert.ok(rotated45.length >= 65, `Expected dense rotated plate, got ${rotated45.length}`);
    // Every voxel on y=0 should remain on y=0 when only rotating around Y
    for (const v of rotated45) {
        assert.equal(v.y, 0);
    }

    // Compound rotation around all three axes produces valid unique integer voxels
    const compound = rotateVoxelRecords(makeAsymmetricBox(), { x: 25, y: 45, z: -15 });
    const compoundKeys = new Set(compound.map((v) => `${v.x},${v.y},${v.z}`));
    assert.equal(compoundKeys.size, compound.length);
    assert.ok(compound.length >= 25);
});

function hasExteriorLeak6(voxels: readonly VoxelColourRecord[], bound = 16): boolean {
    const occupied = new Set(voxels.map((v) => `${v.x},${v.y},${v.z}`));
    const startKey = `${-bound},${-bound},${-bound}`;
    const visited = new Set<string>([startKey]);
    const queue: [number, number, number][] = [[-bound, -bound, -bound]];
    const dirs: [number, number, number][] = [
        [1, 0, 0], [-1, 0, 0],
        [0, 1, 0], [0, -1, 0],
        [0, 0, 1], [0, 0, -1],
    ];
    while (queue.length > 0) {
        const [x, y, z] = queue.pop()!;
        if (x === 0 && y === 0 && z === 0) {
            return true;
        }
        for (const [dx, dy, dz] of dirs) {
            const nx = x + dx;
            const ny = y + dy;
            const nz = z + dz;
            if (nx < -bound || nx > bound || ny < -bound || ny > bound || nz < -bound || nz > bound) {
                continue;
            }
            const key = `${nx},${ny},${nz}`;
            if (!occupied.has(key) && !visited.has(key)) {
                visited.add(key);
                queue.push([nx, ny, nz]);
            }
        }
    }
    return false;
}

function makeExactSphereShell(radius = 10): VoxelColourRecord[] {
    const inside = (x: number, y: number, z: number) => x * x + y * y + z * z <= radius * radius;
    const dirs: [number, number, number][] = [
        [1, 0, 0], [-1, 0, 0],
        [0, 1, 0], [0, -1, 0],
        [0, 0, 1], [0, 0, -1],
    ];
    const shell: VoxelColourRecord[] = [];
    for (let x = -radius - 1; x <= radius + 1; ++x) {
        for (let y = -radius - 1; y <= radius + 1; ++y) {
            for (let z = -radius - 1; z <= radius + 1; ++z) {
                if (!inside(x, y, z)) {
                    continue;
                }
                if (dirs.some(([dx, dy, dz]) => !inside(x + dx, y + dy, z + dz))) {
                    shell.push({ x, y, z, colour: { r: 0.7, g: 0.3, b: 0.9, a: 1 } });
                }
            }
        }
    }
    return shell;
}

test('rotateVoxelRecords keeps 1-voxel hollow curved shells watertight without holes across arbitrary angles', () => {
    const shell = makeExactSphereShell(10);
    assert.equal(hasExteriorLeak6(shell, 16), false);

    const angles = [
        { x: 0, y: 15, z: 0 },
        { x: 0, y: 45, z: 0 },
        { x: 15, y: 30, z: 0 },
        { x: 23, y: 37, z: 15 },
        { x: 45, y: 45, z: 45 },
    ];
    for (const rot of angles) {
        const rotated = rotateVoxelRecords(shell, rot);
        assert.equal(
            hasExteriorLeak6(rotated, 16),
            false,
            `Expected watertight rotated sphere shell for ${JSON.stringify(rot)}`,
        );
    }
});

test('rotateVoxelRecords keeps diagonal 26-connected sheets connected and leaves intentional windows open', () => {
    const diag: VoxelColourRecord[] = [];
    for (let x = 0; x < 10; ++x) {
        for (let y = 0; y < 10; ++y) {
            diag.push({ x, y, z: x, colour: { r: 1, g: 0.8, b: 0.2, a: 1 } });
        }
    }
    const rotDiag = rotateVoxelRecords(diag, { x: 15, y: 45, z: 20 });
    const occupied = new Set(rotDiag.map((v) => `${v.x},${v.y},${v.z}`));
    assert.equal(occupied.size, rotDiag.length);
    assert.ok(rotDiag.length >= diag.length);

    // Hollow cube with a 2x2 intentional window must remain open to exterior flood-fill
    const windowedCube: VoxelColourRecord[] = [];
    for (let x = -6; x <= 6; ++x) {
        for (let y = -6; y <= 6; ++y) {
            for (let z = -6; z <= 6; ++z) {
                if (Math.abs(x) === 6 || Math.abs(y) === 6 || Math.abs(z) === 6) {
                    if (z === 6 && x >= 0 && x <= 1 && y >= 0 && y <= 1) {
                        continue;
                    }
                    windowedCube.push({ x, y, z, colour: { r: 0.5, g: 0.5, b: 0.5, a: 1 } });
                }
            }
        }
    }
    const rotWin = rotateVoxelRecords(windowedCube, { x: 15, y: 30, z: 10 });
    assert.equal(hasExteriorLeak6(rotWin, 16), true);
});

function countSpursAndExposedFaces(voxels: readonly VoxelColourRecord[]) {
    const occupied = new Set(voxels.map((v) => `${v.x},${v.y},${v.z}`));
    const dirs6: [number, number, number][] = [
        [1, 0, 0], [-1, 0, 0],
        [0, 1, 0], [0, -1, 0],
        [0, 0, 1], [0, 0, -1],
    ];
    let spurs1 = 0;
    let exposedFaces = 0;
    for (const v of voxels) {
        let n6 = 0;
        for (const [dx, dy, dz] of dirs6) {
            if (occupied.has(`${v.x + dx},${v.y + dy},${v.z + dz}`)) {
                n6++;
            } else {
                exposedFaces++;
            }
        }
        if (n6 <= 1) {
            spurs1++;
        }
    }
    return { spurs1, exposedFaces };
}

test('rotateVoxelRecords produces smooth low-bloat surfaces without excessive thickness or rough spurs', () => {
    const shell = makeExactSphereShell(10);
    const origMetrics = countSpursAndExposedFaces(shell);

    for (const rot of [
        { x: 25, y: 37, z: 15 },
        { x: 45, y: 0, z: 0 },
        { x: 15, y: 30, z: 45 },
    ]) {
        const rotated = rotateVoxelRecords(shell, rot);
        const metrics = countSpursAndExposedFaces(rotated);
        assert.ok(
            rotated.length <= Math.ceil(shell.length * 1.25),
            `Expected low-bloat rotated shell (<= ${Math.ceil(shell.length * 1.25)}), got ${rotated.length}`,
        );
        assert.ok(
            metrics.exposedFaces <= Math.ceil(origMetrics.exposedFaces * 1.05),
            `Expected smooth exposedFaces <= ${Math.ceil(origMetrics.exposedFaces * 1.05)}, got ${metrics.exposedFaces}`,
        );
        assert.ok(
            metrics.spurs1 <= origMetrics.spurs1,
            `Expected fewer spurs1 than original (${origMetrics.spurs1}), got ${metrics.spurs1}`,
        );
    }

    // Open-bottom hollow sphere should also stay thin and smooth without global cavity fill
    const openShell = shell.filter((v) => !(v.y <= -8 && v.x * v.x + v.z * v.z <= 9));
    const rotOpen = rotateVoxelRecords(openShell, { x: 25, y: 37, z: 15 });
    assert.ok(
        rotOpen.length <= Math.ceil(openShell.length * 1.25),
        `Expected smooth open shell (<= ${Math.ceil(openShell.length * 1.25)}), got ${rotOpen.length}`,
    );

    // Flat 11x11 plate should preserve area without shrinking borders or bloating
    const plate: VoxelColourRecord[] = [];
    for (let x = -5; x <= 5; ++x) {
        for (let z = -5; z <= 5; ++z) {
            plate.push({ x, y: 0, z, colour: { r: 1, g: 1, b: 1, a: 1 } });
        }
    }
    const rotPlate = rotateVoxelRecords(plate, { x: 25, y: 37, z: 15 });
    assert.ok(rotPlate.length >= 110 && rotPlate.length <= 145, `Unexpected rotated plate size: ${rotPlate.length}`);
});

test('rotateVoxelRecords keeps rotated solid spheres smooth and mixed hollow shells free of bloat/distortion', () => {
    const solidSphere: VoxelColourRecord[] = [];
    for (let x = -12; x <= 12; ++x) {
        for (let y = -12; y <= 12; ++y) {
            for (let z = -12; z <= 12; ++z) {
                if (x * x + y * y + z * z <= 144) {
                    solidSphere.push({ x, y, z, colour: { r: 0.8, g: 0.8, b: 0.8, a: 1 } });
                }
            }
        }
    }
    const origSphereMetrics = countSpursAndExposedFaces(solidSphere);
    const rotSphere = rotateVoxelRecords(solidSphere, { x: 45, y: 30, z: 0 });
    const rotSphereMetrics = countSpursAndExposedFaces(rotSphere);
    assert.ok(rotSphereMetrics.spurs1 <= origSphereMetrics.spurs1, `Expected spurs1 <= ${origSphereMetrics.spurs1}, got ${rotSphereMetrics.spurs1}`);
    assert.ok(rotSphereMetrics.exposedFaces <= origSphereMetrics.exposedFaces + 80, `Expected smooth sphere exposedFaces <= ${origSphereMetrics.exposedFaces + 80}, got ${rotSphereMetrics.exposedFaces}`);
    assert.ok(Math.abs(rotSphere.length - solidSphere.length) / solidSphere.length <= 0.03, `Expected minimal volume drift on solid sphere, got ${rotSphere.length} vs ${solidSphere.length}`);

    // Mixed 1-to-2 voxel closed hollow shell (simulating RayVoxelised curved meshes like skull.obj)
    const mixedShell = makeExactSphereShell(10);
    const occupied = new Set(mixedShell.map((v) => `${v.x},${v.y},${v.z}`));
    for (let x = -4; x <= 4; ++x) {
        for (let y = -4; y <= 4; ++y) {
            for (let z = 8; z <= 10; ++z) {
                if (x * x + y * y + z * z <= 100 && x * x + y * y + (z - 1) * (z - 1) <= 100) {
                    const key = `${x},${y},${z - 1}`;
                    if (!occupied.has(key)) {
                        occupied.add(key);
                        mixedShell.push({ x, y, z: z - 1, colour: { r: 0.6, g: 0.9, b: 0.5, a: 1 } });
                    }
                }
            }
        }
    }
    for (const rot of [{ x: 45, y: 30, z: 0 }, { x: 0, y: 35, z: 0 }]) {
        const rotMixed = rotateVoxelRecords(mixedShell, rot);
        assert.equal(hasExteriorLeak6(rotMixed, 16), false, `Expected watertight mixed shell for ${JSON.stringify(rot)}`);
        assert.ok(
            rotMixed.length <= Math.ceil(mixedShell.length * 1.12),
            `Expected no swelling/bloat on mixed shell (<= ${Math.ceil(mixedShell.length * 1.12)}), got ${rotMixed.length}`,
        );
    }
});
