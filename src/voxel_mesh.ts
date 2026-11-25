import { EFaceVisibility } from './block_assigner';
import { Bounds } from './bounds';
import { ChunkedBufferGenerator, TVoxelMeshBufferDescription } from './buffer';
import { RGBA, RGBAUtil } from './colour';
import { OcclusionManager } from './occlusion';
import { TOptional } from './util';
import { ASSERT } from './util/error_util';
import { LOGF } from './util/log_util';
import { Vector3 } from './vector';
import { computeCleanVoxelIndices } from './voxel_cleanup';
import { computeHollowShellIndices } from './voxel_hollow';
import { DominantColourCluster, mergeDominantColourSample } from './voxel_overlap';
import {
    applyVoxelMorphology,
    computeBasePlinthVoxels,
    computeMirroredVoxels,
    TMorphMode,
    TVoxelMirrorAxis,
    VoxelColourRecord,
} from './voxel_postprocess';
import { RenderNextVoxelMeshChunkParams, VoxeliseParams } from './worker_types';

export { DominantColourCluster, mergeDominantColourSample };

export interface Voxel {
    position: Vector3,
    colour: RGBA,
    collisions: number,
    neighbours: number,
    /** CIE L* lightness normalized to [0, 1], retained for dichrome assignment. */
    dichromeValue: number,
}

export type TVoxelOverlapRule = 'first' | 'average' | 'dominant';

export type TVoxelMeshParams = Pick<VoxeliseParams.Input, 'voxelOverlapRule' | 'enableAmbientOcclusion'>;

export class VoxelMesh {
    private _voxels: Map<number, Voxel>;
    private _linearAccumulators: Map<number, DominantColourCluster>;
    private _dominantClusters: Map<number, DominantColourCluster[]>;
    private _bounds: Bounds;
    private _voxelMeshParams: TVoxelMeshParams;

    public constructor(voxelMeshParams: TVoxelMeshParams) {
        this._voxels = new Map();
        this._linearAccumulators = new Map();
        this._dominantClusters = new Map();
        this._bounds = Bounds.getInfiniteBounds();
        this._voxelMeshParams = voxelMeshParams;
        this._recreateBuffer = true;
    }

    public getVoxels(): Voxel[] {
        return Array.from(this._voxels.values());
    }

    public isVoxelAt(pos: Vector3): boolean {
        return this._voxels.has(pos.hash());
    }

    public isOpaqueVoxelAt(pos: Vector3): boolean {
        const voxel = this.getVoxelAt(pos);
        if (voxel) {
            return voxel.colour.a == 1.0;
        }
        return false;
    }

    public getVoxelAt(pos: Vector3): TOptional<Voxel> {
        return this._voxels.get(pos.hash());
    }

    public static getFullFaceVisibility(): EFaceVisibility {
        return EFaceVisibility.Up | EFaceVisibility.Down | EFaceVisibility.North | EFaceVisibility.West | EFaceVisibility.East | EFaceVisibility.South;
    }

    public getFaceVisibility(pos: Vector3) {
        let visibility: EFaceVisibility = 0;
        if (!this.isOpaqueVoxelAt(Vector3.add(pos, new Vector3(0, 1, 0)))) {
            visibility += EFaceVisibility.Up;
        }
        if (!this.isOpaqueVoxelAt(Vector3.add(pos, new Vector3(0, -1, 0)))) {
            visibility += EFaceVisibility.Down;
        }
        if (!this.isOpaqueVoxelAt(Vector3.add(pos, new Vector3(1, 0, 0)))) {
            visibility += EFaceVisibility.North;
        }
        if (!this.isOpaqueVoxelAt(Vector3.add(pos, new Vector3(-1, 0, 0)))) {
            visibility += EFaceVisibility.South;
        }
        if (!this.isOpaqueVoxelAt(Vector3.add(pos, new Vector3(0, 0, 1)))) {
            visibility += EFaceVisibility.East;
        }
        if (!this.isOpaqueVoxelAt(Vector3.add(pos, new Vector3(0, 0, -1)))) {
            visibility += EFaceVisibility.West;
        }
        return visibility;
    }

