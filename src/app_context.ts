import '../styles.css';

import { AppAnalytics } from './analytics';
import { FallableBehaviour } from './block_mesh';
import { ArcballCamera } from './camera';
import { AppConfig } from './config';
import { EstimatedDimensions, estimateVoxelDimensions } from './dimension_estimator';
import { EAppEvent, EventManager } from './event';
import { InteractionManager } from './interaction';
import { LOC, Localiser, TLocalisedString } from './localiser';
import { MaterialMapManager } from './material-map';
import { MouseManager } from './mouse';
import { MeshType, Renderer } from './renderer';
import { AppConsole, TMessage } from './ui/console';
import { UI } from './ui/layout';
import { ColourSpace, EAction } from './util';
import { ASSERT } from './util/error_util';
import { download, downloadAsZip } from './util/file_util';
import { LOG_ERROR, Logger } from './util/log_util';
import { Vector3 } from './vector';
import { deriveModelNameFromVoxelFilename } from './voxel_model_io';
import { WorkerController } from './worker_controller';
import { TFromWorkerMessage, TReplaceMode, TReplaceScope } from './worker_types';

export class AppContext {
    /* Singleton */
    private static _instance: AppContext;
    public static get Get() {
        return this._instance || (this._instance = new this());
    }

    private _workerController: WorkerController;
    private _lastAction?: EAction;
    public minConstraint?: { x: number, z: number };
    public maxConstraint?: { x: number, z: number };
    private _materialManager: MaterialMapManager;
    private _loadedFilename: string | null;
    private _importedFileSignature: string | null;
    private _importedMeshDimensions?: Vector3;
    private _importedTriangleCount?: number;
    private _activeAssignPromise: Promise<boolean> | null;
    private _activeVoxelPostPromise: Promise<boolean> | null;
    private _isManualActionRunning: boolean;
    private _isWorkerReady: boolean;
    private _hasVoxelMesh: boolean;
    private _hasBlockMesh: boolean;
    private _currentVoxelDesiredHeight: number;

    private constructor() {
        this._workerController = new WorkerController();
        this._materialManager = new MaterialMapManager(new Map());
        this._loadedFilename = null;
        this._importedFileSignature = null;
        this._activeAssignPromise = null;
        this._activeVoxelPostPromise = null;
        this._isManualActionRunning = false;
        this._isWorkerReady = false;
        this._hasVoxelMesh = false;
        this._hasBlockMesh = false;
        this._currentVoxelDesiredHeight = 80;
    }

    public isActionBusy(): boolean {
        return (
            this._isManualActionRunning ||
            this._activeAssignPromise !== null ||
            this._activeVoxelPostPromise !== null ||
            this._workerController.isBusy()
        );
    }

    public isWorkerReady(): boolean {
        return this._isWorkerReady;
    }

    public hasVoxelMesh(): boolean {
        return this._hasVoxelMesh;
    }

    public static async init() {
        AppAnalytics.Init();

        await Localiser.Get.init();
        AppConsole.info(LOC('init.initialising'));

        Logger.Get.enableLOG();
        Logger.Get.enableLOGMAJOR();
        Logger.Get.enableLOGWARN();

        AppConfig.Get.dumpConfig();


        EventManager.Get.bindToContext(this.Get);

        UI.Get.bindToContext(this.Get);
        UI.Get.build();
        UI.Get.registerEvents();
        UI.Get.updateMaterialsAction(this.Get._materialManager);
        UI.Get.disableAll();

        ArcballCamera.Get.init();
        MouseManager.Get.init();
        InteractionManager.Get.init();

        window.addEventListener('contextmenu', (e) => e.preventDefault());

        this.Get._workerController.execute({ action: 'Init', params: {}}).then(() => {
            this.Get._isWorkerReady = true;
            UI.Get.enableTo(EAction.Import);
            UI.Get.syncVoxelIOButtons();
            AppConsole.success(LOC('init.ready'));
        });

        ArcballCamera.Get.toggleAngleSnap();

        EventManager.Get.add(EAppEvent.onLanguageChanged, () => {
            this.Get._workerController.execute({ action: 'Settings', params: { language: Localiser.Get.getCurrentLanguage() }}).then(() => {
            });
        });
    }

    public getLastAction() {
        return this._lastAction;
    }

    public hasImportedMesh(): boolean {
        return this._importedMeshDimensions !== undefined;
    }

    public getMaterialManager(): MaterialMapManager {
        return this._materialManager;
    }

    public getImportedMeshDimensions(): Vector3 | undefined {
        return this._importedMeshDimensions;
    }

    public getImportedTriangleCount(): number | undefined {
        return this._importedTriangleCount;
    }

    public getLoadedFilename(): string | null {
        return this._loadedFilename;
    }

