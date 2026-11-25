import { AppContext } from '../../app_context';
import { ArcballCamera } from '../../camera';
import { InteractionManager, TMeshPaintEvent } from '../../interaction';
import { LOC } from '../../localiser';
import { MaterialType, SolidMaterial, TexturedMaterial } from '../../mesh';
import { MeshEditParams } from '../../mesh_editor';
import {
    addSnapshotLayer,
    applyEditToActiveModelLayer,
    createInitialModelLayersState,
    deleteModelLayer,
    duplicateModelLayer,
    getActiveModelLayer,
    mergeVisibleModelLayers,
    mergeVisiblePartsIntoSingleLayer,
    ModelLayer,
    ModelLayerStackState,
    renameModelLayer,
    replaceWorkingLayersWithSplitParts,
    restoreLayerToWorking,
    splitGeometryByMaterial,
    splitGeometryIntoConnectedParts,
    toggleModelLayerLock,
    toggleModelLayerSolo,
    toggleModelLayerVisibility,
} from '../../model_layers';
import {
    PreprocessBundleV1,
    PreprocessCheckpointSummary,
    PreprocessOperationLogEntry,
    PreprocessRecipe,
    PreprocessRecipeParams,
    PreprocessStorage,
    serializePreprocessBundleJson,
} from '../../preprocessing_storage';
import { MeshType, Renderer } from '../../renderer';
import { TImageRawWrap } from '../../texture';
import {
    adjustTexturePixels,
    autoLevelsRgba,
    createSolidRgbaBuffer,
    flipRgbaHorizontal,
    flipRgbaVertical,
    floodFillRgba,
    paintBrushDab,
    paintBrushStroke,
    PixelRGBA,
    rotateRgba90CW,
    TextureFilterParams,
    uvToPixelCoord,
} from '../../texture_editor';
import {
    addPaintTextureLayer,
    compositeTextureLayers,
    createTextureLayerStack,
    deleteTextureLayer,
    duplicateTextureLayer,
    flattenTextureLayers,
    getActiveTextureLayer,
    mergeTextureLayerDown,
    moveTextureLayer,
    offsetRgbaWrap,
    pixelizeRgba,
    TextureBlendMode,
    TextureLayer,
    TextureLayerStack,
} from '../../texture_layers';
import { download } from '../../util/file_util';
import { AppConsole } from '../console';

export type PreprocessTab = 'geometry' | 'textures' | 'storage';
type GeomTool = 'transform' | 'deform' | 'repair' | 'decimate' | 'crop';
type PaintTool = 'brush' | 'eraser' | 'fill' | 'eyedropper';

interface TextureEditState {
    materialName: string;
    width: number;
    height: number;
    layerStack: TextureLayerStack;
    workingPixels: Uint8ClampedArray;
    originalRaw?: TImageRawWrap;
    filters: TextureFilterParams;
    pixelizeSize: number;
}

function defaultFilters(): TextureFilterParams {
    return {
        brightness: 0,
        contrast: 0,
        saturation: 0,
        hue: 0,
        posterize: 0,
        gamma: 0,
        warmth: 0,
        sharpen: 0,
        blur: 0,
    };
}

function hasActiveFilters(f: TextureFilterParams, pixelizeSize: number): boolean {
    return (
        pixelizeSize > 1 ||
        f.brightness !== 0 ||
        f.contrast !== 0 ||
        f.saturation !== 0 ||
        f.hue !== 0 ||
        f.posterize >= 2 ||
        (f.gamma ?? 0) !== 0 ||
        (f.warmth ?? 0) !== 0 ||
        (f.sharpen ?? 0) !== 0 ||
        (f.blur ?? 0) !== 0
    );
}

function rgbFloatToHex(r: number, g: number, b: number): string {
    const toByte = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255))).toString(16).padStart(2, '0');
    return `#${toByte(r)}${toByte(g)}${toByte(b)}`;
}

function hexToPixelRGBA(hex: string): PixelRGBA {
    const clean = hex.replace('#', '');
    const r = parseInt(clean.slice(0, 2), 16) || 0;
    const g = parseInt(clean.slice(2, 4), 16) || 0;
    const b = parseInt(clean.slice(4, 6), 16) || 0;
    return { r, g, b, a: 255 };
}

function formatShortTime(ts: number): string {
    try {
        return new Date(ts).toLocaleString([], {
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
        });
    } catch {
        return '';
    }
}

export class ModelTextureEditor {
    private static _instance: ModelTextureEditor;
    public static get Get() {
        return this._instance || (this._instance = new this());
    }

    private _appContext?: AppContext;
    private _isOpen = false;
    private _activeTab: PreprocessTab = 'geometry';
    private _activeGeomTool: GeomTool = 'transform';
    private _isBusy = false;

    // 3D Model Layers & History (Photoshop/Blender non-destructive layers & snapshots)
    private _modelLayersState: ModelLayerStackState | null = null;
    private _modelLayersInitPending = false;
    private _modelLayerUndoStack: ModelLayerStackState[] = [];
    private _modelLayerRedoStack: ModelLayerStackState[] = [];
    private _renamingModelLayerId: string | null = null;

    // Geometry tool parameters
    private _uniformScale = true;
    private _smoothFactor = 0.35;
    private _smoothIterations = 2;
    private _inflateAmountPct = 5;
    private _weldTolerance = 0.0001;
    private _decimateRatio = 0.5;
    private _cleanRemoveIslands = false;
    private _cleanMinIslandTris = 16;
    private _cleanForceSmoothNormals = false;
    private _cropMinPct = { x: 0, y: 0, z: 0 };
    private _cropMaxPct = { x: 100, y: 100, z: 100 };

    // Texture editing state
    private _selectedMaterialName: string | null = null;
    private _textureResolution = 256;
    private _textureStates = new Map<string, TextureEditState>();
    private _loadingMaterials = new Set<string>();
    private _adjustmentsExpanded = false;

    private _tool: PaintTool = 'brush';
    private _brushColor = '#e63946';
    private _brushSize = 8;
    private _brushHardness = 0.85;
    private _zoomPercent = 100;
    private _is3DPaintEnabled = false;
    private _mirrorXBrush = false;

    private _isDrawing2D = false;
    private _last2DPoint: { x: number; y: number } | null = null;
    private _last3DPoint: { materialName: string; x: number; y: number } | null = null;

    private _windowMoveListener: ((e: MouseEvent) => void) | null = null;
    private _windowUpListener: (() => void) | null = null;

    private _liveSyncTimer: number | null = null;
    private _liveSyncInFlight = false;
    private _liveSyncPendingMat: string | null = null;

    // Storage & History
    private _operationLog: PreprocessOperationLogEntry[] = [];
    private _checkpoints: PreprocessCheckpointSummary[] = [];
    private _recipes: PreprocessRecipe[] = [];
    private _checkpointsLoaded = false;

    private _onProceedToPipeline?: () => void;

    private constructor() {
        this._recipes = PreprocessStorage.listRecipes();
    }

    public bindToContext(context: AppContext) {
        this._appContext = context;
    }

    public setProceedHandler(handler: () => void) {
        this._onProceedToPipeline = handler;
    }

    public setOpen(isOpen: boolean) {
        this._isOpen = isOpen;
        if (!isOpen) {
            this._disable3DPaint();
        } else {
            this._recipes = PreprocessStorage.listRecipes();
            this._refreshCheckpoints();
            if (Renderer.Get.getModelsAvailable() >= MeshType.TriangleMesh) {
                Renderer.Get.setModelToUse(MeshType.TriangleMesh);
            }
            this._ensureModelLayersInitialized();
            this.render();
            this._sync3DPaintHook();
        }
    }

    public isOpen(): boolean {
        return this._isOpen;
    }

    public setActiveSubTab(tab: PreprocessTab) {
        this._activeTab = tab;
        if (this._isOpen) {
            this.render();
            this._sync3DPaintHook();
        }
    }

    public resetForNewMesh() {
        this._modelLayersState = null;
        this._modelLayersInitPending = false;
        this._modelLayerUndoStack = [];
        this._modelLayerRedoStack = [];
        this._renamingModelLayerId = null;

        this._textureStates.clear();
        this._loadingMaterials.clear();
        this._selectedMaterialName = null;
        this._last3DPoint = null;
        this._last2DPoint = null;
        this._operationLog = [];
        this._cropMinPct = { x: 0, y: 0, z: 0 };
        this._cropMaxPct = { x: 100, y: 100, z: 100 };

        if (this._isOpen) {
            this._ensureModelLayersInitialized();
            this.render();
            this._sync3DPaintHook();
        }
    }

    public onPreprocessedBundleLoaded(bundle: PreprocessBundleV1) {
        this._modelLayersState = null;
        this._modelLayersInitPending = false;
        this._modelLayerUndoStack = [];
        this._modelLayerRedoStack = [];
        this._renamingModelLayerId = null;

        this._textureStates.clear();
        this._loadingMaterials.clear();
        this._selectedMaterialName = null;
        this._operationLog = (bundle.operations ?? []).map((o) => ({ ...o }));
        if (bundle.recipe) {
            this.loadRecipeParams(bundle.recipe, false);
        }
        if (this._isOpen) {
            this._refreshCheckpoints();
            this._ensureModelLayersInitialized();
            this.render();
            this._sync3DPaintHook();
        }
    }

    public loadRecipeParams(params: PreprocessRecipeParams, shouldRender = true) {
        this._weldTolerance = params.weldTolerance ?? 0.0001;
        this._decimateRatio = params.decimateRatio ?? 0.5;
        this._cleanMinIslandTris = params.minIslandTriangles ?? 16;
        this._cleanForceSmoothNormals = params.forceSmoothNormals ?? false;
        this._cleanRemoveIslands = (params.minIslandTriangles ?? 0) > 0;
        this._cropMinPct = {
            x: Math.round((params.cropMin?.x ?? 0) * 100),
            y: Math.round((params.cropMin?.y ?? 0) * 100),
            z: Math.round((params.cropMin?.z ?? 0) * 100),
        };
        this._cropMaxPct = {
            x: Math.round((params.cropMax?.x ?? 1) * 100),
            y: Math.round((params.cropMax?.y ?? 1) * 100),
            z: Math.round((params.cropMax?.z ?? 1) * 100),
        };
        if (params.filters && this._selectedMaterialName) {
            const state = this._textureStates.get(this._selectedMaterialName);
            if (state) {
                state.filters = { ...defaultFilters(), ...params.filters };
                this._recomputeWorkingPixels(state);
                this._scheduleLiveTextureSync(this._selectedMaterialName, true);
            }
        }
        if (shouldRender && this._isOpen) {
            this.render();
        }
    }

    public onMeshStateChanged() {
        if (this._isOpen) {
            this._ensureModelLayersInitialized();
            this.render();
            this._sync3DPaintHook();
        } else {
            this._disable3DPaint();
        }
    }

    public onLanguageChanged() {
        if (this._isOpen) {
            this.render();
        }
    }

    private async _ensureModelLayersInitialized() {
        if (!this._appContext || !this._appContext.hasImportedMesh()) return;
        if (this._modelLayersState || this._modelLayersInitPending) return;
        this._modelLayersInitPending = true;
        try {
            const geom = await this._appContext.fetchCurrentGeometrySnapshot();
            if (geom && !this._modelLayersState) {
                this._modelLayersState = createInitialModelLayersState(geom);
                if (this._isOpen) {
                    this.render();
                }
            }
        } finally {
            this._modelLayersInitPending = false;
        }
    }

    private _recordOp(label: string) {
        this._operationLog.unshift({
            timestamp: Date.now(),
            label,
        });
        if (this._operationLog.length > 40) {
            this._operationLog.length = 40;
        }
    }

    private _getCurrentRecipeParams(): PreprocessRecipeParams {
        const activeTexState = this._selectedMaterialName ?
            this._textureStates.get(this._selectedMaterialName) :
            undefined;
        return {
            weldTolerance: this._weldTolerance,
            decimateRatio: this._decimateRatio,
            minIslandTriangles: this._cleanRemoveIslands ? this._cleanMinIslandTris : 0,
            forceSmoothNormals: this._cleanForceSmoothNormals,
            cropMin: {
                x: this._cropMinPct.x / 100,
                y: this._cropMinPct.y / 100,
                z: this._cropMinPct.z / 100,
            },
            cropMax: {
                x: this._cropMaxPct.x / 100,
                y: this._cropMaxPct.y / 100,
                z: this._cropMaxPct.z / 100,
            },
            filters: activeTexState ? { ...activeTexState.filters } : undefined,
        };
    }

    private async _refreshCheckpoints() {
        try {
            this._checkpoints = await PreprocessStorage.listCheckpoints();
            this._checkpointsLoaded = true;
            if (this._isOpen && this._activeTab === 'storage') {
                this.render();
            }
        } catch {
            this._checkpointsLoaded = true;
        }
    }

    private _disable3DPaint() {
        InteractionManager.Get.setMeshPaintHandler(null);
        this._last3DPoint = null;
    }

    private _sync3DPaintHook() {
        const shouldEnable =
            this._isOpen &&
            this._activeTab === 'textures' &&
            this._is3DPaintEnabled &&
            (this._appContext?.hasImportedMesh() ?? false) &&
            Renderer.Get.getActiveMeshType() === MeshType.TriangleMesh;

        if (shouldEnable) {
            InteractionManager.Get.setMeshPaintHandler((evt) => {
                this._handle3DPaintEvent(evt);
            });
        } else {
            this._disable3DPaint();
        }
    }

    private _getStudioSlots() {
        if (typeof document === 'undefined') return null;
        const topbar = document.getElementById('blender-studio-topbar');
        const toolshelf = document.getElementById('blender-studio-toolshelf');
        const hud = document.getElementById('blender-viewport-hud');
        const inspector = document.getElementById('blender-studio-inspector');
        if (!topbar || !toolshelf || !hud || !inspector) return null;
        return { topbar, toolshelf, hud, inspector };
    }

    public render() {
        if (!this._isOpen) return;
        const slots = this._getStudioSlots();
        if (!slots) return;

        const hasMesh = this._appContext?.hasImportedMesh() ?? false;
        if (!hasMesh && this._activeTab !== 'storage') {
            this._disable3DPaint();
        }

        slots.topbar.innerHTML = this._renderTopbarHTML(hasMesh);
        slots.toolshelf.innerHTML = this._renderToolShelfHTML(hasMesh);
        slots.hud.innerHTML = this._renderViewportHudHTML(hasMesh);
        slots.inspector.innerHTML = this._renderInspectorHTML(hasMesh);

        this._bindTopbarEvents(slots.topbar);
        this._bindToolShelfEvents(slots.toolshelf);
        this._bindInspectorEvents(slots.inspector);

        if (hasMesh && this._activeTab === 'textures') {
            this._drawActiveCanvas();
        }
    }

