import { AppContext } from '../../app_context';
import { InteractionManager, TMeshPaintEvent } from '../../interaction';
import { LOC } from '../../localiser';
import { MaterialType, SolidMaterial, TexturedMaterial } from '../../mesh';
import { MeshEditParams } from '../../mesh_editor';
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
import { download } from '../../util/file_util';
import { AppConsole } from '../console';

export type PreprocessTab = 'geometry' | 'textures' | 'storage';
type PaintTool = 'brush' | 'eraser' | 'fill' | 'eyedropper';

interface TextureEditState {
    materialName: string;
    width: number;
    height: number;
    basePixels: Uint8ClampedArray;
    workingPixels: Uint8ClampedArray;
    undoStack: Uint8ClampedArray[];
    originalRaw?: TImageRawWrap;
    filters: TextureFilterParams;
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

function hasActiveFilters(f: TextureFilterParams): boolean {
    return (
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
    private _canUndoMesh = false;
    private _uniformScale = true;
    private _isBusy = false;

    // Geometry recipe parameters
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
        this._canUndoMesh = false;
        this._textureStates.clear();
        this._loadingMaterials.clear();
        this._selectedMaterialName = null;
        this._last3DPoint = null;
        this._last2DPoint = null;
        this._operationLog = [];
        this._cropMinPct = { x: 0, y: 0, z: 0 };
        this._cropMaxPct = { x: 100, y: 100, z: 100 };
        if (this._isOpen) {
            this.render();
            this._sync3DPaintHook();
        }
    }

    public onPreprocessedBundleLoaded(bundle: PreprocessBundleV1) {
        this._textureStates.clear();
        this._loadingMaterials.clear();
        this._selectedMaterialName = null;
        this._canUndoMesh = false;
        this._operationLog = (bundle.operations ?? []).map((o) => ({ ...o }));
        if (bundle.recipe) {
            this.loadRecipeParams(bundle.recipe, false);
        }
        if (this._isOpen) {
            this._refreshCheckpoints();
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
                this._reapplyFiltersToWorking(state);
                this._scheduleLiveTextureSync(this._selectedMaterialName, true);
            }
        }
        if (shouldRender && this._isOpen) {
            this.render();
        }
    }

