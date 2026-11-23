import { RGBA, RGBAUtil } from '../colour';
import { Mesh } from '../mesh';
import { ProgressManager } from '../progress';
import { Axes, axesToDirection, Ray } from '../ray';
import { LOG } from '../util/log_util';
import { Vector3 } from '../vector';
import { VoxelMesh } from '../voxel_mesh';
import { VoxeliseParams } from '../worker_types';
import { IVoxeliser } from './base-voxeliser';
import { buildSolidIntervalsFromCrossings, interpolateSpanColour, ScanlineCrossing } from './voxel_algos_math';

const bvhtree = require('bvh-tree');

/**
 * Watertight Solid-Fill Voxeliser: combines BVH surface sampling with 3-axis scanline parity
 * and 2-of-3 majority voting so enclosed interiors become completely solid without ray leaks.
 */
export class SolidFillVoxeliser extends IVoxeliser {
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

        const triangles = Array<{ x: number; y: number; z: number }[]>(mesh._tris.length);
        for (let triIndex = 0; triIndex < mesh.getTriangleCount(); ++triIndex) {
            const positionData = mesh.getVertices(triIndex);
            triangles[triIndex] = [positionData.v0, positionData.v1, positionData.v2];
        }

        LOG('Creating BVH (solid-fill)...');
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
        const taskHandle = ProgressManager.Get.start('Voxelising');

        for (let i = 0; i < rays.length; ++i) {
            if ((i & 127) === 0) {
                ProgressManager.Get.progress(taskHandle, (i / Math.max(1, rays.length)) * 0.8);
            }

            const ray = rays[i];
            const intersections = bvh.intersectRay(ray.origin, axesToDirection(ray.axis), false);
            if (!intersections || intersections.length === 0) {
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
                voxelMesh.addVoxel(position, voxelColour);

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

        // Fill interior cells corroborated by at least 2 axes (prevents non-watertight ray leaks)
        let idx = 0;
        const totalVotes = Math.max(1, interiorVotes.size);
        interiorVotes.forEach((entry) => {
            if ((idx++ & 1023) === 0) {
                ProgressManager.Get.progress(taskHandle, 0.8 + (idx / totalVotes) * 0.2);
            }
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