    private _renderTopbarHTML(hasMesh: boolean): string {
        const isClay = Renderer.Get.isClayShadingEnabled();
        const isWire = Renderer.Get.isWireframeEnabled();
        const isGhost = Renderer.Get.isReferenceGhostEnabled();
        const isGrid = Renderer.Get.isGridEnabled();
        const isAxes = Renderer.Get.isAxesEnabled();
        const isPersp = ArcballCamera.Get.isPerspective();
        const canUndo = this._modelLayerUndoStack.length > 0;
        const canRedo = this._modelLayerRedoStack.length > 0;

        return `
            <div class="bs-top-left">
                <button type="button" class="bs-btn bs-back-btn" id="prep-back-pipeline">${LOC('workspace.back_to_pipeline')}</button>
                <div class="bs-segmented" role="tablist">
                    <button type="button" role="tab" aria-selected="${this._activeTab === 'geometry'}" class="bs-seg-btn ${this._activeTab === 'geometry' ? 'active' : ''}" data-prep-tab="geometry">${LOC('preprocessing.mode_sculpt')}</button>
                    <button type="button" role="tab" aria-selected="${this._activeTab === 'textures'}" class="bs-seg-btn ${this._activeTab === 'textures' ? 'active' : ''}" data-prep-tab="textures">${LOC('preprocessing.mode_paint')}</button>
                    <button type="button" role="tab" aria-selected="${this._activeTab === 'storage'}" class="bs-seg-btn ${this._activeTab === 'storage' ? 'active' : ''}" data-prep-tab="storage">${LOC('preprocessing.mode_presets')}</button>
                </div>
            </div>

            <div class="bs-top-center">
                <div class="bs-tool-pill-group">
                    <button type="button" class="bs-btn-sm ${!isClay ? 'active' : ''}" id="bs-shade-textured">${LOC('preprocessing.view_textured')}</button>
                    <button type="button" class="bs-btn-sm ${isClay ? 'active' : ''}" id="bs-shade-clay">${LOC('preprocessing.view_clay')}</button>
                    <button type="button" class="bs-btn-sm ${isWire ? 'active' : ''}" id="bs-toggle-wire">${LOC('preprocessing.view_wireframe')}</button>
                    <button type="button" class="bs-btn-sm accent-cyan ${isGhost ? 'active' : ''}" id="bs-toggle-ghost" ${hasMesh ? '' : 'disabled'}>${LOC('preprocessing.view_compare_orig')}</button>
                    <button type="button" class="bs-btn-sm ${isGrid ? 'active' : ''}" id="bs-toggle-grid">${LOC('preprocessing.view_grid')}</button>
                    <button type="button" class="bs-btn-sm ${isAxes ? 'active' : ''}" id="bs-toggle-axes">${LOC('preprocessing.view_axes')}</button>
                </div>

                <div class="bs-tool-pill-group">
                    <button type="button" class="bs-btn-sm" data-bs-cam="front">${LOC('preprocessing.cam_front')}</button>
                    <button type="button" class="bs-btn-sm" data-bs-cam="right">${LOC('preprocessing.cam_right')}</button>
                    <button type="button" class="bs-btn-sm" data-bs-cam="top">${LOC('preprocessing.cam_top')}</button>
                    <button type="button" class="bs-btn-sm" data-bs-cam="iso">${LOC('preprocessing.cam_reset')}</button>
                    <button type="button" class="bs-btn-sm ${!isPersp ? 'active' : ''}" id="bs-toggle-proj">${isPersp ? LOC('preprocessing.cam_persp') : LOC('preprocessing.cam_ortho')}</button>
                </div>
            </div>

            <div class="bs-top-right">
                <button type="button" class="bs-btn-sm" id="bs-undo-global" ${canUndo ? '' : 'disabled'} title="${LOC('model_editor.undo')}">↶</button>
                <button type="button" class="bs-btn-sm" id="bs-redo-global" ${canRedo ? '' : 'disabled'} title="Redo">↷</button>
                <button type="button" class="bs-btn" id="bs-quick-snapshot" ${hasMesh ? '' : 'disabled'}>${LOC('preprocessing.layer_snapshot')}</button>
                <button type="button" class="bs-btn" id="prep-export-glb" ${hasMesh ? '' : 'disabled'}>${LOC('model_editor.export_glb')}</button>
                <button type="button" class="bs-btn primary" id="prep-proceed-voxel">${LOC('workspace.proceed_to_voxel')}</button>
            </div>
        `;
    }

    private _renderToolShelfHTML(hasMesh: boolean): string {
        if (this._activeTab === 'storage') {
            return `
                <div class="bs-shelf-group">
                    <button type="button" class="bs-shelf-btn active" data-prep-tab="storage" title="${this._escapeAttr(LOC('preprocessing.mode_presets'))}">
                        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
                        <span>.otsprep</span>
                    </button>
                </div>
            `;
        }

        if (this._activeTab === 'textures') {
            const disabledAttr = hasMesh ? '' : 'disabled';
            return `
                <div class="bs-shelf-group">
                    <button type="button" class="bs-shelf-btn ${this._tool === 'brush' ? 'active' : ''}" data-tool="brush" ${disabledAttr} title="${this._escapeAttr(LOC('model_editor.tool_brush'))}">
                        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M18.37 2.63 14 7l-1.59-1.59a2 2 0 0 0-2.82 0L8 7l9 9 1.59-1.59a2 2 0 0 0 0-2.82L17 10l4.37-4.37a2.12 2.12 0 1 0-3-3Z"/><path d="M9 8c-2 3-4 3.5-7 4l8 10c2-1 6-5 6-7"/></svg>
                        <span>${LOC('model_editor.tool_brush')}</span>
                    </button>
                    <button type="button" class="bs-shelf-btn ${this._tool === 'eraser' ? 'active' : ''}" data-tool="eraser" ${disabledAttr} title="${this._escapeAttr(LOC('model_editor.tool_eraser'))}">
                        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8"><path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21"/><path d="M22 21H7"/><path d="m5 11 9 9"/></svg>
                        <span>${LOC('model_editor.tool_eraser')}</span>
                    </button>
                    <button type="button" class="bs-shelf-btn ${this._tool === 'fill' ? 'active' : ''}" data-tool="fill" ${disabledAttr} title="${this._escapeAttr(LOC('model_editor.tool_fill'))}">
                        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8"><path d="m19 11-8-8-8.6 8.6a2 2 0 0 0 0 2.8l5.2 5.2c.8.8 2 .8 2.8 0L19 11Z"/><path d="m5 2 5 5"/><path d="M2 13h15"/><path d="M22 20a2 2 0 1 1-4 0c0-1.6 1.7-2.4 2-4 .3 1.6 2 2.4 2 4Z"/></svg>
                        <span>${LOC('model_editor.tool_fill')}</span>
                    </button>
                    <button type="button" class="bs-shelf-btn ${this._tool === 'eyedropper' ? 'active' : ''}" data-tool="eyedropper" ${disabledAttr} title="${this._escapeAttr(LOC('model_editor.tool_eyedropper'))}">
                        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8"><path d="m2 22 1-1h3l9-9"/><path d="M3 21v-3l9-9"/><path d="m15 6 3.4-3.4a2.1 2.1 0 1 1 3 3L18 9l.4.4a2.1 2.1 0 1 1-3 3l-3.8-3.8a2.1 2.1 0 1 1 3-3L15 6Z"/></svg>
                        <span>${LOC('model_editor.tool_eyedropper')}</span>
                    </button>
                </div>
                <div class="bs-shelf-divider"></div>
                <div class="bs-shelf-group">
                    <button type="button" class="bs-shelf-btn accent ${this._is3DPaintEnabled ? 'active' : ''}" id="me-paint-3d-toggle" ${disabledAttr} title="${this._escapeAttr(LOC('model_editor.paint_3d'))}">
                        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>
                        <span>3D</span>
                    </button>
                    <button type="button" class="bs-shelf-btn accent ${this._mirrorXBrush ? 'active' : ''}" id="prep-mirror-x-toggle" ${disabledAttr} title="${this._escapeAttr(LOC('preprocessing.mirror_x_brush'))}">
                        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8"><line x1="12" y1="3" x2="12" y2="21"/><polyline points="8 7 3 12 8 17"/><polyline points="16 7 21 12 16 17"/></svg>
                        <span>${LOC('preprocessing.mirror_x_brush')}</span>
                    </button>
                    <button type="button" class="bs-shelf-btn" id="prep-tex-wrap-offset" ${disabledAttr} title="${this._escapeAttr(LOC('preprocessing.tool_wrap_offset'))}">
                        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="8" height="8"/><rect x="13" y="13" width="8" height="8"/><path d="M13 7h6v6"/><path d="M11 17H5v-6"/></svg>
                        <span>${LOC('preprocessing.tool_wrap_offset')}</span>
                    </button>
                </div>
            `;
        }

        const geomTools: Array<{ id: GeomTool; label: string; icon: string }> = [
            {
                id: 'transform',
                label: LOC('preprocessing.tool_transform'),
                icon: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8"><polyline points="5 9 2 12 5 15"/><polyline points="9 5 12 2 15 5"/><polyline points="15 19 12 22 9 19"/><polyline points="19 9 22 12 19 15"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="12" y1="2" x2="12" y2="22"/></svg>',
            },
            {
                id: 'deform',
                label: LOC('preprocessing.tool_deform'),
                icon: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="8"/><path d="M8 12c1.5-2.5 6.5-2.5 8 0"/></svg>',
            },
            {
                id: 'repair',
                label: LOC('preprocessing.tool_repair'),
                icon: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>',
            },
            {
                id: 'decimate',
                label: LOC('preprocessing.tool_decimate'),
                icon: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8"><polygon points="12 2 22 8.5 22 15.5 12 22 2 15.5 2 8.5 12 2"/><line x1="12" y1="22" x2="12" y2="15.5"/><polyline points="22 8.5 12 15.5 2 8.5"/></svg>',
            },
            {
                id: 'crop',
                label: LOC('preprocessing.tool_crop'),
                icon: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M6 2v14a2 2 0 0 0 2 2h14"/><path d="M18 22V8a2 2 0 0 0-2-2H2"/></svg>',
            },
        ];

        return `
            <div class="bs-shelf-group">
                ${geomTools.map((t) => `
                    <button type="button" class="bs-shelf-btn ${this._activeGeomTool === t.id ? 'active' : ''}" data-geom-tool="${t.id}" ${hasMesh ? '' : 'disabled'} title="${this._escapeAttr(t.label)}">
                        ${t.icon}
                        <span>${this._escapeHtml(t.label)}</span>
                    </button>
                `).join('')}
            </div>
        `;
    }

    private _renderViewportHudHTML(hasMesh: boolean): string {
        if (!hasMesh) return '';
        const dims = this._appContext?.getImportedMeshDimensions();
        const diag = this._appContext?.getMeshDiagnostics();
        const tris = diag?.triangleCount ?? this._appContext?.getImportedTriangleCount() ?? 0;
        const verts = diag?.vertexCount ?? 0;
        const dimsStr = dims ? `${dims.x.toFixed(2)} × ${dims.y.toFixed(2)} × ${dims.z.toFixed(2)}` : '—';
        const activeLayer = this._modelLayersState ? getActiveModelLayer(this._modelLayersState) : undefined;
        const layerName = activeLayer?.name ?? 'Base Mesh';

        const hint = this._activeTab === 'textures' && this._is3DPaintEnabled ?
            LOC('preprocessing.hud_paint_hint') :
            LOC('preprocessing.hud_view_hint', { layer: layerName });

        return `
            <div class="bs-hud-card ${this._activeTab === 'textures' && this._is3DPaintEnabled ? 'paint-live' : ''}">
                <div class="bs-hud-stats">
                    <span>${dimsStr}</span>
                    <span>•</span>
                    <span>${LOC('preprocessing.diag_verts', { count: verts })}</span>
                    <span>•</span>
                    <span>${LOC('preprocessing.diag_tris', { count: tris })}</span>
                </div>
                <div class="bs-hud-hint">${this._escapeHtml(hint)}</div>
            </div>
        `;
    }

    private _renderInspectorHTML(hasMesh: boolean): string {
        if (this._activeTab === 'storage') {
            return `<div class="bs-inspector-scroll">${this._renderStorageTabHTML(hasMesh)}</div>`;
        }

        if (!hasMesh) {
            return `
                <div class="bs-inspector-scroll">
                    <div class="model-editor-empty preprocess-empty-card">
                        <p>${LOC('preprocessing.no_mesh_hint')}</p>
                        <button type="button" class="model-editor-btn primary" id="prep-jump-storage">${LOC('preprocessing.mode_presets')}</button>
                    </div>
                </div>
            `;
        }

        const outlinerHTML = this._renderModelLayersOutlinerHTML();
        const toolBodyHTML = this._activeTab === 'geometry' ?
            this._renderActiveGeometryToolHTML() :
            this._renderTexturesTabHTML();

        return `
            ${outlinerHTML}
            <div class="bs-inspector-scroll" data-testid="bs-active-inspector">
                ${toolBodyHTML}
            </div>
        `;
    }

    private _renderModelLayersOutlinerHTML(): string {
        const diag = this._appContext?.getMeshDiagnostics();
        const tris = diag?.triangleCount ?? this._appContext?.getImportedTriangleCount() ?? 0;
        const islands = diag?.connectedComponents ?? 1;
        const isGhost = Renderer.Get.isReferenceGhostEnabled();

        const badges: string[] = [];
        badges.push(`<span class="prep-badge neutral">${LOC('preprocessing.diag_tris', { count: tris })}</span>`);
        badges.push(`<span class="prep-badge ${islands > 1 ? 'warn' : 'neutral'}">${LOC('preprocessing.diag_islands', { count: islands })}</span>`);
        if (diag?.degenerateTriangles) {
            badges.push(`<span class="prep-badge warn">${LOC('preprocessing.diag_degen', { count: diag.degenerateTriangles })}</span>`);
        }
        if (diag?.missingNormalTriangles) {
            badges.push(`<span class="prep-badge warn">${LOC('preprocessing.diag_missing_norm', { count: diag.missingNormalTriangles })}</span>`);
        }

        const layers = this._modelLayersState?.layers ?? [];
        const activeId = this._modelLayersState?.activeLayerId ?? '';
        const nonOrigCount = layers.filter((l) => l.kind !== 'original').length;
        const partCount = layers.filter((l) => l.kind === 'part').length;

        const layersListHTML = !this._modelLayersState ?
            `<div class="prep-empty-sub">...</div>` :
            layers.map((layer) => this._renderModelLayerRowHTML(layer, layer.id === activeId, nonOrigCount, isGhost)).join('');

        return `
            <div class="bs-outliner" data-testid="bs-model-layers-outliner">
                <div class="bs-outliner-head">
                    <span class="bs-panel-title">${LOC('preprocessing.model_layers_title')}</span>
                    <div class="bs-outliner-actions">
                        <button type="button" class="model-editor-btn-xs primary" id="ml-add-snapshot">${LOC('preprocessing.layer_snapshot')}</button>
                        <button type="button" class="model-editor-btn-xs" id="ml-split-parts">${LOC('preprocessing.layer_split_parts')}</button>
                        <button type="button" class="model-editor-btn-xs" id="ml-split-mats">${LOC('preprocessing.layer_split_mats')}</button>
                        ${partCount > 1 ? `<button type="button" class="model-editor-btn-xs accent" id="ml-merge-visible">${LOC('preprocessing.layer_merge_visible')}</button>` : ''}
                    </div>
                </div>
                <div class="bs-layer-list">${layersListHTML}</div>
                <div class="bs-diag-strip" data-testid="prep-diagnostics">${badges.join('')}</div>
            </div>
        `;
    }

    private _renderModelLayerRowHTML(
        layer: ModelLayer,
        isActive: boolean,
        nonOrigCount: number,
        isGhostOn: boolean,
    ): string {
        const isOrig = layer.kind === 'original';
        const isSnap = layer.kind === 'snapshot';
        const badgeText = isOrig ?
            LOC('preprocessing.layer_orig_badge') :
            isSnap ?
                LOC('preprocessing.layer_snap_badge') :
                layer.kind === 'part' ?
                    LOC('preprocessing.layer_part_badge') :
                    LOC('preprocessing.layer_work_badge');

        const eyeActive = isOrig ? isGhostOn : layer.visible;
        const canDelete = !isOrig && nonOrigCount > 1;
        const isRenaming = this._renamingModelLayerId === layer.id;

        const nameHTML = isRenaming ?
            `<input type="text" class="bs-inline-rename" id="ml-rename-input" value="${this._escapeAttr(layer.name)}" data-ml-rename-id="${this._escapeAttr(layer.id)}" />` :
            `<span class="bs-layer-name" data-ml-name-id="${this._escapeAttr(layer.id)}" title="${this._escapeAttr(layer.name)}">${this._escapeHtml(layer.name)}</span>`;

        return `
            <div class="bs-layer-row ${isActive ? 'active' : ''} ${layer.locked ? 'is-locked' : ''} kind-${layer.kind}" data-ml-select="${this._escapeAttr(layer.id)}">
                <button type="button" class="bs-icon-btn ${eyeActive ? 'on' : ''}" data-ml-eye="${this._escapeAttr(layer.id)}" title="${isOrig ? this._escapeAttr(LOC('preprocessing.view_compare_orig')) : 'Toggle visibility'}">
                    ${eyeActive ?
        '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>' :
        '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><line x1="1" y1="1" x2="23" y2="23"/></svg>'}
                </button>
                <span class="bs-layer-badge badge-${layer.kind}">${badgeText}</span>
                ${nameHTML}
                <span class="bs-layer-count">${layer.triangleCount}</span>
                <div class="bs-layer-row-btns">
                    ${!isOrig ? `<button type="button" class="bs-mini-tag ${layer.solo ? 'solo-on' : ''}" data-ml-solo="${this._escapeAttr(layer.id)}" title="${this._escapeAttr(LOC('preprocessing.layer_solo'))}">S</button>` : ''}
                    ${(isOrig || isSnap) ? `<button type="button" class="bs-mini-tag restore" data-ml-restore="${this._escapeAttr(layer.id)}" title="${this._escapeAttr(LOC('preprocessing.layer_rollback'))}">↺</button>` : ''}
                    <button type="button" class="bs-mini-tag" data-ml-dup="${this._escapeAttr(layer.id)}" title="${this._escapeAttr(LOC('preprocessing.layer_dup'))}">⧉</button>
                    ${!isOrig ? `<button type="button" class="bs-mini-tag ${layer.locked ? 'locked-on' : ''}" data-ml-lock="${this._escapeAttr(layer.id)}" title="Lock">${layer.locked ? 'L' : 'U'}</button>` : ''}
                    ${canDelete ? `<button type="button" class="bs-mini-tag danger" data-ml-del="${this._escapeAttr(layer.id)}" title="${this._escapeAttr(LOC('preprocessing.delete_btn'))}">×</button>` : ''}
                </div>
            </div>
        `;
    }

