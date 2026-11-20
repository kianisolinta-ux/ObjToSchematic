import { RGBA } from '../colour';

export type Mat4 = [
    number, number, number, number,
    number, number, number, number,
    number, number, number, number,
    number, number, number, number,
];

export interface GltfCollectedPrimitive {
    primitive: any;
    worldMatrix: Mat4;
}

export function identityMat4(): Mat4 {
    return [
        1, 0, 0, 0,
        0, 1, 0, 0,
        0, 0, 1, 0,
        0, 0, 0, 1,
    ];
}

/**
 * Multiply two column-major 4x4 matrices: a * b.
 */
export function multiplyMat4(a: Mat4, b: Mat4): Mat4 {
    const out = new Array<number>(16) as Mat4;
    for (let col = 0; col < 4; ++col) {
        const b0 = b[col * 4 + 0];
        const b1 = b[col * 4 + 1];
        const b2 = b[col * 4 + 2];
        const b3 = b[col * 4 + 3];
        for (let row = 0; row < 4; ++row) {
            out[col * 4 + row] =
                a[0 * 4 + row] * b0 +
                a[1 * 4 + row] * b1 +
                a[2 * 4 + row] * b2 +
                a[3 * 4 + row] * b3;
        }
    }
    return out;
}

/**
 * Compose glTF TRS (T * R * S) into a column-major 4x4 matrix.
 */
export function composeTRS(
    translation?: ArrayLike<number>,
    rotation?: ArrayLike<number>,
    scale?: ArrayLike<number>,
): Mat4 {
    const tx = translation && translation.length >= 3 && Number.isFinite(translation[0]) ? translation[0] : 0;
    const ty = translation && translation.length >= 3 && Number.isFinite(translation[1]) ? translation[1] : 0;
    const tz = translation && translation.length >= 3 && Number.isFinite(translation[2]) ? translation[2] : 0;

    let qx = rotation && rotation.length >= 4 && Number.isFinite(rotation[0]) ? rotation[0] : 0;
    let qy = rotation && rotation.length >= 4 && Number.isFinite(rotation[1]) ? rotation[1] : 0;
    let qz = rotation && rotation.length >= 4 && Number.isFinite(rotation[2]) ? rotation[2] : 0;
    let qw = rotation && rotation.length >= 4 && Number.isFinite(rotation[3]) ? rotation[3] : 1;

    const qLen = Math.hypot(qx, qy, qz, qw);
    if (qLen > 1e-8) {
        qx /= qLen;
        qy /= qLen;
        qz /= qLen;
        qw /= qLen;
    } else {
        qx = 0;
        qy = 0;
        qz = 0;
        qw = 1;
    }

    const sx = scale && scale.length >= 3 && Number.isFinite(scale[0]) ? scale[0] : 1;
    const sy = scale && scale.length >= 3 && Number.isFinite(scale[1]) ? scale[1] : 1;
    const sz = scale && scale.length >= 3 && Number.isFinite(scale[2]) ? scale[2] : 1;

    const x2 = qx + qx;
    const y2 = qy + qy;
    const z2 = qz + qz;
    const xx = qx * x2;
    const xy = qx * y2;
    const xz = qx * z2;
    const yy = qy * y2;
    const yz = qy * z2;
    const zz = qz * z2;
    const wx = qw * x2;
    const wy = qw * y2;
    const wz = qw * z2;

    return [
        (1 - (yy + zz)) * sx,
        (xy + wz) * sx,
        (xz - wy) * sx,
        0,

        (xy - wz) * sy,
        (1 - (xx + zz)) * sy,
        (yz + wx) * sy,
        0,

        (xz + wy) * sz,
        (yz - wx) * sz,
        (1 - (xx + yy)) * sz,
        0,

        tx,
        ty,
        tz,
        1,
    ];
}

export function getNodeLocalMatrix(node: any): Mat4 {
    if (node && Array.isArray(node.matrix) && node.matrix.length === 16) {
        const m = node.matrix;
        let allFinite = true;
        for (let i = 0; i < 16; ++i) {
            if (!Number.isFinite(m[i])) {
                allFinite = false;
                break;
            }
        }
        if (allFinite) {
            return m.slice(0, 16) as Mat4;
        }
    }
    return composeTRS(node?.translation, node?.rotation, node?.scale);
}

