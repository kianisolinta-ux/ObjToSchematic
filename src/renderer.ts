import * as twgl from 'twgl.js';

import VANILLA_TEXTURE from '../res/atlases/vanilla.png';
import { Bounds } from './bounds';
import { BufferGenerator } from './buffer';
import { ArcballCamera } from './camera';
import { RGBA, RGBAUtil } from './colour';
import { AppConfig } from './config';
import { DebugGeometryTemplates } from './geometry';
import { InteractionManager } from './interaction';
import { MaterialType, SolidMaterial, TexturedMaterial } from './mesh';
import { RenderBuffer } from './render_buffer';
import { ShaderManager } from './shaders';
import {
    computeSliceLayerBlockSummary,
    computeSliceLayerStats,
    SliceLayerBlockSummary,
    SliceLayerStats,
} from './slice_stats';
import { EImageChannel } from './texture';
import { UI } from './ui/layout';
import { ASSERT } from './util/error_util';
import { LOG_ERROR } from './util/log_util';
import { TAxis } from './util/type_util';
import { UIUtil } from './util/ui_util';
import { Vector3 } from './vector';
import { RenderMeshParams, RenderNextBlockMeshChunkParams, RenderNextVoxelMeshChunkParams } from './worker_types';

/* eslint-disable */
export enum MeshType {
    None,
    TriangleMesh,
    VoxelMesh,
    BlockMesh
}
/* eslint-enable */

/* eslint-disable */

enum EDebugBufferComponents {
    Wireframe,
    Normals,
    Bounds,
    Dev,
}
/* eslint-enable */

/**
 * Dedicated type for passing to shaders for solid materials
 */
type InternalSolidMaterial = {
    type: MaterialType.solid,
    colourArray: number[],
}

/**
 * Dedicated type for passing to shaders for textured materials
 */
type InternalTextureMaterial = {
    type: MaterialType.textured,
    diffuseTexture: WebGLTexture,
    // The texture to sample alpha values from (if is using a texture map)
    alphaTexture: WebGLTexture,
    // What texture channel to sample the alpha value from
    alphaChannel: EImageChannel,
    // What alpha value to use (only used if using constant transparency mode)
    alphaValue: number,
    tintColour: number[],
    alphaCutoff: number,
};

export class Renderer {
    public _gl: WebGL2RenderingContext;

    private _backgroundColour: RGBA = { r: 0.125, g: 0.125, b: 0.125, a: 1.0 };
    private _atlasTexture?: WebGLTexture;

    private _atlasSize: number = 1.0;
    private _meshToUse: MeshType = MeshType.None;
    private _voxelSize: number = 1.0;
    private _gridOffset: Vector3 = new Vector3(0, 0, 0);
    private _sliceHeight: number = 0.0;

    private _modelsAvailable: number;

    private _materialBuffers: Map<string, {
        material: InternalSolidMaterial | InternalTextureMaterial,
        buffer: twgl.BufferInfo,
        numElements: number,
        materialName: string,
    }>;
    private _meshBuffersData: Array<{
        positions: Float32Array;
        indices: Uint32Array;
        texcoords: Float32Array;
        materialName: string;
    }> = [];
    public _voxelBuffer?: twgl.BufferInfo[];
    private _voxelData: Array<{ position: [number, number, number] }> = [];
    private _blockBuffer?: twgl.BufferInfo[];
    private _blockSelectionData: Array<{ position: [number, number, number], id: number }> = [];
    private _blockYs: number[] = [];
    private _selectedBlockNames: Set<string> = new Set<string>();
    private _selectionOutlineBuffer: RenderBuffer;
    private _selectionOutlineCount: number = 0;
    private _blockBounds: Bounds;
    private _axisBuffer: RenderBuffer;

    private _axisHighlightBuffer: {
        x: { enabled: boolean, buffer: RenderBuffer },
        y: { enabled: boolean, buffer: RenderBuffer },
        z: { enabled: boolean, buffer: RenderBuffer },
    };

    private _isGridComponentEnabled: { [bufferComponent: string]: boolean };
    private _axesEnabled: boolean;
    private _nightVisionEnabled: boolean;
    private _sliceViewEnabled: boolean;
    private _colorChartEnabled: boolean = false;

    private _gridBuffers: {
        x: { [meshType: string]: RenderBuffer };
        y: { [meshType: string]: RenderBuffer };
        z: { [meshType: string]: RenderBuffer };
    };
    private _gridEnabled: boolean;
    private _clayShadingEnabled: boolean = false;
    private _meshWireframeBuffer?: RenderBuffer;
    private _referenceGhostBuffer?: RenderBuffer;
    private _referenceGhostEnabled: boolean = false;

    private static _instance: Renderer;
    public static get Get() {
        return this._instance || (this._instance = new this());
    }