    private _applyMeshConstraints(dimensions: Vector3, resetDefaults: boolean) {
        this.minConstraint = Vector3.copy(dimensions)
            .mulScalar(AppConfig.Get.CONSTRAINT_MINIMUM_HEIGHT).ceil();
        this.maxConstraint = Vector3.copy(dimensions)
            .mulScalar(AppConfig.Get.CONSTRAINT_MAXIMUM_HEIGHT).floor();

        const xEnabled = this.minConstraint.x > 0 && this.minConstraint.x <= this.maxConstraint.x;
        const zEnabled = this.minConstraint.z > 0 && this.minConstraint.z <= this.maxConstraint.z;

        const voxelComps = UI.Get._ui.voxelise.components;
        const prevAxis = voxelComps.constraintAxis.getValue();
        const prevSize = voxelComps.size.getValue();

        voxelComps.constraintAxis.setOptionEnabled(0, xEnabled);
        voxelComps.constraintAxis.setOptionEnabled(2, zEnabled);

        if (resetDefaults) {
            voxelComps.constraintAxis.setValue('y');
            voxelComps.size.setMin(AppConfig.Get.CONSTRAINT_MINIMUM_HEIGHT);
            voxelComps.size.setMax(AppConfig.Get.CONSTRAINT_MAXIMUM_HEIGHT);
            voxelComps.size.setValue(80);
        } else {
            const validAxis = prevAxis === 'y' || (prevAxis === 'x' && xEnabled) || (prevAxis === 'z' && zEnabled);
            const nextAxis = validAxis ? prevAxis : 'y';
            voxelComps.constraintAxis.setValue(nextAxis);

            const minBound = nextAxis === 'y' ?
                AppConfig.Get.CONSTRAINT_MINIMUM_HEIGHT :
                this.minConstraint[nextAxis];
            const maxBound = nextAxis === 'y' ?
                AppConfig.Get.CONSTRAINT_MAXIMUM_HEIGHT :
                this.maxConstraint[nextAxis];
            if (maxBound >= minBound) {
                voxelComps.size.setMin(minBound);
                voxelComps.size.setMax(maxBound);
                const clampedSize = Math.max(minBound, Math.min(maxBound, prevSize));
                voxelComps.size.setValue(clampedSize);
            }
        }
    }

    public async exportRepairedGlb(options?: {
        preserveCurrentGeometry?: boolean,
        forceRecomputeNormals?: boolean,
        removeSmallIslands?: boolean,
        minIslandTriangles?: number,
    }): Promise<boolean> {
        if (!this.hasImportedMesh()) {
            return false;
        }

        UI.Get.disableAll();
        AppConsole.info(LOC('import.exporting_glb'));
        const baseName = (UI.Get.layout.export.components.structureName.getValue() || this._loadedFilename || 'model').trim();

        const forceRecomputeNormals = options?.forceRecomputeNormals ?? false;
        const removeSmallIslands = options?.removeSmallIslands ?? false;
        const minIslandTriangles = options?.minIslandTriangles ?? 16;

        const resultGlb = await this._workerController.execute({
            action: 'ExportGlb',
            params: {
                modelName: baseName,
                groundAndCenter: true,
                preserveCurrentGeometry: options?.preserveCurrentGeometry ?? false,
                forceRecomputeNormals,
                removeSmallIslands,
                minIslandTriangles,
            },
        });

        UI.Get.getExportGlbButton()?.resetLoading();
        if (!this._handleErrors(resultGlb) && resultGlb.action === 'ExportGlb') {
            this._addWorkerMessagesToConsole(resultGlb.messages);
            const safeFileBase = (this._loadedFilename || baseName || 'model').replace(/[^a-zA-Z0-9_\-.]/g, '_');
            download(resultGlb.result.glbBytes, `${safeFileBase}_fixed.glb`);

            const stats = resultGlb.result.stats;
            const removedTotal =
                stats.removedDegenerateTriangles +
                stats.removedInvalidIndexTriangles +
                stats.removedIslandTriangles;
            AppConsole.success(LOC('import.exported_glb', {
                triangles: stats.keptTriangles,
                removed: removedTotal,
                normals: stats.fixedNormals,
            }));
        }

        this._restoreUIState();
        return true;
    }

    public onRotationChanged() {
        if (this._importedMeshDimensions !== undefined) {
            UI.Get.getActionButton(EAction.Import)?.setNeedsAttention(
                true,
                LOC('import.components.reimport_needed_hint'),
            );
        }
    }

    public updateEstimatedVoxelDimensions(isExact = false, exactDims?: EstimatedDimensions) {
        if (isExact && exactDims) {
            UI.Get.updateVoxelDimensions(exactDims, true);
            return;
        }
        if (!this._importedMeshDimensions) {
            UI.Get.updateVoxelDimensions(null, false);
            return;
        }
        const comps = UI.Get._ui.voxelise.components;
        const estimated = estimateVoxelDimensions({
            meshDimensions: this._importedMeshDimensions,
            constraintAxis: comps.constraintAxis.getValue(),
            size: comps.size.getValue(),
            voxeliser: comps.voxeliser.getValue(),
        });
        UI.Get.updateVoxelDimensions(estimated, false);
    }