/**
 * Computes transpose(inverse(mat3(worldMatrix))) in column-major 3x3 layout,
 * plus the determinant of the upper-left 3x3 block (negative det = mirrored geometry).
 */
export function computeNormalMatrix3(m: Mat4): { m3: number[], det: number } {
    const a00 = m[0];
    const a10 = m[1];
    const a20 = m[2];
    const a01 = m[4];
    const a11 = m[5];
    const a21 = m[6];
    const a02 = m[8];
    const a12 = m[9];
    const a22 = m[10];

    const c00 = a11 * a22 - a12 * a21;
    const c01 = -(a10 * a22 - a12 * a20);
    const c02 = a10 * a21 - a11 * a20;

    const c10 = -(a01 * a22 - a02 * a21);
    const c11 = a00 * a22 - a02 * a20;
    const c12 = -(a00 * a21 - a01 * a20);

    const c20 = a01 * a12 - a02 * a11;
    const c21 = -(a00 * a12 - a02 * a10);
    const c22 = a00 * a11 - a01 * a10;

    const det = a00 * c00 + a01 * c01 + a02 * c02;
    if (!Number.isFinite(det) || Math.abs(det) <= 1e-12) {
        return {
            m3: [
                1, 0, 0,
                0, 1, 0,
                0, 0, 1,
            ],
            det: det || 0,
        };
    }

    const invDet = 1.0 / det;
    // Transpose of cofactor/det = transpose(inverse), stored column-major:
    // col0 = [c00, c01, c02] * invDet? Wait:
    // inverse = (1/det) * adj = (1/det) * cofactor^T.
    // Therefore transpose(inverse) = (1/det) * cofactor!
    // In column-major storage: col0 = [c00, c10, c20]*invDet, col1 = [c01, c11, c21]*invDet, col2 = [c02, c12, c22]*invDet.
    return {
        m3: [
            c00 * invDet, c10 * invDet, c20 * invDet,
            c01 * invDet, c11 * invDet, c21 * invDet,
            c02 * invDet, c12 * invDet, c22 * invDet,
        ],
        det,
    };
}

export function transformPoint(m: Mat4, x: number, y: number, z: number): [number, number, number] {
    const w = m[3] * x + m[7] * y + m[11] * z + m[15];
    const invW = (Number.isFinite(w) && Math.abs(w) > 1e-8 && Math.abs(w - 1) > 1e-6) ? 1.0 / w : 1.0;
    return [
        (m[0] * x + m[4] * y + m[8] * z + m[12]) * invW,
        (m[1] * x + m[5] * y + m[9] * z + m[13]) * invW,
        (m[2] * x + m[6] * y + m[10] * z + m[14]) * invW,
    ];
}

export function transformNormal(normalMat3: number[], nx: number, ny: number, nz: number): [number, number, number] {
    const tx = normalMat3[0] * nx + normalMat3[3] * ny + normalMat3[6] * nz;
    const ty = normalMat3[1] * nx + normalMat3[4] * ny + normalMat3[7] * nz;
    const tz = normalMat3[2] * nx + normalMat3[5] * ny + normalMat3[8] * nz;
    const len = Math.hypot(tx, ty, tz);
    if (!Number.isFinite(len) || len <= 1e-6) {
        return [0, 1, 0];
    }
    return [tx / len, ty / len, tz / len];
}

function resolveRef(collection: any, ref: any): any {
    if (ref === null || ref === undefined) {
        return undefined;
    }
    if (typeof ref === 'object') {
        return ref;
    }
    if ((typeof ref === 'number' || typeof ref === 'string') && collection) {
        return collection[ref];
    }
    return undefined;
}

/**
 * Traverses glTF scene hierarchy and returns mesh primitives paired with accumulated world matrices.
 * Handles both @loaders.gl/gltf post-processed objects and raw index-based glTF structures.
 * Falls back to iterating gltf.meshes directly when no scenes/nodes are defined.
 */