    private constructor() {
        const webgl2Context = (<HTMLCanvasElement>document.getElementById('canvas')).getContext('webgl2', {
            alpha: false,
        });

        if (webgl2Context === null) {
            throw new Error('Could not get WebGL2');
        }

        this._gl = webgl2Context;
        twgl.addExtensionsToContext(this._gl);

        this._backgroundColour = AppConfig.Get.VIEWPORT_BACKGROUND_COLOUR;

        this._modelsAvailable = 0;
        this._materialBuffers = new Map();

        this._gridBuffers = { x: {}, y: {}, z: {} };
        this._gridEnabled = false;

        this._isGridComponentEnabled = {};
        this._axesEnabled = true;
        this._nightVisionEnabled = true;
        this._sliceViewEnabled = false;

        this._blockBounds = new Bounds(new Vector3(0, 0, 0), new Vector3(0, 0, 0));

        this._selectionOutlineBuffer = new RenderBuffer([
            { name: 'position', numComponents: 3 },
            { name: 'colour', numComponents: 4 },
        ]);

        this._axisBuffer = new RenderBuffer([
            { name: 'position', numComponents: 3 },
            { name: 'colour', numComponents: 4 },
        ]);
        this._axisBuffer.add(DebugGeometryTemplates.arrow(new Vector3(0, 0, 0), new Vector3(0.125, 0, 0), { r: 0.96, g: 0.21, b: 0.32, a: 1.0 }));
        this._axisBuffer.add(DebugGeometryTemplates.arrow(new Vector3(0, 0, 0), new Vector3(0, 0.125, 0), { r: 0.44, g: 0.64, b: 0.11, a: 1.0 }));
        this._axisBuffer.add(DebugGeometryTemplates.arrow(new Vector3(0, 0, 0), new Vector3(0, 0, 0.125), { r: 0.18, g: 0.52, b: 0.89, a: 1.0 }));

        const resizeObserver = new ResizeObserver(() => {
            this.forceRedraw();
        });

        resizeObserver.observe(UIUtil.getElementById('canvas'));

        {
            this._axisHighlightBuffer = {
                x: {
                    enabled: false, buffer: new RenderBuffer([
                        { name: 'position', numComponents: 3 },
                        { name: 'colour', numComponents: 4 },
                    ]),
                },
                y: {
                    enabled: false, buffer: new RenderBuffer([
                        { name: 'position', numComponents: 3 },
                        { name: 'colour', numComponents: 4 },
                    ]),
                },
                z: {
                    enabled: false, buffer: new RenderBuffer([
                        { name: 'position', numComponents: 3 },
                        { name: 'colour', numComponents: 4 },
                    ]),
                },
            };

            this._axisHighlightBuffer.x.buffer.add(DebugGeometryTemplates.line(new Vector3(-10, 0, 0), new Vector3(10, 0, 0), { r: 0.96, g: 0.21, b: 0.32, a: 1.0 }));
            this._axisHighlightBuffer.y.buffer.add(DebugGeometryTemplates.line(new Vector3(0, -10, 0), new Vector3(0, 10, 0), { r: 0.44, g: 0.64, b: 0.11, a: 1.0 }));
            this._axisHighlightBuffer.z.buffer.add(DebugGeometryTemplates.line(new Vector3(0, 0, -10), new Vector3(0, 0, 10), { r: 0.18, g: 0.52, b: 0.89, a: 1.0 }));
        }

        const textureSrc = (typeof VANILLA_TEXTURE === 'object' && (VANILLA_TEXTURE as any)?.default) ?
            (VANILLA_TEXTURE as any).default :
            VANILLA_TEXTURE;

        this._atlasTexture = twgl.createTexture(this._gl, {
            src: textureSrc,
            mag: this._gl.NEAREST,
            crossOrigin: 'anonymous',
        }, (err) => {
            if (err) {
                LOG_ERROR(`Atlas texture load error: ${err}`);
            }
            this.forceRedraw();
        });
    }

    public update() {
        ArcballCamera.Get.updateCamera();
    }

    private _redraw = true;
    public forceRedraw() {
        this._redraw = true;
    }

    public draw() {
        if (this._redraw || ArcballCamera.Get.isMoving()) {
            this._setupScene();

            switch (this._meshToUse) {
                case MeshType.TriangleMesh:
                    this._drawMesh();
                    break;
                case MeshType.VoxelMesh:
                    this._drawVoxelMesh();
                    break;
                case MeshType.BlockMesh:
                    this._drawBlockMesh();
                    break;
            };

            this._drawDebug();
            this._redraw = false;
        }
    }

    // /////////////////////////////////////////////////////////////////////////

    public isSliceViewerEnabled() {
        return this._sliceViewEnabled && this._meshToUse === MeshType.BlockMesh;
    }

    public toggleSliceViewerEnabled() {
        this._sliceViewEnabled = !this._sliceViewEnabled;
        if (this._selectedBlockNames.size > 0) {
            this._rebuildSelectionOutline();
        }
        this.forceRedraw();
    }

    public canIncrementSliceHeight() {
        return this._blockBounds.max.y > this._sliceHeight;
    }

    public canDecrementSliceHeight() {
        return this._blockBounds.min.y < this._sliceHeight;
    }

    public incrementSliceHeight() {
        if (this.canIncrementSliceHeight()) {
            ++this._sliceHeight;
            if (this._selectedBlockNames.size > 0) {
                this._rebuildSelectionOutline();
            }
            this.forceRedraw();
        }
    }

    public decrementSliceHeight() {
        if (this.canDecrementSliceHeight()) {
            --this._sliceHeight;
            if (this._selectedBlockNames.size > 0) {
                this._rebuildSelectionOutline();
            }
            this.forceRedraw();
        }
    }

    private _lightingAvailable: boolean = false;
    public setLightingAvailable(isAvailable: boolean) {
        this._lightingAvailable = isAvailable;
        if (!isAvailable) {
            this._nightVisionEnabled = true;
        }
    }

    public toggleIsGridEnabled() {
        this._gridEnabled = !this._gridEnabled;
        this.forceRedraw();
    }

    public isGridEnabled() {
        return this._gridEnabled;
    }

    public isAxesEnabled() {
        return this._axesEnabled;
    }

    public toggleIsAxesEnabled() {
        this._axesEnabled = !this._axesEnabled;
        this.forceRedraw();
    }

    public canToggleNightVision() {
        return this._lightingAvailable;
    }

    public toggleIsNightVisionEnabled() {
        this._nightVisionEnabled = !this._nightVisionEnabled;
        if (!this._lightingAvailable) {
            this._nightVisionEnabled = true;
        }
        this.forceRedraw();
    }

    public isNightVisionEnabled() {
        return this._nightVisionEnabled;
    }

    public toggleIsWireframeEnabled() {
        const isEnabled = !this._isGridComponentEnabled[EDebugBufferComponents.Wireframe];
        this._isGridComponentEnabled[EDebugBufferComponents.Wireframe] = isEnabled;
        this.forceRedraw();
    }

    public isWireframeEnabled(): boolean {
        return Boolean(this._isGridComponentEnabled[EDebugBufferComponents.Wireframe]);
    }

    public setClayShadingEnabled(enabled: boolean) {
        this._clayShadingEnabled = enabled;
        this.forceRedraw();
    }

