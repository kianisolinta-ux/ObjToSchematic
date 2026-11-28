import path from 'path';

import { Atlas } from './atlas';
import { BlockMesh } from './block_mesh';
import { BufferGenerator } from './buffer';
import { EAppEvent, EventManager } from './event';
import { IExporter } from './exporters/base_exporter';
import { ExporterFactory } from './exporters/exporters';
import { exportMeshToGlb } from './exporters/glb_exporter';
import { ImporterFactor } from './importers/importers';
import { LOC, Localiser } from './localiser';
import { Mesh } from './mesh';
import { ProgressManager, TTaskHandle } from './progress';
import { StatusHandler } from './status';
import { AppError, ASSERT } from './util/error_util';
import { Vector3 } from './vector';
import { VoxelMesh } from './voxel_mesh';
import { parseVoxelModelJson, serializeVoxelModel } from './voxel_model_io';
import { IVoxeliser } from './voxelisers/base-voxeliser';
import { VoxeliserFactory } from './voxelisers/voxelisers';
import {
    AssignParams,
    ExportGlbParams,
    ExportParams,
    ImportParams,
    InitParams,
    LoadVoxelModelParams,
    PreviewParams,
    RenderMeshParams,
    RenderNextBlockMeshChunkParams,
    RenderNextVoxelMeshChunkParams,
    ReplaceBlockParams,
    SaveVoxelModelParams,
    SetMaterialsParams,
    SettingsParams,
    TFromWorkerMessage,
    VoxeliseParams,
    VoxelPostParams,
} from './worker_types';

export class WorkerClient {
    private static _instance: WorkerClient;
    public static get Get() {
        return this._instance || (this._instance = new this());
    }

    private constructor() {
    }

    private _loadedMesh?: Mesh;
    private _baseVoxelMesh?: VoxelMesh;
    private _loadedVoxelMesh?: VoxelMesh;
    private _loadedBlockMesh?: BlockMesh;

    /**
     * This function should only be called if the client is using the worker.
     */
    public async init(params: InitParams.Input): Promise<InitParams.Output> {
        EventManager.Get.add(EAppEvent.onTaskStart, (e: any) => {
            const message: TFromWorkerMessage = {
                action: 'Progress',
                payload: {
                    type: 'Started',
                    taskId: e[0],
                },
            };
            postMessage(message);
        });

        EventManager.Get.add(EAppEvent.onTaskProgress, (e: any) => {
            const message: TFromWorkerMessage = {
                action: 'Progress',
                payload: {
                    type: 'Progress',
                    taskId: e[0],
                    percentage: e[1],
                },
            };
            postMessage(message);
        });

        EventManager.Get.add(EAppEvent.onTaskEnd, (e: any) => {
            const message: TFromWorkerMessage = {
                action: 'Progress',
                payload: {
                    type: 'Finished',
                    taskId: e[0],
                },
            };
            postMessage(message);
        });

        await Localiser.Get.init();

        return {};
    }

    public async settings(params: SettingsParams.Input): Promise<SettingsParams.Output> {
        await Localiser.Get.changeLanguage(params.language);

        return {};
    }

    public async import(params: ImportParams.Input): Promise<ImportParams.Output> {
        const parsed = path.parse(params.file.name);

        const importer = ImporterFactor.GetImporter(parsed.ext === '.obj' ? 'obj' : 'gltf');
        this._loadedMesh = await importer.import(params.file);
        this._baseVoxelMesh = undefined;
        this._loadedVoxelMesh = undefined;
        this._loadedBlockMesh = undefined;

        this._loadedMesh.processMesh(params.rotation.y, params.rotation.x, params.rotation.z);

        return {
            triangleCount: this._loadedMesh.getTriangleCount(),
            dimensions: this._loadedMesh.getBounds().getDimensions(),
            materials: this._loadedMesh.getMaterials(),
        };
    }

    public setMaterials(params: SetMaterialsParams.Input): SetMaterialsParams.Output {
        ASSERT(this._loadedMesh !== undefined);

        this._loadedMesh.setMaterials(params.materials);

        return {
            materials: this._loadedMesh.getMaterials(),
            materialsChanged: Array.from(params.materials.keys()), // TODO: Change to actual materials changed
        };
    }

