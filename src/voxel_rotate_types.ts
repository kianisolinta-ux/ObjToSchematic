export type TVoxelRotationAlgorithm =
    | 'forward'
    | 'nearest'
    | 'trilinear'
    | 'shear'
    | 'sdf'
    | 'rotsprite'
    | 'surface-nets';

export const ALL_VOXEL_ROTATION_ALGORITHMS: readonly TVoxelRotationAlgorithm[] = [
    'forward',
    'nearest',
    'trilinear',
    'shear',
    'sdf',
    'rotsprite',
    'surface-nets',
];

export interface IVoxelRotationAngles {
    x: number;
    y: number;
    z: number;
}

export interface IVoxelRotationOptions {
    algorithm?: TVoxelRotationAlgorithm;
    closeHoles?: boolean;
}
