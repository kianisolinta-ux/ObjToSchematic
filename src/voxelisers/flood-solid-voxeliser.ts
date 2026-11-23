import { Mesh } from '../mesh';
import { ProgressManager } from '../progress';
import { Vector3 } from '../vector';
import { VoxelMesh } from '../voxel_mesh';
import { computeFloodSolidInterior } from '../voxel_postprocess';
import { VoxeliseParams } from '../worker_types';
import { IVoxeliser } from './base-voxeliser';
import { closestPointOnTriangle, triangleIntersectsAabb } from './voxel_algos_math';

/**
 * Watertight 3D Flood-Fill Solid Volume voxeliser.
 * Phase 1: Rasterises a conservative SAT boundary shell with zero diagonal gaps.
 * Phase 2: Flood-fills exterior air in a padded 3D grid and fills every enclosed interior cell
 * with smoothly propagated boundary colours, ideal for twisted or non-axis-aligned shapes.
 */
export class FloodSolidVoxeliser extends IVoxeliser {
    protected override _voxelise(mesh: Mesh, voxeliseParams: VoxeliseParams.Input): VoxelMesh {
        const voxelMesh = new VoxelMesh(voxeliseParams);

        const meshDimensions = mesh.getBounds().getDimensions();
        let scale: number;
        let offset = new Vector3(0.0, 0.0, 0.0);
        switch (voxeliseParams.constraintAxis) {
            case 'x':
                scale = (voxeliseParams.size - 1) / Math.max(1e-6, meshDimensions.x);
                offset = (voxeliseParams.size % 2 === 0) ? new Vector3(0.5, 0.0, 0.0) : new Vector3(0.0, 0.0, 0.0);
                break;
            case 'y':
                scale = (voxeliseParams.size - 1) / Math.max(1e-6, meshDimensions.y);
                offset = (voxeliseParams.size % 2 === 0) ? new Vector3(0.0, 0.5, 0.0) : new Vector3(0.0, 0.0, 0.0);
                break;
            case 'z':
                scale = (voxeliseParams.size - 1) / Math.max(1e-6, meshDimensions.z);
                offset = (voxeliseParams.size % 2 === 0) ? new Vector3(0.0, 0.0, 0.5) : new Vector3(0.0, 0.0, 0.0);
                break;
        }

        mesh.setTransform((vertex: Vector3) => {
            return vertex.copy().mulScalar(scale).add(offset);
        });

        const numTris = mesh.getTriangleCount();
        const taskHandle = ProgressManager.Get.start('Voxelising');

        for (let triIndex = 0; triIndex < numTris; ++triIndex) {
            if ((triIndex & 63) === 0) {
                ProgressManager.Get.progress(taskHandle, 0.7 * (triIndex / Math.max(1, numTris)));
            }

            const uvTri = mesh.getUVTriangle(triIndex);
            const materialName = mesh.getMaterialByTriangle(triIndex);
            const { v0, v1, v2 } = uvTri;

            const minX = Math.ceil(Math.min(v0.x, v1.x, v2.x) - 0.5);
            const maxX = Math.floor(Math.max(v0.x, v1.x, v2.x) + 0.5);
            const minY = Math.ceil(Math.min(v0.y, v1.y, v2.y) - 0.5);
            const maxY = Math.floor(Math.max(v0.y, v1.y, v2.y) + 0.5);
            const minZ = Math.ceil(Math.min(v0.z, v1.z, v2.z) - 0.5);
            const maxZ = Math.floor(Math.max(v0.z, v1.z, v2.z) + 0.5);

            for (let gx = minX; gx <= maxX; ++gx) {
                for (let gy = minY; gy <= maxY; ++gy) {
                    for (let gz = minZ; gz <= maxZ; ++gz) {
                        const boxCenter = { x: gx, y: gy, z: gz };
                        if (!triangleIntersectsAabb(v0, v1, v2, boxCenter, 0.5)) {
                            continue;
                        }
                        const cp = closestPointOnTriangle(boxCenter, v0, v1, v2);
                        const voxelColour = this._getVoxelColour(
                            mesh,
                            uvTri,
                            materialName,
                            new Vector3(cp.x, cp.y, cp.z),
                            voxeliseParams.useMultisampleColouring,
                        );
                        voxelMesh.addVoxel(new Vector3(gx, gy, gz), voxelColour);
                    }
                }
            }
        }

        ProgressManager.Get.progress(taskHandle, 0.75);
        const shellVoxels = voxelMesh.getVoxels().map((v) => ({
            x: v.position.x,
            y: v.position.y,
            z: v.position.z,
            colour: v.colour,
        }));
        const interiorVoxels = computeFloodSolidInterior(shellVoxels);
        ProgressManager.Get.progress(taskHandle, 0.9);

        for (let i = 0; i < interiorVoxels.length; ++i) {
            const iv = interiorVoxels[i];
            voxelMesh.addVoxel(new Vector3(iv.x, iv.y, iv.z), iv.colour);
        }

        ProgressManager.Get.end(taskHandle);
        mesh.clearTransform();

        return voxelMesh;
    }
}