    public renderMesh(params: RenderMeshParams.Input): RenderMeshParams.Output {
        ASSERT(this._loadedMesh !== undefined);

        return {
            buffers: BufferGenerator.fromMesh(this._loadedMesh),
            dimensions: this._loadedMesh.getBounds().getDimensions(),
        };
    }


    public exportGlb(params: ExportGlbParams.Input): ExportGlbParams.Output {
        ASSERT(this._loadedMesh !== undefined);
        const groundAndCenter = params.preserveCurrentGeometry ?
            false :
            (params.groundAndCenter ?? true);
        return exportMeshToGlb(this._loadedMesh, {
            modelName: params.modelName,
            groundAndCenter,
            forceRecomputeNormals: params.forceRecomputeNormals ?? false,
            removeSmallIslands: params.removeSmallIslands ?? false,
            minIslandTriangles: params.minIslandTriangles ?? 16,
        });
    }

    public voxelise(params: VoxeliseParams.Input): VoxeliseParams.Output {
        ASSERT(this._loadedMesh !== undefined);

        const voxeliser: IVoxeliser = VoxeliserFactory.GetVoxeliser(params.voxeliser);
        this._loadedVoxelMesh = voxeliser.voxelise(this._loadedMesh, params);
        this._loadedBlockMesh = undefined;

        let modified = false;

        if (params.morphMode && params.morphMode !== 'none') {
            const { addedCount, removedCount, totalCount } = this._loadedVoxelMesh.applyMorphology(
                params.morphMode,
                params.morphPasses ?? 1,
            );
            if (addedCount > 0 || removedCount > 0) {
                modified = true;
            }
            StatusHandler.info(LOC('voxelise.morph_applied', {
                added: addedCount,
                removed: removedCount,
                total: totalCount,
            }));
        }

        if (params.voxelMirror && params.voxelMirror !== 'none') {
            const { addedCount, totalCount } = this._loadedVoxelMesh.mirrorVoxels(params.voxelMirror);
            if (addedCount > 0) {
                modified = true;
            }
            StatusHandler.info(LOC('voxelise.mirror_applied', {
                added: addedCount,
                total: totalCount,
            }));
        }

        if (params.removeFloatingIslands) {
            const { removedCount, keptCount, removedComponents } = this._loadedVoxelMesh.removeFloatingIslands(params.minIslandSize ?? 4);
            if (removedCount > 0) {
                modified = true;
            }
            StatusHandler.info(LOC('voxelise.islands_removed', {
                removed: removedCount,
                islands: removedComponents,
                kept: keptCount,
            }));
        }

        if (params.hollow) {
            const { removedCount, keptCount } = this._loadedVoxelMesh.hollow(params.wallThickness ?? 1);
            if (removedCount > 0) {
                modified = true;
            }
            StatusHandler.info(LOC('voxelise.hollow_removed', {
                removed: removedCount,
                kept: keptCount,
            }));
        }

        if (params.addBasePlinth) {
            const { addedCount, totalCount } = this._loadedVoxelMesh.addBasePlinth(params.plinthThickness ?? 1);
            if (addedCount > 0) {
                modified = true;
            }
            StatusHandler.info(LOC('voxelise.plinth_added', {
                added: addedCount,
                total: totalCount,
            }));
        }

        if (modified) {
            StatusHandler.info(LOC('voxelise.final_voxel_count', { count: this._loadedVoxelMesh.getVoxelCount() }));
        }

        this._loadedVoxelMesh.calculateNeighbours();
        this._baseVoxelMesh = this._loadedVoxelMesh.clone();

        this._voxelMeshChunkIndex = 0;

        return {
        };
    }

    public saveVoxelModel(params: SaveVoxelModelParams.Input): SaveVoxelModelParams.Output {
        ASSERT(this._loadedVoxelMesh !== undefined, 'No voxel mesh available to save');

        const voxels = this._loadedVoxelMesh.getVoxels();
        const content = serializeVoxelModel(voxels, {
            modelName: params.modelName,
            constraintAxis: params.constraintAxis,
            size: params.size,
            enableAmbientOcclusion: params.enableAmbientOcclusion,
            voxelOverlapRule: params.voxelOverlapRule,
        });

        return {
            content,
            voxelCount: voxels.length,
            dimensions: this._loadedVoxelMesh.getBounds().getDimensions(),
        };
    }