    public isClayShadingEnabled(): boolean {
        return this._clayShadingEnabled;
    }

    public setReferenceGhostEnabled(enabled: boolean) {
        this._referenceGhostEnabled = enabled;
        this.forceRedraw();
    }

    public isReferenceGhostEnabled(): boolean {
        return this._referenceGhostEnabled;
    }

    public setReferenceGhostMesh(buffers: RenderMeshParams.Output['buffers'] | null) {
        if (!buffers || buffers.length === 0) {
            this._referenceGhostBuffer = undefined;
            this.forceRedraw();
            return;
        }
        this._referenceGhostBuffer = this._buildWireframeLinesFromBuffers(
            buffers.map((b) => ({
                positions: b.buffer.position.data,
                indices: b.buffer.indices.data,
            })),
            { r: 0.22, g: 0.84, b: 0.98, a: 0.65 },
            9000,
        );
        this.forceRedraw();
    }

    private _buildWireframeLinesFromBuffers(
        list: Array<{ positions: Float32Array; indices: Uint32Array }>,
        colour: RGBA,
        maxTrianglesPerMesh = 12000,
    ): RenderBuffer {
        const rb = new RenderBuffer([
            { name: 'position', numComponents: 3 },
            { name: 'colour', numComponents: 4 },
        ]);
        for (let m = 0; m < list.length; ++m) {
            const { positions, indices } = list[m];
            const triTotal = Math.floor(indices.length / 3);
            const step = triTotal > maxTrianglesPerMesh ? Math.ceil(triTotal / maxTrianglesPerMesh) : 1;
            for (let t = 0; t < triTotal; t += step) {
                const i0 = indices[t * 3] * 3;
                const i1 = indices[t * 3 + 1] * 3;
                const i2 = indices[t * 3 + 2] * 3;
                const p0 = new Vector3(positions[i0], positions[i0 + 1], positions[i0 + 2]);
                const p1 = new Vector3(positions[i1], positions[i1 + 1], positions[i1 + 2]);
                const p2 = new Vector3(positions[i2], positions[i2 + 1], positions[i2 + 2]);
                rb.add(DebugGeometryTemplates.line(p0, p1, colour));
                rb.add(DebugGeometryTemplates.line(p1, p2, colour));
                rb.add(DebugGeometryTemplates.line(p2, p0, colour));
            }
        }
        return rb;
    }

    public toggleIsNormalsEnabled() {
        const isEnabled = !this._isGridComponentEnabled[EDebugBufferComponents.Normals];
        this._isGridComponentEnabled[EDebugBufferComponents.Normals] = isEnabled;
        this.forceRedraw();
    }

    public toggleIsDevDebugEnabled() {
        const isEnabled = !this._isGridComponentEnabled[EDebugBufferComponents.Dev];
        this._isGridComponentEnabled[EDebugBufferComponents.Dev] = isEnabled;
        this.forceRedraw();
    }

    public clearMesh() {
        this._materialBuffers = new Map();
        this._meshBuffersData = [];
        this._meshWireframeBuffer = undefined;
        this._referenceGhostBuffer = undefined;

        this._modelsAvailable = 0;
        this.setModelToUse(MeshType.None);
    }

    private _createInternalMaterial(material: SolidMaterial | TexturedMaterial): (InternalSolidMaterial | InternalTextureMaterial) {
        if (material.type === MaterialType.solid) {
            return {
                type: MaterialType.solid,
                colourArray: RGBAUtil.toArray(material.colour),
            };
        } else {
            const blankTexture = twgl.createTexture(this._gl, {
                min: this._gl.NEAREST,
                mag: this._gl.NEAREST,
                src: [
                    255, 0, 255, 255,
                ],
            }, () => {
                this.forceRedraw();
            });

            let diffuseTexture = blankTexture;
            let alphaTexture = diffuseTexture;

            if (material.diffuse !== undefined && material.diffuse.raw !== '') {
                diffuseTexture = twgl.createTexture(this._gl, {
                    src: material.diffuse?.raw, // TODO Unimplemented
                    min: material.interpolation === 'linear' ? this._gl.LINEAR : this._gl.NEAREST,
                    mag: material.interpolation === 'linear' ? this._gl.LINEAR : this._gl.NEAREST,
                    wrap: material.extension === 'clamp' ? this._gl.CLAMP_TO_EDGE : this._gl.REPEAT,
                }, () => {
                    this.forceRedraw();
                });
            }

            if (material.transparency.type === 'UseAlphaMap') {
                alphaTexture = blankTexture;
                if (material.transparency.alpha !== undefined && material.transparency.alpha.raw !== '') {
                    alphaTexture = twgl.createTexture(this._gl, {
                        src: material.transparency.alpha.raw, // TODO Unimplemented
                        min: material.interpolation === 'linear' ? this._gl.LINEAR : this._gl.NEAREST,
                        mag: material.interpolation === 'linear' ? this._gl.LINEAR : this._gl.NEAREST,
                        wrap: material.extension === 'clamp' ? this._gl.CLAMP_TO_EDGE : this._gl.REPEAT,
                    }, () => {
                        this.forceRedraw();
                    });
                }
            }

            const alphaValue = material.transparency.type === 'UseAlphaValue' ?
                material.transparency.alpha : 1.0;

            let alphaChannel: EImageChannel = EImageChannel.MAX;
            switch (material.transparency.type) {
                case 'None':
                    alphaChannel = EImageChannel.MAX;
                    break;
                case 'UseAlphaValue':
                    alphaChannel = EImageChannel.MAX;
                    break;
                case 'UseDiffuseMapAlphaChannel':
                    alphaChannel = EImageChannel.A;
                    break;
                case 'UseAlphaMap':
                    alphaChannel = material.transparency.channel;
                    break;
            }

            return {
                type: MaterialType.textured,
                diffuseTexture: diffuseTexture,
                alphaTexture: alphaTexture,
                alphaValue: alphaValue,
                alphaChannel: alphaChannel,
                tintColour: material.tint ? RGBAUtil.toArray(material.tint) : [1, 1, 1, 1],
                alphaCutoff: material.alphaCutoff ?? -1.0,
            };
        }
    }