    private async _import(): Promise<boolean> {
        // Gather data from the UI to send to the worker
        const components = UI.Get.layout.import.components;
        let filetype: string;

        if (!components.input.hasValue()) {
            AppConsole.warning(LOC('import.components.no_file_chosen'));
            UI.Get.getActionButton(EAction.Import)?.resetLoading();
            UI.Get.getActionButton(EAction.Import)?.setEnabled(false);
            return false;
        }

        AppConsole.info(LOC('import.importing_mesh'));
        {
            // Instruct the worker to perform the job and await the result
            const file = components.input.getValue();
            filetype = file.type;
            const fileSignature = `${file.name}:${file.size}:${file.lastModified}`;
            const isSameFileReimport = this._importedFileSignature === fileSignature;

            const resultImport = await this._workerController.execute({
                action: 'Import',
                params: {
                    file: file,
                    rotation: components.rotation.getValue(),
                },
            });

            UI.Get.getActionButton(EAction.Import)?.resetLoading();
            if (this._handleErrors(resultImport)) {
                return false;
            }
            ASSERT(resultImport.action === 'Import');

            AppConsole.success(LOC('import.imported_mesh'));
            this._addWorkerMessagesToConsole(resultImport.messages);

            this._importedFileSignature = fileSignature;
            this._importedMeshDimensions = Vector3.copy(resultImport.result.dimensions);
            this._importedTriangleCount = resultImport.result.triangleCount;
            this._hasVoxelMesh = false;
            this._hasBlockMesh = false;
            UI.Get.resetVoxelPostControls();

            this._applyMeshConstraints(resultImport.result.dimensions, !isSameFileReimport);

            UI.Get.getActionButton(EAction.Import)?.setNeedsAttention(false);
            this.updateEstimatedVoxelDimensions(false);

            this._materialManager = new MaterialMapManager(resultImport.result.materials);
            UI.Get.updateMaterialsAction(this._materialManager);

            const baseName = file.name.replace(/\.[^/.]+$/, '') || 'result';
            this._loadedFilename = baseName;
            UI.Get.setStructureName(baseName);
        }

        AppConsole.info(LOC('import.rendering_mesh'));
        {
            // Instruct the worker to perform the job and await the result
            const resultRender = await this._workerController.execute({
                action: 'RenderMesh',
                params: {},
            });

            UI.Get.getActionButton(EAction.Import)?.resetLoading();
            if (this._handleErrors(resultRender)) {
                return false;
            }
            ASSERT(resultRender.action === 'RenderMesh');

            this._addWorkerMessagesToConsole(resultRender.messages);
            Renderer.Get.useMesh(resultRender.result);
        }
        AppConsole.success(LOC('import.rendered_mesh'));

        AppAnalytics.Event('import', {
            'filetype': filetype,
        });
        return true;
    }


    private async _materials(): Promise<boolean> {
        AppConsole.info(LOC('materials.updating_materials'));
        {
            // Instruct the worker to perform the job and await the result
            const resultMaterials = await this._workerController.execute({
                action: 'SetMaterials',
                params: {
                    materials: this._materialManager.materials,
                },
            });

            UI.Get.getActionButton(EAction.Materials)?.resetLoading();
            if (this._handleErrors(resultMaterials)) {
                return false;
            }
            ASSERT(resultMaterials.action === 'SetMaterials');

            resultMaterials.result.materialsChanged.forEach((materialName) => {
                const material = this._materialManager.materials.get(materialName);
                ASSERT(material !== undefined);
                Renderer.Get.recreateMaterialBuffer(materialName, material);
                Renderer.Get.setModelToUse(MeshType.TriangleMesh);
            });

            this._addWorkerMessagesToConsole(resultMaterials.messages);
        }
        AppConsole.success(LOC('materials.updated_materials'));

        AppAnalytics.Event('materials');
        return true;
    }

    private async _voxelise(): Promise<boolean> {
        // Gather data from the UI to send to the worker
        const components = UI.Get.layout.voxelise.components;

        AppConsole.info(LOC('voxelise.loading_voxel_mesh'));
        {
            // Instruct the worker to perform the job and await the result
            const resultVoxelise = await this._workerController.execute({
                action: 'Voxelise',
                params: {
                    constraintAxis: components.constraintAxis.getValue(),
                    voxeliser: components.voxeliser.getValue(),
                    size: components.size.getValue(),
                    useMultisampleColouring: components.multisampleColouring.getValue(),
                    enableAmbientOcclusion: components.ambientOcclusion.getValue(),
                    voxelOverlapRule: components.voxelOverlapRule.getValue(),
                    surfaceRadius: components.surfaceRadius.getValue(),
                    coverageThreshold: components.coverageThreshold.getValue(),
                    morphMode: components.morphMode.getValue(),
                    morphPasses: components.morphPasses.getValue(),
                    voxelMirror: components.voxelMirror.getValue(),
                    addBasePlinth: components.addBasePlinth.getValue(),
                    plinthThickness: components.plinthThickness.getValue(),
                    hollow: components.hollow.getValue(),
                    wallThickness: components.wallThickness.getValue(),
                    removeFloatingIslands: components.removeFloatingIslands.getValue(),
                    minIslandSize: components.minIslandSize.getValue(),
                },
            });

            UI.Get.getActionButton(EAction.Voxelise)?.resetLoading();
            if (this._handleErrors(resultVoxelise)) {
                return false;
            }
            ASSERT(resultVoxelise.action === 'Voxelise');

            this._addWorkerMessagesToConsole(resultVoxelise.messages);
        }
        AppConsole.success(LOC('voxelise.loaded_voxel_mesh'));

        AppConsole.info(LOC('voxelise.rendering_voxel_mesh'));
        {
            let moreVoxelsToBuffer = false;
            do {
                // Instruct the worker to perform the job and await the result
                const resultRender = await this._workerController.execute({
                    action: 'RenderNextVoxelMeshChunk',
                    params: {
                        enableAmbientOcclusion: components.ambientOcclusion.getValue(),
                        desiredHeight: components.size.getValue(),
                    },
                });

                UI.Get.getActionButton(EAction.Voxelise)?.resetLoading();
                if (this._handleErrors(resultRender)) {
                    return false;
                }
                ASSERT(resultRender.action === 'RenderNextVoxelMeshChunk');

                moreVoxelsToBuffer = resultRender.result.moreVoxelsToBuffer;
                this._addWorkerMessagesToConsole(resultRender.messages);

                if (resultRender.result.isFirstChunk) {
                    const bDims = resultRender.result.dimensions;
                    this.updateEstimatedVoxelDimensions(true, {
                        x: Math.max(1, Math.round(bDims.x) + 1),
                        y: Math.max(1, Math.round(bDims.y) + 1),
                        z: Math.max(1, Math.round(bDims.z) + 1),
                    });
                }

                Renderer.Get.useVoxelMeshChunk(resultRender.result);
            } while (moreVoxelsToBuffer);
        }
        AppConsole.success(LOC('voxelise.rendered_voxel_mesh'));
        this._currentVoxelDesiredHeight = components.size.getValue();
        this._hasVoxelMesh = true;
        this._hasBlockMesh = false;
        UI.Get.resetVoxelPostControls();

        AppAnalytics.Event('voxelise', {
            constraintAxis: components.constraintAxis.getValue(),
            voxeliser: components.voxeliser.getValue(),
            size: components.size.getValue(),
            useMultisampleColouring: components.multisampleColouring.getValue(),
            enableAmbientOcclusion: components.ambientOcclusion.getValue(),
            voxelOverlapRule: components.voxelOverlapRule.getValue(),
        });
        return true;
    }

