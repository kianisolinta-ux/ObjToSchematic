import { remesh, transferAttribute } from '@autoremesher/wasm';

import { Mesh, Tri } from './mesh';
import { ProgressManager } from './progress';
import { UV } from './util';
import { Vector3 } from './vector';
import { TMeshFace, TMeshRepairStats, TRepairMeshOptions, TRepairMeshResult } from './mesh_repair';

interface TSourceBuffers {
    vertices: Float32Array;
    indices: Uint32Array;
    attributes: Float32Array;
    hasUVs: boolean;
    materialNames: string[];
    validTriangles: Tri[];
    degenerateFaces: number;
    nonManifoldEdges: number;
}

interface TOutputFace {
    vertices: number[];
    cornerQueryIndices: number[];
    materialQueryIndex: number;
}

export class MeshRetopologyEngine {
    /**
     * Field-based quad remeshing. Unlike the legacy repair pass, this creates
     * a new surface through AutoRemesher and transfers source attributes per
     * output face corner so UV seams are not collapsed onto shared vertices.
     */
    public static async repair(mesh: Mesh, options: TRepairMeshOptions): Promise<TRepairMeshResult> {
        const startedAt = performance.now();
        const task = ProgressManager.Get.start('MeshRepair');

        try {
            ProgressManager.Get.progress(task, 0.02, 'Анализ исходной поверхности::Подготовка геометрии и UV-данных...');

            const source = this._buildSourceBuffers(mesh);
            if (source.validTriangles.length < 4) {
                throw new Error('Недостаточно корректных треугольников для ретопологии.');
            }

            ProgressManager.Get.progress(
                task,
                0.07,
                'Подготовка геометрии::Передано ' + source.validTriangles.length.toLocaleString() + ' исходных треугольников',
            );

            const density = Math.max(0.2, Math.min(2.0, options.targetDensity || 1.0));
            const targetQuads = Math.max(8000, Math.min(90000, Math.round(40000 * density)));
            const maxInputTriangles = Math.min(
                source.validTriangles.length,
                Math.max(100000, Math.min(300000, targetQuads * 5)),
            );

            const remeshed = await remesh(
                {
                    vertices: source.vertices,
                    indices: source.indices,
                },
                {
                    targetQuads,
                    maxInputTriangles,
                    adaptivity: Math.max(0, Math.min(1, options.curvatureAdaptivity)),
                    sharpEdgeThreshold: Math.max(20, Math.min(80, options.sharpEdgeAngle || 45)),
                    modelType: 'organic',
                    preserveSharpFeatures: false,
                    preserveUVs: false,
                    allowHoles: false,
                    maxParts: 64,
                    minPartTriangles: 8,
                    smoothNormals: true,
                    onProgress: (progress, status) => {
                        const pct = 0.08 + Math.max(0, Math.min(1, progress)) * 0.68;
                        ProgressManager.Get.progress(task, pct, 'Поле направлений и квадросетка::' + status);
                    },
                },
            );

            if (remeshed.vertices.length < 9 || remeshed.quads.length < 4) {
                throw new Error('Ретопологизатор не вернул пригодную геометрию.');
            }

            ProgressManager.Get.progress(
                task,
                0.78,
                'Перенос атрибутов::Перепроецирование UV по углам граней и назначение материалов...',
            );

            const outputVertices: Vector3[] = [];
            for (let i = 0; i + 2 < remeshed.vertices.length; i += 3) {
                outputVertices.push(new Vector3(
                    remeshed.vertices[i],
                    remeshed.vertices[i + 1],
                    remeshed.vertices[i + 2],
                ));
            }

            const rawFaces: number[][] = [];
            for (let i = 0; i + 3 < remeshed.quads.length; i += 4) {
                const a = remeshed.quads[i];
                const b = remeshed.quads[i + 1];
                const c = remeshed.quads[i + 2];
                const d = remeshed.quads[i + 3];
                const face = c === d ? [a, b, c] : [a, b, c, d];

                if (face.some((index) => index >= outputVertices.length)) continue;
                if (new Set(face).size !== face.length) continue;
                rawFaces.push(face);
            }

            if (rawFaces.length === 0) {
                throw new Error('Ретопологизатор вернул только вырожденные грани.');
            }

            const needsProjection = source.hasUVs || source.materialNames.length > 1;
            const outputFaces: TOutputFace[] = [];
            let targetQueryCount = 0;

            for (const face of rawFaces) {
                const center = new Vector3(0, 0, 0);
                for (const index of face) center.add(outputVertices[index]);
                center.mulScalar(1 / face.length);

                const cornerQueryIndices: number[] = [];
                for (const index of face) {
                    cornerQueryIndices.push(targetQueryCount++);
                }
                const materialQueryIndex = targetQueryCount++;
                outputFaces.push({ vertices: face, cornerQueryIndices, materialQueryIndex });
            }

            let transferred = new Float32Array(0);
            if (needsProjection) {
                const targetPositions = new Float32Array(targetQueryCount * 3);

                for (const face of outputFaces) {
                    const center = new Vector3(0, 0, 0);
                    for (const index of face.vertices) center.add(outputVertices[index]);
                    center.mulScalar(1 / face.vertices.length);

                    for (let corner = 0; corner < face.vertices.length; ++corner) {
                        const sourcePosition = outputVertices[face.vertices[corner]];
                        // A small inward/tangential offset resolves closest-point ties at UV seams:
                        // each face corner is sampled from the side that the face itself occupies.
                        const query = Vector3.add(
                            Vector3.mulScalar(sourcePosition, 0.985),
                            Vector3.mulScalar(center, 0.015),
                        );
                        const queryIndex = face.cornerQueryIndices[corner] * 3;
                        targetPositions[queryIndex] = query.x;
                        targetPositions[queryIndex + 1] = query.y;
                        targetPositions[queryIndex + 2] = query.z;
                    }

                    const materialPosition = Vector3.mulScalar(center, 1);
                    const materialIndex = face.materialQueryIndex * 3;
                    targetPositions[materialIndex] = materialPosition.x;
                    targetPositions[materialIndex + 1] = materialPosition.y;
                    targetPositions[materialIndex + 2] = materialPosition.z;
                }

                transferred = transferAttribute(
                    {
                        vertices: source.vertices,
                        indices: source.indices,
                    },
                    source.attributes,
                    3,
                    targetPositions,
                );
            }

            const outputNormals: Vector3[] = [];
            if (remeshed.normals && remeshed.normals.length >= outputVertices.length * 3) {
                for (let i = 0; i < outputVertices.length; ++i) {
                    const offset = i * 3;
                    outputNormals.push(new Vector3(
                        remeshed.normals[offset],
                        remeshed.normals[offset + 1],
                        remeshed.normals[offset + 2],
                    ));
                }
            } else {
                for (let i = 0; i < outputVertices.length; ++i) {
                    outputNormals.push(new Vector3(0, 0, 0));
                }
                for (const face of outputFaces) {
                    const a = outputVertices[face.vertices[0]];
                    const b = outputVertices[face.vertices[1]];
                    const c = outputVertices[face.vertices[2]];
                    const normal = Vector3.cross(Vector3.sub(b, a), Vector3.sub(c, a));
                    for (const index of face.vertices) outputNormals[index].add(normal);
                }
                for (const normal of outputNormals) {
                    if (normal.magnitude() > 1e-8) normal.normalise();
                    else normal.set(0, 1, 0);
                }
            }

            const outputUVs: UV[] = [];
            const outputTris: Tri[] = [];
            const meshFaces: TMeshFace[] = [];
            let outputQuadCount = 0;
            let outputTriangleCount = 0;

            const materialFallback = source.materialNames[0] || 'default';

            for (let faceIndex = 0; faceIndex < outputFaces.length; ++faceIndex) {
                const face = outputFaces[faceIndex];
                const vtIndices: number[] = [];

                if (source.hasUVs) {
                    for (const queryIndex of face.cornerQueryIndices) {
                        const offset = queryIndex * 3;
                        outputUVs.push(new UV(transferred[offset], transferred[offset + 1]));
                        vtIndices.push(outputUVs.length - 1);
                    }
                }

                let material = materialFallback;
                if (source.materialNames.length > 1 && needsProjection) {
                    const materialOffset = face.materialQueryIndex * 3 + 2;
                    const materialIndex = Math.max(
                        0,
                        Math.min(source.materialNames.length - 1, Math.round(transferred[materialOffset])),
                    );
                    material = source.materialNames[materialIndex] || materialFallback;
                }

                const vertices = face.vertices;
                if (vertices.length === 4) {
                    const v: [number, number, number, number] = [vertices[0], vertices[1], vertices[2], vertices[3]];
                    const vt = source.hasUVs ?
                        [vtIndices[0], vtIndices[1], vtIndices[2], vtIndices[3]] as [number, number, number, number] :
                        undefined;
                    const vn: [number, number, number, number] = [v[0], v[1], v[2], v[3]];

                    meshFaces.push({ v, vt, vn, material });
                    outputTris.push({
                        positionIndices: { x: v[0], y: v[1], z: v[2] },
                        texcoordIndices: vt ? { x: vt[0], y: vt[1], z: vt[2] } : undefined,
                        normalIndices: { x: vn[0], y: vn[1], z: vn[2] },
                        material,
                        hiddenEdge: 'zx',
                    });
                    outputTris.push({
                        positionIndices: { x: v[0], y: v[2], z: v[3] },
                        texcoordIndices: vt ? { x: vt[0], y: vt[2], z: vt[3] } : undefined,
                        normalIndices: { x: vn[0], y: vn[2], z: vn[3] },
                        material,
                        hiddenEdge: 'xy',
                    });
                    outputQuadCount++;
                } else {
                    const v: [number, number, number] = [vertices[0], vertices[1], vertices[2]];
                    const vt = source.hasUVs ? [vtIndices[0], vtIndices[1], vtIndices[2]] as [number, number, number] : undefined;
                    const vn: [number, number, number] = [v[0], v[1], v[2]];

                    meshFaces.push({ v, vt, vn, material });
                    outputTris.push({
                        positionIndices: { x: v[0], y: v[1], z: v[2] },
                        texcoordIndices: vt ? { x: vt[0], y: vt[1], z: vt[2] } : undefined,
                        normalIndices: { x: vn[0], y: vn[1], z: vn[2] },
                        material,
                    });
                    outputTriangleCount++;
                }

                if ((faceIndex + 1) % 2048 === 0 || faceIndex === outputFaces.length - 1) {
                    const fraction = (faceIndex + 1) / outputFaces.length;
                    ProgressManager.Get.progress(
                        task,
                        0.80 + fraction * 0.17,
                        'Перенос атрибутов::Обработано ' + (faceIndex + 1).toLocaleString()
                            + ' из ' + outputFaces.length.toLocaleString() + ' граней',
                    );
                }
            }

            const repairedMesh = new Mesh(
                outputVertices,
                outputNormals,
                outputUVs,
                outputTris,
                mesh.getMaterials(),
            );
            repairedMesh.setMaterials(mesh.getMaterials());

            const endTime = performance.now();
            const totalFaces = outputQuadCount + outputTriangleCount;
            const repairedStats: TMeshRepairStats = {
                vertices: outputVertices.length,
                triangles: outputTriangleCount,
                quads: outputQuadCount,
                totalFaces,
                quadPercentage: totalFaces > 0 ? (outputQuadCount / totalFaces) * 100 : 0,
                holesSealed: 0,
                degenerateFacesRemoved: source.degenerateFaces,
                nonManifoldEdgesFixed: source.nonManifoldEdges,
                processingTimeMs: Math.round(endTime - startedAt),
                watertight: remeshed.watertight,
                quality: remeshed.quality,
            };

            ProgressManager.Get.progress(
                task,
                1.0,
                'Завершено::Создано ' + outputQuadCount.toLocaleString() + ' квадов и '
                    + outputTriangleCount.toLocaleString() + ' треугольников; watertight: '
                    + (remeshed.watertight ? 'да' : 'нет'),
            );

            return {
                repairedMesh,
                originalStats: {
                    vertices: mesh._vertices.length,
                    triangles: mesh._tris.length,
                    degenerateFaces: source.degenerateFaces,
                    nonManifoldEdges: source.nonManifoldEdges,
                },
                repairedStats,
                quadsList: meshFaces,
            };
        } finally {
            ProgressManager.Get.end(task);
        }
    }