    public recreateMaterialBuffer(materialName: string, material: SolidMaterial | TexturedMaterial) {
        const oldBuffer = this._materialBuffers.get(materialName);
        if (!oldBuffer) {
            return;
        }

        const internalMaterial = this._createInternalMaterial(material);
        this._materialBuffers.set(materialName, {
            buffer: oldBuffer.buffer,
            material: internalMaterial,
            numElements: oldBuffer.numElements,
            materialName: materialName,
        });
        this.forceRedraw();
    }

    public useMesh(params: RenderMeshParams.Output) {
        this._materialBuffers = new Map();
        this._meshBuffersData = params.buffers.map((b) => ({
            positions: b.buffer.position.data,
            indices: b.buffer.indices.data,
            texcoords: b.buffer.texcoord.data,
            materialName: b.materialName,
        }));

        for (const { material, buffer, numElements, materialName } of params.buffers) {
            const internalMaterial = this._createInternalMaterial(material);
            this._materialBuffers.set(materialName, {
                buffer: twgl.createBufferInfoFromArrays(this._gl, buffer),
                material: internalMaterial,
                numElements: numElements,
                materialName: materialName,
            });
        }

        this._gridBuffers.x[MeshType.TriangleMesh] = DebugGeometryTemplates.gridX(params.dimensions);
        this._gridBuffers.y[MeshType.TriangleMesh] = DebugGeometryTemplates.gridY(params.dimensions);
        this._gridBuffers.z[MeshType.TriangleMesh] = DebugGeometryTemplates.gridZ(params.dimensions);
        this._meshWireframeBuffer = this._buildWireframeLinesFromBuffers(
            this._meshBuffersData,
            { r: 0.12, g: 0.13, b: 0.16, a: 0.48 },
            14000,
        );

        this._modelsAvailable = 1;
        this.setModelToUse(MeshType.TriangleMesh);
    }

    private _allVoxelChunks = false;
    public useVoxelMeshChunk(params: RenderNextVoxelMeshChunkParams.Output) {
        if (params.isFirstChunk) {
            this._voxelBuffer = [];
            this._voxelData = [];
        }

        const posData = params.buffer.buffer.position.data as Float32Array;
        const numVoxels = posData.length / 72;
        for (let i = 0; i < numVoxels; ++i) {
            const base = i * 72;
            let minX = Infinity; let maxX = -Infinity;
            let minY = Infinity; let maxY = -Infinity;
            let minZ = Infinity; let maxZ = -Infinity;
            for (let v = 0; v < 24; ++v) {
                const vx = posData[base + v * 3 + 0];
                const vy = posData[base + v * 3 + 1];
                const vz = posData[base + v * 3 + 2];
                if (vx < minX) minX = vx;
                if (vx > maxX) maxX = vx;
                if (vy < minY) minY = vy;
                if (vy > maxY) maxY = vy;
                if (vz < minZ) minZ = vz;
                if (vz > maxZ) maxZ = vz;
            }
            this._voxelData.push({
                position: [
                    Math.round((minX + maxX) / 2),
                    Math.round((minY + maxY) / 2),
                    Math.round((minZ + maxZ) / 2),
                ],
            });
        }

        this._allVoxelChunks = !params.moreVoxelsToBuffer;

        this._voxelBuffer?.push(twgl.createBufferInfoFromArrays(this._gl, params.buffer.buffer));
        this._voxelSize = params.voxelSize;

        if (params.isFirstChunk) {
            const voxelSize = this._voxelSize;
            const dimensions = new Vector3(0, 0, 0);
            dimensions.setFrom(params.dimensions);

            this._gridOffset = new Vector3(
                dimensions.x % 2 === 0 ? 0 : -0.5,
                dimensions.y % 2 === 0 ? 0 : -0.5,
                dimensions.z % 2 === 0 ? 0 : -0.5,
            );
            dimensions.add(1);

            this._gridBuffers.x[MeshType.VoxelMesh] = DebugGeometryTemplates.gridX(Vector3.mulScalar(dimensions, voxelSize), voxelSize);
            this._gridBuffers.y[MeshType.VoxelMesh] = DebugGeometryTemplates.gridY(Vector3.mulScalar(dimensions, voxelSize), voxelSize);
            this._gridBuffers.z[MeshType.VoxelMesh] = DebugGeometryTemplates.gridZ(Vector3.mulScalar(dimensions, voxelSize), voxelSize);

            this._modelsAvailable = 2;
            this.setModelToUse(MeshType.VoxelMesh);
        }

        this.forceRedraw();
    }

    /*
    public useVoxelMesh(params: RenderNextVoxelMeshChunkParams.Output) {
        this._voxelBuffer?.push(twgl.createBufferInfoFromArrays(this._gl, params.buffer.buffer));
        this._voxelSize = params.voxelSize;

        const voxelSize = this._voxelSize;
        const dimensions = new Vector3(0, 0, 0);
        dimensions.setFrom(params.dimensions);

        this._gridOffset = new Vector3(
            dimensions.x % 2 === 0 ? 0 : -0.5,
            dimensions.y % 2 === 0 ? 0 : -0.5,
            dimensions.z % 2 === 0 ? 0 : -0.5,
        );
        dimensions.add(1);

        this._gridBuffers.x[MeshType.VoxelMesh] = DebugGeometryTemplates.gridX(Vector3.mulScalar(dimensions, voxelSize), voxelSize);
        this._gridBuffers.y[MeshType.VoxelMesh] = DebugGeometryTemplates.gridY(Vector3.mulScalar(dimensions, voxelSize), voxelSize);
        this._gridBuffers.z[MeshType.VoxelMesh] = DebugGeometryTemplates.gridZ(Vector3.mulScalar(dimensions, voxelSize), voxelSize);

        this._modelsAvailable = 2;
        this.setModelToUse(MeshType.VoxelMesh);
    }
    */