    private async _voxelPost(options?: { isAuto?: boolean }): Promise<boolean> {
        if (!this._hasVoxelMesh) {
            return false;
        }

        const components = UI.Get.layout.voxelPost.components;
        const voxelComponents = UI.Get.layout.voxelise.components;
        const rotation = components.rotation.getValue();

        if (!options?.isAuto) {
            AppConsole.info(LOC('voxel_post.applying'));
        }
        const resultPost = await this._workerController.execute({
            action: 'VoxelPost',
            params: {
                rotation: rotation,
            },
        });

        if (!options?.isAuto) {
            UI.Get.getActionButton(EAction.VoxelPost)?.resetLoading();
        }
        if (this._handleErrors(resultPost)) {
            return false;
        }
        ASSERT(resultPost.action === 'VoxelPost');

        this._addWorkerMessagesToConsole(resultPost.messages);

        UI.Get.clearPreview();
        Renderer.Get.clearBlockMesh();
        this._hasVoxelMesh = true;
        this._hasBlockMesh = false;

        if (!options?.isAuto) {
            AppConsole.info(LOC('voxelise.rendering_voxel_mesh'));
        }
        {
            let moreVoxelsToBuffer = false;
            do {
                const resultRender = await this._workerController.execute({
                    action: 'RenderNextVoxelMeshChunk',
                    params: {
                        enableAmbientOcclusion: voxelComponents.ambientOcclusion.getValue(),
                        desiredHeight: Math.max(1, this._currentVoxelDesiredHeight),
                    },
                });

                if (!options?.isAuto) {
                    UI.Get.getActionButton(EAction.VoxelPost)?.resetLoading();
                }
                if (this._handleErrors(resultRender)) {
                    return false;
                }
                ASSERT(resultRender.action === 'RenderNextVoxelMeshChunk');

                moreVoxelsToBuffer = resultRender.result.moreVoxelsToBuffer;
                this._addWorkerMessagesToConsole(resultRender.messages);

                if (resultRender.result.isFirstChunk) {
                    const bDims = resultRender.result.dimensions;
                    this.updateEstimatedVoxelDimensions(true, {
                        x: Math.max(1, Math.round(bDims.x) + 1),
                        y: Math.max(1, Math.round(bDims.y) + 1),
                        z: Math.max(1, Math.round(bDims.z) + 1),
                    });
                }

                Renderer.Get.useVoxelMeshChunk(resultRender.result);
            } while (moreVoxelsToBuffer);
        }

        const dims = resultPost.result.dimensions;
        AppConsole.success(LOC('voxel_post.applied', {
            count: resultPost.result.voxelCount,
            x: Math.round(dims.x),
            y: Math.round(dims.y),
            z: Math.round(dims.z),
        }));
        return true;
    }

    public async resetVoxelPost(): Promise<void> {
        UI.Get.cancelAutoVoxelPost();
        if (this._activeVoxelPostPromise) {
            try {
                await this._activeVoxelPostPromise;
            } catch (_) {}
        }
        if (!this._hasVoxelMesh || this.isActionBusy()) {
            return;
        }
        UI.Get.resetVoxelPostControls();
        await this.do(EAction.VoxelPost);
    }

    private _restoreUIState() {
        if (this._hasBlockMesh) {
            UI.Get.enableTo(EAction.Export);
        } else if (this._hasVoxelMesh) {
            UI.Get.enableTo(EAction.Assign);
        } else if (this.hasImportedMesh()) {
            UI.Get.enableTo(EAction.Voxelise);
        } else if (this._isWorkerReady) {
            UI.Get.enableTo(EAction.Import);
        } else {
            UI.Get.disableAll();
        }
        UI.Get.syncVoxelIOButtons();
    }