    public addVoxel(inPos: Vector3, colour: RGBA) {
        if (colour.a === 0) {
            return;
        }

        const pos = inPos.copy().round();
        const hash = pos.hash();
        const voxel = this._voxels.get(hash);

        if (voxel !== undefined) {
            if (this._voxelMeshParams.voxelOverlapRule === 'average') {
                let accum = this._linearAccumulators.get(hash);
                if (!accum) {
                    accum = {
                        lr: RGBAUtil.srgbToLinear(voxel.colour.r),
                        lg: RGBAUtil.srgbToLinear(voxel.colour.g),
                        lb: RGBAUtil.srgbToLinear(voxel.colour.b),
                        alphaSum: voxel.colour.a,
                        count: 1,
                    };
                    this._linearAccumulators.set(hash, accum);
                }
                accum.lr += RGBAUtil.srgbToLinear(colour.r);
                accum.lg += RGBAUtil.srgbToLinear(colour.g);
                accum.lb += RGBAUtil.srgbToLinear(colour.b);
                accum.alphaSum += colour.a;
                accum.count += 1;

                voxel.colour.r = RGBAUtil.linearToSrgb(accum.lr / accum.count);
                voxel.colour.g = RGBAUtil.linearToSrgb(accum.lg / accum.count);
                voxel.colour.b = RGBAUtil.linearToSrgb(accum.lb / accum.count);
                voxel.colour.a = accum.alphaSum / accum.count;
                ++voxel.collisions;
                voxel.dichromeValue = VoxelMesh._getDichromeValue(voxel.colour);
            } else if (this._voxelMeshParams.voxelOverlapRule === 'dominant') {
                let clusters = this._dominantClusters.get(hash);
                if (!clusters) {
                    clusters = [{
                        lr: RGBAUtil.srgbToLinear(voxel.colour.r),
                        lg: RGBAUtil.srgbToLinear(voxel.colour.g),
                        lb: RGBAUtil.srgbToLinear(voxel.colour.b),
                        alphaSum: voxel.colour.a,
                        count: 1,
                    }];
                    this._dominantClusters.set(hash, clusters);
                }
                voxel.colour = mergeDominantColourSample(clusters, colour);
                ++voxel.collisions;
                voxel.dichromeValue = VoxelMesh._getDichromeValue(voxel.colour);
            }
        } else {
            this._voxels.set(hash, {
                position: pos,
                colour: colour,
                collisions: 1,
                neighbours: 0,
                dichromeValue: VoxelMesh._getDichromeValue(colour),
            });
            this._bounds.extendByPoint(pos);
        }
    }

    /** Convert a sampled voxel colour into a perceptual black-to-white tone. */
    private static _getDichromeValue(colour: RGBA): number {
        const lightness = RGBAUtil.toLab(colour)[0] / 100.0;
        return Math.max(0.0, Math.min(1.0, lightness));
    }

    public getBounds() {
        return this._bounds;
    }

    public getVoxelCount(): number {
        return this._voxels.size;
    }

    /**
     * Removes strictly interior voxels while retaining a watertight exterior shell
     * of the specified wall thickness (1..4 blocks).
     */
    public hollow(wallThickness: number = 1): { removedCount: number; keptCount: number } {
        const voxels = this.getVoxels();
        if (voxels.length === 0) {
            return { removedCount: 0, keptCount: 0 };
        }

        const positions = voxels.map((v) => ({
            x: v.position.x,
            y: v.position.y,
            z: v.position.z,
        }));
        const { keptIndices, removedIndices } = computeHollowShellIndices(positions, wallThickness);
        if (removedIndices.length === 0) {
            return { removedCount: 0, keptCount: voxels.length };
        }

        const nextVoxels = new Map<number, Voxel>();
        const nextBounds = Bounds.getInfiniteBounds();
        for (const idx of keptIndices) {
            const voxel = voxels[idx];
            nextVoxels.set(voxel.position.hash(), voxel);
            nextBounds.extendByPoint(voxel.position);
        }

        this._voxels = nextVoxels;
        this._linearAccumulators.clear();
        this._dominantClusters.clear();
        this._bounds = nextBounds;
        this._recreateBuffer = true;
        this._bufferChunks = [];

        return {
            removedCount: removedIndices.length,
            keptCount: keptIndices.length,
        };
    }