    public clearBlockMesh() {
        this._blockBuffer = undefined;
        this._blockSelectionData = [];
        this._blockYs = [];
        this._selectedBlockNames.clear();
        this._selectionOutlineCount = 0;
        this._selectionOutlineBuffer = new RenderBuffer([
            { name: 'position', numComponents: 3 },
            { name: 'colour', numComponents: 4 },
        ]);
        this._modelsAvailable = Math.min(this._modelsAvailable, MeshType.VoxelMesh);
        this._sliceViewEnabled = false;
        this._sliceHeight = 0.0;
        this.forceRedraw();
    }

    public useBlockMeshChunk(params: RenderNextBlockMeshChunkParams.Output) {
        if (params.isFirstChunk) {
            this._blockBuffer = [];
            this._blockSelectionData = [];
            this._blockYs = [];

            // re-create objects, due to serialization.
            const min = new Vector3(0, 0, 0);
            const max = new Vector3(0, 0, 0);
            min.setFrom(params.bounds['_min']);
            max.setFrom(params.bounds['_max']);

            this._blockBounds = new Bounds(min, max);
            this._sliceHeight = this._blockBounds.min.y;
        }

        this._blockBuffer?.push(twgl.createBufferInfoFromArrays(this._gl, params.buffer.buffer));

        const blockPositions = params.buffer.buffer.blockPosition.data as Float32Array;
        const blockTypeIds = params.buffer.buffer.blockTypeId.data as Float32Array;
        for (let i = 0; i < blockTypeIds.length; i += 24) {
            const by = blockPositions[(i / 24) * 72 + 1];
            this._blockSelectionData.push({
                position: [
                    blockPositions[(i / 24) * 72],
                    by,
                    blockPositions[(i / 24) * 72 + 2],
                ],
                id: blockTypeIds[i],
            });
            this._blockYs.push(by);
        }
        this._rebuildSelectionOutline();

        if (params.isFirstChunk) {
            if (!this._atlasTexture) {
                const textureSrc = (typeof VANILLA_TEXTURE === 'object' && (VANILLA_TEXTURE as any)?.default) ?
                    (VANILLA_TEXTURE as any).default :
                    VANILLA_TEXTURE;

                this._atlasTexture = twgl.createTexture(this._gl, {
                    src: textureSrc,
                    mag: this._gl.NEAREST,
                    crossOrigin: 'anonymous',
                }, (err) => {
                    if (err) {
                        LOG_ERROR(`Atlas texture load error: ${err}`);
                    }
                    this.forceRedraw();
                });
            }

            this._atlasSize = params.atlasSize;

            this._gridBuffers.y[MeshType.BlockMesh] = this._gridBuffers.y[MeshType.VoxelMesh];

            this._modelsAvailable = 3;
            this.setModelToUse(MeshType.BlockMesh);
        }

        this.forceRedraw();
    }

    // /////////////////////////////////////////////////////////////////////////

    public setAxisToHighlight(axis: TAxis) {
        this.clearAxisToHighlight();
        this._axisHighlightBuffer[axis].enabled = true;
        this.forceRedraw();
    }

    public clearAxisToHighlight() {
        this._axisHighlightBuffer.x.enabled = false;
        this._axisHighlightBuffer.y.enabled = false;
        this._axisHighlightBuffer.z.enabled = false;
        this.forceRedraw();
    }

    private _drawDebug() {
        // Draw debug modes
        {
            //this._gl.disable(this._gl.DEPTH_TEST);

            const axes: TAxis[] = ['x', 'y', 'z'];
            axes.forEach((axis) => {
                if (this._axisHighlightBuffer[axis].enabled) {
                    this._drawBuffer(this._gl.LINES, this._axisHighlightBuffer[axis].buffer.getWebGLBuffer(), ShaderManager.Get.debugProgram, {
                        u_worldViewProjection: ArcballCamera.Get.getWorldViewProjection(),
                    });
                }
            });


            //this._gl.enable(this._gl.DEPTH_TEST);
        }

        // Draw grid
        if (this._gridEnabled) {
            if (ArcballCamera.Get.isAlignedWithAxis('x') && !ArcballCamera.Get.isAlignedWithAxis('y') && !ArcballCamera.Get.isUserRotating) {
                const gridBuffer = this._gridBuffers.x[this._meshToUse];
                if (gridBuffer !== undefined) {
                    this._drawBuffer(this._gl.LINES, gridBuffer.getWebGLBuffer(), ShaderManager.Get.debugProgram, {
                        u_worldViewProjection: ArcballCamera.Get.getWorldViewProjection(),
                    });
                }
            } else if (ArcballCamera.Get.isAlignedWithAxis('z') && !ArcballCamera.Get.isAlignedWithAxis('y') && !ArcballCamera.Get.isUserRotating) {
                const gridBuffer = this._gridBuffers.z[this._meshToUse];
                if (gridBuffer !== undefined) {
                    this._drawBuffer(this._gl.LINES, gridBuffer.getWebGLBuffer(), ShaderManager.Get.debugProgram, {
                        u_worldViewProjection: ArcballCamera.Get.getWorldViewProjection(),
                    });
                }
            } else {
                const gridBuffer = this._gridBuffers.y[this._meshToUse];
                if (gridBuffer !== undefined) {
                    this._drawBuffer(this._gl.LINES, gridBuffer.getWebGLBuffer(), ShaderManager.Get.debugProgram, {
                        u_worldViewProjection: ArcballCamera.Get.getWorldViewProjection(),
                        u_worldOffset: [0, this._sliceViewEnabled ? this._sliceHeight * this._voxelSize: 0, 0],
                    });
                }
            }
        }

        // Draw axis
        if (this._axesEnabled) {
            this._gl.disable(this._gl.DEPTH_TEST);
            this._drawBuffer(this._gl.LINES, this._axisBuffer.getWebGLBuffer(), ShaderManager.Get.debugProgram, {
                u_worldViewProjection: ArcballCamera.Get.getWorldViewProjection(),
            });
            this._gl.enable(this._gl.DEPTH_TEST);
        }

        if (this._meshToUse === MeshType.TriangleMesh && this._isGridComponentEnabled[EDebugBufferComponents.Wireframe] && this._meshWireframeBuffer && this._meshWireframeBuffer.getCount() > 0) {
            this._gl.enable(this._gl.DEPTH_TEST);
            this._gl.depthFunc(this._gl.LEQUAL);
            this._gl.depthMask(false);
            this._drawBuffer(this._gl.LINES, this._meshWireframeBuffer.getWebGLBuffer(), ShaderManager.Get.debugProgram, {
                u_worldViewProjection: ArcballCamera.Get.getWorldViewProjection(),
                u_worldOffset: [0, 0, 0],
            });
            this._gl.depthMask(true);
            this._gl.depthFunc(this._gl.LESS);
        }

        if (this._meshToUse === MeshType.TriangleMesh && this._referenceGhostEnabled && this._referenceGhostBuffer && this._referenceGhostBuffer.getCount() > 0) {
            this._gl.enable(this._gl.DEPTH_TEST);
            this._gl.depthFunc(this._gl.LEQUAL);
            this._gl.depthMask(false);
            this._drawBuffer(this._gl.LINES, this._referenceGhostBuffer.getWebGLBuffer(), ShaderManager.Get.debugProgram, {
                u_worldViewProjection: ArcballCamera.Get.getWorldViewProjection(),
                u_worldOffset: [0, 0, 0],
            });
            this._gl.depthMask(true);
            this._gl.depthFunc(this._gl.LESS);
        }

        this._drawInteractionHighlights();
    }

