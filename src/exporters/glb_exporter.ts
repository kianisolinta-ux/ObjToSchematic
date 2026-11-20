import { Mesh } from '../mesh';
import { GlbExportOptions, GlbExportResult, GlbMaterialLike, serializeGlbFromMeshData } from './glb_serializer';

export type { GlbExportOptions, GlbExportResult };

/**
 * Repairs and serializes a loaded Mesh instance to binary GLB.
 */
export function exportMeshToGlb(
    mesh: Mesh,
    options: GlbExportOptions = {},
): GlbExportResult {
    return serializeGlbFromMeshData(
        {
            vertices: mesh._vertices,
            normals: mesh._normals,
            uvs: mesh._uvs,
            tris: mesh._tris,
            vertexColours: mesh._vertexColours,
        },
        mesh.getMaterials() as unknown as Map<string, GlbMaterialLike>,
        options,
    );
}