    /**
     * Removes small detached floating voxel islands using 26-connected component analysis,
     * preserving the largest component and any component meeting `minIslandSize`.
     */
    public removeFloatingIslands(
        minIslandSize: number = 4,
    ): { removedCount: number; keptCount: number; removedComponents: number } {
        const voxels = this.getVoxels();
        if (voxels.length === 0) {
            return { removedCount: 0, keptCount: 0, removedComponents: 0 };
        }

        const positions = voxels.map((v) => ({
            x: v.position.x,
            y: v.position.y,
            z: v.position.z,
        }));
        const { keptIndices, removedIndices, removedComponents } = computeCleanVoxelIndices(positions, minIslandSize);
        if (removedIndices.length === 0) {
            return { removedCount: 0, keptCount: voxels.length, removedComponents: 0 };
        }

        const nextVoxels = new Map<number, Voxel>();
        const nextBounds = Bounds.getInfiniteBounds();
        for (const idx of keptIndices) {
            const voxel = voxels[idx];
            nextVoxels.set(voxel.position.hash(), voxel);
            nextBounds.extendByPoint(voxel.position);
        }

        this._voxels = nextVoxels;
        this._linearAccumulators.clear();
        this._dominantClusters.clear();
        this._bounds = nextBounds;
        this._recreateBuffer = true;
        this._bufferChunks = [];

        return {
            removedCount: removedIndices.length,
            keptCount: keptIndices.length,
            removedComponents,
        };
    }

    private _exportRecords(): VoxelColourRecord[] {
        return this.getVoxels().map((v) => ({
            x: v.position.x,
            y: v.position.y,
            z: v.position.z,
            colour: v.colour,
        }));
    }

    private _replaceFromRecords(records: readonly VoxelColourRecord[]) {
        const nextVoxels = new Map<number, Voxel>();
        const nextBounds = Bounds.getInfiniteBounds();
        for (let i = 0; i < records.length; ++i) {
            const rec = records[i];
            const pos = new Vector3(rec.x, rec.y, rec.z).round();
            nextVoxels.set(pos.hash(), {
                position: pos,
                colour: rec.colour,
                collisions: 1,
                neighbours: 0,
                dichromeValue: VoxelMesh._getDichromeValue(rec.colour),
            });
            nextBounds.extendByPoint(pos);
        }
        this._voxels = nextVoxels;
        this._linearAccumulators.clear();
        this._dominantClusters.clear();
        this._bounds = nextBounds;
        this._recreateBuffer = true;
        this._bufferChunks = [];
    }

    /**
     * Applies morphological filtering (close gaps, despeckle/smooth, bevel, fill-cavities, dilate, erode) to the voxel grid.
     */
    public applyMorphology(mode: TMorphMode, passes = 1): { addedCount: number; removedCount: number; totalCount: number } {
        if (mode === 'none' || this._voxels.size === 0) {
            return { addedCount: 0, removedCount: 0, totalCount: this._voxels.size };
        }
        const res = applyVoxelMorphology(this._exportRecords(), mode, passes);
        if (res.addedCount > 0 || res.removedCount > 0) {
            this._replaceFromRecords(res.voxels);
        }
        return {
            addedCount: res.addedCount,
            removedCount: res.removedCount,
            totalCount: this._voxels.size,
        };
    }

    /**
     * Mirrors occupied voxels across the bounding-box center along X, Z, or both axes.
     */
    public mirrorVoxels(axis: TVoxelMirrorAxis): { addedCount: number; totalCount: number } {
        if (axis === 'none' || this._voxels.size === 0) {
            return { addedCount: 0, totalCount: this._voxels.size };
        }
        const res = computeMirroredVoxels(this._exportRecords(), axis);
        if (res.addedCount > 0) {
            this._replaceFromRecords(res.voxels);
        }
        return {
            addedCount: res.addedCount,
            totalCount: this._voxels.size,
        };
    }

    /**
     * Extrudes a flat base plinth beneath the lowest occupied layer (`minY`).
     */
    public addBasePlinth(thickness: number = 1): { addedCount: number; totalCount: number } {
        if (this._voxels.size === 0) {
            return { addedCount: 0, totalCount: 0 };
        }
        const res = computeBasePlinthVoxels(this._exportRecords(), thickness);
        if (res.addedCount > 0) {
            this._replaceFromRecords(res.voxels);
        }
        return {
            addedCount: res.addedCount,
            totalCount: this._voxels.size,
        };
    }