    public async saveVoxelModel(): Promise<boolean> {
        if (!this._hasVoxelMesh || this.isActionBusy()) {
            return false;
        }

        this._isManualActionRunning = true;
        UI.Get.disableAll();
        UI.Get.syncVoxelIOButtons();
        AppConsole.info(LOC('voxelise.saving_voxel_model'));

        try {
            const voxelComps = UI.Get.layout.voxelise.components;
            const exportName = UI.Get.layout.export.components.structureName.getValue().trim();
            const baseName = exportName || this._loadedFilename || 'model';

            const resultSave = await this._workerController.execute({
                action: 'SaveVoxelModel',
                params: {
                    modelName: baseName,
                    constraintAxis: voxelComps.constraintAxis.getValue(),
                    size: voxelComps.size.getValue(),
                    enableAmbientOcclusion: voxelComps.ambientOcclusion.getValue(),
                    voxelOverlapRule: voxelComps.voxelOverlapRule.getValue(),
                },
            });

            if (this._handleErrors(resultSave)) {
                return false;
            }
            ASSERT(resultSave.action === 'SaveVoxelModel');

            this._addWorkerMessagesToConsole(resultSave.messages);
            const safeFileBase = baseName.replace(/[^a-zA-Z0-9_\-. ]/g, '_').trim() || 'model';
            download(resultSave.result.content, `${safeFileBase}.voxels.json`);

            AppConsole.success(LOC('voxelise.saved_voxel_model', {
                count: resultSave.result.voxelCount,
            }));
            return true;
        } finally {
            this._isManualActionRunning = false;
            this._restoreUIState();
        }
    }

    public async loadVoxelModel(jsonText: string, filename: string): Promise<boolean> {
        if (!this._isWorkerReady) {
            return false;
        }

        UI.Get.cancelAutoAssign();
        if (this._activeAssignPromise) {
            try {
                await this._activeAssignPromise;
            } catch (_) {}
        }

        if (this.isActionBusy()) {
            return false;
        }

        this._isManualActionRunning = true;
        UI.Get.disableAll();
        UI.Get.syncVoxelIOButtons();
        AppConsole.info(LOC('voxelise.loading_saved_voxels'));

        try {
            const voxelComps = UI.Get.layout.voxelise.components;
            const enableAO = voxelComps.ambientOcclusion.getValue();

            const resultLoad = await this._workerController.execute({
                action: 'LoadVoxelModel',
                params: {
                    jsonText,
                    enableAmbientOcclusion: enableAO,
                },
            });

            if (this._handleErrors(resultLoad)) {
                return false;
            }
            ASSERT(resultLoad.action === 'LoadVoxelModel');

            UI.Get.clearPreview();
            Renderer.Get.clearBlockMesh();
            this._hasVoxelMesh = true;
            this._hasBlockMesh = false;

            this._addWorkerMessagesToConsole(resultLoad.messages);

            const resolvedName = resultLoad.result.meta.modelName || deriveModelNameFromVoxelFilename(filename);
            this._loadedFilename = resolvedName;
            UI.Get.setStructureName(resolvedName);

            const dims = resultLoad.result.dimensions;
            const desiredHeight = Math.max(1, resultLoad.result.desiredHeight);
            this._currentVoxelDesiredHeight = desiredHeight;
            UI.Get.resetVoxelPostControls();

            AppConsole.info(LOC('voxelise.rendering_voxel_mesh'));
            let moreVoxelsToBuffer = false;
            do {
                const resultRender = await this._workerController.execute({
                    action: 'RenderNextVoxelMeshChunk',
                    params: {
                        enableAmbientOcclusion: enableAO,
                        desiredHeight,
                    },
                });
                if (this._handleErrors(resultRender)) {
                    return false;
                }
                ASSERT(resultRender.action === 'RenderNextVoxelMeshChunk');

                moreVoxelsToBuffer = resultRender.result.moreVoxelsToBuffer;
                this._addWorkerMessagesToConsole(resultRender.messages);
                Renderer.Get.useVoxelMeshChunk(resultRender.result);
            } while (moreVoxelsToBuffer);

            this.updateEstimatedVoxelDimensions(true, {
                x: Math.max(1, Math.round(dims.x)),
                y: Math.max(1, Math.round(dims.y)),
                z: Math.max(1, Math.round(dims.z)),
            });

            AppConsole.success(LOC('voxelise.loaded_saved_voxels', {
                count: resultLoad.result.voxelCount,
            }));
            return true;
        } finally {
            this._isManualActionRunning = false;
            this._restoreUIState();
        }
    }