export function collectGltfPrimitives(gltf: any): GltfCollectedPrimitive[] {
    if (!gltf) {
        return [];
    }

    const collected: GltfCollectedPrimitive[] = [];

    const visitNode = (nodeRef: any, parentMatrix: Mat4, activeBranch: Set<any>) => {
        const node = resolveRef(gltf.nodes, nodeRef);
        if (!node || activeBranch.has(node)) {
            return;
        }

        activeBranch.add(node);
        const worldMatrix = multiplyMat4(parentMatrix, getNodeLocalMatrix(node));

        if (node.mesh !== undefined && node.mesh !== null) {
            const mesh = resolveRef(gltf.meshes, node.mesh);
            if (mesh && mesh.primitives) {
                Object.values(mesh.primitives).forEach((primitive: any) => {
                    if (primitive) {
                        collected.push({ primitive, worldMatrix });
                    }
                });
            }
        }

        if (Array.isArray(node.children)) {
            for (const childRef of node.children) {
                visitNode(childRef, worldMatrix, activeBranch);
            }
        }
        activeBranch.delete(node);
    };

    let rootNodes: any[] | undefined;

    if (gltf.scene !== undefined && gltf.scene !== null) {
        const activeScene = typeof gltf.scene === 'object' ? gltf.scene : resolveRef(gltf.scenes, gltf.scene);
        if (activeScene && Array.isArray(activeScene.nodes)) {
            rootNodes = activeScene.nodes;
        }
    } else if (Array.isArray(gltf.scenes) && gltf.scenes.length > 0 && Array.isArray(gltf.scenes[0]?.nodes)) {
        rootNodes = gltf.scenes[0].nodes;
    }

    if (rootNodes && rootNodes.length > 0) {
        const identity = identityMat4();
        for (const nodeRef of rootNodes) {
            visitNode(nodeRef, identity, new Set());
        }
        if (collected.length > 0) {
            return collected;
        }
    }

    // If scenes didn't yield primitives, check gltf.nodes for orphan/root nodes
    if (gltf.nodes) {
        const nodeList: any[] = Array.isArray(gltf.nodes) ? gltf.nodes : Object.values(gltf.nodes);
        if (nodeList.length > 0) {
            const referencedChildren = new Set<any>();
            for (const node of nodeList) {
                if (Array.isArray(node?.children)) {
                    for (const childRef of node.children) {
                        const resolvedChild = resolveRef(gltf.nodes, childRef);
                        if (resolvedChild) {
                            referencedChildren.add(resolvedChild);
                        }
                    }
                }
            }
            const identity = identityMat4();
            for (const node of nodeList) {
                if (node && !referencedChildren.has(node)) {
                    visitNode(node, identity, new Set());
                }
            }
            if (collected.length > 0) {
                return collected;
            }
        }
    }

    // Fallback: iterate raw meshes with identity matrix (for synthetic/node-less glTF)
    if (gltf.meshes) {
        const identity = identityMat4();
        Object.values(gltf.meshes).forEach((mesh: any) => {
            if (mesh && mesh.primitives) {
                Object.values(mesh.primitives).forEach((primitive: any) => {
                    if (primitive) {
                        collected.push({ primitive, worldMatrix: identity });
                    }
                });
            }
        });
    }

    return collected;
}

/**
 * Expands primitive vertex indices into triangle triplets [i0, i1, i2, ...].
 * Supports TRIANGLES (4), TRIANGLE_STRIP (5), and TRIANGLE_FAN (6).
 * Returns empty array for non-triangle modes (POINTS/LINES).
 */
export function expandPrimitiveTriangleIndices(
    rawIndices: ArrayLike<number> | undefined,
    vertexCount: number,
    mode: number = 4,
): number[] {
    const count = rawIndices ? rawIndices.length : vertexCount;
    const idxAt = (k: number) => rawIndices ? rawIndices[k] : k;

    if (mode === 4) {
        const out: number[] = [];
        const triCount = Math.floor(count / 3);
        for (let i = 0; i < triCount; ++i) {
            out.push(idxAt(i * 3 + 0), idxAt(i * 3 + 1), idxAt(i * 3 + 2));
        }
        return out;
    }

    if (mode === 5) {
        const out: number[] = [];
        for (let i = 0; i + 2 < count; ++i) {
            const a = idxAt(i);
            const b = idxAt(i + 1);
            const c = idxAt(i + 2);
            if (i % 2 === 0) {
                out.push(a, b, c);
            } else {
                out.push(b, a, c);
            }
        }
        return out;
    }

    if (mode === 6) {
        const out: number[] = [];
        if (count >= 3) {
            const a = idxAt(0);
            for (let i = 1; i + 1 < count; ++i) {
                out.push(a, idxAt(i), idxAt(i + 1));
            }
        }
        return out;
    }

    return [];
}

