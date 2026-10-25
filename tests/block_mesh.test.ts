import { RGBA_255 } from '../src/colour';
import { BlockMesh } from '../src/block_mesh';
import { Vector3 } from '../src/vector';

test('nearest-colour uses the same colour-accuracy and dithering preprocessing as other algorithms', () => {
    // Exercise the private preprocessing stage without constructing an atlas or voxel mesh.
    const blockMesh = Object.create(BlockMesh.prototype) as any;
    const voxel = {
        colour: { r: 0.5, g: 0.5, b: 0.5, a: 1 },
        position: new Vector3(0, 0, 0),
    };
    const commonParams = {
        resolution: 255,
        dithering: 'ordered',
        ditheringMagnitude: 64,
    };

    const nearestColour = blockMesh._getFinalVoxelColour(voxel, {
        ...commonParams,
        blockSelectionAlgorithm: 'nearest-color',
    }) as RGBA_255;
    const chartMatch = blockMesh._getFinalVoxelColour(voxel, {
        ...commonParams,
        blockSelectionAlgorithm: 'color-chart-match',
    }) as RGBA_255;

    expect(nearestColour).toEqual({ r: 95, g: 95, b: 95, a: 255 });
    expect(nearestColour).toEqual(chartMatch);
});