    public loadVoxelModel(params: LoadVoxelModelParams.Input): LoadVoxelModelParams.Output {
        let parsed;
        try {
            parsed = parseVoxelModelJson(params.jsonText);
        } catch {
            throw new AppError(LOC('voxelise.invalid_voxel_file'));
        }

        const enableAO = params.enableAmbientOcclusion ?? parsed.meta.enableAmbientOcclusion ?? true;
        const nextVoxelMesh = new VoxelMesh({
            voxelOverlapRule: parsed.meta.voxelOverlapRule ?? 'average',
            enableAmbientOcclusion: enableAO,
        });
        nextVoxelMesh.loadSavedVoxels(parsed.voxels);
        nextVoxelMesh.calculateNeighbours();

        this._loadedVoxelMesh = nextVoxelMesh;
        this._baseVoxelMesh = nextVoxelMesh.clone();
        this._loadedBlockMesh = undefined;
        this._voxelMeshChunkIndex = 0;

        const dims = new Vector3(parsed.dimensions.x, parsed.dimensions.y, parsed.dimensions.z);
        StatusHandler.info(LOC('voxelise.voxel_count', { count: parsed.voxels.length }));
        StatusHandler.info(LOC('voxelise.voxel_mesh_dimensions', { x: dims.x, y: dims.y, z: dims.z }));

        return {
            voxelCount: parsed.voxels.length,
            dimensions: dims,
            desiredHeight: parsed.desiredHeight,
            meta: parsed.meta,
        };
    }

    public voxelPost(params: VoxelPostParams.Input): VoxelPostParams.Output {
        ASSERT(this._baseVoxelMesh !== undefined, 'No voxel mesh available for post-adjustment');

        const nextVoxelMesh = this._baseVoxelMesh.clone();
        const { voxelCount, boundsDimensions } = nextVoxelMesh.rotate(
            {
                x: params.rotation.x,
                y: params.rotation.y,
                z: params.rotation.z,
            },
            {
                algorithm: params.algorithm,
                closeHoles: params.closeHoles,
            },
        );

        this._loadedVoxelMesh = nextVoxelMesh;
        this._loadedBlockMesh = undefined;
        this._voxelMeshChunkIndex = 0;

        const blockDimensions = voxelCount > 0 ?
            new Vector3(
                Math.max(1, Math.round(boundsDimensions.x) + 1),
                Math.max(1, Math.round(boundsDimensions.y) + 1),
                Math.max(1, Math.round(boundsDimensions.z) + 1),
            ) :
            new Vector3(0, 0, 0);

        StatusHandler.info(LOC('voxelise.voxel_count', { count: voxelCount }));
        StatusHandler.info(LOC('voxelise.voxel_mesh_dimensions', {
            x: blockDimensions.x,
            y: blockDimensions.y,
            z: blockDimensions.z,
        }));

        return {
            voxelCount,
            dimensions: blockDimensions,
        };
    }

    private _voxelMeshChunkIndex = 0;
    private _voxelMeshProgressHandle?: TTaskHandle;
    public renderChunkedVoxelMesh(params: RenderNextVoxelMeshChunkParams.Input): RenderNextVoxelMeshChunkParams.Output {
        ASSERT(this._loadedVoxelMesh !== undefined);

        const isFirstChunk = this._voxelMeshChunkIndex === 0;
        if (isFirstChunk) {
            this._voxelMeshProgressHandle = ProgressManager.Get.start('VoxelMeshBuffer');
            this._loadedVoxelMesh.setRenderParams(params);
        }

        const buffer = this._loadedVoxelMesh.getChunkedBuffer(this._voxelMeshChunkIndex);
        ++this._voxelMeshChunkIndex;

        if (this._voxelMeshProgressHandle !== undefined) {
            if (buffer.moreVoxelsToBuffer) {
                ProgressManager.Get.progress(this._voxelMeshProgressHandle, buffer.progress);
            } else {
                ProgressManager.Get.end(this._voxelMeshProgressHandle);
                this._voxelMeshProgressHandle = undefined;
            }
        }

        return {
            buffer: buffer,
            dimensions: this._loadedVoxelMesh.getBounds().getDimensions(),
            voxelSize: 1.0 / params.desiredHeight,
            moreVoxelsToBuffer: buffer.moreVoxelsToBuffer,
            isFirstChunk: isFirstChunk,
        };
    }