    public onMeshStateChanged() {
        if (this._isOpen) {
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

    private _getPanelElement(): HTMLElement | null {
        if (typeof document === 'undefined') return null;
        return document.getElementById('preprocess-workspace-panel');
    }

    public render() {
        const panel = this._getPanelElement();
        if (!panel) return;

        if (!this._isOpen) {
            return;
        }

        const hasMesh = this._appContext?.hasImportedMesh() ?? false;
        if (!hasMesh && this._activeTab !== 'storage') {
            this._disable3DPaint();
        }

        const headerHTML = `
            <div class="preprocess-studio-header">
                <div class="preprocess-studio-title">${LOC('workspace.studio_title')}</div>
                <button type="button" class="preprocess-link-btn" id="prep-back-pipeline">${LOC('workspace.back_to_pipeline')}</button>
            </div>
        `;

        const diagHTML = this._renderDiagnosticsHTML(hasMesh);

        const tabsHTML = `
            <div class="model-editor-tabs preprocess-tabs" role="tablist">
                <button type="button" role="tab" aria-selected="${this._activeTab === 'geometry'}" class="model-editor-tab ${this._activeTab === 'geometry' ? 'active' : ''}" data-prep-tab="geometry">${LOC('preprocessing.tab_geometry')}</button>
                <button type="button" role="tab" aria-selected="${this._activeTab === 'textures'}" class="model-editor-tab ${this._activeTab === 'textures' ? 'active' : ''}" data-prep-tab="textures">${LOC('preprocessing.tab_textures')}</button>
                <button type="button" role="tab" aria-selected="${this._activeTab === 'storage'}" class="model-editor-tab ${this._activeTab === 'storage' ? 'active' : ''}" data-prep-tab="storage">${LOC('preprocessing.tab_storage')}</button>
            </div>
        `;

        let bodyHTML = '';
        if (this._activeTab === 'storage') {
            bodyHTML = this._renderStorageTabHTML(hasMesh);
        } else if (!hasMesh) {
            bodyHTML = `
                <div class="model-editor-empty preprocess-empty-card">
                    <p>${LOC('preprocessing.no_mesh_hint')}</p>
                    <button type="button" class="model-editor-btn primary" id="prep-jump-storage">${LOC('preprocessing.tab_storage')}</button>
                </div>
            `;
        } else if (this._activeTab === 'geometry') {
            bodyHTML = this._renderGeometryTabHTML();
        } else {
            bodyHTML = this._renderTexturesTabHTML();
        }

        const stickyFooterHTML = `
            <div class="preprocess-sticky-footer">
                <button type="button" class="model-editor-btn" id="prep-export-glb" ${hasMesh ? '' : 'disabled'}>${LOC('model_editor.export_glb')}</button>
                <button type="button" class="model-editor-btn primary" id="prep-proceed-voxel">${LOC('workspace.proceed_to_voxel')}</button>
            </div>
        `;

        panel.innerHTML = `
            ${headerHTML}
            ${diagHTML}
            ${tabsHTML}
            <div class="model-editor-content preprocess-content">${bodyHTML}</div>
            ${stickyFooterHTML}
        `;

        this._bindEvents(panel);

        if (hasMesh && this._activeTab === 'textures') {
            this._drawActiveCanvas();
        }
    }

    private _renderDiagnosticsHTML(hasMesh: boolean): string {
        if (!hasMesh) {
            return '';
        }
        const dims = this._appContext?.getImportedMeshDimensions();
        const diag = this._appContext?.getMeshDiagnostics();
        const tris = diag?.triangleCount ?? this._appContext?.getImportedTriangleCount() ?? 0;
        const verts = diag?.vertexCount ?? 0;
        const islands = diag?.connectedComponents ?? 1;
        const dimsStr = dims ?
            `${dims.x.toFixed(2)} × ${dims.y.toFixed(2)} × ${dims.z.toFixed(2)}` :
            '—';

        const badges: string[] = [];
        badges.push(`<span class="prep-badge neutral">${LOC('preprocessing.diag_verts', { count: verts })}</span>`);
        badges.push(`<span class="prep-badge neutral">${LOC('preprocessing.diag_tris', { count: tris })}</span>`);
        badges.push(`<span class="prep-badge ${islands > 1 ? 'warn' : 'neutral'}">${LOC('preprocessing.diag_islands', { count: islands })}</span>`);

        if (diag) {
            if (diag.degenerateTriangles > 0) {
                badges.push(`<span class="prep-badge warn">${LOC('preprocessing.diag_degen', { count: diag.degenerateTriangles })}</span>`);
            }
            if (diag.missingNormalTriangles > 0) {
                badges.push(`<span class="prep-badge warn">${LOC('preprocessing.diag_missing_norm', { count: diag.missingNormalTriangles })}</span>`);
            }
            if (diag.hasOobUVs) {
                badges.push(`<span class="prep-badge info">${LOC('preprocessing.diag_oob_uv')}</span>`);
            }
            if (diag.hasVertexColours) {
                badges.push(`<span class="prep-badge info">${LOC('preprocessing.diag_vertex_col')}</span>`);
            }
            if (diag.degenerateTriangles === 0 && diag.missingNormalTriangles === 0 && islands <= 1) {
                badges.push(`<span class="prep-badge ok">${LOC('preprocessing.diag_ok')}</span>`);
            }
        }

        return `
            <div class="prep-diagnostics-card" data-testid="prep-diagnostics">
                <div class="prep-diag-top">
                    <span class="prep-diag-title">${LOC('preprocessing.diagnostics')}</span>
                    <span class="model-editor-mono">${dimsStr}</span>
                </div>
                <div class="prep-diag-badges">${badges.join('')}</div>
            </div>
        `;
    }

    private _renderGeometryTabHTML(): string {
        const tris = this._appContext?.getImportedTriangleCount() ?? 0;
        const estSimplified = Math.max(4, Math.round(tris * this._decimateRatio));

        return `
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
                <div class="model-editor-section-head">
                    <span>${LOC('model_editor.rotate_label')}</span>
                </div>
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
                <div class="model-editor-section-head">
                    <span>${LOC('model_editor.mirror_label')} & ${LOC('model_editor.geom_tools')}</span>
                </div>
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
                <div class="model-editor-btn-row-3">
                    <button type="button" class="model-editor-btn" id="me-normals-btn">${LOC('model_editor.recompute_normals')}</button>
                    <button type="button" class="model-editor-btn" id="me-flat-normals-btn">${LOC('preprocessing.op_flat_normals')}</button>
                    <button type="button" class="model-editor-btn" id="me-flip-normals-btn">${LOC('model_editor.flip_normals')}</button>
                </div>
            </div>

            <div class="model-editor-section">
                <div class="model-editor-section-head">
                    <span>${LOC('preprocessing.op_weld')} & ${LOC('preprocessing.op_clean_repair')}</span>
                </div>
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
                <button type="button" class="model-editor-btn" id="prep-clean-btn">${LOC('preprocessing.op_clean_repair')}</button>
            </div>

            <div class="model-editor-section">
                <div class="model-editor-section-head">
                    <span>${LOC('preprocessing.op_simplify')}</span>
                    <span class="model-editor-mono" id="prep-decimate-est">${LOC('preprocessing.est_tris', { count: estSimplified })}</span>
                </div>
                <div class="prep-slider-action-row">
                    <label class="model-editor-slider-inline">
                        <span>${LOC('preprocessing.target_ratio')}: <b id="prep-decimate-val">${Math.round(this._decimateRatio * 100)}%</b></span>
                        <input type="range" id="prep-decimate-ratio" min="10" max="95" step="5" value="${Math.round(this._decimateRatio * 100)}" />
                    </label>
                    <button type="button" class="model-editor-btn" id="prep-decimate-btn">${LOC('preprocessing.op_simplify')}</button>
                </div>
            </div>

            <div class="model-editor-section">
                <div class="model-editor-section-head">
                    <span>${LOC('preprocessing.op_crop')} (%)</span>
                </div>
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
                    <button type="button" class="model-editor-btn" id="prep-crop-apply">${LOC('preprocessing.crop_apply')}</button>
                    <button type="button" class="model-editor-btn" id="prep-crop-reset">${LOC('preprocessing.crop_reset')}</button>
                </div>
            </div>

            <div class="model-editor-btn-row-2">
                <button type="button" class="model-editor-btn" id="me-undo-mesh" ${this._canUndoMesh ? '' : 'disabled'}>${LOC('model_editor.undo')}</button>
                <button type="button" class="model-editor-btn" id="me-reset-mesh">${LOC('model_editor.reset_original')}</button>
            </div>
        `;
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

        const filters = state.filters;
        const dimsBadge = LOC('model_editor.tex_info', { w: state.width, h: state.height });

        return `
            ${selectorRow}
            <div class="model-editor-tex-toolbar prep-tex-toolbar">
                <button type="button" class="model-editor-tool-btn ${this._tool === 'brush' ? 'active' : ''}" data-tool="brush">${LOC('model_editor.tool_brush')}</button>
                <button type="button" class="model-editor-tool-btn ${this._tool === 'eraser' ? 'active' : ''}" data-tool="eraser">${LOC('model_editor.tool_eraser')}</button>
                <button type="button" class="model-editor-tool-btn ${this._tool === 'fill' ? 'active' : ''}" data-tool="fill">${LOC('model_editor.tool_fill')}</button>
                <button type="button" class="model-editor-tool-btn ${this._tool === 'eyedropper' ? 'active' : ''}" data-tool="eyedropper">${LOC('model_editor.tool_eyedropper')}</button>
                <button type="button" class="model-editor-tool-btn accent ${this._is3DPaintEnabled ? 'active' : ''}" id="me-paint-3d-toggle">${LOC('model_editor.paint_3d')}</button>
                <button type="button" class="model-editor-tool-btn accent ${this._mirrorXBrush ? 'active' : ''}" id="prep-mirror-x-toggle">${LOC('preprocessing.mirror_x_brush')}</button>
            </div>

            ${this._is3DPaintEnabled ? `<div class="model-editor-3d-hint">${LOC('model_editor.paint_3d_hint')}</div>` : ''}

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

            <div class="prep-tex-ops-row">
                <button type="button" class="model-editor-btn-xs" id="prep-tex-flip-h">${LOC('preprocessing.flip_h')}</button>
                <button type="button" class="model-editor-btn-xs" id="prep-tex-flip-v">${LOC('preprocessing.flip_v')}</button>
                <button type="button" class="model-editor-btn-xs" id="prep-tex-rot-90">${LOC('preprocessing.rotate_90')}</button>
                <button type="button" class="model-editor-btn-xs" id="prep-tex-auto-levels">${LOC('preprocessing.auto_levels')}</button>
            </div>

            <div class="model-editor-canvas-bar">
                <span class="model-editor-mono">${dimsBadge}</span>
                <div class="model-editor-zoom-btns">
                    <span>${LOC('model_editor.zoom_label')}:</span>
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

            <div class="model-editor-section">
                <div class="model-editor-section-head">
                    <span>${LOC('model_editor.filters_label')}</span>
                    <div class="model-editor-mini-actions">
                        <button type="button" class="model-editor-btn-xs" id="me-commit-filters">${LOC('model_editor.commit_filters')}</button>
                        <button type="button" class="model-editor-btn-xs" id="me-reset-filters">${LOC('model_editor.reset_filters')}</button>
                    </div>
                </div>
                <div class="model-editor-filters-grid">
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
                </div>
            </div>

            <div class="model-editor-footer">
                <button type="button" class="model-editor-btn primary" id="me-apply-texture">${LOC('model_editor.apply_texture')}</button>
                <button type="button" class="model-editor-btn" id="me-undo-texture" ${state.undoStack.length > 0 ? '' : 'disabled'}>${LOC('model_editor.undo')}</button>
                <button type="button" class="model-editor-btn" id="me-reset-texture" ${state.originalRaw ? '' : 'disabled'}>${LOC('model_editor.reset_original')}</button>
                <button type="button" class="model-editor-btn" id="me-download-png">${LOC('model_editor.download_png')}</button>
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
                            <button type="button" class="model-editor-btn-xs primary" data-cp-load="${this._escapeAttr(cp.id)}" aria-label="${this._escapeAttr(`${LOC('preprocessing.restore_btn')} ${cp.name}`)}">${LOC('preprocessing.restore_btn')}</button>
                            <button type="button" class="model-editor-btn-xs danger" data-cp-del="${this._escapeAttr(cp.id)}" aria-label="${this._escapeAttr(`${LOC('preprocessing.delete_btn')} ${cp.name}`)}">${LOC('preprocessing.delete_btn')}</button>
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
                        <button type="button" class="model-editor-btn-xs" data-recipe-apply="${this._escapeAttr(rcp.id)}" aria-label="${this._escapeAttr(`${LOC('preprocessing.apply_recipe')} ${rcp.name}`)}">${LOC('preprocessing.apply_recipe')}</button>
                        <button type="button" class="model-editor-btn-xs danger" data-recipe-del="${this._escapeAttr(rcp.id)}" aria-label="${this._escapeAttr(`${LOC('preprocessing.delete_btn')} ${rcp.name}`)}">${LOC('preprocessing.delete_btn')}</button>
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
                <div class="model-editor-section-head">
                    <span>${LOC('preprocessing.checkpoints_title')}</span>
                </div>
                <div class="prep-input-row">
                    <input type="text" id="prep-cp-name" class="prep-text-input" value="${this._escapeAttr(defaultName)}" placeholder="${this._escapeAttr(LOC('preprocessing.checkpoint_name_ph'))}" aria-label="${this._escapeAttr(LOC('preprocessing.checkpoint_name_ph'))}" />
                    <button type="button" class="model-editor-btn primary" id="prep-save-cp" ${hasMesh ? '' : 'disabled'}>${LOC('preprocessing.save_checkpoint')}</button>
                </div>
                <div class="prep-saved-list" data-testid="prep-checkpoints-list">${checkpointsHTML}</div>
            </div>

            <div class="model-editor-section">
                <div class="model-editor-section-head">
                    <span>${LOC('preprocessing.bundle_title')}</span>
                </div>
                <div class="model-editor-btn-row-2">
                    <button type="button" class="model-editor-btn" id="prep-export-bundle" ${hasMesh ? '' : 'disabled'}>${LOC('preprocessing.export_bundle')}</button>
                    <button type="button" class="model-editor-btn" id="prep-import-bundle-btn">${LOC('preprocessing.import_bundle')}</button>
                </div>
                <input type="file" id="prep-import-bundle-input" accept=".json,.otsprep.json" class="hide" aria-label="${this._escapeAttr(LOC('preprocessing.import_bundle'))}" />
            </div>

            <div class="model-editor-section">
                <div class="model-editor-section-head">
                    <span>${LOC('preprocessing.recipes_title')}</span>
                </div>
                <div class="prep-input-row">
                    <input type="text" id="prep-recipe-name" class="prep-text-input" placeholder="${this._escapeAttr(LOC('preprocessing.recipe_name_ph'))}" aria-label="${this._escapeAttr(LOC('preprocessing.recipe_name_ph'))}" />
                    <button type="button" class="model-editor-btn" id="prep-save-recipe">${LOC('preprocessing.save_recipe')}</button>
                </div>
                <div class="prep-saved-list" data-testid="prep-recipes-list">${recipesHTML}</div>
            </div>

            <div class="model-editor-section">
                <div class="model-editor-section-head">
                    <span>${LOC('preprocessing.history_title')}</span>
                </div>
                <div class="prep-history-list">${historyHTML}</div>
            </div>
        `;
    }

    private _bindEvents(panel: HTMLElement) {
        panel.querySelector('#prep-back-pipeline')?.addEventListener('click', () => {
            this._onProceedToPipeline?.();
        });
        panel.querySelector('#prep-proceed-voxel')?.addEventListener('click', () => {
            this._onProceedToPipeline?.();
        });
        panel.querySelector('#prep-export-glb')?.addEventListener('click', async () => {
            await this._appContext?.exportRepairedGlb({ preserveCurrentGeometry: true });
        });
        panel.querySelector('#prep-jump-storage')?.addEventListener('click', () => {
            this.setActiveSubTab('storage');
        });

        panel.querySelectorAll('[data-prep-tab]').forEach((btn) => {
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

        if (this._activeTab === 'storage') {
            this._bindStorageEvents(panel);
            return;
        }

        if (!(this._appContext?.hasImportedMesh() ?? false)) {
            return;
        }

        if (this._activeTab === 'geometry') {
            this._bindGeometryEvents(panel);
        } else {
            this._bindTextureEvents(panel);
        }
    }

    private _bindGeometryEvents(panel: HTMLElement) {
        const uniformEl = panel.querySelector('#me-uniform-scale') as HTMLInputElement | null;
        const sxEl = panel.querySelector('#me-scale-x') as HTMLInputElement | null;
        const syEl = panel.querySelector('#me-scale-y') as HTMLInputElement | null;
        const szEl = panel.querySelector('#me-scale-z') as HTMLInputElement | null;

        const rxEl = panel.querySelector('#me-rot-x') as HTMLInputElement | null;
        const ryEl = panel.querySelector('#me-rot-y') as HTMLInputElement | null;
        const rzEl = panel.querySelector('#me-rot-z') as HTMLInputElement | null;

        if (uniformEl) {
            uniformEl.addEventListener('change', () => {
                this._uniformScale = uniformEl.checked;
            });
        }

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
                await this._runMeshEdit({ operation: 'transform', rotateDeg }, `Rotate ${axis.toUpperCase()} ${deg}°`);
            });
        });

        panel.querySelectorAll('[data-mirror-axis]').forEach((btn) => {
            btn.addEventListener('click', async () => {
                const axis = btn.getAttribute('data-mirror-axis') as 'x' | 'y' | 'z';
                if (!axis) return;
                await this._runMeshEdit({ operation: 'transform', flipAxis: axis }, `Mirror ${axis.toUpperCase()}`);
            });
        });

        panel.querySelector('#me-center-btn')?.addEventListener('click', async () => {
            await this._runMeshEdit({ operation: 'centerGround' }, 'Center & Ground');
        });
        panel.querySelector('#me-ground-btn')?.addEventListener('click', async () => {
            await this._runMeshEdit({ operation: 'putOnGround' }, 'Put on Ground Y=0');
        });
        panel.querySelector('#me-normalize-btn')?.addEventListener('click', async () => {
            await this._runMeshEdit({ operation: 'normalizeSize' }, 'Normalize Height 1.0');
        });
        panel.querySelector('#me-normals-btn')?.addEventListener('click', async () => {
            await this._runMeshEdit({ operation: 'recomputeNormals' }, 'Smooth Normals');
        });
        panel.querySelector('#me-flat-normals-btn')?.addEventListener('click', async () => {
            await this._runMeshEdit({ operation: 'flatNormals' }, 'Flat Normals');
        });
        panel.querySelector('#me-flip-normals-btn')?.addEventListener('click', async () => {
            await this._runMeshEdit({ operation: 'flipNormals' }, 'Flip Normals');
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
            if (!hasScale && !hasRot) {
                return;
            }
            await this._runMeshEdit({
                operation: 'transform',
                scale: { x: sx, y: sy, z: sz },
                rotateDeg: { x: rx, y: ry, z: rz },
            }, `Transform (${sx.toFixed(2)}, ${sy.toFixed(2)}, ${sz.toFixed(2)})`);
        });

        const weldSelect = panel.querySelector('#prep-weld-tol') as HTMLSelectElement | null;
        weldSelect?.addEventListener('change', () => {
            this._weldTolerance = parseFloat(weldSelect.value) || 0.0001;
        });
        panel.querySelector('#prep-weld-btn')?.addEventListener('click', async () => {
            await this._runMeshEdit({
                operation: 'weldVertices',
                weldTolerance: this._weldTolerance,
            }, `Weld Vertices (${this._weldTolerance})`);
        });

        const cleanIslandsEl = panel.querySelector('#prep-clean-islands') as HTMLInputElement | null;
        const cleanMinEl = panel.querySelector('#prep-clean-min-tris') as HTMLInputElement | null;
        const cleanSmoothEl = panel.querySelector('#prep-clean-smooth-normals') as HTMLInputElement | null;
        cleanIslandsEl?.addEventListener('change', () => {
            this._cleanRemoveIslands = cleanIslandsEl.checked;
            if (cleanMinEl) {
                cleanMinEl.disabled = !this._cleanRemoveIslands;
            }
        });
        cleanMinEl?.addEventListener('change', () => {
            this._cleanMinIslandTris = Math.max(2, Math.min(500, parseInt(cleanMinEl.value, 10) || 16));
        });
        cleanSmoothEl?.addEventListener('change', () => {
            this._cleanForceSmoothNormals = cleanSmoothEl.checked;
        });
        panel.querySelector('#prep-clean-btn')?.addEventListener('click', async () => {
            await this._runMeshEdit({
                operation: 'cleanRepair',
                removeSmallIslands: this._cleanRemoveIslands,
                minIslandTriangles: this._cleanMinIslandTris,
                forceRecomputeNormals: this._cleanForceSmoothNormals,
                groundAndCenter: false,
            }, 'Clean & Repair');
        });

        const decimateSlider = panel.querySelector('#prep-decimate-ratio') as HTMLInputElement | null;
        decimateSlider?.addEventListener('input', () => {
            const pct = parseInt(decimateSlider.value, 10) || 50;
            this._decimateRatio = pct / 100;
            const valEl = panel.querySelector('#prep-decimate-val');
            if (valEl) valEl.textContent = `${pct}%`;
            const estEl = panel.querySelector('#prep-decimate-est');
            const tris = this._appContext?.getImportedTriangleCount() ?? 0;
            if (estEl) estEl.textContent = LOC('preprocessing.est_tris', { count: Math.max(4, Math.round(tris * this._decimateRatio)) });
        });
        panel.querySelector('#prep-decimate-btn')?.addEventListener('click', async () => {
            await this._runMeshEdit({
                operation: 'decimate',
                decimateRatio: this._decimateRatio,
            }, `Simplify (${Math.round(this._decimateRatio * 100)}%)`);
        });

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
        panel.querySelector('#prep-crop-apply')?.addEventListener('click', async () => {
            readCropInputs();
            await this._runMeshEdit({
                operation: 'cropBounds',
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
            }, `Crop BBox (${this._cropMinPct.x}-${this._cropMaxPct.x}%, ${this._cropMinPct.y}-${this._cropMaxPct.y}%, ${this._cropMinPct.z}-${this._cropMaxPct.z}%)`);
        });
        panel.querySelector('#prep-crop-reset')?.addEventListener('click', () => {
            this._cropMinPct = { x: 0, y: 0, z: 0 };
            this._cropMaxPct = { x: 100, y: 100, z: 100 };
            this.render();
        });

        panel.querySelector('#me-undo-mesh')?.addEventListener('click', async () => {
            await this._runMeshEdit({ operation: 'undo' }, 'Undo Geometry');
        });
        panel.querySelector('#me-reset-mesh')?.addEventListener('click', async () => {
            await this._runMeshEdit({ operation: 'reset' }, 'Reset Geometry');
        });
    }

