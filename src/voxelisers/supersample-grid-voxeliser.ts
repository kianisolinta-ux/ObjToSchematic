import { RGBA } from '../colour';
import { Mesh } from '../mesh';
import { ProgressManager } from '../progress';
import { Vector3 } from '../vector';
import { VoxelMesh } from '../voxel_mesh';
import { VoxeliseParams } from '../worker_types';
import { IVoxeliser } from './base-voxeliser';
import {
    closestPointOnTriangle,
    countMaskBits8,
    evaluateSubVoxelCoverage,
    triangleIntersectsAabb,
} from './voxel_algos_math';

interface SupersampleCellEntry {
    gx: number;
    gy: number;
    gz: number;
    mask: number;
    samples: Array<{
        colour: RGBA;
        weight: number;
    }>;
}

/**
 * 2x2x2 Sub-Voxel Super-Sampled Anti-Aliased voxeliser.
 * Evaluates triangle occupancy across 8 sub-voxels per block and filters out grazing
 * slivers below `coverageThreshold`, producing cleaner silhouettes and anti-aliased edges.
 */
export class SupersampleGridVoxeliser extends IVoxeliser {
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

        const coverageThreshold = Math.max(0.1, Math.min(0.95, voxeliseParams.coverageThreshold ?? 0.25));
        const minSubVoxels = Math.max(1, Math.min(8, Math.round(coverageThreshold * 8)));

        const cells = new Map<number, Map<number, Map<number, SupersampleCellEntry>>>();
        const getOrCreateCell = (gx: number, gy: number, gz: number): SupersampleCellEntry => {
            let yMap = cells.get(gx);
            if (!yMap) {
                yMap = new Map();
                cells.set(gx, yMap);
            }
            let zMap = yMap.get(gy);
            if (!zMap) {
                zMap = new Map();
                yMap.set(gy, zMap);
            }
            let entry = zMap.get(gz);
            if (!entry) {
                entry = { gx, gy, gz, mask: 0, samples: [] };
                zMap.set(gz, entry);
            }
            return entry;
        };

        const numTris = mesh.getTriangleCount();
        const taskHandle = ProgressManager.Get.start('Voxelising');

        for (let triIndex = 0; triIndex < numTris; ++triIndex) {
            if ((triIndex & 63) === 0) {
                ProgressManager.Get.progress(taskHandle, 0.75 * (triIndex / Math.max(1, numTris)));
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
                        const triMask = evaluateSubVoxelCoverage(v0, v1, v2, boxCenter);
                        if (triMask === 0) {
                            continue;
                        }

                        const cp = closestPointOnTriangle(boxCenter, v0, v1, v2);
                        const colour = this._getVoxelColour(
                            mesh,
                            uvTri,
                            materialName,
                            new Vector3(cp.x, cp.y, cp.z),
                            voxeliseParams.useMultisampleColouring,
                        );
                        const entry = getOrCreateCell(gx, gy, gz);
                        entry.mask |= triMask;
                        entry.samples.push({
                            colour,
                            weight: countMaskBits8(triMask),
                        });
                    }
                }
            }
        }

        let processed = 0;
        let totalCells = 0;
        cells.forEach((yMap) => yMap.forEach((zMap) => {
            totalCells += zMap.size;
        }));

        cells.forEach((yMap) => {
            yMap.forEach((zMap) => {
                zMap.forEach((entry) => {
                    if ((processed & 255) === 0 && totalCells > 0) {
                        ProgressManager.Get.progress(taskHandle, 0.75 + 0.25 * (processed / totalCells));
                    }
                    ++processed;

                    if (countMaskBits8(entry.mask) < minSubVoxels) {
                        return;
                    }

                    const pos = new Vector3(entry.gx, entry.gy, entry.gz);
                    for (let i = 0; i < entry.samples.length; ++i) {
                        const s = entry.samples[i];
                        // Repeat weight proportionally when using average/dominant rules, capped cleanly
                        const reps = voxeliseParams.voxelOverlapRule === 'first' ? 1 : Math.min(4, Math.max(1, Math.round(s.weight / 2)));
                        for (let r = 0; r < reps; ++r) {
                            voxelMesh.addVoxel(pos, {
                                r: s.colour.r,
                                g: s.colour.g,
                                b: s.colour.b,
                                a: s.colour.a,
                            });
                        }
                    }
                });
            });
        });

        ProgressManager.Get.end(taskHandle);
        mesh.clearTransform();

        return voxelMesh;
    }
}
