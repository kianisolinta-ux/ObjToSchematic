import { RGBA, RGBAUtil } from '../colour';
import { Mesh } from '../mesh';
import { ProgressManager } from '../progress';
import { Axes, axesToDirection, Ray } from '../ray';
import { LOG } from '../util/log_util';
import { Vector3 } from '../vector';
import { VoxelMesh } from '../voxel_mesh';
import { VoxeliseParams } from '../worker_types';
import { IVoxeliser } from './base-voxeliser';
import {
    buildSolidIntervalsFromCrossings,
    closestPointOnTriangle,
    interpolateSpanColour,
    ScanlineCrossing,
    triangleIntersectsAabb,
} from './voxel_algos_math';

const bvhtree = require('bvh-tree');

/**
 * Hybrid SAT Surface + 3-Axis BVH Solid Voxeliser:
 * 1) Conservative Triangle-AABB SAT pass captures razor-sharp thin features & edges without pinholes.
 * 2) 3-Axis BVH scanline parity + 2-of-3 majority voting fills enclosed interior volume fast.
 */
export class HybridSatRayVoxeliser extends IVoxeliser {
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

        // Pass 1: Conservative SAT surface rasterisation
        const triangles = Array<{ x: number; y: number; z: number }[]>(numTris);
        for (let triIndex = 0; triIndex < numTris; ++triIndex) {
            if ((triIndex & 63) === 0) {
                ProgressManager.Get.progress(taskHandle, 0.45 * (triIndex / Math.max(1, numTris)));
            }

            const posData = mesh.getVertices(triIndex);
            triangles[triIndex] = [posData.v0, posData.v1, posData.v2];

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

        // Pass 2: BVH 3-axis scanline interior fill
        LOG('Creating BVH (hybrid-sat-ray)...');
        const bvh = new bvhtree.BVH(triangles, 8);
        const bounds = mesh.getBounds();
        bounds.min.floor();
        bounds.max.ceil();

        const planeDims = Vector3.sub(bounds.max, bounds.min).add(1);
        const numRays = (planeDims.x * planeDims.y) + (planeDims.x * planeDims.z) + (planeDims.y * planeDims.z);
        const rays = new Array<Ray>(numRays);
        let rayIndex = 0;
        for (let y = bounds.min.y; y <= bounds.max.y; ++y) {
            for (let z = bounds.min.z; z <= bounds.max.z; ++z) {
                rays[rayIndex++] = { origin: new Vector3(bounds.min.x - 1, y, z), axis: Axes.x };
            }
        }
        for (let x = bounds.min.x; x <= bounds.max.x; ++x) {
            for (let z = bounds.min.z; z <= bounds.max.z; ++z) {
                rays[rayIndex++] = { origin: new Vector3(x, bounds.min.y - 1, z), axis: Axes.y };
            }
        }
        for (let x = bounds.min.x; x <= bounds.max.x; ++x) {
            for (let y = bounds.min.y; y <= bounds.max.y; ++y) {
                rays[rayIndex++] = { origin: new Vector3(x, y, bounds.min.z - 1), axis: Axes.z };
            }
        }

        const interiorVotes = new Map<number, { count: number; x: number; y: number; z: number; colours: RGBA[] }>();
        for (let i = 0; i < rays.length; ++i) {
            if ((i & 127) === 0) {
                ProgressManager.Get.progress(taskHandle, 0.45 + (i / Math.max(1, rays.length)) * 0.45);
            }
            const ray = rays[i];
            const intersections = bvh.intersectRay(ray.origin, axesToDirection(ray.axis), false);
            if (!intersections || intersections.length < 2) {
                continue;
            }

            const crossings: ScanlineCrossing[] = [];
            for (const intersection of intersections) {
                const point = intersection.intersectionPoint;
                const position = new Vector3(point.x, point.y, point.z);
                const voxelColour = this._getVoxelColour(
                    mesh,
                    mesh.getUVTriangle(intersection.triangleIndex),
                    mesh.getMaterialByTriangle(intersection.triangleIndex),
                    position,
                    voxeliseParams.useMultisampleColouring,
                );
                const coord = ray.axis === Axes.x ? point.x : (ray.axis === Axes.y ? point.y : point.z);
                crossings.push({ coord, colour: voxelColour });
            }

            const intervals = buildSolidIntervalsFromCrossings(crossings);
            for (const span of intervals) {
                const spanLen = Math.max(1, span.end - span.start);
                for (let s = span.start; s <= span.end; ++s) {
                    const vx = ray.axis === Axes.x ? s : Math.round(ray.origin.x);
                    const vy = ray.axis === Axes.y ? s : Math.round(ray.origin.y);
                    const vz = ray.axis === Axes.z ? s : Math.round(ray.origin.z);
                    const p = new Vector3(vx, vy, vz);
                    if (voxelMesh.isVoxelAt(p)) {
                        continue;
                    }
                    const hash = p.hash();
                    const sampleCol = interpolateSpanColour(span.entryColour, span.exitColour, (s - span.start) / spanLen);
                    let entry = interiorVotes.get(hash);
                    if (!entry) {
                        entry = { count: 0, x: vx, y: vy, z: vz, colours: [] };
                        interiorVotes.set(hash, entry);
                    }
                    entry.count += 1;
                    entry.colours.push(sampleCol);
                }
            }
        }

        interiorVotes.forEach((entry) => {
            if (entry.count >= 2) {
                const avgCol = RGBAUtil.averageLinear(...entry.colours);
                if (avgCol.a > 0) {
                    voxelMesh.addVoxel(new Vector3(entry.x, entry.y, entry.z), avgCol);
                }
            }
        });

        ProgressManager.Get.end(taskHandle);
        mesh.clearTransform();
        return voxelMesh;
    }
}
