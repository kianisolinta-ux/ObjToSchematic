import { RGBA, RGBAColours, RGBAUtil } from '../colour';
import { AppConfig } from '../config';
import { LOC } from '../localiser';
import { MaterialType, Mesh } from '../mesh';
import { StatusHandler } from '../status';
import { Triangle, UVTriangle } from '../triangle';
import { UV } from '../util';
import { ASSERT } from '../util/error_util';
import { Vector3 } from '../vector';
import { VoxelMesh } from '../voxel_mesh';
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
        for (let i = 0; i < (multisample ? AppConfig.Get.MULTISAMPLE_COUNT : 1); ++i) {
            const offset = multisample ? Vector3.random().sub(0.5) : new Vector3(0, 0, 0);
            samples.push(this._internalGetVoxelColour(
                mesh,
                triangle,
                materialName,
                offset.add(location),
            ));
        }

        return RGBAUtil.average(...samples);
    }

    private _internalGetVoxelColour(mesh: Mesh, triangle: UVTriangle, materialName: string, location: Vector3): RGBA {
        const material = mesh.getMaterialByName(materialName);
        ASSERT(material !== undefined);

        const area01 = new Triangle(triangle.v0, triangle.v1, location).getArea();
        const area12 = new Triangle(triangle.v1, triangle.v2, location).getArea();
        const area20 = new Triangle(triangle.v2, triangle.v0, location).getArea();
        const total = area01 + area12 + area20;

        const hasFiniteArea = Number.isFinite(total) && total > 1e-12;
        if (!hasFiniteArea && material.type === MaterialType.textured) {
            return RGBAUtil.copy(RGBAColours.MAGENTA);
        }

        let w0 = 1 / 3;
        let w1 = 1 / 3;
        let w2 = 1 / 3;
        if (hasFiniteArea) {
            w0 = area12 / total;
            w1 = area20 / total;
            w2 = area01 / total;
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