    private async _assign(options?: { isAuto?: boolean }): Promise<boolean> {
        if (!options?.isAuto) {
            UI.Get.clearPreview();
        }

        // Gather data from the UI to send to the worker
        const components = UI.Get.layout.assign.components;

        const blockSelectionAlgorithm = components.blockSelectionAlgorithm.getValue();
        const isMultiBlockWeighted = blockSelectionAlgorithm === 'dichrome' || blockSelectionAlgorithm === 'polychrome';
        const selectedBlocks = isMultiBlockWeighted ?
            components.dichromePalette.getValue() :
            components.blockPalette.getValue().getBlocks();
        if (isMultiBlockWeighted) {
            const uniqueBlocks = new Set(selectedBlocks);
            if (selectedBlocks.length < 2 || uniqueBlocks.size < 2) {
                AppConsole.warning(LOC(
                    blockSelectionAlgorithm === 'polychrome' ?
                        'assign.polychrome_requires_blocks' :
                        'assign.dichrome_requires_blocks',
                ));
                UI.Get.getActionButton(EAction.Assign)?.resetLoading();
                return false;
            }
        } else if (selectedBlocks.length === 0) {
            AppConsole.warning(LOC('assign.no_blocks_selected'));
            UI.Get.getActionButton(EAction.Assign)?.resetLoading();
            return false;
        }

        AppConsole.info(LOC('assign.loading_block_mesh'));
        {
            // Instruct the worker to perform the job and await the result
            const resultAssign = await this._workerController.execute({
                action: 'Assign',
                params: {
                    textureAtlas: isMultiBlockWeighted ?
                        'vanilla' :
                        components.textureAtlas.getValue(),
                    blockPalette: selectedBlocks,
                    blockSelectionAlgorithm: blockSelectionAlgorithm,
                    dichromeToneBias: components.dichromeToneBias.getValue(),
                    dithering: components.dithering.getValue(),
                    ditheringMagnitude: components.ditheringMagnitude.getValue(),
                    blockFilter: components.blockFilter.getValue(),
                    blockFilterThreshold: components.blockFilterThreshold.getValue(),
                    colourSpace: ColourSpace.RGB,
                    fallable: isMultiBlockWeighted ?
                        'do-nothing' :
                        components.fallable.getValue() as FallableBehaviour,
                    resolution: Math.pow(2, components.colourAccuracy.getValue()),
                    calculateLighting: components.calculateLighting.getValue(),
                    lightThreshold: components.lightThreshold.getValue(),
                    lightingPlacement: components.lightingPlacement.getValue(),
                    lightingScope: components.lightingScope.getValue(),
                    lightingLightBlock: components.lightingLightBlock.getValue(),
                    contextualAveraging: components.contextualAveraging.getValue(),
                    errorWeight: components.errorWeight.getValue() / 10,
                    brightnessOffset: components.brightnessOffset.getValue(),
                    saturationOffset: components.saturationOffset.getValue(),
                    contrastOffset: components.contrastOffset.getValue(),
                    temperatureOffset: components.temperatureOffset.getValue(),
                    colourStyle: components.colourStyle.getValue(),
                    colourStyleStrength: components.colourStyleStrength.getValue(),
                    materialFilter: components.materialFilter.getValue(),
                    maxBlockTypes: components.maxBlockTypes.getValue(),
                },
            });

            UI.Get.getActionButton(EAction.Assign)?.resetLoading();
            if (this._handleErrors(resultAssign)) {
                return false;
            }
            ASSERT(resultAssign.action === 'Assign');

            this._addWorkerMessagesToConsole(resultAssign.messages);
        }
        AppConsole.success(LOC('assign.loaded_block_mesh'));

        Renderer.Get.setLightingAvailable(components.calculateLighting.getValue());

        AppConsole.info(LOC('assign.rendering_block_mesh'));
        {
            let moreBlocksToBuffer = false;
            do {
                // Instruct the worker to perform the job and await the result
                const resultRender = await this._workerController.execute({
                    action: 'RenderNextBlockMeshChunk',
                    params: {
                        textureAtlas: components.textureAtlas.getValue(),
                    },
                });

                UI.Get.getActionButton(EAction.Assign)?.resetLoading();
                if (this._handleErrors(resultRender)) {
                    return false;
                }
                ASSERT(resultRender.action === 'RenderNextBlockMeshChunk');

                moreBlocksToBuffer = resultRender.result.moreBlocksToBuffer;
                this._addWorkerMessagesToConsole(resultRender.messages);

                Renderer.Get.useBlockMeshChunk(resultRender.result);
            } while (moreBlocksToBuffer);
        }
        AppConsole.success(LOC('assign.rendered_block_mesh'));
        this._hasBlockMesh = true;

        // Automatically fetch block counts and update preview right after assigning
        AppConsole.info(LOC('preview.loading'));
        {
            const resultPreview = await this._workerController.execute({
                action: 'Preview',
                params: {},
            });

            if (!this._handleErrors(resultPreview) && resultPreview.action === 'Preview') {
                this._addWorkerMessagesToConsole(resultPreview.messages);
                const summary = resultPreview.result;
                UI.Get.setReplaceCanUndo(false);
                UI.Get.updatePreview(summary);
                AppConsole.success(LOC('preview.ready', {
                    unique: summary.unique,
                    total: summary.total,
                }));
                AppAnalytics.Event('preview', {
                    total: summary.total,
                    unique: summary.unique,
                });
            }
        }

        AppAnalytics.Event('assign', {
            dithering: components.dithering.getValue(),
            ditheringMagnitude: components.ditheringMagnitude.getValue(),
            blockFilter: components.blockFilter.getValue(),
            blockFilterThreshold: components.blockFilterThreshold.getValue(),
            fallable: components.fallable.getValue() as FallableBehaviour,
            resolution: Math.pow(2, components.colourAccuracy.getValue()),
            calculateLighting: components.calculateLighting.getValue(),
            lightThreshold: components.lightThreshold.getValue(),
            lightingPlacement: components.lightingPlacement.getValue(),
            lightingScope: components.lightingScope.getValue(),
            lightingLightBlock: components.lightingLightBlock.getValue(),
            contextualAveraging: components.contextualAveraging.getValue(),
            errorWeight: components.errorWeight.getValue() / 10,
        });
        return true;
    }