    private async _runMeshEdit(params: MeshEditParams, logLabel?: string) {
        if (this._isBusy || !this._appContext) return;
        this._isBusy = true;
        try {
            const res = await this._appContext.editMesh(params);
            if (res) {
                this._canUndoMesh = res.canUndo;
                if (logLabel) {
                    this._recordOp(`${logLabel} → ${res.triangleCount} tris`);
                }
                this.render();
            }
        } finally {
            this._isBusy = false;
        }
    }

    private _applyPaintDab(state: TextureEditState, x: number, y: number, mode: 'paint' | 'erase') {
        const radius = this._brushSize * 0.5;
        const rgba = hexToPixelRGBA(this._brushColor);
        paintBrushDab(state.basePixels, state.width, state.height, x, y, radius, rgba, this._brushHardness, mode);
        if (this._mirrorXBrush) {
            const mx = state.width - 1 - x;
            paintBrushDab(state.basePixels, state.width, state.height, mx, y, radius, rgba, this._brushHardness, mode);
        }
    }

    private _applyPaintStroke(state: TextureEditState, x0: number, y0: number, x1: number, y1: number, mode: 'paint' | 'erase') {
        const radius = this._brushSize * 0.5;
        const rgba = hexToPixelRGBA(this._brushColor);
        paintBrushStroke(state.basePixels, state.width, state.height, x0, y0, x1, y1, radius, rgba, this._brushHardness, mode);
        if (this._mirrorXBrush) {
            paintBrushStroke(
                state.basePixels,
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
                    this._recordOp(`Solid colour (${matName}) → ${solidColorEl.value.toUpperCase()}`);
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
            const rgba: PixelRGBA = {
                r: Math.round(mat.colour.r * 255),
                g: Math.round(mat.colour.g * 255),
                b: Math.round(mat.colour.b * 255),
                a: Math.round(mat.colour.a * 255),
            };
            const pixels = createSolidRgbaBuffer(size, size, rgba);
            const raw = this._encodePixelsToPngDataUrl(pixels, size, size);
            const wrap: TImageRawWrap = { filetype: 'png', raw };

            const nextMat: TexturedMaterial = {
                type: MaterialType.textured,
                diffuse: wrap,
                transparency: { type: 'None' },
                extension: 'repeat',
                interpolation: 'nearest',
                needsAttention: false,
            };

            this._textureStates.set(matName, {
                materialName: matName,
                width: size,
                height: size,
                basePixels: pixels,
                workingPixels: new Uint8ClampedArray(pixels),
                undoStack: [],
                originalRaw: { ...wrap },
                filters: defaultFilters(),
            });

            this._recordOp(`Convert Solid → Texture (${matName}, ${size}×${size})`);
            await this._appContext.applyMaterialTextureUpdate(matName, nextMat, true);
            this.render();
            this._sync3DPaintHook();
        });

        panel.querySelector('#me-init-blank-btn')?.addEventListener('click', async () => {
            if (!this._selectedMaterialName || !this._appContext) return;
            const matName = this._selectedMaterialName;
            const mat = this._appContext.getMaterialManager().materials.get(matName);
            if (!mat || mat.type !== MaterialType.textured) return;

            const size = this._textureResolution;
            const pixels = createSolidRgbaBuffer(size, size, { r: 240, g: 240, b: 240, a: 255 });
            const raw = this._encodePixelsToPngDataUrl(pixels, size, size);
            const wrap: TImageRawWrap = { filetype: 'png', raw };
            const nextMat: TexturedMaterial = { ...mat, diffuse: wrap, needsAttention: false };

            this._textureStates.set(matName, {
                materialName: matName,
                width: size,
                height: size,
                basePixels: pixels,
                workingPixels: new Uint8ClampedArray(pixels),
                undoStack: [],
                originalRaw: { ...wrap },
                filters: defaultFilters(),
            });

            this._recordOp(`Create Blank Texture (${matName}, ${size}×${size})`);
            await this._appContext.applyMaterialTextureUpdate(matName, nextMat, true);
            this.render();
            this._sync3DPaintHook();
        });

        panel.querySelectorAll('[data-tool]').forEach((btn) => {
            btn.addEventListener('click', () => {
                const t = btn.getAttribute('data-tool') as PaintTool;
                if (t) {
                    this._tool = t;
                    panel.querySelectorAll('[data-tool]').forEach((el) => {
                        el.classList.toggle('active', el.getAttribute('data-tool') === t);
                    });
                }
            });
        });

        panel.querySelector('#me-paint-3d-toggle')?.addEventListener('click', () => {
            this._is3DPaintEnabled = !this._is3DPaintEnabled;
            this.render();
            this._sync3DPaintHook();
        });

        panel.querySelector('#prep-mirror-x-toggle')?.addEventListener('click', () => {
            this._mirrorXBrush = !this._mirrorXBrush;
            panel.querySelector('#prep-mirror-x-toggle')?.classList.toggle('active', this._mirrorXBrush);
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

        if (this._selectedMaterialName) {
            const matName = this._selectedMaterialName;

            panel.querySelector('#prep-tex-flip-h')?.addEventListener('click', () => {
                const state = this._textureStates.get(matName);
                if (!state) return;
                this._pushUndo(state);
                state.basePixels = flipRgbaHorizontal(state.basePixels, state.width, state.height);
                this._reapplyFiltersToWorking(state);
                this._drawActiveCanvas();
                this._updateUndoButtonState();
                this._recordOp(`Texture Flip H (${matName})`);
                this._scheduleLiveTextureSync(matName, true);
            });

            panel.querySelector('#prep-tex-flip-v')?.addEventListener('click', () => {
                const state = this._textureStates.get(matName);
                if (!state) return;
                this._pushUndo(state);
                state.basePixels = flipRgbaVertical(state.basePixels, state.width, state.height);
                this._reapplyFiltersToWorking(state);
                this._drawActiveCanvas();
                this._updateUndoButtonState();
                this._recordOp(`Texture Flip V (${matName})`);
                this._scheduleLiveTextureSync(matName, true);
            });

            panel.querySelector('#prep-tex-rot-90')?.addEventListener('click', () => {
                const state = this._textureStates.get(matName);
                if (!state) return;
                this._pushUndo(state);
                const rot = rotateRgba90CW(state.basePixels, state.width, state.height);
                state.basePixels = rot.pixels;
                state.width = rot.width;
                state.height = rot.height;
                this._reapplyFiltersToWorking(state);
                this._recordOp(`Texture Rotate 90° (${matName})`);
                this.render();
                this._scheduleLiveTextureSync(matName, true);
            });

            panel.querySelector('#prep-tex-auto-levels')?.addEventListener('click', () => {
                const state = this._textureStates.get(matName);
                if (!state) return;
                this._pushUndo(state);
                state.basePixels = autoLevelsRgba(state.basePixels, state.width, state.height);
                this._reapplyFiltersToWorking(state);
                this._drawActiveCanvas();
                this._updateUndoButtonState();
                this._recordOp(`Auto-Levels (${matName})`);
                this._scheduleLiveTextureSync(matName, true);
            });
        }

        const canvas = panel.querySelector('#me-texture-canvas') as HTMLCanvasElement | null;
        if (canvas && this._selectedMaterialName) {
            const matName = this._selectedMaterialName;
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

                this._pushUndo(state);
                if (this._tool === 'fill') {
                    const rgba = hexToPixelRGBA(this._brushColor);
                    floodFillRgba(state.basePixels, state.width, state.height, pt.x, pt.y, rgba);
                    if (this._mirrorXBrush) {
                        floodFillRgba(state.basePixels, state.width, state.height, state.width - 1 - pt.x, pt.y, rgba);
                    }
                    this._reapplyFiltersToWorking(state);
                    this._drawActiveCanvas();
                    this._recordOp(`Fill (${matName})`);
                    this._scheduleLiveTextureSync(matName, true);
                    this._updateUndoButtonState();
                    return;
                }

                this._isDrawing2D = true;
                this._last2DPoint = pt;
                const paintMode = this._tool === 'eraser' ? 'erase' : 'paint';
                this._applyPaintDab(state, pt.x, pt.y, paintMode);
                this._reapplyFiltersToWorking(state);
                this._drawActiveCanvas();
                this._scheduleLiveTextureSync(matName, false);
                this._updateUndoButtonState();
            });

            const onWindowMove = (e: MouseEvent) => {
                if (!this._isDrawing2D || this._selectedMaterialName !== matName) return;
                const state = this._textureStates.get(matName);
                const pt = getCanvasCoords(e);
                if (!state || !pt || !this._last2DPoint) return;

                const paintMode = this._tool === 'eraser' ? 'erase' : 'paint';
                this._applyPaintStroke(state, this._last2DPoint.x, this._last2DPoint.y, pt.x, pt.y, paintMode);
                this._last2DPoint = pt;
                this._reapplyFiltersToWorking(state);
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

            if (this._windowMoveListener) {
                window.removeEventListener('mousemove', this._windowMoveListener);
            }
            if (this._windowUpListener) {
                window.removeEventListener('mouseup', this._windowUpListener);
            }
            this._windowMoveListener = onWindowMove;
            this._windowUpListener = onWindowUp;
            window.addEventListener('mousemove', onWindowMove);
            window.addEventListener('mouseup', onWindowUp);
        }

        if (this._selectedMaterialName) {
            const matName = this._selectedMaterialName;
            const bindFilterSlider = (id: string, valId: string, key: keyof TextureFilterParams, suffix = '') => {
                const slider = panel.querySelector(`#${id}`) as HTMLInputElement | null;
                slider?.addEventListener('input', () => {
                    const state = this._textureStates.get(matName);
                    if (!state) return;
                    const v = parseFloat(slider.value) || 0;
                    state.filters[key] = v;
                    const labelEl = panel.querySelector(`#${valId}`);
                    if (labelEl) {
                        labelEl.textContent = key === 'posterize' && v === 0 ? 'Off' : `${v}${suffix}`;
                    }
                    this._reapplyFiltersToWorking(state);
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

            panel.querySelector('#me-commit-filters')?.addEventListener('click', () => {
                const state = this._textureStates.get(matName);
                if (!state) return;
                this._pushUndo(state);
                state.basePixels = new Uint8ClampedArray(state.workingPixels);
                state.filters = defaultFilters();
                this._recordOp(`Bake Filters (${matName})`);
                this.render();
                this._scheduleLiveTextureSync(matName, true);
            });

            panel.querySelector('#me-reset-filters')?.addEventListener('click', () => {
                const state = this._textureStates.get(matName);
                if (!state) return;
                state.filters = defaultFilters();
                state.workingPixels = new Uint8ClampedArray(state.basePixels);
                this.render();
                this._scheduleLiveTextureSync(matName, true);
            });

            panel.querySelector('#me-apply-texture')?.addEventListener('click', async () => {
                await this._flushTextureToModel(matName, true);
                this._recordOp(`Apply Texture (${matName})`);
            });

            panel.querySelector('#me-undo-texture')?.addEventListener('click', () => {
                const state = this._textureStates.get(matName);
                if (!state || state.undoStack.length === 0) return;
                const prev = state.undoStack.pop()!;
                state.basePixels = prev;
                this._reapplyFiltersToWorking(state);
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
                if (bundle) {
                    await this._appContext.loadPreprocessedBundle(bundle);
                }
            });
        });

        panel.querySelectorAll('[data-cp-del]').forEach((btn) => {
            btn.addEventListener('click', async () => {
                const id = btn.getAttribute('data-cp-del');
                if (!id) return;
                const cp = this._checkpoints.find((c) => c.id === id);
                await PreprocessStorage.deleteCheckpoint(id);
                if (cp) {
                    AppConsole.info(LOC('preprocessing.checkpoint_deleted', { name: cp.name }));
                }
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
        panel.querySelector('#prep-import-bundle-btn')?.addEventListener('click', () => {
            fileInput?.click();
        });
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

        const paintMode = this._tool === 'eraser' ? 'erase' : 'paint';
        if (evt.phase === 'start') {
            if (this._selectedMaterialName !== targetMatName) {
                this._selectedMaterialName = targetMatName;
                this.render();
            }
            this._pushUndo(state);
            if (this._tool === 'fill') {
                const rgba = hexToPixelRGBA(this._brushColor);
                floodFillRgba(state.basePixels, state.width, state.height, x, y, rgba);
                if (this._mirrorXBrush) {
                    floodFillRgba(state.basePixels, state.width, state.height, state.width - 1 - x, y, rgba);
                }
                this._reapplyFiltersToWorking(state);
                this._drawActiveCanvas();
                this._updateUndoButtonState();
                this._recordOp(`3D Fill (${targetMatName})`);
                this._scheduleLiveTextureSync(targetMatName, true);
                return;
            }
            this._applyPaintDab(state, x, y, paintMode);
            this._last3DPoint = { materialName: targetMatName, x, y };
        } else if (evt.phase === 'move') {
            if (this._tool === 'fill') return;
            if (this._last3DPoint && this._last3DPoint.materialName === targetMatName) {
                this._applyPaintStroke(state, this._last3DPoint.x, this._last3DPoint.y, x, y, paintMode);
            } else {
                this._applyPaintDab(state, x, y, paintMode);
            }
            this._last3DPoint = { materialName: targetMatName, x, y };
        }

        this._reapplyFiltersToWorking(state);
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

    private _pushUndo(state: TextureEditState) {
        state.undoStack.push(new Uint8ClampedArray(state.basePixels));
        if (state.undoStack.length > 15) {
            state.undoStack.shift();
        }
    }

    private _updateUndoButtonState() {
        const btn = document.getElementById('me-undo-texture') as HTMLButtonElement | null;
        if (!btn || !this._selectedMaterialName) return;
        const state = this._textureStates.get(this._selectedMaterialName);
        btn.disabled = !(state && state.undoStack.length > 0);
    }

    private _reapplyFiltersToWorking(state: TextureEditState) {
        const f = state.filters;
        if (!hasActiveFilters(f)) {
            state.workingPixels = new Uint8ClampedArray(state.basePixels);
        } else {
            state.workingPixels = adjustTexturePixels(state.basePixels, state.width, state.height, f);
        }
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

            this._textureStates.set(materialName, {
                materialName,
                width,
                height,
                basePixels: new Uint8ClampedArray(imageData.data),
                workingPixels: new Uint8ClampedArray(imageData.data),
                undoStack: [],
                originalRaw: mat.diffuse ? { ...mat.diffuse } : undefined,
                filters: defaultFilters(),
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

        const baseDisplay = 220;
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
                diffuse: {
                    filetype: 'png',
                    raw,
                },
                needsAttention: false,
            };
            await this._appContext.applyMaterialTextureUpdate(materialName, nextMat, syncSidebar);
        } finally {
            this._liveSyncInFlight = false;
            const pending = this._liveSyncPendingMat;
            this._liveSyncPendingMat = null;
            if (pending) {
                this._flushTextureToModel(pending, false);
            }
        }
    }

    private _escapeHtml(str: string): string {
        return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    private _escapeAttr(str: string): string {
        return this._escapeHtml(str).replace(/"/g, '&quot;');
    }
}