    private static _Neighbours = [
        new Vector3(1, 1, -1),
        new Vector3(0, 1, -1),
        new Vector3(-1, 1, -1),
        new Vector3(1, 0, -1),
        new Vector3(-1, 0, -1),
        new Vector3(1, -1, -1),
        new Vector3(0, -1, -1),
        new Vector3(-1, -1, -1),
        new Vector3(1, 1, 0),
        new Vector3(-1, 1, 0),
        new Vector3(1, -1, 0),
        new Vector3(-1, -1, 0),
        new Vector3(1, 1, 1),
        new Vector3(0, 1, 1),
        new Vector3(-1, 1, 1),
        new Vector3(1, 0, 1),
        new Vector3(-1, 0, 1),
        new Vector3(1, -1, 1),
        new Vector3(0, -1, 1),
        new Vector3(-1, -1, 1),
    ].map((neighbourOffset) => {
        const inverseOffset = neighbourOffset.copy().negate();

        return {
            offset: neighbourOffset,
            index: OcclusionManager.getNeighbourIndex(neighbourOffset),
            inverseIndex: OcclusionManager.getNeighbourIndex(inverseOffset),
        };
    });

    /**
     * Goes through each voxel and calculates what voxel neighbours it has.
     * This is used for ambient occlusion.
     * @note This does NOT check all 27 neighbours, i.e. it does not check voxels
     * directly up, down, north, south, east, west as they're not needed.
     */
    public calculateNeighbours() {
        if (!this._voxelMeshParams.enableAmbientOcclusion) {
            return;
        }

        const pos = new Vector3(0, 0, 0);

        this._voxels.forEach((voxel) => {
            voxel.neighbours = 0;

            VoxelMesh._Neighbours.forEach((neighbour) => {
                pos.setFrom(voxel.position);
                pos.add(neighbour.offset);

                if (this.isVoxelAt(pos)) {
                    voxel.neighbours |= (1 << neighbour.index);
                }
            });
        });
    }

    public getNeighbours(pos: Vector3) {
        return this._voxels.get(pos.hash())?.neighbours ?? 0;
    }

    /*
     * Returns true if a voxel at position 'pos' has a neighbour with offset 'offset'
     * Offset must be a vector that exists within this._neighbours defined above
     */
    public hasNeighbour(pos: Vector3, offset: Vector3): boolean {
        return (this.getNeighbours(pos) & (1 << OcclusionManager.getNeighbourIndex(offset))) > 0;
    }

    private _renderParams?: RenderNextVoxelMeshChunkParams.Input;
    private _recreateBuffer: boolean;
    public setRenderParams(params: RenderNextVoxelMeshChunkParams.Input) {
        this._renderParams = params;
        this._recreateBuffer = true;
        this._bufferChunks = [];
    }

    /*
    private _buffer?: TVoxelMeshBufferDescription;
    public getBuffer(): TVoxelMeshBufferDescription {
        ASSERT(this._renderParams, 'Called VoxelMesh.getBuffer() without setting render params');
        if (this._buffer === undefined || this._recreateBuffer) {
            this._buffer = BufferGenerator.fromVoxelMesh(this, this._renderParams);
            this._recreateBuffer = false;
        }
        return this._buffer;
    }
    */

    private _bufferChunks: Array<TVoxelMeshBufferDescription & { moreVoxelsToBuffer: boolean, progress: number }> = [];
    public getChunkedBuffer(chunkIndex: number): TVoxelMeshBufferDescription & { moreVoxelsToBuffer: boolean, progress: number } {
        ASSERT(this._renderParams, 'Called VoxelMesh.getChunkedBuffer() without setting render params');
        if (this._bufferChunks[chunkIndex] === undefined) {
            LOGF(`[VoxelMesh]: getChunkedBuffer: ci: ${chunkIndex} not cached`);
            this._bufferChunks[chunkIndex] = ChunkedBufferGenerator.fromVoxelMesh(this, this._renderParams, chunkIndex);
        } else {
            LOGF(`[VoxelMesh]: getChunkedBuffer: ci: ${chunkIndex} cached`);
        }
        return this._bufferChunks[chunkIndex];
    }
}