    private async _preview(): Promise<boolean> {
        AppConsole.info(LOC('preview.loading'));
        {
            const resultPreview = await this._workerController.execute({
                action: 'Preview',
                params: {},
            });

            UI.Get.getActionButton(EAction.Preview)?.resetLoading();
            if (this._handleErrors(resultPreview)) {
                return false;
            }
            ASSERT(resultPreview.action === 'Preview');

            this._addWorkerMessagesToConsole(resultPreview.messages);

            const summary = resultPreview.result;
            UI.Get.updatePreview(summary);

            AppConsole.success(LOC('preview.ready', {
                unique: summary.unique,
                total: summary.total,
            }));

            AppAnalytics.Event('preview', {
                total: summary.total,
                unique: summary.unique,
            });
        }
        return true;
    }

    public async replaceBlockInMesh(
        sourceBlock: string,
        targetBlock: string,
        options?: {
            scope?: TReplaceScope;
            mode?: TReplaceMode;
            sourceBlocks?: string[];
        },
    ): Promise<boolean> {
        const mode: TReplaceMode = options?.mode ?? 'swap';
        const hasSource = Boolean(sourceBlock) || (options?.sourceBlocks?.length ?? 0) > 0;
        if (mode !== 'undo' && (!hasSource || (mode === 'swap' && !targetBlock))) {
            return false;
        }

        const scope: TReplaceScope = options?.scope ?? 'all';
        const wasSliceEnabled = Renderer.Get.isSliceViewerEnabled();
        const prevSliceHeight = Renderer.Get.getSliceHeight();
        const sliceY = scope === 'layer' && wasSliceEnabled ?
            Renderer.Get.getSliceLayerStats().sliceY :
            undefined;

        if (scope === 'layer' && sliceY === undefined && mode !== 'undo') {
            AppConsole.warning(LOC('preview.replace_none'));
            return false;
        }

        UI.Get.disableAll();
        let replaced = false;

        try {
            const resultReplace = await this._workerController.execute({
                action: 'ReplaceBlock',
                params: {
                    sourceBlock,
                    targetBlock,
                    scope,
                    sliceY,
                    mode,
                    activePalette: mode === 'auto-palette' ? UI.Get.getActivePaletteBlocks() : undefined,
                    sourceBlocks: options?.sourceBlocks,
                },
            });

            if (this._handleErrors(resultReplace) || resultReplace.action !== 'ReplaceBlock') {
                return false;
            }
            this._addWorkerMessagesToConsole(resultReplace.messages);
            UI.Get.setReplaceCanUndo(Boolean(resultReplace.result.canUndo));

            if (resultReplace.result.replacedCount === 0) {
                AppConsole.warning(mode === 'undo' ? LOC('preview.replace_undo_none') : LOC('preview.replace_none'));
                return false;
            }

            const components = UI.Get.layout.assign.components;
            let moreBlocksToBuffer = false;
            do {
                const resultRender = await this._workerController.execute({
                    action: 'RenderNextBlockMeshChunk',
                    params: {
                        textureAtlas: components.textureAtlas.getValue(),
                    },
                });
                if (this._handleErrors(resultRender) || resultRender.action !== 'RenderNextBlockMeshChunk') {
                    return false;
                }
                moreBlocksToBuffer = resultRender.result.moreBlocksToBuffer;
                this._addWorkerMessagesToConsole(resultRender.messages);
                Renderer.Get.useBlockMeshChunk(resultRender.result);
            } while (moreBlocksToBuffer);

            if (wasSliceEnabled) {
                Renderer.Get.setSliceState(true, prevSliceHeight);
            }

            const resultPreview = await this._workerController.execute({
                action: 'Preview',
                params: {},
            });
            if (!this._handleErrors(resultPreview) && resultPreview.action === 'Preview') {
                this._addWorkerMessagesToConsole(resultPreview.messages);
                UI.Get.updatePreview(resultPreview.result);
            }

            if (mode === 'undo') {
                AppConsole.success(LOC('preview.replace_undo_success', {
                    count: resultReplace.result.replacedCount,
                }));
            } else {
                AppConsole.success(LOC('preview.replace_success', {
                    count: resultReplace.result.replacedCount,
                    source: resultReplace.result.sourceName,
                    target: resultReplace.result.targetName,
                }));
            }
            replaced = true;
        } finally {
            UI.Get.enableTo(EAction.Export);
        }

        return replaced;
    }

