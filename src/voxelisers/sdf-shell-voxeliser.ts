import { Mesh } from '../mesh';
import { ProgressManager } from '../progress';
import { Vector3 } from '../vector';
import { VoxelMesh } from '../voxel_mesh';
import { VoxeliseParams } from '../worker_types';
import { IVoxeliser } from './base-voxeliser';
import { distanceSquaredToTriangle } from './voxel_algos_math';

interface SdfCellEntry {
    gx: number;
    gy: number;
    gz: number;
    bestDistSq: number;
    hits: Array<{
        triIndex: number;
        cpX: number;
        cpY: number;
        cpZ: number;
    }>;
}

/**
 * Signed/Unsigned Euclidean Distance Field Shell voxeliser.
 * Evaluates exact voxel-center-to-triangle distance and emits a smooth, gap-free shell
 * of configurable surface thickness (`surfaceRadius` in voxel units, default 0.75).
 */
export class SdfShellVoxeliser extends IVoxeliser {
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

        const surfaceRadius = Math.max(0.5, Math.min(2.5, voxeliseParams.surfaceRadius ?? 0.75));
        const radiusSq = surfaceRadius * surfaceRadius;
        const pad = Math.ceil(surfaceRadius);
        const tieEps = 1e-4;

        const cells = new Map<number, Map<number, Map<number, SdfCellEntry>>>();
        const getOrCreateCell = (gx: number, gy: number, gz: number): SdfCellEntry | undefined => {
            return cells.get(gx)?.get(gy)?.get(gz);
        };
        const setCell = (entry: SdfCellEntry) => {
            let yMap = cells.get(entry.gx);
            if (!yMap) {
                yMap = new Map();
                cells.set(entry.gx, yMap);
            }
            let zMap = yMap.get(entry.gy);
            if (!zMap) {
                zMap = new Map();
                yMap.set(entry.gy, zMap);
            }
            zMap.set(entry.gz, entry);
        };

        const numTris = mesh.getTriangleCount();
        const taskHandle = ProgressManager.Get.start('Voxelising');

        for (let triIndex = 0; triIndex < numTris; ++triIndex) {
            if ((triIndex & 63) === 0) {
                ProgressManager.Get.progress(taskHandle, 0.75 * (triIndex / Math.max(1, numTris)));
            }

            const uvTri = mesh.getUVTriangle(triIndex);
            const { v0, v1, v2 } = uvTri;

            const minX = Math.floor(Math.min(v0.x, v1.x, v2.x) - pad);
            const maxX = Math.ceil(Math.max(v0.x, v1.x, v2.x) + pad);
            const minY = Math.floor(Math.min(v0.y, v1.y, v2.y) - pad);
            const maxY = Math.ceil(Math.max(v0.y, v1.y, v2.y) + pad);
            const minZ = Math.floor(Math.min(v0.z, v1.z, v2.z) - pad);
            const maxZ = Math.ceil(Math.max(v0.z, v1.z, v2.z) + pad);

            for (let gx = minX; gx <= maxX; ++gx) {
                for (let gy = minY; gy <= maxY; ++gy) {
                    for (let gz = minZ; gz <= maxZ; ++gz) {
                        const { distSq, closest } = distanceSquaredToTriangle(
                            { x: gx, y: gy, z: gz },
                            v0,
                            v1,
                            v2,
                        );
                        if (distSq > radiusSq) {
                            continue;
                        }

                        const existing = getOrCreateCell(gx, gy, gz);
                        const hit = { triIndex, cpX: closest.x, cpY: closest.y, cpZ: closest.z };
                        if (!existing) {
                            setCell({
                                gx,
                                gy,
                                gz,
                                bestDistSq: distSq,
                                hits: [hit],
                            });
                        } else if (distSq < existing.bestDistSq - tieEps) {
                            existing.bestDistSq = distSq;
                            existing.hits = [hit];
                        } else if (Math.abs(distSq - existing.bestDistSq) <= tieEps && existing.hits.length < 4) {
                            existing.hits.push(hit);
                        }
                    }
                }
            }
        }

        let processed = 0;
        let totalEntries = 0;
        cells.forEach((yMap) => yMap.forEach((zMap) => {
            totalEntries += zMap.size;
        }));

        cells.forEach((yMap) => {
            yMap.forEach((zMap) => {
                zMap.forEach((entry) => {
                    if ((processed & 255) === 0 && totalEntries > 0) {
                        ProgressManager.Get.progress(taskHandle, 0.75 + 0.25 * (processed / totalEntries));
                    }
                    ++processed;

                    const pos = new Vector3(entry.gx, entry.gy, entry.gz);
                    for (let i = 0; i < entry.hits.length; ++i) {
                        const hit = entry.hits[i];
                        const uvTri = mesh.getUVTriangle(hit.triIndex);
                        const materialName = mesh.getMaterialByTriangle(hit.triIndex);
                        const voxelColour = this._getVoxelColour(
                            mesh,
                            uvTri,
                            materialName,
                            new Vector3(hit.cpX, hit.cpY, hit.cpZ),
                            voxeliseParams.useMultisampleColouring,
                        );
                        voxelMesh.addVoxel(pos, voxelColour);
                    }
                });
            });
        });

        ProgressManager.Get.end(taskHandle);
        mesh.clearTransform();

        return voxelMesh;
    }
}
