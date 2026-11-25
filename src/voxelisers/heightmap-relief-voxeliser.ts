import { Mesh } from '../mesh';
import { ProgressManager } from '../progress';
import { Vector3 } from '../vector';
import { VoxelMesh } from '../voxel_mesh';
import { VoxeliseParams } from '../worker_types';
import { IVoxeliser } from './base-voxeliser';

const bvhtree = require('bvh-tree');

/**
 * 2.5D Heightmap / Relief Voxeliser:
 * Projects vertical (-Y) rays across every (X, Z) column to capture the uppermost surface
 * and extrudes solid backing columns down to the base plane.
 * Ideal for terrain, topographical maps, bas-relief plaques, crests, and wall medallions.
 */
export class HeightmapReliefVoxeliser extends IVoxeliser {
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
        const triangles = Array<{ x: number; y: number; z: number }[]>(numTris);
        for (let triIndex = 0; triIndex < numTris; ++triIndex) {
            const posData = mesh.getVertices(triIndex);
            triangles[triIndex] = [posData.v0, posData.v1, posData.v2];
        }

        const bvh = new bvhtree.BVH(triangles, 8);
        const bounds = mesh.getBounds();
        const minX = Math.floor(bounds.min.x);
        const maxX = Math.ceil(bounds.max.x);
        const minY = Math.round(bounds.min.y);
        const rayStartY = Math.ceil(bounds.max.y) + 2;
        const minZ = Math.floor(bounds.min.z);
        const maxZ = Math.ceil(bounds.max.z);

        const downDir = new Vector3(0, -1, 0);
        const colsX = Math.max(1, maxX - minX + 1);
        const colsZ = Math.max(1, maxZ - minZ + 1);
        const totalColumns = colsX * colsZ;
        let done = 0;

        const taskHandle = ProgressManager.Get.start('Voxelising');

        for (let gx = minX; gx <= maxX; ++gx) {
            for (let gz = minZ; gz <= maxZ; ++gz) {
                if ((done & 127) === 0) {
                    ProgressManager.Get.progress(taskHandle, done / totalColumns);
                }
                ++done;

                const origin = new Vector3(gx, rayStartY, gz);
                const intersections = bvh.intersectRay(origin, downDir, false);
                if (!intersections || intersections.length === 0) {
                    continue;
                }

                // Highest surface intersection in this column
                let topHit = intersections[0];
                for (let k = 1; k < intersections.length; ++k) {
                    if (intersections[k].intersectionPoint.y > topHit.intersectionPoint.y) {
                        topHit = intersections[k];
                    }
                }

                const pt = topHit.intersectionPoint;
                const topY = Math.round(pt.y);
                const surfacePos = new Vector3(pt.x, pt.y, pt.z);
                const topColour = this._getVoxelColour(
                    mesh,
                    mesh.getUVTriangle(topHit.triangleIndex),
                    mesh.getMaterialByTriangle(topHit.triangleIndex),
                    surfacePos,
                    voxeliseParams.useMultisampleColouring,
                );

                for (let gy = minY; gy <= topY; ++gy) {
                    voxelMesh.addVoxel(new Vector3(gx, gy, gz), {
                        r: topColour.r,
                        g: topColour.g,
                        b: topColour.b,
                        a: topColour.a,
                    });
                }
            }
        }

        ProgressManager.Get.end(taskHandle);
        mesh.clearTransform();
        return voxelMesh;
    }
}