    private static _buildSourceBuffers(mesh: Mesh): TSourceBuffers {
        const vertexCount = mesh._vertices.length;
        const materialNames = Array.from(new Set(mesh._tris.map((tri) => tri.material)));
        if (materialNames.length === 0) materialNames.push('default');

        const materialIds = new Map<string, number>();
        materialNames.forEach((name, index) => materialIds.set(name, index));

        const bounds = mesh.getBounds();
        const dx = bounds.max.x - bounds.min.x;
        const dy = bounds.max.y - bounds.min.y;
        const dz = bounds.max.z - bounds.min.z;
        const diagonal = Math.max(0.001, Math.sqrt(dx * dx + dy * dy + dz * dz));
        const minimumAreaSquared = Math.pow(diagonal, 4) * 1e-20;

        const validTriangles: Tri[] = [];
        let degenerateFaces = 0;

        for (const tri of mesh._tris) {
            const p = tri.positionIndices;
            if (
                p.x < 0 || p.y < 0 || p.z < 0
                || p.x >= vertexCount || p.y >= vertexCount || p.z >= vertexCount
                || p.x === p.y || p.y === p.z || p.z === p.x
            ) {
                degenerateFaces++;
                continue;
            }

            const a = mesh._vertices[p.x];
            const b = mesh._vertices[p.y];
            const c = mesh._vertices[p.z];
            const ab = Vector3.sub(b, a);
            const ac = Vector3.sub(c, a);
            const cross = Vector3.cross(ab, ac);
            if (Vector3.dot(cross, cross) < minimumAreaSquared) {
                degenerateFaces++;
                continue;
            }
            validTriangles.push(tri);
        }

        if (validTriangles.length === 0) {
            throw new Error('В исходной модели нет корректных треугольников.');
        }

        const hasUVs = mesh._uvs.length > 0
            && validTriangles.some((tri) => tri.texcoordIndices !== undefined);

        let canUseIndexedBuffers = materialNames.length === 1;
        if (canUseIndexedBuffers) {
            for (const tri of validTriangles) {
                const p = tri.positionIndices;
                const uv = tri.texcoordIndices;
                if (hasUVs && (
                    !uv || uv.x !== p.x || uv.y !== p.y || uv.z !== p.z
                )) {
                    canUseIndexedBuffers = false;
                    break;
                }
            }
        }

        let sourceVertices: Float32Array;
        let sourceIndices: Uint32Array;
        let attributes: Float32Array;

        if (canUseIndexedBuffers) {
            sourceVertices = new Float32Array(vertexCount * 3);
            for (let i = 0; i < vertexCount; ++i) {
                const v = mesh._vertices[i];
                sourceVertices[i * 3] = v.x;
                sourceVertices[i * 3 + 1] = v.y;
                sourceVertices[i * 3 + 2] = v.z;
            }

            sourceIndices = new Uint32Array(validTriangles.length * 3);
            attributes = new Float32Array(vertexCount * 3);
            const uvWritten = new Uint8Array(vertexCount);

            for (let i = 0; i < validTriangles.length; ++i) {
                const tri = validTriangles[i];
                const p = tri.positionIndices;
                sourceIndices[i * 3] = p.x;
                sourceIndices[i * 3 + 1] = p.y;
                sourceIndices[i * 3 + 2] = p.z;

                if (hasUVs && tri.texcoordIndices) {
                    const corners = [p.x, p.y, p.z];
                    const uvIndices = [
                        tri.texcoordIndices.x,
                        tri.texcoordIndices.y,
                        tri.texcoordIndices.z,
                    ];
                    for (let corner = 0; corner < 3; ++corner) {
                        const positionIndex = corners[corner];
                        if (uvWritten[positionIndex]) continue;
                        const uv = mesh._uvs[uvIndices[corner]];
                        if (uv) {
                            attributes[positionIndex * 3] = uv.u;
                            attributes[positionIndex * 3 + 1] = uv.v;
                        }
                        uvWritten[positionIndex] = 1;
                    }
                }
                attributes[p.x * 3 + 2] = 0;
                attributes[p.y * 3 + 2] = 0;
                attributes[p.z * 3 + 2] = 0;
            }
        } else {
            // Expand to triangle corners when material or UV indices are discontinuous.
            // This preserves independent OBJ/glTF corner attributes before projection.
            sourceVertices = new Float32Array(validTriangles.length * 9);
            sourceIndices = new Uint32Array(validTriangles.length * 3);
            attributes = new Float32Array(validTriangles.length * 9);

            for (let i = 0; i < validTriangles.length; ++i) {
                const tri = validTriangles[i];
                const positions = [
                    tri.positionIndices.x,
                    tri.positionIndices.y,
                    tri.positionIndices.z,
                ];
                const uvIndices = tri.texcoordIndices ? [
                    tri.texcoordIndices.x,
                    tri.texcoordIndices.y,
                    tri.texcoordIndices.z,
                ] : [-1, -1, -1];
                const materialId = materialIds.get(tri.material) ?? 0;

                for (let corner = 0; corner < 3; ++corner) {
                    const sourcePosition = mesh._vertices[positions[corner]];
                    const dstVertex = i * 3 + corner;
                    const dstPosition = dstVertex * 3;
                    sourceVertices[dstPosition] = sourcePosition.x;
                    sourceVertices[dstPosition + 1] = sourcePosition.y;
                    sourceVertices[dstPosition + 2] = sourcePosition.z;
                    sourceIndices[dstVertex] = dstVertex;

                    if (hasUVs && uvIndices[corner] >= 0 && mesh._uvs[uvIndices[corner]]) {
                        const uv = mesh._uvs[uvIndices[corner]];
                        attributes[dstPosition] = uv.u;
                        attributes[dstPosition + 1] = uv.v;
                    }
                    attributes[dstPosition + 2] = materialId;
                }
            }
        }

        // Count non-manifold edges in the imported index topology without allocating
        // millions of string keys. Numeric edge keys remain exact at this vertex count.
        const edgeKeys = new Float64Array(validTriangles.length * 3);
        let edgeOffset = 0;
        for (const tri of validTriangles) {
            const p = tri.positionIndices;
            const pairs: Array<[number, number]> = [[p.x, p.y], [p.y, p.z], [p.z, p.x]];
            for (const pair of pairs) {
                const low = Math.min(pair[0], pair[1]);
                const high = Math.max(pair[0], pair[1]);
                edgeKeys[edgeOffset++] = low * Math.max(1, vertexCount) + high;
            }
        }
        edgeKeys.sort();

        let nonManifoldEdges = 0;
        let runLength = 1;
        for (let i = 1; i <= edgeKeys.length; ++i) {
            if (i < edgeKeys.length && edgeKeys[i] === edgeKeys[i - 1]) {
                runLength++;
            } else {
                if (runLength > 2) nonManifoldEdges++;
                runLength = 1;
            }
        }

        return {
            vertices: sourceVertices,
            indices: sourceIndices,
            attributes,
            hasUVs,
            materialNames,
            validTriangles,
            degenerateFaces,
            nonManifoldEdges,
        };
    }
}