    private async _export(): Promise<boolean> {
        // Gather data from the UI to send to the worker
        const components = UI.Get.layout.export.components;

        const structureName = components.structureName.getValue().trim() || this._loadedFilename || 'result';

        AppConsole.info(LOC('export.exporting_structure'));
        {
            // Instruct the worker to perform the job and await the result
            const resultExport = await this._workerController.execute({
                action: 'Export',
                params: {
                    exporter: components.export.getValue(),
                    litematicOptions: {
                        name: structureName,
                        regionName: structureName,
                        author: 'ObjToSchematic',
                        timestampMs: Date.now(),
                        anchor: 'center-base',
                    },
                },
            });

            UI.Get.getActionButton(EAction.Export)?.resetLoading();
            if (this._handleErrors(resultExport)) {
                return false;
            }
            ASSERT(resultExport.action === 'Export');

            this._addWorkerMessagesToConsole(resultExport.messages);

            ASSERT(this._loadedFilename !== null);
            const downloadBase = structureName.replace(/[^a-zA-Z0-9_\-. ]/g, '_').trim() || this._loadedFilename;
            const fileExport = resultExport.result.files;
            if (fileExport.type === 'single') {
                download(fileExport.content, `${downloadBase}_OTS${fileExport.extension}`);
            } else {
                const zipFiles = fileExport.regions.map((region) => {
                    // .nbt exports need to be lowercase
                    return { content: region.content, filename: `ots_${region.name}${fileExport.extension}` };
                });

                downloadAsZip(`${downloadBase}_OTS.zip`, zipFiles);
            }
        }
        AppConsole.success(LOC('export.exported_structure'));

        AppAnalytics.Event('export', {
            exporter: components.export.getValue(),
        });
        return true;
    }

    /**
     * Check if the result from the worker is an error message
     * if so, handle it and return true, otherwise false.
     */
    private _handleErrors(result: TFromWorkerMessage) {
        if (result.action === 'KnownError') {
            AppConsole.error(result.error.message as TLocalisedString);
            return true;
        } else if (result.action === 'UnknownError') {
            AppConsole.error(LOC('something_went_wrong'));
            LOG_ERROR(result.error);
            return true;
        }
        return false;
    }

    public async runAutoAssign(): Promise<boolean> {
        if (this._isManualActionRunning || this._activeAssignPromise !== null || this._workerController.isBusy()) {
            return false;
        }
        if (!UI.Get.canRunAutoAssign()) {
            return false;
        }

        this._lastAction = EAction.Assign;
        UI.Get.setAutoAssignRunning(true);

        const promise = this._assign({ isAuto: true });
        this._activeAssignPromise = promise;

        try {
            const success = await promise;
            if (success && !this._isManualActionRunning) {
                UI.Get.enableExportAfterAutoAssign();
            }
            return success;
        } finally {
            this._activeAssignPromise = null;
            UI.Get.setAutoAssignRunning(false);
        }
    }

    public async runAutoVoxelPost(): Promise<boolean> {
        if (
            this._isManualActionRunning ||
            this._activeAssignPromise !== null ||
            this._activeVoxelPostPromise !== null ||
            this._workerController.isBusy()
        ) {
            return false;
        }
        if (!UI.Get.canRunAutoVoxelPost()) {
            return false;
        }

        this._lastAction = EAction.VoxelPost;
        UI.Get.setAutoVoxelPostRunning(true);

        const promise = this._voxelPost({ isAuto: true });
        this._activeVoxelPostPromise = promise;

        try {
            const success = await promise;
            if (success && !this._isManualActionRunning) {
                UI.Get.enableAssignAfterAutoVoxelPost();
            }
            return success;
        } finally {
            this._activeVoxelPostPromise = null;
            UI.Get.setAutoVoxelPostRunning(false);
            UI.Get.syncVoxelIOButtons();
        }
    }

    public async do(action: EAction) {
        UI.Get.cancelAutoAssign();
        UI.Get.cancelAutoVoxelPost();
        if (this._activeAssignPromise) {
            try {
                await this._activeAssignPromise;
            } catch (_) {}
        }
        if (this._activeVoxelPostPromise) {
            try {
                await this._activeVoxelPostPromise;
            } catch (_) {}
        }

        this._isManualActionRunning = true;
        // Disable the UI while the worker is working
        UI.Get.disableAll();

        this._lastAction = action;

        try {
            const success = await this._executeAction(action);
            if (success) {
                if (action === EAction.Import) {
                    UI.Get.enableTo(EAction.Voxelise);
                } else if (action === EAction.Voxelise || action === EAction.VoxelPost) {
                    UI.Get.enableTo(EAction.Assign);
                } else if (action === EAction.Assign) {
                    UI.Get.enableTo(EAction.Export);
                } else {
                    UI.Get.enableTo(action + 1);
                }
            } else {
                UI.Get.enableTo(action);
            }
        } finally {
            this._isManualActionRunning = false;
            UI.Get.syncVoxelIOButtons();
        }
    }

    private _addWorkerMessagesToConsole(messages: TMessage[]) {
        messages.forEach((message) => {
            AppConsole.add(message);
        });
    }

    private async _executeAction(action: EAction): Promise<boolean> {
        switch (action) {
            case EAction.Import:
                return await this._import();
            case EAction.Materials:
                return await this._materials();
            case EAction.Voxelise:
                return await this._voxelise();
            case EAction.VoxelPost:
                return await this._voxelPost();
            case EAction.Assign:
                return await this._assign();
            case EAction.Preview:
                return await this._preview();
            case EAction.Export:
                return await this._export();
        }
        ASSERT(false);
    }

    public static draw() {
        Renderer.Get.update();
        UI.Get.tick(this.Get._workerController.isBusy());
        Renderer.Get.draw();
    }
}