    private _drawMesh() {
        this._materialBuffers.forEach((materialBuffer) => {
            if (this._clayShadingEnabled) {
                this._drawMeshBuffer(materialBuffer.buffer, materialBuffer.numElements, ShaderManager.Get.solidTriProgram, {
                    u_lightWorldPos: ArcballCamera.Get.getCameraPosition(-Math.PI/4, 0.0).toArray(),
                    u_worldViewProjection: ArcballCamera.Get.getWorldViewProjection(),
                    u_worldInverseTranspose: ArcballCamera.Get.getWorldInverseTranspose(),
                    u_fillColour: [0.74, 0.72, 0.69, 1.0],
                    u_cameraDir: ArcballCamera.Get.getCameraDirection().toArray(),
                    u_fresnelExponent: AppConfig.Get.FRESNEL_EXPONENT,
                    u_fresnelMix: AppConfig.Get.FRESNEL_MIX,
                });
            } else if (materialBuffer.material.type === MaterialType.textured) {
                this._drawMeshBuffer(materialBuffer.buffer, materialBuffer.numElements, ShaderManager.Get.textureTriProgram, {
                    u_lightWorldPos: ArcballCamera.Get.getCameraPosition(-Math.PI/4, 0.0).toArray(),
                    u_worldViewProjection: ArcballCamera.Get.getWorldViewProjection(),
                    u_worldInverseTranspose: ArcballCamera.Get.getWorldInverseTranspose(),
                    u_texture: materialBuffer.material.diffuseTexture,
                    u_alpha: materialBuffer.material.alphaTexture ?? materialBuffer.material.diffuseTexture,
                    u_alphaChannel: materialBuffer.material.alphaChannel,
                    u_alphaFactor: materialBuffer.material.alphaValue,
                    u_alphaCutoff: materialBuffer.material.alphaCutoff,
                    u_tintColour: materialBuffer.material.tintColour,
                    u_cameraDir: ArcballCamera.Get.getCameraDirection().toArray(),
                    u_fresnelExponent: AppConfig.Get.FRESNEL_EXPONENT,
                    u_fresnelMix: AppConfig.Get.FRESNEL_MIX,
                });
            } else {
                this._drawMeshBuffer(materialBuffer.buffer, materialBuffer.numElements, ShaderManager.Get.solidTriProgram, {
                    u_lightWorldPos: ArcballCamera.Get.getCameraPosition(-Math.PI/4, 0.0).toArray(),
                    u_worldViewProjection: ArcballCamera.Get.getWorldViewProjection(),
                    u_worldInverseTranspose: ArcballCamera.Get.getWorldInverseTranspose(),
                    u_fillColour: materialBuffer.material.colourArray,
                    u_cameraDir: ArcballCamera.Get.getCameraDirection().toArray(),
                    u_fresnelExponent: AppConfig.Get.FRESNEL_EXPONENT,
                    u_fresnelMix: AppConfig.Get.FRESNEL_MIX,
                });
            }
        });
    }

    private _drawVoxelMesh() {
        const shader = ShaderManager.Get.voxelProgram;
        const uniforms = {
            u_worldViewProjection: ArcballCamera.Get.getWorldViewProjection(),
            u_voxelSize: this._voxelSize,
            u_gridOffset: this._gridOffset.toArray(),
            u_ambientOcclusion: this._allVoxelChunks,
        };
        this._voxelBuffer?.forEach((buffer) => {
            this._gl.useProgram(shader.program);
            twgl.setBuffersAndAttributes(this._gl, shader, buffer);
            twgl.setUniforms(shader, uniforms);
            this._gl.drawElements(this._gl.TRIANGLES, buffer.numElements, this._gl.UNSIGNED_INT, 0);
        });
    }

