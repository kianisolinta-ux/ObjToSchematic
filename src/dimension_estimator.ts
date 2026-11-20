import { TAxis } from './util/type_util';
import { Vector3 } from './vector';
import type { TVoxelisers } from './voxelisers/voxelisers';

export interface DimensionEstimateInput {
    meshDimensions: Pick<Vector3, 'x' | 'y' | 'z'>;
    constraintAxis: TAxis;
    size: number;
    voxeliser?: TVoxelisers | string;
}

export interface EstimatedDimensions {
    x: number;
    y: number;
    z: number;
}

/**
 * Estimates final voxel / block bounding dimensions (width X, height Y, depth Z)
 * matching how objtoschematic voxelisers scale and discretize a centred mesh.
 */
export function estimateVoxelDimensions(input: DimensionEstimateInput): EstimatedDimensions {
    const { meshDimensions, constraintAxis, size, voxeliser } = input;
    const constrainedDim = meshDimensions[constraintAxis];
    const safeSize = Math.max(1, Math.round(size));

    if (!Number.isFinite(constrainedDim) || constrainedDim <= 0) {
        return { x: safeSize, y: safeSize, z: safeSize };
    }

    if (voxeliser === 'ncrb') {
        const scale = safeSize / constrainedDim;
        const estimateAxis = (axis: TAxis) => {
            if (axis === constraintAxis) {
                return safeSize;
            }
            const dim = meshDimensions[axis];
            if (!Number.isFinite(dim) || dim <= 0) {
                return 1;
            }
            return Math.max(1, Math.round(dim * scale));
        };
        return {
            x: estimateAxis('x'),
            y: estimateAxis('y'),
            z: estimateAxis('z'),
        };
    }

    const scale = (safeSize - 1) / constrainedDim;
    const estimateAxis = (axis: TAxis) => {
        if (axis === constraintAxis) {
            return safeSize;
        }
        const dim = meshDimensions[axis];
        if (!Number.isFinite(dim) || dim <= 0) {
            return 1;
        }
        return Math.max(1, Math.round(dim * scale) + 1);
    };

    return {
        x: estimateAxis('x'),
        y: estimateAxis('y'),
        z: estimateAxis('z'),
    };
}
