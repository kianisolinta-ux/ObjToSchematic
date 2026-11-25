import { ASSERT } from '../util/error_util';
import { IVoxeliser } from './base-voxeliser';
import { BVHRayVoxeliser } from './bvh-ray-voxeliser';
import { BVHRayVoxeliserPlusThickness } from './bvh-ray-voxeliser-plus-thickness';
import { ConservativeSurfaceVoxeliser } from './conservative-surface-voxeliser';
import { FloodSolidVoxeliser } from './flood-solid-voxeliser';
import { HeightmapReliefVoxeliser } from './heightmap-relief-voxeliser';
import { HybridSatRayVoxeliser } from './hybrid-sat-ray-voxeliser';
import { NormalCorrectedRayVoxeliser } from './normal-corrected-ray-voxeliser';
import { RayVoxeliser } from './ray-voxeliser';
import { SdfShellVoxeliser } from './sdf-shell-voxeliser';
import { SolidFillVoxeliser } from './solid-fill-voxeliser';
import { SupersampleGridVoxeliser } from './supersample-grid-voxeliser';

export type TVoxelisers =
    | 'bvh-ray'
    | 'ncrb'
    | 'ray-based'
    | 'bvh-ray-plus-thickness'
    | 'conservative-surface'
    | 'solid-fill'
    | 'sdf-shell'
    | 'supersample-grid'
    | 'flood-solid'
    | 'hybrid-sat-ray'
    | 'heightmap-relief';

export class VoxeliserFactory {
    public static GetVoxeliser(voxeliser: TVoxelisers): IVoxeliser {
        switch (voxeliser) {
            case 'bvh-ray':
                return new BVHRayVoxeliser();
            case 'ncrb':
                return new NormalCorrectedRayVoxeliser();
            case 'ray-based':
                return new RayVoxeliser();
            case 'bvh-ray-plus-thickness':
                return new BVHRayVoxeliserPlusThickness();
            case 'conservative-surface':
                return new ConservativeSurfaceVoxeliser();
            case 'solid-fill':
                return new SolidFillVoxeliser();
            case 'sdf-shell':
                return new SdfShellVoxeliser();
            case 'supersample-grid':
                return new SupersampleGridVoxeliser();
            case 'flood-solid':
                return new FloodSolidVoxeliser();
            case 'hybrid-sat-ray':
                return new HybridSatRayVoxeliser();
            case 'heightmap-relief':
                return new HeightmapReliefVoxeliser();
            default:
                ASSERT(false, 'Unreachable');
        }
    }
}