    private _drawBlockMesh() {
        this._gl.enable(this._gl.CULL_FACE);
        const shader = ShaderManager.Get.blockProgram;
        const selectedIds = Array.from(this._selectedBlockNames).map((name) => this._getBlockTypeId(name)).slice(0, 64);
        const selectedBlockIds = new Float32Array(64);
        selectedIds.forEach((id, index) => {
            selectedBlockIds[index] = id;
        });
        const focusEnabled = selectedIds.length > 0;

        const baseUniforms = {
            u_worldViewProjection: ArcballCamera.Get.getWorldViewProjection(),
            u_colorChart: this._colorChartEnabled,
            u_texture: this._atlasTexture,
            u_voxelSize: this._voxelSize,
            u_atlasSize: this._atlasSize,
            u_gridOffset: this._gridOffset.toArray(),
            u_nightVision: this.isNightVisionEnabled(),
            u_sliceHeight: this._sliceViewEnabled ? this._sliceHeight : Infinity,
            u_focusEnabled: focusEnabled,
            u_selectedBlockIds: selectedBlockIds,
            u_selectedCount: selectedIds.length,
        };

        const drawBlocksWithPass = (passNumber: number) => {
            const uniforms = { ...baseUniforms, u_renderPass: passNumber };
            this._blockBuffer?.forEach((buffer) => {
                this._gl.useProgram(shader.program);
                twgl.setBuffersAndAttributes(this._gl, shader, buffer);
                twgl.setUniforms(shader, uniforms);
                this._gl.drawElements(this._gl.TRIANGLES, buffer.numElements, this._gl.UNSIGNED_INT, 0);
            });
        };

        if (focusEnabled) {
            // Pass 1: Render unselected blocks transparently first. They must not
            // overwrite the selected blocks' textures in the later opaque pass.
            this._gl.depthMask(false);
            this._gl.enable(this._gl.BLEND);
            this._gl.blendFuncSeparate(this._gl.SRC_ALPHA, this._gl.ONE_MINUS_SRC_ALPHA, this._gl.ONE, this._gl.ONE_MINUS_SRC_ALPHA);
            drawBlocksWithPass(2);

            // Pass 2: Render selected blocks opaquely last so their textures remain
            // fully visible instead of being blended with unselected block textures.
            this._gl.depthFunc(this._gl.LESS);
            this._gl.depthMask(true);
            drawBlocksWithPass(1);

            // Draw the selection contour after both block passes.
            if (this._selectionOutlineCount > 0) {
                this._gl.enable(this._gl.DEPTH_TEST);
                this._gl.depthFunc(this._gl.LEQUAL);
                this._gl.depthMask(false);
                this._drawBuffer(this._gl.LINES, this._selectionOutlineBuffer.getWebGLBuffer(), ShaderManager.Get.debugProgram, {
                    u_worldViewProjection: ArcballCamera.Get.getWorldViewProjection(),
                    u_worldOffset: [0, 0, 0],
                });
            }

            this._gl.depthMask(true);
            this._gl.depthFunc(this._gl.LESS);
        } else {
            this._gl.depthMask(true);
            this._gl.depthFunc(this._gl.LESS);
            drawBlocksWithPass(0);
        }

        this._gl.disable(this._gl.CULL_FACE);
    }

    private _getBlockTypeId(name: string): number {
        return BufferGenerator.getBlockTypeId(name);
    }

    public setSelectedBlockNames(names: string[]) {
        this._selectedBlockNames = new Set(names);
        this._rebuildSelectionOutline();
        this.forceRedraw();
    }

    private _rebuildSelectionOutline() {
        const buffer = new RenderBuffer([
            { name: 'position', numComponents: 3 },
            { name: 'colour', numComponents: 4 },
        ]);
        let outlineCount = 0;

        if (this._selectedBlockNames.size > 0) {
            const selectedIds = new Set(Array.from(this._selectedBlockNames).map((name) => this._getBlockTypeId(name)));
            const white = { r: 1, g: 1, b: 1, a: 1 };

            for (let i = 0; i < this._blockSelectionData.length; ++i) {
                const block = this._blockSelectionData[i];
                if (selectedIds.has(block.id)) {
                    if (this._sliceViewEnabled && block.position[1] > this._sliceHeight) {
                        continue;
                    }
                    const centre = new Vector3(
                        (block.position[0] + this._gridOffset.x) * this._voxelSize,
                        (block.position[1] + this._gridOffset.y) * this._voxelSize,
                        (block.position[2] + this._gridOffset.z) * this._voxelSize,
                    );
                    buffer.add(DebugGeometryTemplates.cube(centre, this._voxelSize * 1.002, white));
                    ++outlineCount;
                }
            }
        }

        this._selectionOutlineBuffer = buffer;
        this._selectionOutlineCount = outlineCount;
    }

    // /////////////////////////////////////////////////////////////////////////

    private _drawMeshBuffer(register: twgl.BufferInfo, numElements: number, shaderProgram: twgl.ProgramInfo, uniforms: any) {
        this._drawBuffer(this._gl.TRIANGLES, { buffer: register, numElements: numElements }, shaderProgram, uniforms);
    }

    public setModelToUse(meshType: MeshType) {
        const isModelAvailable = this._modelsAvailable >= meshType;
        if (isModelAvailable) {
            this._meshToUse = meshType;
            InteractionManager.Get.onModelChanged();
            if (meshType !== MeshType.BlockMesh) {
                this._colorChartEnabled = false;
            }
            if (meshType !== MeshType.BlockMesh && this._selectedBlockNames.size > 0) {
                this._selectedBlockNames.clear();
                this._rebuildSelectionOutline();
                UI.Get.clearPreviewSelection();
            }
        }
        this.forceRedraw();
    }

    private _setupScene() {
        twgl.resizeCanvasToDisplaySize(<HTMLCanvasElement>this._gl.canvas);
        this._gl.viewport(0, 0, this._gl.canvas.width, this._gl.canvas.height);
        ArcballCamera.Get.setAspect(this._gl.canvas.width / this._gl.canvas.height);
        this._gl.blendFuncSeparate(this._gl.SRC_ALPHA, this._gl.ONE_MINUS_SRC_ALPHA, this._gl.ONE, this._gl.ONE_MINUS_SRC_ALPHA);

        this._gl.enable(this._gl.DEPTH_TEST);
        this._gl.enable(this._gl.BLEND);
        this._gl.clearColor(this._backgroundColour.r, this._backgroundColour.g, this._backgroundColour.b, 1.0);
        this._gl.clear(this._gl.COLOR_BUFFER_BIT | this._gl.DEPTH_BUFFER_BIT);
    }

