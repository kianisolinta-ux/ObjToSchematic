import { RGBA, RGBAColours, RGBAUtil } from '../colour';
import { AppConfig } from '../config';
import { LOC } from '../localiser';
import { MaterialType, Mesh } from '../mesh';
import { StatusHandler } from '../status';
import { UVTriangle } from '../triangle';
import { UV } from '../util';
import { ASSERT } from '../util/error_util';
import { Vector3 } from '../vector';
import { VoxelMesh } from '../voxel_mesh';
import { getStratifiedSampleOffset } from '../voxel_overlap';
import { VoxeliseParams } from '../worker_types';

export abstract class IVoxeliser {
    public voxelise(mesh: Mesh, voxeliseParams: VoxeliseParams.Input): VoxelMesh {
        const voxelMesh = this._voxelise(mesh, voxeliseParams);

        StatusHandler.info(LOC('voxelise.voxel_count', { count: voxelMesh.getVoxelCount() }));

        const dim = voxelMesh.getBounds().getDimensions().add(1);
        StatusHandler.info(LOC('voxelise.voxel_mesh_dimensions', { x: dim.x, y: dim.y, z: dim.z }));

        return voxelMesh;
    }

    protected abstract _voxelise(mesh: Mesh, voxeliseParams: VoxeliseParams.Input): VoxelMesh;

    /**
     * `Location` should be in block-space.
     */
    protected _getVoxelColour(mesh: Mesh, triangle: UVTriangle, materialName: string, location: Vector3, multisample: boolean): RGBA {
        const material = mesh.getMaterialByName(materialName);
        ASSERT(material !== undefined);

        const hasVertexColours = triangle.c0 !== undefined && triangle.c1 !== undefined && triangle.c2 !== undefined;
        if (material.type === MaterialType.solid && !hasVertexColours) {
            return RGBAUtil.copy(material.colour);
        }

        const samples: RGBA[] = [];
        const tapCount = multisample ? AppConfig.Get.MULTISAMPLE_COUNT : 1;
        for (let i = 0; i < tapCount; ++i) {
            const tap = multisample ? getStratifiedSampleOffset(i) : { x: 0, y: 0, z: 0 };
            samples.push(this._internalGetVoxelColour(
                mesh,
                triangle,
                materialName,
                new Vector3(location.x + tap.x, location.y + tap.y, location.z + tap.z),
            ));
        }

        return RGBAUtil.averageLinearAlphaWeighted(...samples);
    }

    private _internalGetVoxelColour(mesh: Mesh, triangle: UVTriangle, materialName: string, location: Vector3): RGBA {
        const material = mesh.getMaterialByName(materialName);
        ASSERT(material !== undefined);

        const edge01 = Vector3.sub(triangle.v1, triangle.v0);
        const edge02 = Vector3.sub(triangle.v2, triangle.v0);
        const normal = Vector3.cross(edge01, edge02);
        const normalLenSq = Vector3.dot(normal, normal);

        const hasFiniteArea = Number.isFinite(normalLenSq) && normalLenSq > 1e-12;
        if (!hasFiniteArea && material.type === MaterialType.textured) {
            return RGBAUtil.copy(RGBAColours.MAGENTA);
        }

        let w0 = 1 / 3;
        let w1 = 1 / 3;
        let w2 = 1 / 3;
        if (hasFiniteArea) {
            const edge12 = Vector3.sub(triangle.v2, triangle.v1);
            const edge20 = Vector3.sub(triangle.v0, triangle.v2);
            const rawW2 = Vector3.dot(normal, Vector3.cross(edge01, Vector3.sub(location, triangle.v0))) / normalLenSq;
            const rawW0 = Vector3.dot(normal, Vector3.cross(edge12, Vector3.sub(location, triangle.v1))) / normalLenSq;
            const rawW1 = Vector3.dot(normal, Vector3.cross(edge20, Vector3.sub(location, triangle.v2))) / normalLenSq;

            // Clamp jittered sample points inside triangle bounds so UVs never overshoot
            const c0 = Math.max(0, rawW0);
            const c1 = Math.max(0, rawW1);
            const c2 = Math.max(0, rawW2);
            const sum = c0 + c1 + c2;
            if (sum > 1e-12) {
                w0 = c0 / sum;
                w1 = c1 / sum;
                w2 = c2 / sum;
            }
        }

        const hasVertexColours = triangle.c0 !== undefined && triangle.c1 !== undefined && triangle.c2 !== undefined;
        const vertexColour: RGBA = hasVertexColours ? {
            r: triangle.c0!.r * w0 + triangle.c1!.r * w1 + triangle.c2!.r * w2,
            g: triangle.c0!.g * w0 + triangle.c1!.g * w1 + triangle.c2!.g * w2,
            b: triangle.c0!.b * w0 + triangle.c1!.b * w1 + triangle.c2!.b * w2,
            a: triangle.c0!.a * w0 + triangle.c1!.a * w1 + triangle.c2!.a * w2,
        } : { r: 1, g: 1, b: 1, a: 1 };

        if (material.type === MaterialType.solid) {
            return {
                r: material.colour.r * vertexColour.r,
                g: material.colour.g * vertexColour.g,
                b: material.colour.b * vertexColour.b,
                a: material.colour.a * vertexColour.a,
            };
        }

        const uv = new UV(
            triangle.uv0.u * w0 + triangle.uv1.u * w1 + triangle.uv2.u * w2,
            triangle.uv0.v * w0 + triangle.uv1.v * w1 + triangle.uv2.v * w2,
        );

        if (!Number.isFinite(uv.u) || !Number.isFinite(uv.v)) {
            return RGBAUtil.copy(RGBAColours.MAGENTA);
        }

        const sampled = mesh.sampleTextureMaterial(materialName, uv);
        return {
            r: sampled.r * vertexColour.r,
            g: sampled.g * vertexColour.g,
            b: sampled.b * vertexColour.b,
            a: sampled.a * vertexColour.a,
        };
    }
}