    public assign(params: AssignParams.Input): AssignParams.Output {
        ASSERT(this._loadedVoxelMesh !== undefined);

        this._loadedBlockMesh = BlockMesh.createFromVoxelMesh(this._loadedVoxelMesh, params);

        this._blockMeshChunkIndex = 0;

        return {
        };
    }

    private _blockMeshChunkIndex = 0;
    //private _blockMeshProgressHandle?: TTaskHandle;
    public renderChunkedBlockMesh(params: RenderNextBlockMeshChunkParams.Input): RenderNextBlockMeshChunkParams.Output {
        ASSERT(this._loadedBlockMesh !== undefined);

        const isFirstChunk = this._blockMeshChunkIndex === 0;
        if (isFirstChunk) {
            //this._blockMeshProgressHandle = ProgressManager.Get.start('BlockMeshBuffer');
        }

        const buffer = this._loadedBlockMesh.getChunkedBuffer(this._blockMeshChunkIndex);
        ++this._blockMeshChunkIndex;

        /*
        if (this._blockMeshProgressHandle !== undefined) {
            if (buffer.moreBlocksToBuffer) {
                ProgressManager.Get.progress(this._blockMeshProgressHandle, buffer.progress);
            } else {
                ProgressManager.Get.end(this._blockMeshProgressHandle);
                this._blockMeshProgressHandle = undefined;
            }
        }
        */

        const atlas = Atlas.load(params.textureAtlas);
        ASSERT(atlas !== undefined);

        return {
            buffer: buffer,
            bounds: this._loadedBlockMesh.getBounds(),
            atlasTexturePath: atlas.getAtlasTexturePath(),
            atlasSize: atlas.getAtlasSize(),
            moreBlocksToBuffer: buffer.moreBlocksToBuffer,
            isFirstChunk: isFirstChunk,
        };
    }

    /*
    public renderBlockMesh(params: RenderBlockMeshParams.Input): RenderBlockMeshParams.Output {
        ASSERT(this._loadedBlockMesh !== undefined);

        const atlas = Atlas.load(params.textureAtlas);
        ASSERT(atlas !== undefined);

        return {
            buffer: this._loadedBlockMesh.getBuffer(),
            dimensions: this._loadedBlockMesh.getVoxelMesh().getBounds().getDimensions(),
            atlasTexturePath: atlas.getAtlasTexturePath(),
            atlasSize: atlas.getAtlasSize(),
        };
    }
    */

    public replaceBlock(params: ReplaceBlockParams.Input): ReplaceBlockParams.Output {
        ASSERT(this._loadedBlockMesh !== undefined, 'No block mesh assigned yet');
        const res = params.mode === 'undo' ?
            this._loadedBlockMesh.undoLastReplace() :
            this._loadedBlockMesh.replaceBlockType(params.sourceBlock, params.targetBlock, {
                sourceBlocks: params.sourceBlocks,
                scope: params.scope,
                sliceY: params.sliceY,
                mode: params.mode === 'auto-palette' ? 'auto-palette' : 'swap',
                activePalette: params.activePalette,
            });
        if (res.replacedCount > 0) {
            this._blockMeshChunkIndex = 0;
        }
        return res;
    }

    public preview(params: PreviewParams.Input): PreviewParams.Output {
        ASSERT(this._loadedBlockMesh !== undefined, 'No block mesh assigned yet');
        return this._loadedBlockMesh.getBlockSummary();
    }

    public export(params: ExportParams.Input): ExportParams.Output {
        ASSERT(this._loadedBlockMesh !== undefined);

        const exporter: IExporter = ExporterFactory.GetExporter(params.exporter);
        const options = params.exporter === 'litematic' ? params.litematicOptions : undefined;
        const files = exporter.export(this._loadedBlockMesh, options);

        return {
            files: files,
        };
    }
}