    private _drawBuffer(drawMode: number, buffer: { numElements: number, buffer: twgl.BufferInfo }, shader: twgl.ProgramInfo, uniforms: any) {
        this._gl.useProgram(shader.program);
        twgl.setBuffersAndAttributes(this._gl, shader, buffer.buffer);
        twgl.setUniforms(shader, uniforms);
        this._gl.drawElements(drawMode, buffer.numElements, this._gl.UNSIGNED_INT, 0);
    }

    public toggleColorChart() {
        if (this._modelsAvailable < MeshType.BlockMesh) {
            this._colorChartEnabled = false;
            return;
        }
        if (this._meshToUse !== MeshType.BlockMesh) {
            this._meshToUse = MeshType.BlockMesh;
        }
        this._colorChartEnabled = !this._colorChartEnabled;
        this.forceRedraw();
    }

    public isColorChartEnabled() {
        return this._colorChartEnabled && this._meshToUse === MeshType.BlockMesh;
    }

    public getModelsAvailable() {
        return this._modelsAvailable;
    }

    public getActiveMeshType() {
        return this._meshToUse;
    }

    public getGridOffset(): Vector3 {
        return this._gridOffset;
    }

    public getVoxelSize(): number {
        return this._voxelSize;
    }

    public getBlockSelectionData(): Array<{ position: [number, number, number], id: number }> {
        return this._blockSelectionData;
    }

    public getVoxelData(): Array<{ position: [number, number, number] }> {
        return this._voxelData;
    }

    public getMeshBuffersData(): Array<{
        positions: Float32Array;
        indices: Uint32Array;
        texcoords: Float32Array;
        materialName: string;
    }> {
        return this._meshBuffersData;
    }

    public getSliceHeight(): number {
        return this._sliceHeight;
    }

    public getSliceLayerStats(): SliceLayerStats {
        return computeSliceLayerStats(
            this._blockYs,
            this._blockBounds.min.y,
            this._blockBounds.max.y,
            this._sliceHeight,
        );
    }

    public getSliceLayerBlockSummary(colourLookup?: ReadonlyMap<string, string>): SliceLayerBlockSummary {
        const clampedY = Math.max(
            this._blockBounds.min.y,
            Math.min(this._blockBounds.max.y, Math.round(this._sliceHeight)),
        );
        const blocks: Array<{ y: number; name: string }> = [];
        for (let i = 0; i < this._blockSelectionData.length; ++i) {
            const item = this._blockSelectionData[i];
            const name = BufferGenerator.getBlockNameById(item.id);
            if (name) {
                blocks.push({ y: item.position[1], name });
            }
        }
        return computeSliceLayerBlockSummary(blocks, clampedY, colourLookup);
    }

    public setSliceState(enabled: boolean, height: number) {
        if (this._modelsAvailable < MeshType.BlockMesh) {
            return;
        }
        this._sliceViewEnabled = enabled;
        this._sliceHeight = Math.max(this._blockBounds.min.y, Math.min(this._blockBounds.max.y, height));
        this._rebuildSelectionOutline();
        this.forceRedraw();
    }

    private _drawInteractionHighlights() {
        const interaction = InteractionManager.Get;
        if (!interaction.isEnabled()) return;
        const activeType = this._meshToUse;
        if (activeType === MeshType.None) return;

        const hovered = interaction.hoveredTarget;
        const selected = interaction.selectedTarget;

        if (!hovered && !selected) return;

        const grey: RGBA = { r: 0.65, g: 0.65, b: 0.65, a: 1.0 };
        const white: RGBA = { r: 1.0, g: 1.0, b: 1.0, a: 1.0 };

        const buffer = new RenderBuffer([
            { name: 'position', numComponents: 3 },
            { name: 'colour', numComponents: 4 },
        ]);

        const camDist = ArcballCamera.Get.getDistance();
        const dotRadius = Math.max(0.0005, camDist * 0.00375);

        // 1. Draw hovered if present and different from selected
        if (hovered && (!selected || !interaction.targetsEqual(hovered, selected))) {
            if (activeType === MeshType.TriangleMesh && hovered.type === 'mesh') {
                buffer.add(DebugGeometryTemplates.dot(hovered.position, dotRadius, grey, hovered.normal));
            } else if (activeType === MeshType.VoxelMesh && hovered.type === 'voxel') {
                buffer.add(DebugGeometryTemplates.cube(hovered.center, this._voxelSize * 1.002, grey));
            } else if (activeType === MeshType.BlockMesh && hovered.type === 'block') {
                buffer.add(DebugGeometryTemplates.cube(hovered.center, this._voxelSize * 1.002, grey));
            }
        }

        // 2. Draw selected if present
        if (selected) {
            if (activeType === MeshType.TriangleMesh && selected.type === 'mesh') {
                buffer.add(DebugGeometryTemplates.dot(selected.position, dotRadius * 1.25, white, selected.normal));
            } else if (activeType === MeshType.VoxelMesh && selected.type === 'voxel') {
                buffer.add(DebugGeometryTemplates.cube(selected.center, this._voxelSize * 1.002, white));
                buffer.add(DebugGeometryTemplates.cube(selected.center, this._voxelSize * 1.004, white));
            } else if (activeType === MeshType.BlockMesh && selected.type === 'block') {
                buffer.add(DebugGeometryTemplates.cube(selected.center, this._voxelSize * 1.002, white));
                buffer.add(DebugGeometryTemplates.cube(selected.center, this._voxelSize * 1.004, white));
            }
        }

        if (buffer.getCount() > 0) {
            this._gl.enable(this._gl.DEPTH_TEST);
            this._gl.depthFunc(this._gl.LEQUAL);
            this._gl.depthMask(false);
            this._drawBuffer(this._gl.LINES, buffer.getWebGLBuffer(), ShaderManager.Get.debugProgram, {
                u_worldViewProjection: ArcballCamera.Get.getWorldViewProjection(),
                u_worldOffset: [0, 0, 0],
            });
            this._gl.depthMask(true);
            this._gl.depthFunc(this._gl.LESS);
        }
    }
}