/**
 * Converts a linear [0, 1] colour component (glTF spec) to sRGB [0, 1].
 */
export function linearToSrgbChannel(linear: number): number {
    if (!Number.isFinite(linear)) {
        return 1.0;
    }
    const c = Math.max(0, Math.min(1, linear));
    if (c <= 0) {
        return 0.0;
    }
    if (c >= 1) {
        return 1.0;
    }
    if (c <= 0.0031308) {
        return c * 12.92;
    }
    return 1.055 * Math.pow(c, 1.0 / 2.4) - 0.055;
}

export function linearFactorToSrgbRGBA(factor?: ArrayLike<number>, forceOpaque: boolean = false): RGBA {
    if (!factor || factor.length < 3) {
        return { r: 1, g: 1, b: 1, a: 1 };
    }
    const r = Number.isFinite(factor[0]) ? linearToSrgbChannel(factor[0]) : 1;
    const g = Number.isFinite(factor[1]) ? linearToSrgbChannel(factor[1]) : 1;
    const b = Number.isFinite(factor[2]) ? linearToSrgbChannel(factor[2]) : 1;
    const a = forceOpaque ? 1 : (factor.length >= 4 && Number.isFinite(factor[3]) ? Math.max(0, Math.min(1, factor[3])) : 1);
    return { r, g, b, a };
}

/**
 * Decodes glTF COLOR_0 accessor (Float32, Uint8, Uint16; VEC3 or VEC4) into sRGB RGBA[].
 */
export function decodeColorAccessor(accessor: any): RGBA[] {
    if (!accessor || !accessor.value) {
        return [];
    }
    const values = accessor.value as ArrayLike<number>;
    let components = accessor.components;
    if (components !== 3 && components !== 4) {
        if (accessor.type === 'VEC3') {
            components = 3;
        } else if (accessor.type === 'VEC4') {
            components = 4;
        } else if (accessor.count && accessor.count > 0) {
            components = Math.round(values.length / accessor.count);
        } else {
            components = 4;
        }
    }
    if (components !== 3 && components !== 4) {
        return [];
    }

    let scale = 1.0;
    if (values instanceof Uint8Array || accessor.componentType === 5121) {
        scale = 1.0 / 255.0;
    } else if (values instanceof Uint16Array || accessor.componentType === 5123) {
        scale = 1.0 / 65535.0;
    } else if (values instanceof Int8Array || accessor.componentType === 5120) {
        scale = 1.0 / 127.0;
    } else if (values instanceof Int16Array || accessor.componentType === 5122) {
        scale = 1.0 / 32767.0;
    }

    const out: RGBA[] = [];
    for (let i = 0; i + components - 1 < values.length; i += components) {
        const r = linearToSrgbChannel(values[i + 0] * scale);
        const g = linearToSrgbChannel(values[i + 1] * scale);
        const b = linearToSrgbChannel(values[i + 2] * scale);
        const a = components === 4 && Number.isFinite(values[i + 3]) ?
            Math.max(0, Math.min(1, values[i + 3] * scale)) :
            1.0;
        out.push({ r, g, b, a });
    }
    return out;
}

/**
 * Detects image MIME type from declared MIME string or binary magic bytes.
 */
export function detectImageMimeType(bytes: Uint8Array, declaredMimeType?: string): string {
    const normalizedDeclared = typeof declaredMimeType === 'string' ? declaredMimeType.trim().toLowerCase() : '';
    if (normalizedDeclared) {
        return normalizedDeclared;
    }
    if (!bytes || bytes.length < 4) {
        return '';
    }
    // PNG: 89 50 4E 47
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) {
        return 'image/png';
    }
    // JPEG: FF D8 FF
    if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) {
        return 'image/jpeg';
    }
    // WEBP: "RIFF" + 4 bytes + "WEBP"
    if (
        bytes.length >= 12 &&
        bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
        bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
    ) {
        return 'image/webp';
    }
    return '';
}