    private _renderActiveGeometryToolHTML(): string {
        const activeLayer = this._modelLayersState ? getActiveModelLayer(this._modelLayersState) : undefined;
        if (activeLayer && (activeLayer.locked || activeLayer.kind === 'original')) {
            return `
                <div class="bs-locked-banner">
                    <p>${LOC('preprocessing.layer_locked_hint')}</p>
                    <div class="model-editor-btn-row-2">
                        <button type="button" class="model-editor-btn primary" id="ml-locked-restore">${LOC('preprocessing.layer_rollback')}</button>
                        <button type="button" class="model-editor-btn" id="ml-locked-dup">${LOC('preprocessing.layer_duplicate_edit')}</button>
                    </div>
                </div>
            `;
        }

        const activeLayerTris = activeLayer?.triangleCount ?? this._appContext?.getImportedTriangleCount() ?? 0;

        switch (this._activeGeomTool) {
            case 'transform':
                return `
                    <div class="model-editor-section">
                        <div class="model-editor-section-head"><span>${LOC('preprocessing.move_label')}</span></div>
                        <div class="model-editor-xyz-grid">
                            <div class="model-editor-axis-input">
                                <span class="axis-tag axis-x">X</span>
                                <input type="number" id="me-move-x" aria-label="Move X" value="0" step="0.1" />
                            </div>
                            <div class="model-editor-axis-input">
                                <span class="axis-tag axis-y">Y</span>
                                <input type="number" id="me-move-y" aria-label="Move Y" value="0" step="0.1" />
                            </div>
                            <div class="model-editor-axis-input">
                                <span class="axis-tag axis-z">Z</span>
                                <input type="number" id="me-move-z" aria-label="Move Z" value="0" step="0.1" />
                            </div>
                        </div>
                        <button type="button" class="model-editor-btn" id="me-apply-move">${LOC('preprocessing.apply_move')}</button>
                    </div>

                    <div class="model-editor-section">
                        <div class="model-editor-section-head">
                            <span>${LOC('model_editor.scale_label')}</span>
                            <label class="model-editor-check-inline">
                                <input type="checkbox" id="me-uniform-scale" ${this._uniformScale ? 'checked' : ''} />
                                <span>${LOC('model_editor.uniform_scale')}</span>
                            </label>
                        </div>
                        <div class="model-editor-xyz-grid">
                            <div class="model-editor-axis-input">
                                <span class="axis-tag axis-x">X</span>
                                <input type="number" id="me-scale-x" aria-label="Scale X" value="1" min="0.05" max="10" step="0.05" />
                            </div>
                            <div class="model-editor-axis-input">
                                <span class="axis-tag axis-y">Y</span>
                                <input type="number" id="me-scale-y" aria-label="Scale Y" value="1" min="0.05" max="10" step="0.05" />
                            </div>
                            <div class="model-editor-axis-input">
                                <span class="axis-tag axis-z">Z</span>
                                <input type="number" id="me-scale-z" aria-label="Scale Z" value="1" min="0.05" max="10" step="0.05" />
                            </div>
                        </div>
                        <div class="model-editor-chip-row">
                            <button type="button" class="model-editor-chip" data-scale-preset="0.5">0.5×</button>
                            <button type="button" class="model-editor-chip" data-scale-preset="1.5">1.5×</button>
                            <button type="button" class="model-editor-chip" data-scale-preset="2">2×</button>
                            <button type="button" class="model-editor-chip" data-scale-preset="1">1.0</button>
                        </div>
                    </div>

                    <div class="model-editor-section">
                        <div class="model-editor-section-head"><span>${LOC('model_editor.rotate_label')}</span></div>
                        <div class="model-editor-xyz-grid">
                            <div class="model-editor-axis-input">
                                <span class="axis-tag axis-x">X</span>
                                <input type="number" id="me-rot-x" aria-label="Rotate X" value="0" step="5" />
                            </div>
                            <div class="model-editor-axis-input">
                                <span class="axis-tag axis-y">Y</span>
                                <input type="number" id="me-rot-y" aria-label="Rotate Y" value="0" step="5" />
                            </div>
                            <div class="model-editor-axis-input">
                                <span class="axis-tag axis-z">Z</span>
                                <input type="number" id="me-rot-z" aria-label="Rotate Z" value="0" step="5" />
                            </div>
                        </div>
                        <div class="model-editor-quick-rot-grid">
                            <button type="button" class="model-editor-btn-sm" data-quick-rot="x:-90">X -90°</button>
                            <button type="button" class="model-editor-btn-sm" data-quick-rot="x:90">X +90°</button>
                            <button type="button" class="model-editor-btn-sm" data-quick-rot="y:-90">Y -90°</button>
                            <button type="button" class="model-editor-btn-sm" data-quick-rot="y:90">Y +90°</button>
                            <button type="button" class="model-editor-btn-sm" data-quick-rot="z:-90">Z -90°</button>
                            <button type="button" class="model-editor-btn-sm" data-quick-rot="z:90">Z +90°</button>
                        </div>
                        <button type="button" class="model-editor-btn primary" id="me-apply-transform">${LOC('model_editor.apply_transform')}</button>
                    </div>

                    <div class="model-editor-section">
                        <div class="model-editor-section-head"><span>${LOC('model_editor.mirror_label')} & Origin</span></div>
                        <div class="model-editor-btn-row-3">
                            <button type="button" class="model-editor-btn" data-mirror-axis="x">${LOC('model_editor.flip_x')}</button>
                            <button type="button" class="model-editor-btn" data-mirror-axis="y">${LOC('model_editor.flip_y')}</button>
                            <button type="button" class="model-editor-btn" data-mirror-axis="z">${LOC('model_editor.flip_z')}</button>
                        </div>
                        <div class="model-editor-btn-row-3">
                            <button type="button" class="model-editor-btn" id="me-center-btn">${LOC('model_editor.center_mesh')}</button>
                            <button type="button" class="model-editor-btn" id="me-ground-btn">${LOC('preprocessing.op_ground_y0')}</button>
                            <button type="button" class="model-editor-btn" id="me-normalize-btn">${LOC('preprocessing.op_normalize_size')}</button>
                        </div>
                    </div>
                `;

            case 'deform':
                return `
                    <div class="model-editor-section">
                        <div class="model-editor-section-head"><span>${LOC('preprocessing.sculpt_smooth_title')}</span></div>
                        <label class="model-editor-slider-inline">
                            <span>${LOC('preprocessing.smooth_factor')}: <b id="bs-smooth-fac-val">${Math.round(this._smoothFactor * 100)}%</b></span>
                            <input type="range" id="bs-smooth-factor" min="10" max="90" step="5" value="${Math.round(this._smoothFactor * 100)}" />
                        </label>
                        <label class="model-editor-slider-inline">
                            <span>${LOC('preprocessing.smooth_iters')}: <b id="bs-smooth-it-val">${this._smoothIterations}</b></span>
                            <input type="range" id="bs-smooth-iters" min="1" max="8" step="1" value="${this._smoothIterations}" />
                        </label>
                        <button type="button" class="model-editor-btn primary" id="bs-apply-smooth">${LOC('preprocessing.apply_smooth')}</button>
                    </div>

                    <div class="model-editor-section">
                        <div class="model-editor-section-head"><span>${LOC('preprocessing.sculpt_inflate_title')}</span></div>
                        <label class="model-editor-slider-inline">
                            <span>${LOC('preprocessing.inflate_amount')}: <b id="bs-inflate-val">${this._inflateAmountPct > 0 ? `+${this._inflateAmountPct}` : this._inflateAmountPct}%</b></span>
                            <input type="range" id="bs-inflate-slider" min="-25" max="25" step="1" value="${this._inflateAmountPct}" />
                        </label>
                        <button type="button" class="model-editor-btn" id="bs-apply-inflate">${LOC('preprocessing.apply_inflate')}</button>
                    </div>

                    <div class="model-editor-section">
                        <div class="model-editor-section-head"><span>${LOC('preprocessing.sculpt_symmetrize_title')}</span></div>
                        <div class="model-editor-btn-row-2">
                            <button type="button" class="model-editor-btn" data-sym="x:posToNeg">${LOC('preprocessing.sym_x_pos_neg')}</button>
                            <button type="button" class="model-editor-btn" data-sym="x:negToPos">${LOC('preprocessing.sym_x_neg_pos')}</button>
                            <button type="button" class="model-editor-btn" data-sym="z:posToNeg">${LOC('preprocessing.sym_z_pos_neg')}</button>
                            <button type="button" class="model-editor-btn" data-sym="z:negToPos">${LOC('preprocessing.sym_z_neg_pos')}</button>
                        </div>
                    </div>

                    <div class="model-editor-section">
                        <div class="model-editor-section-head"><span>${LOC('model_editor.geom_tools')}</span></div>
                        <div class="model-editor-btn-row-3">
                            <button type="button" class="model-editor-btn" id="me-normals-btn">${LOC('model_editor.recompute_normals')}</button>
                            <button type="button" class="model-editor-btn" id="me-flat-normals-btn">${LOC('preprocessing.op_flat_normals')}</button>
                            <button type="button" class="model-editor-btn" id="me-flip-normals-btn">${LOC('model_editor.flip_normals')}</button>
                        </div>
                    </div>
                `;

            case 'repair':
                return `
                    <div class="model-editor-section">
                        <div class="model-editor-section-head"><span>${LOC('preprocessing.op_weld')}</span></div>
                        <div class="prep-inline-control">
                            <label for="prep-weld-tol">${LOC('preprocessing.weld_tol')}</label>
                            <select id="prep-weld-tol" class="model-editor-select">
                                <option value="0.0001" ${Math.abs(this._weldTolerance - 0.0001) < 1e-6 ? 'selected' : ''}>0.0001 (Exact)</option>
                                <option value="0.0005" ${Math.abs(this._weldTolerance - 0.0005) < 1e-6 ? 'selected' : ''}>0.0005</option>
                                <option value="0.001" ${Math.abs(this._weldTolerance - 0.001) < 1e-6 ? 'selected' : ''}>0.001</option>
                                <option value="0.005" ${Math.abs(this._weldTolerance - 0.005) < 1e-6 ? 'selected' : ''}>0.005</option>
                                <option value="0.01" ${Math.abs(this._weldTolerance - 0.01) < 1e-6 ? 'selected' : ''}>0.01 (Coarse)</option>
                            </select>
                            <button type="button" class="model-editor-btn" id="prep-weld-btn">${LOC('preprocessing.op_weld')}</button>
                        </div>
                    </div>

                    <div class="model-editor-section">
                        <div class="model-editor-section-head"><span>${LOC('preprocessing.op_clean_repair')}</span></div>
                        <div class="prep-clean-options">
                            <label class="model-editor-check-inline">
                                <input type="checkbox" id="prep-clean-islands" ${this._cleanRemoveIslands ? 'checked' : ''} />
                                <span>${LOC('preprocessing.remove_islands')}</span>
                            </label>
                            <div class="prep-mini-num-wrap">
                                <label for="prep-clean-min-tris">${LOC('preprocessing.min_island_tris')}</label>
                                <input type="number" id="prep-clean-min-tris" min="2" max="500" step="1" value="${this._cleanMinIslandTris}" ${this._cleanRemoveIslands ? '' : 'disabled'} />
                            </div>
                        </div>
                        <label class="model-editor-check-inline">
                            <input type="checkbox" id="prep-clean-smooth-normals" ${this._cleanForceSmoothNormals ? 'checked' : ''} />
                            <span>${LOC('preprocessing.force_smooth_normals')}</span>
                        </label>
                        <button type="button" class="model-editor-btn primary" id="prep-clean-btn">${LOC('preprocessing.op_clean_repair')}</button>
                    </div>
                `;

            case 'decimate': {
                const estSimplified = Math.max(4, Math.round(activeLayerTris * this._decimateRatio));
                return `
                    <div class="model-editor-section">
                        <div class="model-editor-section-head">
                            <span>${LOC('preprocessing.op_simplify')}</span>
                            <span class="model-editor-mono" id="prep-decimate-est">${LOC('preprocessing.est_tris', { count: estSimplified })}</span>
                        </div>
                        <label class="model-editor-slider-inline">
                            <span>${LOC('preprocessing.target_ratio')}: <b id="prep-decimate-val">${Math.round(this._decimateRatio * 100)}%</b></span>
                            <input type="range" id="prep-decimate-ratio" min="10" max="95" step="5" value="${Math.round(this._decimateRatio * 100)}" />
                        </label>
                        <button type="button" class="model-editor-btn primary" id="prep-decimate-btn">${LOC('preprocessing.op_simplify')}</button>
                    </div>
                `;
            }

            case 'crop':
                return `
                    <div class="model-editor-section">
                        <div class="model-editor-section-head"><span>${LOC('preprocessing.op_crop')} (%)</span></div>
                        <div class="prep-crop-grid">
                            <div class="prep-crop-axis">
                                <span class="axis-tag axis-x">X</span>
                                <input type="number" id="prep-crop-xmin" aria-label="Crop X Min %" min="0" max="99" step="5" value="${this._cropMinPct.x}" />
                                <span class="prep-crop-dash">–</span>
                                <input type="number" id="prep-crop-xmax" aria-label="Crop X Max %" min="1" max="100" step="5" value="${this._cropMaxPct.x}" />
                            </div>
                            <div class="prep-crop-axis">
                                <span class="axis-tag axis-y">Y</span>
                                <input type="number" id="prep-crop-ymin" aria-label="Crop Y Min %" min="0" max="99" step="5" value="${this._cropMinPct.y}" />
                                <span class="prep-crop-dash">–</span>
                                <input type="number" id="prep-crop-ymax" aria-label="Crop Y Max %" min="1" max="100" step="5" value="${this._cropMaxPct.y}" />
                            </div>
                            <div class="prep-crop-axis">
                                <span class="axis-tag axis-z">Z</span>
                                <input type="number" id="prep-crop-zmin" aria-label="Crop Z Min %" min="0" max="99" step="5" value="${this._cropMinPct.z}" />
                                <span class="prep-crop-dash">–</span>
                                <input type="number" id="prep-crop-zmax" aria-label="Crop Z Max %" min="1" max="100" step="5" value="${this._cropMaxPct.z}" />
                            </div>
                        </div>
                        <div class="model-editor-btn-row-2">
                            <button type="button" class="model-editor-btn primary" id="prep-crop-apply">${LOC('preprocessing.crop_apply')}</button>
                            <button type="button" class="model-editor-btn" id="prep-crop-reset">${LOC('preprocessing.crop_reset')}</button>
                        </div>
                    </div>
                `;
        }
    }

