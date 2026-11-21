import { RGBAColours, RGBAUtil } from '../src/colour';
import { ASSERT } from '../src/util/error_util';
import { Vector3 } from '../src/vector';
import { VoxelMesh } from '../src/voxel_mesh';
import { TEST_PREAMBLE } from './preamble';

test('Voxel neighbours', () => {
    TEST_PREAMBLE();

    const voxelMesh = new VoxelMesh({
        voxelOverlapRule: 'first',
        enableAmbientOcclusion: true,

    });
    voxelMesh.addVoxel(new Vector3(0, 0, 0), RGBAColours.WHITE);
    voxelMesh.addVoxel(new Vector3(1, 1, 0), RGBAColours.WHITE);
    voxelMesh.calculateNeighbours();

    expect(voxelMesh.hasNeighbour(new Vector3(0, 0, 0), new Vector3(1, 1, 0))).toBe(true);
    expect(voxelMesh.hasNeighbour(new Vector3(0, 0, 0), new Vector3(-1, -1, 0))).toBe(false);
    expect(voxelMesh.hasNeighbour(new Vector3(1, 1, 0), new Vector3(-1, -1, 0))).toBe(true);
    expect(voxelMesh.hasNeighbour(new Vector3(1, 1, 0), new Vector3(1, 1, 0))).toBe(false);
});

test('Add voxel', () => {
    const voxelMesh = new VoxelMesh({
        voxelOverlapRule: 'first',
        enableAmbientOcclusion: true,
    });

    voxelMesh.addVoxel(new Vector3(1, 2, 3), RGBAColours.RED);

    expect(voxelMesh.isVoxelAt(new Vector3(1, 2, 3))).toBe(true);
    expect(voxelMesh.getVoxelCount()).toBe(1);
    const voxel = voxelMesh.getVoxelAt(new Vector3(1, 2, 3));
    expect(voxel).toBeDefined(); ASSERT(voxel);
    expect(voxel.position.equals(new Vector3(1, 2, 3))).toBe(true);
    expect(voxel.colour).toEqual(RGBAColours.RED);
});

test('Voxel stores normalized perceptual lightness for dichrome assignment', () => {
    const voxelMesh = new VoxelMesh({
        voxelOverlapRule: 'first',
        enableAmbientOcclusion: false,
    });

    voxelMesh.addVoxel(new Vector3(0, 0, 0), RGBAColours.BLACK);
    voxelMesh.addVoxel(new Vector3(1, 0, 0), RGBAColours.WHITE);

    expect(voxelMesh.getVoxelAt(new Vector3(0, 0, 0))?.dichromeValue).toBeCloseTo(0);
    expect(voxelMesh.getVoxelAt(new Vector3(1, 0, 0))?.dichromeValue).toBeCloseTo(1);
});

test('Voxel overlap first', () => {
    const voxelMesh = new VoxelMesh({
        voxelOverlapRule: 'first',
        enableAmbientOcclusion: false,
    });

    voxelMesh.addVoxel(new Vector3(1, 2, 3), RGBAColours.RED);
    voxelMesh.addVoxel(new Vector3(1, 2, 3), RGBAColours.BLUE);

    expect(voxelMesh.getVoxelAt(new Vector3(1, 2, 3))?.colour).toEqual(RGBAColours.RED);
});

test('Voxel overlap average', () => {
    const voxelMesh = new VoxelMesh({
        voxelOverlapRule: 'average',
        enableAmbientOcclusion: false,
    });

    const c1 = { r: 1.0, g: 0.5, b: 0.25, a: 1.0 };
    const c2 = { r: 0.0, g: 0.5, b: 0.75, a: 1.0 };
    const expected = RGBAUtil.averageLinear(c1, c2);

    voxelMesh.addVoxel(new Vector3(1, 2, 3), c1);
    voxelMesh.addVoxel(new Vector3(1, 2, 3), c2);

    const actual = voxelMesh.getVoxelAt(new Vector3(1, 2, 3))?.colour;
    expect(actual?.r).toBeCloseTo(expected.r, 5);
    expect(actual?.g).toBeCloseTo(expected.g, 5);
    expect(actual?.b).toBeCloseTo(expected.b, 5);
    expect(actual?.a).toBeCloseTo(expected.a, 5);
    expect(voxelMesh.getVoxelAt(new Vector3(1, 2, 3))?.dichromeValue).toBeCloseTo(
        RGBAUtil.toLab(expected)[0] / 100.0,
    );
});

test('Voxel overlap dominant preserves majority colour cluster', () => {
    const voxelMesh = new VoxelMesh({
        voxelOverlapRule: 'dominant',
        enableAmbientOcclusion: false,
    });
    const p = new Vector3(2, 3, 4);
    voxelMesh.addVoxel(p, { r: 0.1, g: 0.2, b: 0.85, a: 1.0 });
    voxelMesh.addVoxel(p, { r: 0.12, g: 0.22, b: 0.88, a: 1.0 });
    voxelMesh.addVoxel(p, { r: 0.9, g: 0.15, b: 0.1, a: 1.0 });

    const voxel = voxelMesh.getVoxelAt(p);
    expect(voxel).toBeDefined();
    expect(voxel?.collisions).toBe(3);
    expect(voxel!.colour.b).toBeGreaterThan(0.8);
    expect(voxel!.colour.r).toBeLessThan(0.2);
});

