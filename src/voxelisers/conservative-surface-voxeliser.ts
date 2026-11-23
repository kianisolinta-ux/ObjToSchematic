import { Mesh } from '../mesh';
import { ProgressManager } from '../progress';
import { Vector3 } from '../vector';
import { VoxelMesh } from '../voxel_mesh';
import { VoxeliseParams } from '../worker_types';
import { IVoxeliser } from './base-voxeliser';
import { closestPointOnTriangle, triangleIntersectsAabb } from './voxel_algos_math';

/**
 * Exact Triangle-AABB SAT voxeliser (6-separating / 26-separating conservative rasterisation).
 * Eliminates pinholes on thin sheets, sharp silhouettes, and steep diagonal triangles.
 */
export class ConservativeSurfaceVoxeliser extends IVoxeliser {
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
                ProgressManager.Get.progress(taskHandle, triIndex / Math.max(1, numTris));
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

        ProgressManager.Get.end(taskHandle);
        mesh.clearTransform();

        return voxelMesh;
    }
}