    private _renderTexturesTabHTML(): string {
        const materialMap = this._appContext?.getMaterialManager().materials;
        if (!materialMap || materialMap.size === 0) {
            return `<div class="model-editor-empty">${LOC('materials.components.no_materials_loaded')}</div>`;
        }

        const matNames = Array.from(materialMap.keys());
        if (!this._selectedMaterialName || !materialMap.has(this._selectedMaterialName)) {
            const firstTextured = matNames.find((name) => materialMap.get(name)?.type === MaterialType.textured);
            this._selectedMaterialName = firstTextured ?? matNames[0];
        }

        const matName = this._selectedMaterialName;
        const mat = materialMap.get(matName)!;

        const optionsHTML = matNames.map((name) => {
            const m = materialMap.get(name)!;
            const badge = m.type === MaterialType.textured ? '[T]' : '[C]';
            const sel = name === matName ? 'selected' : '';
            return `<option value="${this._escapeAttr(name)}" ${sel}>${badge} ${this._escapeHtml(name)}</option>`;
        }).join('');

        const selectorRow = `
            <div class="model-editor-mat-row">
                <label for="me-material-select">${LOC('model_editor.material_label')}</label>
                <select id="me-material-select" class="model-editor-select">${optionsHTML}</select>
            </div>
        `;

        const resSelectorHTML = `
            <div class="prep-inline-control">
                <label for="prep-tex-res">${LOC('preprocessing.tex_res_label')}</label>
                <select id="prep-tex-res" class="model-editor-select">
                    <option value="128" ${this._textureResolution === 128 ? 'selected' : ''}>128 × 128</option>
                    <option value="256" ${this._textureResolution === 256 ? 'selected' : ''}>256 × 256</option>
                    <option value="512" ${this._textureResolution === 512 ? 'selected' : ''}>512 × 512</option>
                </select>
            </div>
        `;

        if (mat.type === MaterialType.solid) {
            const hex = rgbFloatToHex(mat.colour.r, mat.colour.g, mat.colour.b);
            return `
                ${selectorRow}
                <div class="model-editor-solid-box">
                    <p class="model-editor-hint">${LOC('model_editor.solid_hint')}</p>
                    <div class="model-editor-solid-color-row">
                        <label for="me-solid-color">${LOC('model_editor.solid_color')}</label>
                        <input type="color" id="me-solid-color" value="${hex}" />
                        <span class="model-editor-mono" id="me-solid-hex">${hex.toUpperCase()}</span>
                    </div>
                    ${resSelectorHTML}
                    <button type="button" class="model-editor-btn primary" id="me-convert-solid-btn">${LOC('preprocessing.convert_to_texture_res', { res: this._textureResolution })}</button>
                </div>
            `;
        }

        if (!mat.diffuse) {
            return `
                ${selectorRow}
                <div class="model-editor-solid-box">
                    <p class="model-editor-hint">${LOC('model_editor.no_diffuse')}</p>
                    ${resSelectorHTML}
                    <button type="button" class="model-editor-btn primary" id="me-init-blank-btn">${LOC('preprocessing.init_blank_res', { res: this._textureResolution })}</button>
                </div>
            `;
        }

        const state = this._textureStates.get(matName);
        if (!state) {
            this._ensureTextureLoaded(matName, mat);
            return `
                ${selectorRow}
                <div class="model-editor-empty">Loading texture...</div>
            `;
        }

        const activeLayer = getActiveTextureLayer(state.layerStack);
        const filters = state.filters;
        const dimsBadge = LOC('model_editor.tex_info', { w: state.width, h: state.height });
        const canUndoLayer = Boolean(activeLayer && activeLayer.undoStack.length > 0);
        const layersTopFirst = [...state.layerStack.layers].reverse();

        return `
            ${selectorRow}
            <div class="model-editor-brush-row">
                <div class="model-editor-color-wrap">
                    <input type="color" id="me-brush-color" aria-label="Brush color" value="${this._brushColor}" />
                    <span class="model-editor-mono" id="me-brush-hex">${this._brushColor.toUpperCase()}</span>
                </div>
                <label class="model-editor-slider-inline">
                    <span>${LOC('model_editor.brush_size')} (<b id="me-brush-size-val">${this._brushSize}</b>)</span>
                    <input type="range" id="me-brush-size" min="1" max="48" step="1" value="${this._brushSize}" />
                </label>
                <label class="model-editor-slider-inline">
                    <span>${LOC('model_editor.brush_hardness')} (<b id="me-brush-hard-val">${Math.round(this._brushHardness * 100)}%</b>)</span>
                    <input type="range" id="me-brush-hardness" min="0" max="100" step="5" value="${Math.round(this._brushHardness * 100)}" />
                </label>
            </div>

            ${activeLayer?.locked ? `<div class="bs-locked-banner compact">${LOC('preprocessing.tex_layer_locked_hint')}</div>` : ''}

            <div class="model-editor-canvas-bar">
                <span class="model-editor-mono">${dimsBadge}</span>
                <div class="model-editor-zoom-btns">
                    <button type="button" class="model-editor-btn-xs" id="me-zoom-out" aria-label="Zoom out texture">−</button>
                    <span class="model-editor-mono" id="me-zoom-val">${this._zoomPercent}%</span>
                    <button type="button" class="model-editor-btn-xs" id="me-zoom-in" aria-label="Zoom in texture">+</button>
                </div>
            </div>

            <div class="model-editor-canvas-wrap">
                <div class="model-editor-checkerboard">
                    <canvas id="me-texture-canvas" class="model-editor-canvas" width="${state.width}" height="${state.height}"></canvas>
                </div>
            </div>

            <div class="prep-tex-ops-row">
                <button type="button" class="model-editor-btn-xs" id="prep-tex-flip-h">${LOC('preprocessing.flip_h')}</button>
                <button type="button" class="model-editor-btn-xs" id="prep-tex-flip-v">${LOC('preprocessing.flip_v')}</button>
                <button type="button" class="model-editor-btn-xs" id="prep-tex-rot-90">${LOC('preprocessing.rotate_90')}</button>
                <button type="button" class="model-editor-btn-xs" id="prep-tex-auto-levels">${LOC('preprocessing.auto_levels')}</button>
            </div>

            <div class="model-editor-section bs-tex-layers-box" data-testid="bs-texture-layers">
                <div class="model-editor-section-head">
                    <span>${LOC('preprocessing.tex_layers_title')}</span>
                    <div class="model-editor-mini-actions">
                        <button type="button" class="model-editor-btn-xs primary" id="tl-add">${LOC('preprocessing.tex_layer_add')}</button>
                        <button type="button" class="model-editor-btn-xs" id="tl-dup">${LOC('preprocessing.tex_layer_dup')}</button>
                        <button type="button" class="model-editor-btn-xs" id="tl-merge">${LOC('preprocessing.tex_layer_merge')}</button>
                        <button type="button" class="model-editor-btn-xs" id="tl-flatten">${LOC('preprocessing.tex_layer_flatten')}</button>
                    </div>
                </div>
                ${activeLayer ? `
                    <div class="bs-tl-controls">
                        <select id="tl-blend-mode" class="model-editor-select" aria-label="${this._escapeAttr(LOC('preprocessing.tex_layer_blend'))}">
                            ${(['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten'] as TextureBlendMode[]).map((m) => `
                                <option value="${m}" ${activeLayer.blendMode === m ? 'selected' : ''}>${LOC(`preprocessing.blend_${m}` as any)}</option>
                            `).join('')}
                        </select>
                        <label class="model-editor-slider-inline">
                            <span>${LOC('preprocessing.tex_layer_opacity')} <b id="tl-opacity-val">${Math.round(activeLayer.opacity * 100)}%</b></span>
                            <input type="range" id="tl-opacity" min="0" max="100" step="5" value="${Math.round(activeLayer.opacity * 100)}" />
                        </label>
                    </div>
                ` : ''}
                <div class="bs-layer-list">
                    ${layersTopFirst.map((tl) => this._renderTextureLayerRowHTML(tl, tl.id === state.layerStack.activeLayerId, state.layerStack.layers.length)).join('')}
                </div>
            </div>

            <div class="model-editor-section">
                <button type="button" class="bs-accordion-toggle" id="tl-toggle-adjustments">
                    <span>${LOC('preprocessing.tex_adjustments_toggle')}</span>
                    <span>${this._adjustmentsExpanded ? '▾' : '▸'}</span>
                </button>
                ${this._adjustmentsExpanded ? `
                    <div class="model-editor-filters-grid bs-adj-grid">
                        <label class="model-editor-filter-row">
                            <span>${LOC('model_editor.filter_brightness')}</span>
                            <input type="range" id="me-f-brightness" min="-100" max="100" step="2" value="${filters.brightness}" />
                            <span class="model-editor-mono" id="me-f-brightness-val">${filters.brightness}</span>
                        </label>
                        <label class="model-editor-filter-row">
                            <span>${LOC('model_editor.filter_contrast')}</span>
                            <input type="range" id="me-f-contrast" min="-100" max="100" step="2" value="${filters.contrast}" />
                            <span class="model-editor-mono" id="me-f-contrast-val">${filters.contrast}</span>
                        </label>
                        <label class="model-editor-filter-row">
                            <span>${LOC('model_editor.filter_saturation')}</span>
                            <input type="range" id="me-f-saturation" min="-100" max="100" step="2" value="${filters.saturation}" />
                            <span class="model-editor-mono" id="me-f-saturation-val">${filters.saturation}</span>
                        </label>
                        <label class="model-editor-filter-row">
                            <span>${LOC('model_editor.filter_hue')}</span>
                            <input type="range" id="me-f-hue" min="-180" max="180" step="5" value="${filters.hue}" />
                            <span class="model-editor-mono" id="me-f-hue-val">${filters.hue}°</span>
                        </label>
                        <label class="model-editor-filter-row">
                            <span>${LOC('preprocessing.filter_gamma')}</span>
                            <input type="range" id="me-f-gamma" min="-100" max="100" step="2" value="${filters.gamma ?? 0}" />
                            <span class="model-editor-mono" id="me-f-gamma-val">${filters.gamma ?? 0}</span>
                        </label>
                        <label class="model-editor-filter-row">
                            <span>${LOC('preprocessing.filter_warmth')}</span>
                            <input type="range" id="me-f-warmth" min="-100" max="100" step="2" value="${filters.warmth ?? 0}" />
                            <span class="model-editor-mono" id="me-f-warmth-val">${filters.warmth ?? 0}</span>
                        </label>
                        <label class="model-editor-filter-row">
                            <span>${LOC('preprocessing.filter_sharpen')}</span>
                            <input type="range" id="me-f-sharpen" min="0" max="100" step="5" value="${filters.sharpen ?? 0}" />
                            <span class="model-editor-mono" id="me-f-sharpen-val">${filters.sharpen ?? 0}</span>
                        </label>
                        <label class="model-editor-filter-row">
                            <span>${LOC('preprocessing.filter_blur')}</span>
                            <input type="range" id="me-f-blur" min="0" max="100" step="5" value="${filters.blur ?? 0}" />
                            <span class="model-editor-mono" id="me-f-blur-val">${filters.blur ?? 0}</span>
                        </label>
                        <label class="model-editor-filter-row">
                            <span>${LOC('model_editor.filter_posterize')}</span>
                            <input type="range" id="me-f-posterize" min="0" max="16" step="1" value="${filters.posterize}" />
                            <span class="model-editor-mono" id="me-f-posterize-val">${filters.posterize === 0 ? 'Off' : filters.posterize}</span>
                        </label>
                        <label class="model-editor-filter-row">
                            <span>${LOC('preprocessing.tex_pixelize')}</span>
                            <input type="range" id="me-f-pixelize" min="1" max="16" step="1" value="${state.pixelizeSize}" />
                            <span class="model-editor-mono" id="me-f-pixelize-val">${state.pixelizeSize === 1 ? 'Off' : `${state.pixelizeSize}px`}</span>
                        </label>
                    </div>
                    <div class="model-editor-btn-row-2">
                        <button type="button" class="model-editor-btn-xs primary" id="me-commit-filters">${LOC('model_editor.commit_filters')}</button>
                        <button type="button" class="model-editor-btn-xs" id="me-reset-filters">${LOC('model_editor.reset_filters')}</button>
                    </div>
                ` : ''}
            </div>

            <div class="model-editor-footer">
                <button type="button" class="model-editor-btn primary" id="me-apply-texture">${LOC('model_editor.apply_texture')}</button>
                <button type="button" class="model-editor-btn" id="me-undo-texture" ${canUndoLayer ? '' : 'disabled'}>${LOC('model_editor.undo')}</button>
                <button type="button" class="model-editor-btn" id="me-reset-texture" ${state.originalRaw ? '' : 'disabled'}>${LOC('model_editor.reset_original')}</button>
                <button type="button" class="model-editor-btn" id="me-download-png">${LOC('model_editor.download_png')}</button>
            </div>
        `;
    }

    private _renderTextureLayerRowHTML(tl: TextureLayer, isActive: boolean, totalLayers: number): string {
        return `
            <div class="bs-layer-row ${isActive ? 'active' : ''} ${tl.locked ? 'is-locked' : ''}" data-tl-select="${this._escapeAttr(tl.id)}">
                <button type="button" class="bs-icon-btn ${tl.visible ? 'on' : ''}" data-tl-eye="${this._escapeAttr(tl.id)}" title="Toggle visibility">
                    ${tl.visible ?
        '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>' :
        '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><line x1="1" y1="1" x2="23" y2="23"/><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/></svg>'}
                </button>
                <span class="bs-layer-name" title="${this._escapeAttr(tl.name)}">${this._escapeHtml(tl.name)}</span>
                <span class="bs-layer-count">${Math.round(tl.opacity * 100)}%</span>
                <div class="bs-layer-row-btns">
                    <button type="button" class="bs-mini-tag" data-tl-up="${this._escapeAttr(tl.id)}" title="Move Up">↑</button>
                    <button type="button" class="bs-mini-tag" data-tl-dn="${this._escapeAttr(tl.id)}" title="Move Down">↓</button>
                    <button type="button" class="bs-mini-tag ${tl.locked ? 'locked-on' : ''}" data-tl-lock="${this._escapeAttr(tl.id)}" title="Lock">${tl.locked ? 'L' : 'U'}</button>
                    ${totalLayers > 1 ? `<button type="button" class="bs-mini-tag danger" data-tl-del="${this._escapeAttr(tl.id)}" title="Delete">×</button>` : ''}
                </div>
            </div>
        `;
    }

    private _renderStorageTabHTML(hasMesh: boolean): string {
        const defaultName = this._appContext?.getLoadedFilename() || 'model';
        const checkpointsHTML = !this._checkpointsLoaded ?
            `<div class="prep-empty-sub">Loading...</div>` :
            this._checkpoints.length === 0 ?
                `<div class="prep-empty-sub">${LOC('preprocessing.no_checkpoints')}</div>` :
                this._checkpoints.map((cp) => `
                    <div class="prep-saved-item">
                        <div class="prep-saved-meta">
                            <div class="prep-saved-name" title="${this._escapeAttr(cp.name)}">${this._escapeHtml(cp.name)}</div>
                            <div class="prep-saved-sub">${formatShortTime(cp.savedAt)} • ${cp.triangleCount} tris • ${cp.materialCount} mats</div>
                        </div>
                        <div class="prep-saved-actions">
                            <button type="button" class="model-editor-btn-xs primary" data-cp-load="${this._escapeAttr(cp.id)}">${LOC('preprocessing.restore_btn')}</button>
                            <button type="button" class="model-editor-btn-xs danger" data-cp-del="${this._escapeAttr(cp.id)}">${LOC('preprocessing.delete_btn')}</button>
                        </div>
                    </div>
                `).join('');

        const recipesHTML = this._recipes.length === 0 ?
            `<div class="prep-empty-sub">${LOC('preprocessing.no_recipes')}</div>` :
            this._recipes.map((rcp) => `
                <div class="prep-saved-item">
                    <div class="prep-saved-meta">
                        <div class="prep-saved-name" title="${this._escapeAttr(rcp.name)}">${this._escapeHtml(rcp.name)}</div>
                        <div class="prep-saved-sub">${Math.round(rcp.params.decimateRatio * 100)}% tris • weld ${rcp.params.weldTolerance}</div>
                    </div>
                    <div class="prep-saved-actions">
                        <button type="button" class="model-editor-btn-xs" data-recipe-apply="${this._escapeAttr(rcp.id)}">${LOC('preprocessing.apply_recipe')}</button>
                        <button type="button" class="model-editor-btn-xs danger" data-recipe-del="${this._escapeAttr(rcp.id)}">${LOC('preprocessing.delete_btn')}</button>
                    </div>
                </div>
            `).join('');

        const historyHTML = this._operationLog.length === 0 ?
            `<div class="prep-empty-sub">${LOC('preprocessing.no_history')}</div>` :
            this._operationLog.map((op) => `
                <div class="prep-history-item">
                    <span class="prep-history-time">${formatShortTime(op.timestamp)}</span>
                    <span class="prep-history-label">${this._escapeHtml(op.label)}</span>
                </div>
            `).join('');

        return `
            <div class="model-editor-section">
                <div class="model-editor-section-head"><span>${LOC('preprocessing.checkpoints_title')}</span></div>
                <div class="prep-input-row">
                    <input type="text" id="prep-cp-name" class="prep-text-input" value="${this._escapeAttr(defaultName)}" placeholder="${this._escapeAttr(LOC('preprocessing.checkpoint_name_ph'))}" />
                    <button type="button" class="model-editor-btn primary" id="prep-save-cp" ${hasMesh ? '' : 'disabled'}>${LOC('preprocessing.save_checkpoint')}</button>
                </div>
                <div class="prep-saved-list" data-testid="prep-checkpoints-list">${checkpointsHTML}</div>
            </div>

            <div class="model-editor-section">
                <div class="model-editor-section-head"><span>${LOC('preprocessing.bundle_title')}</span></div>
                <div class="model-editor-btn-row-2">
                    <button type="button" class="model-editor-btn" id="prep-export-bundle" ${hasMesh ? '' : 'disabled'}>${LOC('preprocessing.export_bundle')}</button>
                    <button type="button" class="model-editor-btn" id="prep-import-bundle-btn">${LOC('preprocessing.import_bundle')}</button>
                </div>
                <input type="file" id="prep-import-bundle-input" accept=".json,.otsprep.json" class="hide" />
            </div>

            <div class="model-editor-section">
                <div class="model-editor-section-head"><span>${LOC('preprocessing.recipes_title')}</span></div>
                <div class="prep-input-row">
                    <input type="text" id="prep-recipe-name" class="prep-text-input" placeholder="${this._escapeAttr(LOC('preprocessing.recipe_name_ph'))}" />
                    <button type="button" class="model-editor-btn" id="prep-save-recipe">${LOC('preprocessing.save_recipe')}</button>
                </div>
                <div class="prep-saved-list" data-testid="prep-recipes-list">${recipesHTML}</div>
            </div>

            <div class="model-editor-section">
                <div class="model-editor-section-head"><span>${LOC('preprocessing.history_title')}</span></div>
                <div class="prep-history-list">${historyHTML}</div>
            </div>
        `;
    }

    private _bindTopbarEvents(topbar: HTMLElement) {
        topbar.querySelector('#prep-back-pipeline')?.addEventListener('click', () => {
            this._onProceedToPipeline?.();
        });
        topbar.querySelector('#prep-proceed-voxel')?.addEventListener('click', () => {
            this._onProceedToPipeline?.();
        });
        topbar.querySelector('#prep-export-glb')?.addEventListener('click', async () => {
            await this._appContext?.exportRepairedGlb({ preserveCurrentGeometry: true });
        });

        topbar.querySelectorAll('[data-prep-tab]').forEach((btn) => {
            btn.addEventListener('click', () => {
                const tab = btn.getAttribute('data-prep-tab') as PreprocessTab;
                if (tab && tab !== this._activeTab) {
                    this._activeTab = tab;
                    if (tab === 'storage') {
                        this._recipes = PreprocessStorage.listRecipes();
                        this._refreshCheckpoints();
                    }
                    this.render();
                    this._sync3DPaintHook();
                }
            });
        });

        topbar.querySelector('#bs-shade-textured')?.addEventListener('click', () => {
            Renderer.Get.setClayShadingEnabled(false);
            this.render();
        });
        topbar.querySelector('#bs-shade-clay')?.addEventListener('click', () => {
            Renderer.Get.setClayShadingEnabled(true);
            this.render();
        });
        topbar.querySelector('#bs-toggle-wire')?.addEventListener('click', () => {
            Renderer.Get.toggleIsWireframeEnabled();
            this.render();
        });
        topbar.querySelector('#bs-toggle-ghost')?.addEventListener('click', () => {
            Renderer.Get.setReferenceGhostEnabled(!Renderer.Get.isReferenceGhostEnabled());
            this.render();
        });
        topbar.querySelector('#bs-toggle-grid')?.addEventListener('click', () => {
            Renderer.Get.toggleIsGridEnabled();
            this.render();
        });
        topbar.querySelector('#bs-toggle-axes')?.addEventListener('click', () => {
            Renderer.Get.toggleIsAxesEnabled();
            this.render();
        });
        topbar.querySelector('#bs-toggle-proj')?.addEventListener('click', () => {
            ArcballCamera.Get.setCameraMode(ArcballCamera.Get.isPerspective() ? 'orthographic' : 'perspective');
            this.render();
        });

        topbar.querySelectorAll('[data-bs-cam]').forEach((btn) => {
            btn.addEventListener('click', () => {
                const preset = btn.getAttribute('data-bs-cam') as 'front' | 'right' | 'top' | 'iso';
                if (preset) {
                    ArcballCamera.Get.snapToPreset(preset);
                }
            });
        });

        topbar.querySelector('#bs-undo-global')?.addEventListener('click', () => this._undoModelLayerState());
        topbar.querySelector('#bs-redo-global')?.addEventListener('click', () => this._redoModelLayerState());
        topbar.querySelector('#bs-quick-snapshot')?.addEventListener('click', () => this._createSnapshotFromCurrent());
    }

    private _bindToolShelfEvents(shelf: HTMLElement) {
        shelf.querySelectorAll('[data-geom-tool]').forEach((btn) => {
            btn.addEventListener('click', () => {
                const t = btn.getAttribute('data-geom-tool') as GeomTool;
                if (t) {
                    this._activeGeomTool = t;
                    this.render();
                }
            });
        });

        shelf.querySelectorAll('[data-tool]').forEach((btn) => {
            btn.addEventListener('click', () => {
                const t = btn.getAttribute('data-tool') as PaintTool;
                if (t) {
                    this._tool = t;
                    this.render();
                }
            });
        });

        shelf.querySelector('#me-paint-3d-toggle')?.addEventListener('click', () => {
            this._is3DPaintEnabled = !this._is3DPaintEnabled;
            this.render();
            this._sync3DPaintHook();
        });

        shelf.querySelector('#prep-mirror-x-toggle')?.addEventListener('click', () => {
            this._mirrorXBrush = !this._mirrorXBrush;
            this.render();
        });

        shelf.querySelector('#prep-tex-wrap-offset')?.addEventListener('click', () => {
            if (!this._selectedMaterialName) return;
            const state = this._textureStates.get(this._selectedMaterialName);
            if (!state) return;
            const dx = Math.floor(state.width / 2);
            const dy = Math.floor(state.height / 2);
            state.layerStack = {
                ...state.layerStack,
                layers: state.layerStack.layers.map((l) => ({
                    ...l,
                    undoStack: [...l.undoStack, new Uint8ClampedArray(l.pixels)].slice(-15),
                    pixels: offsetRgbaWrap(l.pixels, state.width, state.height, dx, dy),
                })),
            };
            this._recomputeWorkingPixels(state);
            this._recordOp(`Tile Wrap Offset 50% (${this._selectedMaterialName})`);
            this.render();
            this._scheduleLiveTextureSync(this._selectedMaterialName, true);
        });
    }

    private _bindInspectorEvents(inspector: HTMLElement) {
        inspector.querySelector('#prep-jump-storage')?.addEventListener('click', () => {
            this.setActiveSubTab('storage');
        });

        if (this._activeTab === 'storage') {
            this._bindStorageEvents(inspector);
            return;
        }

        if (!(this._appContext?.hasImportedMesh() ?? false)) {
            return;
        }

        this._bindModelLayersEvents(inspector);

        if (this._activeTab === 'geometry') {
            this._bindGeometryEvents(inspector);
        } else {
            this._bindTextureEvents(inspector);
        }
    }

    private _bindModelLayersEvents(inspector: HTMLElement) {
        inspector.querySelector('#ml-add-snapshot')?.addEventListener('click', () => {
            this._createSnapshotFromCurrent();
        });

        inspector.querySelector('#ml-split-parts')?.addEventListener('click', async () => {
            if (!this._modelLayersState || this._isBusy) return;
            const merged = mergeVisibleModelLayers(this._modelLayersState.layers);
            if (!merged) return;
            const parts = splitGeometryIntoConnectedParts(merged, 16);
            if (parts.length <= 1) {
                AppConsole.info(LOC('preprocessing.split_single_island'));
                return;
            }
            this._pushModelLayerUndo();
            this._modelLayersState = replaceWorkingLayersWithSplitParts(this._modelLayersState, parts);
            this._recordOp(`Split Parts (${parts.length} islands)`);
            await this._syncModelLayersToWorkerAndRenderer();
        });

        inspector.querySelector('#ml-split-mats')?.addEventListener('click', async () => {
            if (!this._modelLayersState || this._isBusy) return;
            const merged = mergeVisibleModelLayers(this._modelLayersState.layers);
            if (!merged) return;
            const parts = splitGeometryByMaterial(merged);
            if (parts.length <= 1) {
                AppConsole.info(LOC('preprocessing.split_single_material'));
                return;
            }
            this._pushModelLayerUndo();
            this._modelLayersState = replaceWorkingLayersWithSplitParts(this._modelLayersState, parts);
            this._recordOp(`Split by Material (${parts.length})`);
            await this._syncModelLayersToWorkerAndRenderer();
        });

        inspector.querySelector('#ml-merge-visible')?.addEventListener('click', async () => {
            if (!this._modelLayersState || this._isBusy) return;
            this._pushModelLayerUndo();
            this._modelLayersState = mergeVisiblePartsIntoSingleLayer(this._modelLayersState);
            this._recordOp('Merge Visible Parts');
            await this._syncModelLayersToWorkerAndRenderer();
        });

        inspector.querySelector('#ml-locked-restore')?.addEventListener('click', async () => {
            if (!this._modelLayersState) return;
            await this._restoreFromLayer(this._modelLayersState.activeLayerId);
        });

        inspector.querySelector('#ml-locked-dup')?.addEventListener('click', async () => {
            if (!this._modelLayersState) return;
            await this._duplicateLayerById(this._modelLayersState.activeLayerId);
        });

        inspector.querySelectorAll('[data-ml-select]').forEach((row) => {
            row.addEventListener('click', (e) => {
                const targetEl = e.target as HTMLElement;
                if (targetEl.closest('button') || targetEl.tagName === 'INPUT') return;
                const id = row.getAttribute('data-ml-select');
                if (!id || !this._modelLayersState) return;
                this._modelLayersState = { ...this._modelLayersState, activeLayerId: id };
                this.render();
            });
        });

        inspector.querySelectorAll('[data-ml-name-id]').forEach((nameEl) => {
            nameEl.addEventListener('dblclick', (e) => {
                e.stopPropagation();
                const id = nameEl.getAttribute('data-ml-name-id');
                const layer = this._modelLayersState?.layers.find((l) => l.id === id);
                if (!id || !layer || layer.kind === 'original') return;
                this._renamingModelLayerId = id;
                this.render();
                const inp = document.getElementById('ml-rename-input') as HTMLInputElement | null;
                inp?.focus();
                inp?.select();
            });
        });

        const renameInput = inspector.querySelector('#ml-rename-input') as HTMLInputElement | null;
        if (renameInput) {
            const commitRename = () => {
                const id = renameInput.getAttribute('data-ml-rename-id');
                if (id && this._modelLayersState) {
                    this._modelLayersState = renameModelLayer(this._modelLayersState, id, renameInput.value);
                }
                this._renamingModelLayerId = null;
                this.render();
            };
            renameInput.addEventListener('blur', commitRename);
            renameInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') commitRename();
                if (e.key === 'Escape') {
                    this._renamingModelLayerId = null;
                    this.render();
                }
            });
        }

        inspector.querySelectorAll('[data-ml-eye]').forEach((btn) => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const id = btn.getAttribute('data-ml-eye');
                if (!id || !this._modelLayersState) return;
                if (id === this._modelLayersState.originalLayerId) {
                    Renderer.Get.setReferenceGhostEnabled(!Renderer.Get.isReferenceGhostEnabled());
                    this.render();
                    return;
                }
                this._pushModelLayerUndo();
                this._modelLayersState = toggleModelLayerVisibility(this._modelLayersState, id);
                await this._syncModelLayersToWorkerAndRenderer();
            });
        });

        inspector.querySelectorAll('[data-ml-solo]').forEach((btn) => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const id = btn.getAttribute('data-ml-solo');
                if (!id || !this._modelLayersState) return;
                this._pushModelLayerUndo();
                this._modelLayersState = toggleModelLayerSolo(this._modelLayersState, id);
                await this._syncModelLayersToWorkerAndRenderer();
            });
        });

        inspector.querySelectorAll('[data-ml-restore]').forEach((btn) => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const id = btn.getAttribute('data-ml-restore');
                if (id) await this._restoreFromLayer(id);
            });
        });

        inspector.querySelectorAll('[data-ml-dup]').forEach((btn) => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const id = btn.getAttribute('data-ml-dup');
                if (id) await this._duplicateLayerById(id);
            });
        });

        inspector.querySelectorAll('[data-ml-lock]').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const id = btn.getAttribute('data-ml-lock');
                if (!id || !this._modelLayersState) return;
                this._modelLayersState = toggleModelLayerLock(this._modelLayersState, id);
                this.render();
            });
        });

        inspector.querySelectorAll('[data-ml-del]').forEach((btn) => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const id = btn.getAttribute('data-ml-del');
                if (!id || !this._modelLayersState) return;
                this._pushModelLayerUndo();
                this._modelLayersState = deleteModelLayer(this._modelLayersState, id);
                await this._syncModelLayersToWorkerAndRenderer();
            });
        });
    }

    private _pushModelLayerUndo() {
        if (!this._modelLayersState) return;
        this._modelLayerUndoStack.push(this._modelLayersState);
        if (this._modelLayerUndoStack.length > 15) {
            this._modelLayerUndoStack.shift();
        }
        this._modelLayerRedoStack = [];
    }

    private async _undoModelLayerState() {
        if (this._isBusy || this._modelLayerUndoStack.length === 0 || !this._modelLayersState) return;
        this._modelLayerRedoStack.push(this._modelLayersState);
        this._modelLayersState = this._modelLayerUndoStack.pop()!;
        this._recordOp('Undo 3D Layer Edit');
        await this._syncModelLayersToWorkerAndRenderer();
    }

    private async _redoModelLayerState() {
        if (this._isBusy || this._modelLayerRedoStack.length === 0 || !this._modelLayersState) return;
        this._modelLayerUndoStack.push(this._modelLayersState);
        this._modelLayersState = this._modelLayerRedoStack.pop()!;
        this._recordOp('Redo 3D Layer Edit');
        await this._syncModelLayersToWorkerAndRenderer();
    }

    private _createSnapshotFromCurrent() {
        if (!this._modelLayersState) return;
        const merged = mergeVisibleModelLayers(this._modelLayersState.layers);
        if (!merged) return;
        this._pushModelLayerUndo();
        const res = addSnapshotLayer(this._modelLayersState, merged);
        this._modelLayersState = res.state;
        this._recordOp(`Saved layer "${res.layer.name}"`);
        this.render();
    }

    private async _restoreFromLayer(sourceId: string) {
        if (!this._modelLayersState || this._isBusy) return;
        const src = this._modelLayersState.layers.find((l) => l.id === sourceId);
        if (!src) return;
        this._pushModelLayerUndo();
        const res = restoreLayerToWorking(this._modelLayersState, sourceId);
        this._modelLayersState = res.state;
        this._recordOp(`Restored from "${src.name}"`);
        await this._syncModelLayersToWorkerAndRenderer();
    }

    private async _duplicateLayerById(sourceId: string) {
        if (!this._modelLayersState || this._isBusy) return;
        this._pushModelLayerUndo();
        const res = duplicateModelLayer(this._modelLayersState, sourceId, true);
        this._modelLayersState = res.state;
        if (res.layer) {
            this._recordOp(`Duplicated "${res.layer.name}"`);
        }
        await this._syncModelLayersToWorkerAndRenderer();
    }

    private async _syncModelLayersToWorkerAndRenderer() {
        if (!this._appContext || !this._modelLayersState) return;
        const merged = mergeVisibleModelLayers(this._modelLayersState.layers);
        if (!merged) return;
        this._isBusy = true;
        try {
            await this._appContext.setPreprocessedGeometry(merged, false);
            this.render();
        } finally {
            this._isBusy = false;
        }
    }

    private _bindGeometryEvents(panel: HTMLElement) {
        const isPartLayer = this._modelLayersState ?
            getActiveModelLayer(this._modelLayersState)?.kind === 'part' :
            false;

        // Move
        panel.querySelector('#me-apply-move')?.addEventListener('click', async () => {
            const dx = parseFloat((panel.querySelector('#me-move-x') as HTMLInputElement)?.value || '0') || 0;
            const dy = parseFloat((panel.querySelector('#me-move-y') as HTMLInputElement)?.value || '0') || 0;
            const dz = parseFloat((panel.querySelector('#me-move-z') as HTMLInputElement)?.value || '0') || 0;
            if (Math.abs(dx) < 1e-5 && Math.abs(dy) < 1e-5 && Math.abs(dz) < 1e-5) return;
            await this._runMeshEdit({ operation: 'translate', offset: { x: dx, y: dy, z: dz } }, `Move (${dx}, ${dy}, ${dz})`);
        });

        // Scale & Rotate
        const uniformEl = panel.querySelector('#me-uniform-scale') as HTMLInputElement | null;
        const sxEl = panel.querySelector('#me-scale-x') as HTMLInputElement | null;
        const syEl = panel.querySelector('#me-scale-y') as HTMLInputElement | null;
        const szEl = panel.querySelector('#me-scale-z') as HTMLInputElement | null;
        const rxEl = panel.querySelector('#me-rot-x') as HTMLInputElement | null;
        const ryEl = panel.querySelector('#me-rot-y') as HTMLInputElement | null;
        const rzEl = panel.querySelector('#me-rot-z') as HTMLInputElement | null;

        uniformEl?.addEventListener('change', () => {
            this._uniformScale = uniformEl.checked;
        });

        const syncUniform = (source: HTMLInputElement | null) => {
            if (!source || !this._uniformScale) return;
            const val = source.value;
            if (sxEl && sxEl !== source) sxEl.value = val;
            if (syEl && syEl !== source) syEl.value = val;
            if (szEl && szEl !== source) szEl.value = val;
        };
        sxEl?.addEventListener('input', () => syncUniform(sxEl));
        syEl?.addEventListener('input', () => syncUniform(syEl));
        szEl?.addEventListener('input', () => syncUniform(szEl));

        panel.querySelectorAll('[data-scale-preset]').forEach((btn) => {
            btn.addEventListener('click', () => {
                const val = btn.getAttribute('data-scale-preset') || '1';
                if (sxEl) sxEl.value = val;
                if (syEl) syEl.value = val;
                if (szEl) szEl.value = val;
            });
        });

        panel.querySelectorAll('[data-quick-rot]').forEach((btn) => {
            btn.addEventListener('click', async () => {
                const spec = btn.getAttribute('data-quick-rot');
                if (!spec) return;
                const [axis, degStr] = spec.split(':');
                const deg = parseFloat(degStr) || 0;
                const rotateDeg = {
                    x: axis === 'x' ? deg : 0,
                    y: axis === 'y' ? deg : 0,
                    z: axis === 'z' ? deg : 0,
                };
                await this._runMeshEdit({
                    operation: 'transform',
                    rotateDeg,
                    preservePivot: isPartLayer,
                }, `Rotate ${axis.toUpperCase()} ${deg}°`);
            });
        });

        panel.querySelectorAll('[data-mirror-axis]').forEach((btn) => {
            btn.addEventListener('click', async () => {
                const axis = btn.getAttribute('data-mirror-axis') as 'x' | 'y' | 'z';
                if (!axis) return;
                await this._runMeshEdit({
                    operation: 'transform',
                    flipAxis: axis,
                    preservePivot: isPartLayer,
                }, `Mirror ${axis.toUpperCase()}`);
            });
        });

        panel.querySelector('#me-apply-transform')?.addEventListener('click', async () => {
            const sx = parseFloat(sxEl?.value || '1') || 1;
            const sy = parseFloat(syEl?.value || '1') || 1;
            const sz = parseFloat(szEl?.value || '1') || 1;
            const rx = parseFloat(rxEl?.value || '0') || 0;
            const ry = parseFloat(ryEl?.value || '0') || 0;
            const rz = parseFloat(rzEl?.value || '0') || 0;
            const hasScale = Math.abs(sx - 1) > 1e-4 || Math.abs(sy - 1) > 1e-4 || Math.abs(sz - 1) > 1e-4;
            const hasRot = Math.abs(rx) > 1e-4 || Math.abs(ry) > 1e-4 || Math.abs(rz) > 1e-4;
            if (!hasScale && !hasRot) return;
            await this._runMeshEdit({
                operation: 'transform',
                scale: { x: sx, y: sy, z: sz },
                rotateDeg: { x: rx, y: ry, z: rz },
                preservePivot: isPartLayer,
            }, `Transform (${sx.toFixed(2)}, ${sy.toFixed(2)}, ${sz.toFixed(2)})`);
        });

        panel.querySelector('#me-center-btn')?.addEventListener('click', () => this._runMeshEdit({ operation: 'centerGround' }, 'Center Origin'));
        panel.querySelector('#me-ground-btn')?.addEventListener('click', () => this._runMeshEdit({ operation: 'putOnGround' }, 'Put on Ground Y=0'));
        panel.querySelector('#me-normalize-btn')?.addEventListener('click', () => this._runMeshEdit({ operation: 'normalizeSize' }, 'Normalize Height 1.0'));

        // Sculpt / Deform
        const smFactorSlider = panel.querySelector('#bs-smooth-factor') as HTMLInputElement | null;
        smFactorSlider?.addEventListener('input', () => {
            const pct = parseInt(smFactorSlider.value, 10) || 35;
            this._smoothFactor = pct / 100;
            const val = panel.querySelector('#bs-smooth-fac-val');
            if (val) val.textContent = `${pct}%`;
        });
        const smIterSlider = panel.querySelector('#bs-smooth-iters') as HTMLInputElement | null;
        smIterSlider?.addEventListener('input', () => {
            this._smoothIterations = parseInt(smIterSlider.value, 10) || 2;
            const val = panel.querySelector('#bs-smooth-it-val');
            if (val) val.textContent = `${this._smoothIterations}`;
        });
        panel.querySelector('#bs-apply-smooth')?.addEventListener('click', () => {
            this._runMeshEdit({
                operation: 'smoothMesh',
                smoothFactor: this._smoothFactor,
                smoothIterations: this._smoothIterations,
            }, `Smooth Mesh (${Math.round(this._smoothFactor * 100)}%, ×${this._smoothIterations})`);
        });

        const infSlider = panel.querySelector('#bs-inflate-slider') as HTMLInputElement | null;
        infSlider?.addEventListener('input', () => {
            this._inflateAmountPct = parseInt(infSlider.value, 10) || 0;
            const val = panel.querySelector('#bs-inflate-val');
            if (val) val.textContent = `${this._inflateAmountPct > 0 ? `+${this._inflateAmountPct}` : this._inflateAmountPct}%`;
        });
        panel.querySelector('#bs-apply-inflate')?.addEventListener('click', () => {
            if (this._inflateAmountPct === 0) return;
            this._runMeshEdit({
                operation: 'inflateMesh',
                inflateAmount: this._inflateAmountPct / 100,
            }, `Inflate (${this._inflateAmountPct}%)`);
        });

        panel.querySelectorAll('[data-sym]').forEach((btn) => {
            btn.addEventListener('click', () => {
                const spec = btn.getAttribute('data-sym');
                if (!spec) return;
                const [axis, dir] = spec.split(':');
                this._runMeshEdit({
                    operation: 'symmetrizeMesh',
                    symmetryAxis: axis as 'x' | 'z',
                    symmetryDirection: dir as 'posToNeg' | 'negToPos',
                }, `Symmetrize ${axis.toUpperCase()} (${dir})`);
            });
        });

        panel.querySelector('#me-normals-btn')?.addEventListener('click', () => this._runMeshEdit({ operation: 'recomputeNormals' }, 'Smooth Normals'));
        panel.querySelector('#me-flat-normals-btn')?.addEventListener('click', () => this._runMeshEdit({ operation: 'flatNormals' }, 'Flat Normals'));
        panel.querySelector('#me-flip-normals-btn')?.addEventListener('click', () => this._runMeshEdit({ operation: 'flipNormals' }, 'Flip Normals'));

        // Repair
        const weldSelect = panel.querySelector('#prep-weld-tol') as HTMLSelectElement | null;
        weldSelect?.addEventListener('change', () => {
            this._weldTolerance = parseFloat(weldSelect.value) || 0.0001;
        });
        panel.querySelector('#prep-weld-btn')?.addEventListener('click', () => {
            this._runMeshEdit({ operation: 'weldVertices', weldTolerance: this._weldTolerance }, `Weld Vertices (${this._weldTolerance})`);
        });

        const cleanIslandsEl = panel.querySelector('#prep-clean-islands') as HTMLInputElement | null;
        const cleanMinEl = panel.querySelector('#prep-clean-min-tris') as HTMLInputElement | null;
        const cleanSmoothEl = panel.querySelector('#prep-clean-smooth-normals') as HTMLInputElement | null;
        cleanIslandsEl?.addEventListener('change', () => {
            this._cleanRemoveIslands = cleanIslandsEl.checked;
            if (cleanMinEl) cleanMinEl.disabled = !this._cleanRemoveIslands;
        });
        cleanMinEl?.addEventListener('change', () => {
            this._cleanMinIslandTris = Math.max(2, Math.min(500, parseInt(cleanMinEl.value, 10) || 16));
        });
        cleanSmoothEl?.addEventListener('change', () => {
            this._cleanForceSmoothNormals = cleanSmoothEl.checked;
        });
        panel.querySelector('#prep-clean-btn')?.addEventListener('click', () => {
            this._runMeshEdit({
                operation: 'cleanRepair',
                removeSmallIslands: this._cleanRemoveIslands,
                minIslandTriangles: this._cleanMinIslandTris,
                forceRecomputeNormals: this._cleanForceSmoothNormals,
                groundAndCenter: false,
            }, 'Clean & Repair');
        });

        // Decimate
        const decimateSlider = panel.querySelector('#prep-decimate-ratio') as HTMLInputElement | null;
        decimateSlider?.addEventListener('input', () => {
            const pct = parseInt(decimateSlider.value, 10) || 50;
            this._decimateRatio = pct / 100;
            const valEl = panel.querySelector('#prep-decimate-val');
            if (valEl) valEl.textContent = `${pct}%`;
            const estEl = panel.querySelector('#prep-decimate-est');
            const tris = this._modelLayersState ?
                (getActiveModelLayer(this._modelLayersState)?.triangleCount ?? 0) :
                (this._appContext?.getImportedTriangleCount() ?? 0);
            if (estEl) estEl.textContent = LOC('preprocessing.est_tris', { count: Math.max(4, Math.round(tris * this._decimateRatio)) });
        });
        panel.querySelector('#prep-decimate-btn')?.addEventListener('click', () => {
            this._runMeshEdit({ operation: 'decimate', decimateRatio: this._decimateRatio }, `Simplify (${Math.round(this._decimateRatio * 100)}%)`);
        });

        // Crop
        const readCropInputs = () => {
            const getNum = (id: string, def: number) => {
                const el = panel.querySelector(`#${id}`) as HTMLInputElement | null;
                return el ? Math.max(0, Math.min(100, parseFloat(el.value) || 0)) : def;
            };
            this._cropMinPct = {
                x: getNum('prep-crop-xmin', 0),
                y: getNum('prep-crop-ymin', 0),
                z: getNum('prep-crop-zmin', 0),
            };
            this._cropMaxPct = {
                x: Math.max(this._cropMinPct.x + 1, getNum('prep-crop-xmax', 100)),
                y: Math.max(this._cropMinPct.y + 1, getNum('prep-crop-ymax', 100)),
                z: Math.max(this._cropMinPct.z + 1, getNum('prep-crop-zmax', 100)),
            };
        };
        panel.querySelector('#prep-crop-apply')?.addEventListener('click', () => {
            readCropInputs();
            this._runMeshEdit({
                operation: 'cropBounds',
                cropMin: { x: this._cropMinPct.x / 100, y: this._cropMinPct.y / 100, z: this._cropMinPct.z / 100 },
                cropMax: { x: this._cropMaxPct.x / 100, y: this._cropMaxPct.y / 100, z: this._cropMaxPct.z / 100 },
            }, `Crop BBox`);
        });
        panel.querySelector('#prep-crop-reset')?.addEventListener('click', () => {
            this._cropMinPct = { x: 0, y: 0, z: 0 };
            this._cropMaxPct = { x: 100, y: 100, z: 100 };
            this.render();
        });
    }

    private async _runMeshEdit(params: MeshEditParams, logLabel?: string) {
        if (this._isBusy || !this._appContext) return;

        if (!this._modelLayersState) {
            await this._ensureModelLayersInitialized();
        }
        if (this._modelLayersState) {
            const active = getActiveModelLayer(this._modelLayersState);
            if (!active || active.locked || active.kind === 'original') {
                return;
            }
            this._pushModelLayerUndo();
            const res = applyEditToActiveModelLayer(this._modelLayersState, params);
            if (!res.edited) {
                this._modelLayerUndoStack.pop();
                return;
            }
            this._modelLayersState = res.state;
            if (logLabel) {
                const updatedActive = getActiveModelLayer(this._modelLayersState);
                this._recordOp(`${logLabel} [${updatedActive?.name ?? 'Layer'}] → ${updatedActive?.triangleCount ?? 0} tris`);
            }
            await this._syncModelLayersToWorkerAndRenderer();
        }
    }

    private _applyPaintDabToActiveLayer(state: TextureEditState, layer: TextureLayer, x: number, y: number, mode: 'paint' | 'erase') {
        const radius = this._brushSize * 0.5;
        const rgba = hexToPixelRGBA(this._brushColor);
        paintBrushDab(layer.pixels, state.width, state.height, x, y, radius, rgba, this._brushHardness, mode);
        if (this._mirrorXBrush) {
            paintBrushDab(layer.pixels, state.width, state.height, state.width - 1 - x, y, radius, rgba, this._brushHardness, mode);
        }
    }

    private _applyPaintStrokeToActiveLayer(state: TextureEditState, layer: TextureLayer, x0: number, y0: number, x1: number, y1: number, mode: 'paint' | 'erase') {
        const radius = this._brushSize * 0.5;
        const rgba = hexToPixelRGBA(this._brushColor);
        paintBrushStroke(layer.pixels, state.width, state.height, x0, y0, x1, y1, radius, rgba, this._brushHardness, mode);
        if (this._mirrorXBrush) {
            paintBrushStroke(
                layer.pixels,
                state.width,
                state.height,
                state.width - 1 - x0,
                y0,
                state.width - 1 - x1,
                y1,
                radius,
                rgba,
                this._brushHardness,
                mode,
            );
        }
    }

    private _bindTextureEvents(panel: HTMLElement) {
        const selectEl = panel.querySelector('#me-material-select') as HTMLSelectElement | null;
        selectEl?.addEventListener('change', () => {
            this._selectedMaterialName = selectEl.value;
            this.render();
            this._sync3DPaintHook();
        });

        const resSelect = panel.querySelector('#prep-tex-res') as HTMLSelectElement | null;
        resSelect?.addEventListener('change', () => {
            this._textureResolution = parseInt(resSelect.value, 10) || 256;
            const convBtn = panel.querySelector('#me-convert-solid-btn');
            if (convBtn) {
                convBtn.textContent = LOC('preprocessing.convert_to_texture_res', { res: this._textureResolution });
            }
            const blankBtn = panel.querySelector('#me-init-blank-btn');
            if (blankBtn) {
                blankBtn.textContent = LOC('preprocessing.init_blank_res', { res: this._textureResolution });
            }
        });

        const solidColorEl = panel.querySelector('#me-solid-color') as HTMLInputElement | null;
        if (solidColorEl && this._selectedMaterialName) {
            const matName = this._selectedMaterialName;
            solidColorEl.addEventListener('input', () => {
                const hexEl = panel.querySelector('#me-solid-hex');
                if (hexEl) hexEl.textContent = solidColorEl.value.toUpperCase();
                const mat = this._appContext?.getMaterialManager().materials.get(matName);
                if (mat && mat.type === MaterialType.solid) {
                    const p = hexToPixelRGBA(solidColorEl.value);
                    const nextMat: SolidMaterial = {
                        ...mat,
                        colour: { r: p.r / 255, g: p.g / 255, b: p.b / 255, a: mat.colour.a },
                    };
                    this._appContext?.applyMaterialTextureUpdate(matName, nextMat, false);
                }
            });
            solidColorEl.addEventListener('change', () => {
                const mat = this._appContext?.getMaterialManager().materials.get(matName);
                if (mat && mat.type === MaterialType.solid) {
                    const p = hexToPixelRGBA(solidColorEl.value);
                    const nextMat: SolidMaterial = {
                        ...mat,
                        colour: { r: p.r / 255, g: p.g / 255, b: p.b / 255, a: mat.colour.a },
                    };
                    this._appContext?.applyMaterialTextureUpdate(matName, nextMat, true);
                }
            });
        }

        panel.querySelector('#me-convert-solid-btn')?.addEventListener('click', async () => {
            if (!this._selectedMaterialName || !this._appContext) return;
            const matName = this._selectedMaterialName;
            const mat = this._appContext.getMaterialManager().materials.get(matName);
            if (!mat || mat.type !== MaterialType.solid) return;

            const size = this._textureResolution;
            const pixels = createSolidRgbaBuffer(size, size, {
                r: Math.round(mat.colour.r * 255),
                g: Math.round(mat.colour.g * 255),
                b: Math.round(mat.colour.b * 255),
                a: 255,
            });
            const dataUrl = this._encodePixelsToPngDataUrl(pixels, size, size);
            const wrap: TImageRawWrap = { filetype: 'png', raw: dataUrl };
            const texMat: TexturedMaterial = {
                type: MaterialType.textured,
                diffuse: wrap,
                transparency: { type: 'None' },
                extension: 'repeat',
                interpolation: 'nearest',
                needsAttention: false,
            };

            const stack = createTextureLayerStack(size, size, pixels);
            this._textureStates.set(matName, {
                materialName: matName,
                width: size,
                height: size,
                layerStack: stack,
                workingPixels: compositeTextureLayers(stack.layers, size, size),
                originalRaw: { ...wrap },
                filters: defaultFilters(),
                pixelizeSize: 1,
            });

            this._recordOp(`Convert Solid → Texture (${matName}, ${size}×${size})`);
            await this._appContext.applyMaterialTextureUpdate(matName, texMat, true);
            this.render();
            this._sync3DPaintHook();
        });

        panel.querySelector('#me-init-blank-btn')?.addEventListener('click', async () => {
            if (!this._selectedMaterialName || !this._appContext) return;
            const matName = this._selectedMaterialName;
            const mat = this._appContext.getMaterialManager().materials.get(matName);
            if (!mat || mat.type !== MaterialType.textured) return;

            const size = this._textureResolution;
            const pixels = createSolidRgbaBuffer(size, size, { r: 220, g: 220, b: 220, a: 255 });
            const dataUrl = this._encodePixelsToPngDataUrl(pixels, size, size);
            const wrap: TImageRawWrap = { filetype: 'png', raw: dataUrl };
            const nextMat: TexturedMaterial = { ...mat, diffuse: wrap, needsAttention: false };

            const stack = createTextureLayerStack(size, size, pixels);
            this._textureStates.set(matName, {
                materialName: matName,
                width: size,
                height: size,
                layerStack: stack,
                workingPixels: compositeTextureLayers(stack.layers, size, size),
                originalRaw: { ...wrap },
                filters: defaultFilters(),
                pixelizeSize: 1,
            });

            this._recordOp(`Create Blank Texture (${matName}, ${size}×${size})`);
            await this._appContext.applyMaterialTextureUpdate(matName, nextMat, true);
            this.render();
            this._sync3DPaintHook();
        });

        const colorEl = panel.querySelector('#me-brush-color') as HTMLInputElement | null;
        colorEl?.addEventListener('input', () => {
            this._brushColor = colorEl.value;
            const hexSpan = panel.querySelector('#me-brush-hex');
            if (hexSpan) hexSpan.textContent = this._brushColor.toUpperCase();
        });

        const sizeEl = panel.querySelector('#me-brush-size') as HTMLInputElement | null;
        sizeEl?.addEventListener('input', () => {
            this._brushSize = parseInt(sizeEl.value, 10) || 1;
            const valSpan = panel.querySelector('#me-brush-size-val');
            if (valSpan) valSpan.textContent = `${this._brushSize}`;
        });

        const hardEl = panel.querySelector('#me-brush-hardness') as HTMLInputElement | null;
        hardEl?.addEventListener('input', () => {
            const pct = parseInt(hardEl.value, 10) || 0;
            this._brushHardness = pct / 100;
            const valSpan = panel.querySelector('#me-brush-hard-val');
            if (valSpan) valSpan.textContent = `${pct}%`;
        });

        panel.querySelector('#me-zoom-out')?.addEventListener('click', () => {
            this._zoomPercent = Math.max(50, this._zoomPercent - 25);
            this._applyCanvasZoomDisplay();
        });
        panel.querySelector('#me-zoom-in')?.addEventListener('click', () => {
            this._zoomPercent = Math.min(400, this._zoomPercent + 25);
            this._applyCanvasZoomDisplay();
        });

        if (!this._selectedMaterialName) return;
        const matName = this._selectedMaterialName;

        // Global texture transforms (apply cleanly to every layer in stack!)
        panel.querySelector('#prep-tex-flip-h')?.addEventListener('click', () => {
            const state = this._textureStates.get(matName);
            if (!state) return;
            state.layerStack = {
                ...state.layerStack,
                layers: state.layerStack.layers.map((l) => ({
                    ...l,
                    undoStack: [...l.undoStack, new Uint8ClampedArray(l.pixels)].slice(-15),
                    pixels: flipRgbaHorizontal(l.pixels, state.width, state.height),
                })),
            };
            this._recomputeWorkingPixels(state);
            this._drawActiveCanvas();
            this._updateUndoButtonState();
            this._recordOp(`Texture Flip H (${matName})`);
            this._scheduleLiveTextureSync(matName, true);
        });

        panel.querySelector('#prep-tex-flip-v')?.addEventListener('click', () => {
            const state = this._textureStates.get(matName);
            if (!state) return;
            state.layerStack = {
                ...state.layerStack,
                layers: state.layerStack.layers.map((l) => ({
                    ...l,
                    undoStack: [...l.undoStack, new Uint8ClampedArray(l.pixels)].slice(-15),
                    pixels: flipRgbaVertical(l.pixels, state.width, state.height),
                })),
            };
            this._recomputeWorkingPixels(state);
            this._drawActiveCanvas();
            this._updateUndoButtonState();
            this._recordOp(`Texture Flip V (${matName})`);
            this._scheduleLiveTextureSync(matName, true);
        });

        panel.querySelector('#prep-tex-rot-90')?.addEventListener('click', () => {
            const state = this._textureStates.get(matName);
            if (!state) return;
            let nextW = state.width;
            let nextH = state.height;
            const nextLayers = state.layerStack.layers.map((l) => {
                const rot = rotateRgba90CW(l.pixels, state.width, state.height);
                nextW = rot.width;
                nextH = rot.height;
                return {
                    ...l,
                    undoStack: [...l.undoStack, new Uint8ClampedArray(l.pixels)].slice(-15),
                    pixels: rot.pixels,
                };
            });
            state.width = nextW;
            state.height = nextH;
            state.layerStack = { ...state.layerStack, width: nextW, height: nextH, layers: nextLayers };
            this._recomputeWorkingPixels(state);
            this._recordOp(`Texture Rotate 90° (${matName})`);
            this.render();
            this._scheduleLiveTextureSync(matName, true);
        });

        panel.querySelector('#prep-tex-auto-levels')?.addEventListener('click', () => {
            const state = this._textureStates.get(matName);
            const activeLayer = state ? getActiveTextureLayer(state.layerStack) : undefined;
            if (!state || !activeLayer || activeLayer.locked) return;
            this._pushLayerUndo(activeLayer);
            activeLayer.pixels = autoLevelsRgba(activeLayer.pixels, state.width, state.height);
            this._recomputeWorkingPixels(state);
            this._drawActiveCanvas();
            this._updateUndoButtonState();
            this._recordOp(`Auto-Levels [${activeLayer.name}]`);
            this._scheduleLiveTextureSync(matName, true);
        });

        // Texture Layer Stack events
        panel.querySelector('#tl-add')?.addEventListener('click', () => {
            const state = this._textureStates.get(matName);
            if (!state) return;
            state.layerStack = addPaintTextureLayer(state.layerStack);
            this.render();
        });
        panel.querySelector('#tl-dup')?.addEventListener('click', () => {
            const state = this._textureStates.get(matName);
            if (!state) return;
            state.layerStack = duplicateTextureLayer(state.layerStack, state.layerStack.activeLayerId);
            this._recomputeWorkingPixels(state);
            this.render();
            this._scheduleLiveTextureSync(matName, true);
        });
        panel.querySelector('#tl-merge')?.addEventListener('click', () => {
            const state = this._textureStates.get(matName);
            if (!state) return;
            state.layerStack = mergeTextureLayerDown(state.layerStack, state.layerStack.activeLayerId);
            this._recomputeWorkingPixels(state);
            this.render();
            this._scheduleLiveTextureSync(matName, true);
        });
        panel.querySelector('#tl-flatten')?.addEventListener('click', () => {
            const state = this._textureStates.get(matName);
            if (!state) return;
            state.layerStack = flattenTextureLayers(state.layerStack);
            this._recomputeWorkingPixels(state);
            this.render();
            this._scheduleLiveTextureSync(matName, true);
        });

        const blendSelect = panel.querySelector('#tl-blend-mode') as HTMLSelectElement | null;
        blendSelect?.addEventListener('change', () => {
            const state = this._textureStates.get(matName);
            const activeLayer = state ? getActiveTextureLayer(state.layerStack) : undefined;
            if (!state || !activeLayer) return;
            activeLayer.blendMode = blendSelect.value as TextureBlendMode;
            this._recomputeWorkingPixels(state);
            this._drawActiveCanvas();
            this._scheduleLiveTextureSync(matName, true);
        });

        const opacitySlider = panel.querySelector('#tl-opacity') as HTMLInputElement | null;
        opacitySlider?.addEventListener('input', () => {
            const state = this._textureStates.get(matName);
            const activeLayer = state ? getActiveTextureLayer(state.layerStack) : undefined;
            if (!state || !activeLayer) return;
            const pct = parseInt(opacitySlider.value, 10) || 0;
            activeLayer.opacity = pct / 100;
            const valEl = panel.querySelector('#tl-opacity-val');
            if (valEl) valEl.textContent = `${pct}%`;
            const rowCount = panel.querySelector(`[data-tl-select="${activeLayer.id}"] .bs-layer-count`);
            if (rowCount) rowCount.textContent = `${pct}%`;
            this._recomputeWorkingPixels(state);
            this._drawActiveCanvas();
            this._scheduleLiveTextureSync(matName, false);
        });
        opacitySlider?.addEventListener('change', () => {
            this._scheduleLiveTextureSync(matName, true);
        });

        panel.querySelectorAll('[data-tl-select]').forEach((row) => {
            row.addEventListener('click', (e) => {
                const target = e.target as HTMLElement;
                if (target.closest('button')) return;
                const id = row.getAttribute('data-tl-select');
                const state = this._textureStates.get(matName);
                if (!id || !state) return;
                state.layerStack = { ...state.layerStack, activeLayerId: id };
                this.render();
            });
        });

        panel.querySelectorAll('[data-tl-eye]').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const id = btn.getAttribute('data-tl-eye');
                const state = this._textureStates.get(matName);
                if (!id || !state) return;
                state.layerStack = {
                    ...state.layerStack,
                    layers: state.layerStack.layers.map((l) => (l.id === id ? { ...l, visible: !l.visible } : l)),
                };
                this._recomputeWorkingPixels(state);
                this.render();
                this._scheduleLiveTextureSync(matName, true);
            });
        });

        panel.querySelectorAll('[data-tl-lock]').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const id = btn.getAttribute('data-tl-lock');
                const state = this._textureStates.get(matName);
                if (!id || !state) return;
                state.layerStack = {
                    ...state.layerStack,
                    layers: state.layerStack.layers.map((l) => (l.id === id ? { ...l, locked: !l.locked } : l)),
                };
                this.render();
            });
        });

        panel.querySelectorAll('[data-tl-up]').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const id = btn.getAttribute('data-tl-up');
                const state = this._textureStates.get(matName);
                if (!id || !state) return;
                // Layers displayed reversed, so visual "up" is +1 in stack array
                state.layerStack = moveTextureLayer(state.layerStack, id, 1);
                this._recomputeWorkingPixels(state);
                this.render();
                this._scheduleLiveTextureSync(matName, true);
            });
        });

        panel.querySelectorAll('[data-tl-dn]').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const id = btn.getAttribute('data-tl-dn');
                const state = this._textureStates.get(matName);
                if (!id || !state) return;
                state.layerStack = moveTextureLayer(state.layerStack, id, -1);
                this._recomputeWorkingPixels(state);
                this.render();
                this._scheduleLiveTextureSync(matName, true);
            });
        });

        panel.querySelectorAll('[data-tl-del]').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const id = btn.getAttribute('data-tl-del');
                const state = this._textureStates.get(matName);
                if (!id || !state) return;
                state.layerStack = deleteTextureLayer(state.layerStack, id);
                this._recomputeWorkingPixels(state);
                this.render();
                this._scheduleLiveTextureSync(matName, true);
            });
        });

        // 2D UV Canvas drawing
        const canvas = panel.querySelector('#me-texture-canvas') as HTMLCanvasElement | null;
        if (canvas) {
            const getCanvasCoords = (e: MouseEvent) => {
                const rect = canvas.getBoundingClientRect();
                const state = this._textureStates.get(matName);
                if (!state || rect.width <= 0 || rect.height <= 0) return null;
                const x = Math.max(0, Math.min(state.width - 1, Math.floor(((e.clientX - rect.left) / rect.width) * state.width)));
                const y = Math.max(0, Math.min(state.height - 1, Math.floor(((e.clientY - rect.top) / rect.height) * state.height)));
                return { x, y };
            };

            canvas.addEventListener('mousedown', (e: MouseEvent) => {
                if (e.button !== 0) return;
                const state = this._textureStates.get(matName);
                const pt = getCanvasCoords(e);
                if (!state || !pt) return;

                if (this._tool === 'eyedropper') {
                    this._pickColorAt(state, pt.x, pt.y);
                    return;
                }

                const activeLayer = getActiveTextureLayer(state.layerStack);
                if (!activeLayer || activeLayer.locked) return;

                this._pushLayerUndo(activeLayer);
                if (this._tool === 'fill') {
                    const rgba = hexToPixelRGBA(this._brushColor);
                    floodFillRgba(activeLayer.pixels, state.width, state.height, pt.x, pt.y, rgba);
                    if (this._mirrorXBrush) {
                        floodFillRgba(activeLayer.pixels, state.width, state.height, state.width - 1 - pt.x, pt.y, rgba);
                    }
                    this._recomputeWorkingPixels(state);
                    this._drawActiveCanvas();
                    this._recordOp(`Fill [${activeLayer.name}]`);
                    this._scheduleLiveTextureSync(matName, true);
                    this._updateUndoButtonState();
                    return;
                }

                this._isDrawing2D = true;
                this._last2DPoint = pt;
                const paintMode = this._tool === 'eraser' ? 'erase' : 'paint';
                this._applyPaintDabToActiveLayer(state, activeLayer, pt.x, pt.y, paintMode);
                this._recomputeWorkingPixels(state);
                this._drawActiveCanvas();
                this._scheduleLiveTextureSync(matName, false);
                this._updateUndoButtonState();
            });

            const onWindowMove = (e: MouseEvent) => {
                if (!this._isDrawing2D || this._selectedMaterialName !== matName) return;
                const state = this._textureStates.get(matName);
                const pt = getCanvasCoords(e);
                const activeLayer = state ? getActiveTextureLayer(state.layerStack) : undefined;
                if (!state || !pt || !this._last2DPoint || !activeLayer || activeLayer.locked) return;

                const paintMode = this._tool === 'eraser' ? 'erase' : 'paint';
                this._applyPaintStrokeToActiveLayer(state, activeLayer, this._last2DPoint.x, this._last2DPoint.y, pt.x, pt.y, paintMode);
                this._last2DPoint = pt;
                this._recomputeWorkingPixels(state);
                this._drawActiveCanvas();
                this._scheduleLiveTextureSync(matName, false);
            };

            const onWindowUp = () => {
                if (!this._isDrawing2D) return;
                this._isDrawing2D = false;
                this._last2DPoint = null;
                this._recordOp(`2D ${this._tool} (${matName})`);
                this._scheduleLiveTextureSync(matName, true);
            };

            if (this._windowMoveListener) window.removeEventListener('mousemove', this._windowMoveListener);
            if (this._windowUpListener) window.removeEventListener('mouseup', this._windowUpListener);
            this._windowMoveListener = onWindowMove;
            this._windowUpListener = onWindowUp;
            window.addEventListener('mousemove', onWindowMove);
            window.addEventListener('mouseup', onWindowUp);
        }

        // Collapsible Adjustments
        panel.querySelector('#tl-toggle-adjustments')?.addEventListener('click', () => {
            this._adjustmentsExpanded = !this._adjustmentsExpanded;
            this.render();
        });

        if (this._adjustmentsExpanded) {
            const bindFilterSlider = (id: string, valId: string, key: keyof TextureFilterParams, suffix = '') => {
                const slider = panel.querySelector(`#${id}`) as HTMLInputElement | null;
                slider?.addEventListener('input', () => {
                    const state = this._textureStates.get(matName);
                    if (!state) return;
                    const v = parseFloat(slider.value) || 0;
                    state.filters[key] = v;
                    const labelEl = panel.querySelector(`#${valId}`);
                    if (labelEl) labelEl.textContent = key === 'posterize' && v === 0 ? 'Off' : `${v}${suffix}`;
                    this._recomputeWorkingPixels(state);
                    this._drawActiveCanvas();
                    this._scheduleLiveTextureSync(matName, false);
                });
                slider?.addEventListener('change', () => {
                    this._scheduleLiveTextureSync(matName, true);
                });
            };

            bindFilterSlider('me-f-brightness', 'me-f-brightness-val', 'brightness');
            bindFilterSlider('me-f-contrast', 'me-f-contrast-val', 'contrast');
            bindFilterSlider('me-f-saturation', 'me-f-saturation-val', 'saturation');
            bindFilterSlider('me-f-hue', 'me-f-hue-val', 'hue', '°');
            bindFilterSlider('me-f-gamma', 'me-f-gamma-val', 'gamma');
            bindFilterSlider('me-f-warmth', 'me-f-warmth-val', 'warmth');
            bindFilterSlider('me-f-sharpen', 'me-f-sharpen-val', 'sharpen');
            bindFilterSlider('me-f-blur', 'me-f-blur-val', 'blur');
            bindFilterSlider('me-f-posterize', 'me-f-posterize-val', 'posterize');

            const pixSlider = panel.querySelector('#me-f-pixelize') as HTMLInputElement | null;
            pixSlider?.addEventListener('input', () => {
                const state = this._textureStates.get(matName);
                if (!state) return;
                const val = Math.max(1, parseInt(pixSlider.value, 10) || 1);
                state.pixelizeSize = val;
                const lbl = panel.querySelector('#me-f-pixelize-val');
                if (lbl) lbl.textContent = val === 1 ? 'Off' : `${val}px`;
                this._recomputeWorkingPixels(state);
                this._drawActiveCanvas();
                this._scheduleLiveTextureSync(matName, false);
            });
            pixSlider?.addEventListener('change', () => this._scheduleLiveTextureSync(matName, true));

            panel.querySelector('#me-commit-filters')?.addEventListener('click', () => {
                const state = this._textureStates.get(matName);
                if (!state) return;
                state.layerStack = flattenTextureLayers(state.layerStack);
                const onlyLayer = state.layerStack.layers[0];
                onlyLayer.pixels = new Uint8ClampedArray(state.workingPixels);
                state.filters = defaultFilters();
                state.pixelizeSize = 1;
                this._recordOp(`Bake Filters (${matName})`);
                this.render();
                this._scheduleLiveTextureSync(matName, true);
            });

            panel.querySelector('#me-reset-filters')?.addEventListener('click', () => {
                const state = this._textureStates.get(matName);
                if (!state) return;
                state.filters = defaultFilters();
                state.pixelizeSize = 1;
                this._recomputeWorkingPixels(state);
                this.render();
                this._scheduleLiveTextureSync(matName, true);
            });
        }

        panel.querySelector('#me-apply-texture')?.addEventListener('click', async () => {
            await this._flushTextureToModel(matName, true);
            this._recordOp(`Apply Texture (${matName})`);
        });

        panel.querySelector('#me-undo-texture')?.addEventListener('click', () => {
            const state = this._textureStates.get(matName);
            const activeLayer = state ? getActiveTextureLayer(state.layerStack) : undefined;
            if (!state || !activeLayer || activeLayer.undoStack.length === 0) return;
            activeLayer.pixels = activeLayer.undoStack.pop()!;
            this._recomputeWorkingPixels(state);
            this._drawActiveCanvas();
            this._updateUndoButtonState();
            this._scheduleLiveTextureSync(matName, true);
        });

        panel.querySelector('#me-reset-texture')?.addEventListener('click', () => {
            const state = this._textureStates.get(matName);
            if (!state || !state.originalRaw) return;
            this._textureStates.delete(matName);
            const mat = this._appContext?.getMaterialManager().materials.get(matName);
            if (mat && mat.type === MaterialType.textured) {
                const restored: TexturedMaterial = { ...mat, diffuse: { ...state.originalRaw } };
                this._recordOp(`Reset Texture (${matName})`);
                this._appContext?.applyMaterialTextureUpdate(matName, restored, true).then(() => {
                    this.render();
                });
            }
        });

        panel.querySelector('#me-download-png')?.addEventListener('click', () => {
            const state = this._textureStates.get(matName);
            if (!state) return;
            const url = this._encodePixelsToPngDataUrl(state.workingPixels, state.width, state.height);
            const link = document.createElement('a');
            link.href = url;
            link.download = `${matName.replace(/[^a-zA-Z0-9_\-.]/g, '_')}.png`;
            link.click();
        });
    }

    private _bindStorageEvents(panel: HTMLElement) {
        panel.querySelector('#prep-save-cp')?.addEventListener('click', async () => {
            if (!this._appContext || !this._appContext.hasImportedMesh()) return;
            const nameInput = panel.querySelector('#prep-cp-name') as HTMLInputElement | null;
            const name = nameInput?.value.trim() || this._appContext.getLoadedFilename() || 'Checkpoint';
            const bundle = await this._appContext.buildPreprocessedSnapshot(name, {
                operations: this._operationLog,
                recipe: this._getCurrentRecipeParams(),
            });
            if (!bundle) return;
            await PreprocessStorage.saveCheckpoint(bundle);
            AppConsole.success(LOC('preprocessing.checkpoint_saved', { name: bundle.name }));
            await this._refreshCheckpoints();
        });

        panel.querySelectorAll('[data-cp-load]').forEach((btn) => {
            btn.addEventListener('click', async () => {
                const id = btn.getAttribute('data-cp-load');
                if (!id || !this._appContext) return;
                const bundle = await PreprocessStorage.getCheckpoint(id);
                if (bundle) await this._appContext.loadPreprocessedBundle(bundle);
            });
        });

        panel.querySelectorAll('[data-cp-del]').forEach((btn) => {
            btn.addEventListener('click', async () => {
                const id = btn.getAttribute('data-cp-del');
                if (!id) return;
                const cp = this._checkpoints.find((c) => c.id === id);
                await PreprocessStorage.deleteCheckpoint(id);
                if (cp) AppConsole.info(LOC('preprocessing.checkpoint_deleted', { name: cp.name }));
                await this._refreshCheckpoints();
            });
        });

        panel.querySelector('#prep-export-bundle')?.addEventListener('click', async () => {
            if (!this._appContext || !this._appContext.hasImportedMesh()) return;
            const nameInput = panel.querySelector('#prep-cp-name') as HTMLInputElement | null;
            const name = nameInput?.value.trim() || this._appContext.getLoadedFilename() || 'model';
            const bundle = await this._appContext.buildPreprocessedSnapshot(name, {
                operations: this._operationLog,
                recipe: this._getCurrentRecipeParams(),
            });
            if (!bundle) return;
            const safeBase = name.replace(/[^a-zA-Z0-9_\-.]/g, '_');
            const jsonText = serializePreprocessBundleJson(bundle);
            download(jsonText, `${safeBase}.otsprep.json`);
            AppConsole.success(LOC('preprocessing.bundle_exported', { name: safeBase }));
        });

        const fileInput = panel.querySelector('#prep-import-bundle-input') as HTMLInputElement | null;
        panel.querySelector('#prep-import-bundle-btn')?.addEventListener('click', () => fileInput?.click());
        fileInput?.addEventListener('change', async () => {
            const file = fileInput.files?.[0];
            if (!file || !this._appContext) return;
            try {
                const { parsePreprocessBundle } = await import('../../preprocessing_storage');
                const text = await file.text();
                const bundle = parsePreprocessBundle(text);
                await this._appContext.loadPreprocessedBundle(bundle);
            } catch {
                AppConsole.error(LOC('preprocessing.bundle_invalid'));
            } finally {
                fileInput.value = '';
            }
        });

        panel.querySelector('#prep-save-recipe')?.addEventListener('click', () => {
            const nameInput = panel.querySelector('#prep-recipe-name') as HTMLInputElement | null;
            const name = nameInput?.value.trim() || 'Preset';
            const saved = PreprocessStorage.saveRecipe(name, this._getCurrentRecipeParams());
            this._recipes = PreprocessStorage.listRecipes();
            AppConsole.success(LOC('preprocessing.recipe_saved', { name: saved.name }));
            this.render();
        });

        panel.querySelectorAll('[data-recipe-apply]').forEach((btn) => {
            btn.addEventListener('click', () => {
                const id = btn.getAttribute('data-recipe-apply');
                const recipe = this._recipes.find((r) => r.id === id);
                if (!recipe) return;
                this.loadRecipeParams(recipe.params, true);
                this._recordOp(`Preset: ${recipe.name}`);
                AppConsole.info(LOC('preprocessing.recipe_applied', { name: recipe.name }));
            });
        });

        panel.querySelectorAll('[data-recipe-del]').forEach((btn) => {
            btn.addEventListener('click', () => {
                const id = btn.getAttribute('data-recipe-del');
                if (!id) return;
                PreprocessStorage.deleteRecipe(id);
                this._recipes = PreprocessStorage.listRecipes();
                this.render();
            });
        });
    }

    private _handle3DPaintEvent(evt: TMeshPaintEvent) {
        if (evt.phase === 'end') {
            if (this._last3DPoint) {
                this._recordOp(`3D ${this._tool} (${this._last3DPoint.materialName})`);
                this._scheduleLiveTextureSync(this._last3DPoint.materialName, true);
            }
            this._last3DPoint = null;
            return;
        }

        const matMap = this._appContext?.getMaterialManager().materials;
        if (!matMap) return;

        const targetMatName = evt.materialName && matMap.has(evt.materialName) ?
            evt.materialName :
            this._selectedMaterialName;
        if (!targetMatName) return;

        const mat = matMap.get(targetMatName);
        if (!mat || mat.type !== MaterialType.textured || !mat.diffuse) return;

        const state = this._textureStates.get(targetMatName);
        if (!state) {
            this._ensureTextureLoaded(targetMatName, mat);
            return;
        }

        if (!evt.uv) return;
        const { x, y } = uvToPixelCoord(
            evt.uv.u,
            evt.uv.v,
            state.width,
            state.height,
            mat.extension === 'clamp' ? 'clamp' : 'repeat',
        );

        if (this._tool === 'eyedropper') {
            this._pickColorAt(state, x, y);
            return;
        }

        const activeLayer = getActiveTextureLayer(state.layerStack);
        if (!activeLayer || activeLayer.locked) return;

        const paintMode = this._tool === 'eraser' ? 'erase' : 'paint';
        if (evt.phase === 'start') {
            if (this._selectedMaterialName !== targetMatName) {
                this._selectedMaterialName = targetMatName;
                this.render();
            }
            this._pushLayerUndo(activeLayer);
            if (this._tool === 'fill') {
                const rgba = hexToPixelRGBA(this._brushColor);
                floodFillRgba(activeLayer.pixels, state.width, state.height, x, y, rgba);
                if (this._mirrorXBrush) {
                    floodFillRgba(activeLayer.pixels, state.width, state.height, state.width - 1 - x, y, rgba);
                }
                this._recomputeWorkingPixels(state);
                this._drawActiveCanvas();
                this._updateUndoButtonState();
                this._recordOp(`3D Fill (${targetMatName})`);
                this._scheduleLiveTextureSync(targetMatName, true);
                return;
            }
            this._applyPaintDabToActiveLayer(state, activeLayer, x, y, paintMode);
            this._last3DPoint = { materialName: targetMatName, x, y };
        } else if (evt.phase === 'move') {
            if (this._tool === 'fill') return;
            if (this._last3DPoint && this._last3DPoint.materialName === targetMatName) {
                this._applyPaintStrokeToActiveLayer(state, activeLayer, this._last3DPoint.x, this._last3DPoint.y, x, y, paintMode);
            } else {
                this._applyPaintDabToActiveLayer(state, activeLayer, x, y, paintMode);
            }
            this._last3DPoint = { materialName: targetMatName, x, y };
        }

        this._recomputeWorkingPixels(state);
        if (this._selectedMaterialName === targetMatName) {
            this._drawActiveCanvas();
            this._updateUndoButtonState();
        }
        this._scheduleLiveTextureSync(targetMatName, false);
    }

    private _pickColorAt(state: TextureEditState, x: number, y: number) {
        const idx = (y * state.width + x) * 4;
        const hex = `#${state.workingPixels[idx].toString(16).padStart(2, '0')}${state.workingPixels[idx + 1].toString(16).padStart(2, '0')}${state.workingPixels[idx + 2].toString(16).padStart(2, '0')}`;
        this._brushColor = hex;
        const colorEl = document.getElementById('me-brush-color') as HTMLInputElement | null;
        const hexEl = document.getElementById('me-brush-hex');
        if (colorEl) colorEl.value = hex;
        if (hexEl) hexEl.textContent = hex.toUpperCase();
    }

    private _pushLayerUndo(layer: TextureLayer) {
        layer.undoStack.push(new Uint8ClampedArray(layer.pixels));
        if (layer.undoStack.length > 15) {
            layer.undoStack.shift();
        }
    }

    private _updateUndoButtonState() {
        const btn = document.getElementById('me-undo-texture') as HTMLButtonElement | null;
        if (!btn || !this._selectedMaterialName) return;
        const state = this._textureStates.get(this._selectedMaterialName);
        const activeLayer = state ? getActiveTextureLayer(state.layerStack) : undefined;
        btn.disabled = !(activeLayer && activeLayer.undoStack.length > 0);
    }

    private _recomputeWorkingPixels(state: TextureEditState) {
        let composed = compositeTextureLayers(state.layerStack.layers, state.width, state.height);
        if (state.pixelizeSize > 1) {
            composed = pixelizeRgba(composed, state.width, state.height, state.pixelizeSize);
        }
        if (hasActiveFilters(state.filters, 1)) {
            composed = adjustTexturePixels(composed, state.width, state.height, state.filters);
        }
        state.workingPixels = composed;
    }

    private _ensureTextureLoaded(materialName: string, mat: TexturedMaterial) {
        if (!mat.diffuse || this._textureStates.has(materialName) || this._loadingMaterials.has(materialName)) {
            return;
        }
        this._loadingMaterials.add(materialName);
        const img = new Image();
        img.onload = () => {
            this._loadingMaterials.delete(materialName);
            const width = Math.max(1, img.naturalWidth || img.width);
            const height = Math.max(1, img.naturalHeight || img.height);
            const tmp = document.createElement('canvas');
            tmp.width = width;
            tmp.height = height;
            const ctx = tmp.getContext('2d');
            if (!ctx) return;
            ctx.drawImage(img, 0, 0, width, height);
            const imageData = ctx.getImageData(0, 0, width, height);
            const basePixels = new Uint8ClampedArray(imageData.data);
            const stack = createTextureLayerStack(width, height, basePixels);

            this._textureStates.set(materialName, {
                materialName,
                width,
                height,
                layerStack: stack,
                workingPixels: compositeTextureLayers(stack.layers, width, height),
                originalRaw: mat.diffuse ? { ...mat.diffuse } : undefined,
                filters: defaultFilters(),
                pixelizeSize: 1,
            });

            if (this._isOpen && this._activeTab === 'textures' && this._selectedMaterialName === materialName) {
                this.render();
            }
        };
        img.onerror = () => {
            this._loadingMaterials.delete(materialName);
        };
        img.src = mat.diffuse.raw;
    }

    private _drawActiveCanvas() {
        if (!this._selectedMaterialName) return;
        const state = this._textureStates.get(this._selectedMaterialName);
        const canvas = document.getElementById('me-texture-canvas') as HTMLCanvasElement | null;
        if (!state || !canvas) return;

        if (canvas.width !== state.width) canvas.width = state.width;
        if (canvas.height !== state.height) canvas.height = state.height;

        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        const imgData = new ImageData(new Uint8ClampedArray(state.workingPixels), state.width, state.height);
        ctx.putImageData(imgData, 0, 0);
        this._applyCanvasZoomDisplay();
    }

    private _applyCanvasZoomDisplay() {
        if (!this._selectedMaterialName) return;
        const state = this._textureStates.get(this._selectedMaterialName);
        const canvas = document.getElementById('me-texture-canvas') as HTMLCanvasElement | null;
        if (!state || !canvas) return;

        const baseDisplay = 196;
        const aspect = state.width / Math.max(1, state.height);
        const w = Math.round((baseDisplay * this._zoomPercent / 100) * (aspect >= 1 ? 1 : aspect));
        const h = Math.round((baseDisplay * this._zoomPercent / 100) * (aspect >= 1 ? 1 / aspect : 1));
        canvas.style.width = `${Math.max(48, w)}px`;
        canvas.style.height = `${Math.max(48, h)}px`;

        const zoomVal = document.getElementById('me-zoom-val');
        if (zoomVal) zoomVal.textContent = `${this._zoomPercent}%`;
    }

    private _encodePixelsToPngDataUrl(pixels: Uint8ClampedArray, width: number, height: number): string {
        const c = document.createElement('canvas');
        c.width = width;
        c.height = height;
        const ctx = c.getContext('2d');
        if (!ctx) return '';
        const imgData = new ImageData(new Uint8ClampedArray(pixels), width, height);
        ctx.putImageData(imgData, 0, 0);
        return c.toDataURL('image/png');
    }

    private _scheduleLiveTextureSync(materialName: string, immediate: boolean) {
        if (immediate) {
            if (this._liveSyncTimer !== null) {
                window.clearTimeout(this._liveSyncTimer);
                this._liveSyncTimer = null;
            }
            this._flushTextureToModel(materialName, false);
            return;
        }

        if (this._liveSyncTimer !== null) return;
        this._liveSyncTimer = window.setTimeout(() => {
            this._liveSyncTimer = null;
            this._flushTextureToModel(materialName, false);
        }, 90);
    }

    private async _flushTextureToModel(materialName: string, syncSidebar: boolean) {
        if (this._liveSyncInFlight) {
            this._liveSyncPendingMat = materialName;
            return;
        }

        const state = this._textureStates.get(materialName);
        const mat = this._appContext?.getMaterialManager().materials.get(materialName);
        if (!state || !mat || mat.type !== MaterialType.textured || !this._appContext) {
            return;
        }

        this._liveSyncInFlight = true;
        try {
            const raw = this._encodePixelsToPngDataUrl(state.workingPixels, state.width, state.height);
            const nextMat: TexturedMaterial = {
                ...mat,
                diffuse: { filetype: 'png', raw },
                needsAttention: false,
            };
            await this._appContext.applyMaterialTextureUpdate(materialName, nextMat, syncSidebar);
        } finally {
            this._liveSyncInFlight = false;
            const pending = this._liveSyncPendingMat;
            this._liveSyncPendingMat = null;
            if (pending) this._flushTextureToModel(pending, false);
        }
    }

    private _escapeHtml(str: string): string {
        return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    private _escapeAttr(str: string): string {
        return this._escapeHtml(str).replace(/"/g, '&quot;');
    }
}
