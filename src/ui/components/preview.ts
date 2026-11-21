import { PALETTE_ALL_RELEASE } from '../../../res/palettes/all';
import { Atlas } from '../../atlas';
import { LOC } from '../../localiser';
import { formatMaterialListText, formatStackSummary } from '../../preview_stats';
import { MeshType, Renderer } from '../../renderer';
import { rankReplacementCandidates } from '../../smart_replace';
import { download } from '../../util/file_util';
import { PreviewParams, TReplaceMode, TReplaceScope } from '../../worker_types';
import { AppConsole } from '../console';
import { UI } from '../layout';
import { ConfigComponent } from './config';

export class PreviewComponent extends ConfigComponent<PreviewParams.Output, HTMLDivElement> {
    private _structureName?: string;
    private _searchTerm: string;
    private _copyTimeout?: any;
    private _optimizeThreshold: number;
    private _selectedBlocks: Set<string>;
    private _checkedBlocks: Set<string>;
    private _disableUnusedInPalette: boolean;
    private _sliceScope: 'all' | 'layer';
    private _replaceSource: string;
    private _replaceTarget: string;
    private _replaceScope: TReplaceScope;
    private _canUndoReplace: boolean;

    public constructor() {
        super();
        this._searchTerm = '';
        this._optimizeThreshold = 1.000;
        this._selectedBlocks = new Set();
        this._checkedBlocks = new Set();
        this._disableUnusedInPalette = true;
        this._sliceScope = 'all';
        this._replaceSource = '';
        this._replaceTarget = '';
        this._replaceScope = 'all';
        this._canUndoReplace = false;
        this._setValue({
            total: 0,
            unique: 0,
            blocks: [],
        });
    }

    public setStructureName(name?: string) {
        this._structureName = name?.trim() || undefined;
    }

    public setCanUndoReplace(canUndo: boolean) {
        this._canUndoReplace = canUndo;
        if (typeof document !== 'undefined') {
            const undoBtn = document.getElementById(`${this._getId()}-replace-undo-btn`) as HTMLButtonElement | null;
            if (undoBtn) {
                undoBtn.disabled = !this.enabled || !this._canUndoReplace;
            }
        }
    }

    public updateSummary(summary: PreviewParams.Output) {
        this._selectedBlocks.clear();
        this._checkedBlocks.clear();
        Renderer.Get.setSelectedBlockNames([]);
        this._setValue(summary);
        this._renderContent();
    }

    public clearSelection() {
        if (this._selectedBlocks.size === 0) {
            return;
        }
        this._selectedBlocks.clear();
        Renderer.Get.setSelectedBlockNames([]);
        const list = document.getElementById(`${this._getId()}-list`);
        if (list) {
            list.querySelectorAll('.preview-block-item.selected').forEach((el) => {
                el.classList.remove('selected');
            });
        }
    }

    public clear() {
        this._selectedBlocks.clear();
        this._checkedBlocks.clear();
        this._canUndoReplace = false;
        Renderer.Get.setSelectedBlockNames([]);
        this._setValue({
            total: 0,
            unique: 0,
            blocks: [],
        });
        this._searchTerm = '';
        this._renderContent();
    }

    public override generateHTML(): string {
        return `
            <div class="preview-container" id="${this._getId()}-container">
                ${this._generateInnerHTML()}
            </div>
        `;
    }

    private _isSliceLayerModeActive(): boolean {
        return this._sliceScope === 'layer' &&
            typeof Renderer.Get?.isSliceViewerEnabled === 'function' &&
            typeof Renderer.Get?.getSliceLayerBlockSummary === 'function' &&
            Renderer.Get.isSliceViewerEnabled();
    }

    private _getDisplayedSummary(): PreviewParams.Output {
        const val = this.getValue() ?? { total: 0, unique: 0, blocks: [] };
        if (!this._isSliceLayerModeActive()) {
            return val;
        }
        const colourLookup = new Map<string, string>();
        for (const b of val.blocks) {
            colourLookup.set(b.name, b.hexColour);
        }
        const layerSummary = Renderer.Get.getSliceLayerBlockSummary(colourLookup);
        return {
            total: layerSummary.total,
            unique: layerSummary.unique,
            blocks: layerSummary.blocks,
        };
    }

    private _shortBlockLabel(name: string): string {
        return name.startsWith('minecraft:') ? name.substring(10) : name;
    }

    private _getBlockHexMap(summary: PreviewParams.Output): Map<string, string> {
        const hexMap = new Map<string, string>(Atlas.getVanillaColourHexMap());
        for (const block of summary.blocks) {
            if (block.hexColour) {
                hexMap.set(block.name, block.hexColour);
            }
        }
        return hexMap;
    }

    private _generateReplaceTargetOptionsHTML(fullSummary: PreviewParams.Output): string {
        const rawPalette = typeof UI.Get?.getActivePaletteBlocks === 'function' ?
            UI.Get.getActivePaletteBlocks() :
            [];
        const blockHexMap = this._getBlockHexMap(fullSummary);
        const sourceSummary = fullSummary.blocks.find((b) => b.name === this._replaceSource);

        const ranked = rankReplacementCandidates(
            this._replaceSource,
            sourceSummary?.hexColour,
            rawPalette,
            PALETTE_ALL_RELEASE,
            blockHexMap,
            6,
        );

        const orderedNames: string[] = [
            ...ranked.similar.map((s) => s.name),
            ...ranked.paletteOthers,
            ...ranked.allOthers,
        ];
        if (!orderedNames.includes(this._replaceTarget) || this._replaceTarget === this._replaceSource) {
            this._replaceTarget = orderedNames[0] ?? '';
        }

        const renderOptions = (list: string[]) => list.map((name) => {
            const sel = name === this._replaceTarget ? ' selected' : '';
            return `<option value="${this._escapeHtml(name)}"${sel}>${this._escapeHtml(this._shortBlockLabel(name))}</option>`;
        }).join('');

        let dstHTML = '';
        if (ranked.similar.length > 0) {
            const similarLabel = LOC('preview.components.replace_similar_group') ?? 'Similar by colour';
            const similarOptions = ranked.similar.map((cand) => {
                const sel = cand.name === this._replaceTarget ? ' selected' : '';
                const label = `${this._shortBlockLabel(cand.name)} (${cand.similarityPct}%)`;
                return `<option value="${this._escapeHtml(cand.name)}"${sel}>${this._escapeHtml(label)}</option>`;
            }).join('');
            dstHTML += `<optgroup label="${this._escapeHtml(similarLabel)}">${similarOptions}</optgroup>`;
        }
        if (ranked.paletteOthers.length > 0) {
            const paletteLabel = LOC('preview.components.replace_palette_group') ?? 'Active palette';
            dstHTML += `<optgroup label="${this._escapeHtml(paletteLabel)}">${renderOptions(ranked.paletteOthers)}</optgroup>`;
        }
        if (ranked.allOthers.length > 0) {
            const otherLabel = LOC('preview.components.replace_other_group') ?? 'All release blocks';
            dstHTML += `<optgroup label="${this._escapeHtml(otherLabel)}">${renderOptions(ranked.allOthers)}</optgroup>`;
        }
        return dstHTML;
    }

    private _generateReplaceSelectsHTML(fullSummary: PreviewParams.Output): { srcHTML: string; dstHTML: string } {
        const srcNames = fullSummary.blocks.map((b) => b.name);
        if (!srcNames.includes(this._replaceSource)) {
            this._replaceSource = srcNames[0] ?? '';
        }
        const srcHTML = srcNames.map((name) => {
            const sel = name === this._replaceSource ? ' selected' : '';
            return `<option value="${this._escapeHtml(name)}"${sel}>${this._escapeHtml(this._shortBlockLabel(name))}</option>`;
        }).join('');

        const dstHTML = this._generateReplaceTargetOptionsHTML(fullSummary);
        return { srcHTML, dstHTML };
    }

    private _refreshReplaceTargetDropdown() {
        const val = this.getValue();
        if (!val || val.blocks.length === 0) {
            return;
        }
        const dstSel = document.getElementById(`${this._getId()}-replace-dst`) as HTMLSelectElement | null;
        if (dstSel) {
            dstSel.innerHTML = this._generateReplaceTargetOptionsHTML(val);
            dstSel.value = this._replaceTarget;
        }
    }

    protected override _generateInnerHTML(): string {
        const val = this.getValue();
        if (!val || val.blocks.length === 0) {
            return `
                <div class="preview-placeholder" id="${this._getId()}-placeholder">
                    ${LOC('preview.components.placeholder')}
                </div>
            `;
        }

        const displayVal = this._getDisplayedSummary();
        const { srcHTML, dstHTML } = this._generateReplaceSelectsHTML(val);

        return `
            <div class="preview-header-row">
                <div class="preview-stats-box">
                    <span class="preview-stats-total" id="${this._getId()}-stats-total">
                        ${LOC('preview.components.total_blocks', { count: displayVal.total })}
                    </span>
                    <span class="preview-stats-types" id="${this._getId()}-stats-types">
                        ${LOC('preview.components.unique_types', { count: displayVal.unique })}
                    </span>
                </div>
                <div class="preview-header-actions">
                    <button type="button" class="preview-copy-btn" id="${this._getId()}-copy" ${this.enabled ? '' : 'disabled'}>
                        <svg class="preview-copy-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
                        <span id="${this._getId()}-copy-text">${LOC('preview.components.copy')}</span>
                    </button>
                    <button type="button" class="preview-copy-btn" id="${this._getId()}-save-txt" ${this.enabled ? '' : 'disabled'}>
                        <span>${LOC('preview.components.save_txt')}</span>
                    </button>
                </div>
            </div>
            <div class="preview-slice-bar hide" id="${this._getId()}-slice-bar">
                <span class="preview-slice-text" id="${this._getId()}-slice-text"></span>
                <div class="preview-slice-scope-toggle">
                    <button type="button" class="preview-scope-btn${this._sliceScope === 'all' ? ' active' : ''}" id="${this._getId()}-scope-all" ${this.enabled ? '' : 'disabled'}>${LOC('preview.components.scope_all')}</button>
                    <button type="button" class="preview-scope-btn${this._sliceScope === 'layer' ? ' active' : ''}" id="${this._getId()}-scope-layer" ${this.enabled ? '' : 'disabled'}>${LOC('preview.components.scope_layer')}</button>
                </div>
            </div>
            <input
                type="text"
                class="preview-search-input"
                id="${this._getId()}-search"
                placeholder="${LOC('preview.components.search')}"
                value="${this._escapeHtml(this._searchTerm)}"
                ${this.enabled ? '' : 'disabled'}
            />
            <div class="preview-blocks-list" id="${this._getId()}-list">
                ${this._generateBlocksListHTML()}
            </div>
            <div class="preview-optimize-card">
                <div class="preview-optimize-row">
                    <div class="preview-optimize-controls">
                        <label for="${this._getId()}-thresh" class="preview-optimize-label">
                            ${LOC('preview.components.min_percentage')}:
                        </label>
                        <div class="camera-setting-input-wrapper">
                            <input
                                id="${this._getId()}-thresh"
                                type="number"
                                min="0"
                                max="100"
                                step="0.05"
                                value="${this._optimizeThreshold.toFixed(3)}"
                                class="preview-optimize-input"
                                ${this.enabled ? '' : 'disabled'}
                            />
                            <button
                                type="button"
                                class="camera-setting-wheel-btn"
                                id="${this._getId()}-wheel"
                                title="${LOC('preview.components.optimize_wheel_tooltip')} (↕ Scroll / Drag)"
                                ${this.enabled ? '' : 'disabled'}
                            >↕</button>
                        </div>
                        <span class="preview-optimize-unit">%</span>
                    </div>
                    <div class="preview-optimize-btns">
                        <button
                            type="button"
                            class="preview-take-btn"
                            id="${this._getId()}-take-btn"
                            title="${LOC('preview.components.take_tooltip')}"
                            ${this.enabled ? '' : 'disabled'}
                        >
                            <span>${LOC('preview.components.take')}</span>
                        </button>
                        <button
                            type="button"
                            class="preview-optimize-btn"
                            id="${this._getId()}-optimize-btn"
                            title="${LOC('preview.components.optimize_tooltip')}"
                            ${this.enabled ? '' : 'disabled'}
                        >
                            <span>${LOC('preview.components.optimize')}</span>
                        </button>
                    </div>
                </div>
                <div class="preview-optimize-options">
                    <label class="preview-optimize-checkbox-label" for="${this._getId()}-disable-unused" title="${LOC('preview.components.disable_unused_tooltip')}">
                        <input
                            type="checkbox"
                            id="${this._getId()}-disable-unused"
                            class="preview-optimize-checkbox"
                            ${this._disableUnusedInPalette ? 'checked' : ''}
                            ${this.enabled ? '' : 'disabled'}
                        />
                        <span>${LOC('preview.components.disable_unused')}</span>
                    </label>
                </div>
                <div class="preview-replace-row">
                    <select class="preview-replace-select" id="${this._getId()}-replace-src" title="Source block" ${this.enabled ? '' : 'disabled'}>${srcHTML}</select>
                    <span class="preview-replace-arrow">→</span>
                    <select class="preview-replace-select" id="${this._getId()}-replace-dst" title="Target block" ${this.enabled ? '' : 'disabled'}>${dstHTML}</select>
                    <button
                        type="button"
                        class="preview-take-btn preview-replace-btn"
                        id="${this._getId()}-replace-btn"
                        title="${this._escapeHtml(this._getReplaceButtonTooltip())}"
                        ${this.enabled ? '' : 'disabled'}
                    >${this._escapeHtml(this._getReplaceButtonLabel())}</button>
                </div>
                <div class="preview-replace-tools-row">
                    <select class="preview-replace-scope-select" id="${this._getId()}-replace-scope" title="${LOC('preview.components.replace_scope_all')}" ${this.enabled ? '' : 'disabled'}>
                        <option value="all"${this._replaceScope === 'all' ? ' selected' : ''}>${LOC('preview.components.replace_scope_all')}</option>
                        <option value="layer"${this._replaceScope === 'layer' ? ' selected' : ''}>${LOC('preview.components.replace_scope_layer')}</option>
                        <option value="surface"${this._replaceScope === 'surface' ? ' selected' : ''}>${LOC('preview.components.replace_scope_surface')}</option>
                        <option value="hidden"${this._replaceScope === 'hidden' ? ' selected' : ''}>${LOC('preview.components.replace_scope_hidden')}</option>
                    </select>
                    <button
                        type="button"
                        class="preview-take-btn"
                        id="${this._getId()}-replace-auto-btn"
                        title="${this._escapeHtml(this._getAutoFitButtonTooltip())}"
                        ${this.enabled ? '' : 'disabled'}
                    >${this._escapeHtml(this._getAutoFitButtonLabel())}</button>
                    <button
                        type="button"
                        class="preview-take-btn"
                        id="${this._getId()}-replace-undo-btn"
                        title="${LOC('preview.components.replace_undo_tooltip')}"
                        ${this.enabled && this._canUndoReplace ? '' : 'disabled'}
                    >${LOC('preview.components.replace_undo_btn')}</button>
                </div>
            </div>
        `;
    }

    private _escapeHtml(text: string): string {
        return String(text ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    private _generateBlocksListHTML(): string {
        const val = this._getDisplayedSummary();
        if (!val || val.blocks.length === 0) {
            return `
                <div class="preview-empty-search">
                    ${LOC('preview.components.empty_search')}
                </div>
            `;
        }

        const filter = this._searchTerm.trim().toLowerCase();
        const filteredBlocks = filter.length === 0 ?
            val.blocks :
            val.blocks.filter((b) => b.name.toLowerCase().includes(filter));

        if (filteredBlocks.length === 0) {
            return `
                <div class="preview-empty-search">
                    ${LOC('preview.components.empty_search')}
                </div>
            `;
        }

        const stackUnits = {
            shulker: LOC('preview.components.unit_shulker'),
            stack: LOC('preview.components.unit_stack'),
        };

        let html = '';
        filteredBlocks.forEach((block) => {
            let prefix = '';
            let shortName = block.name;
            if (block.name.startsWith('minecraft:')) {
                prefix = '<span class="preview-block-prefix">minecraft:</span>';
                shortName = block.name.substring(10);
            }
            const isSelected = this._selectedBlocks.has(block.name);
            const isChecked = this._checkedBlocks.has(block.name);
            const stackBadge = block.count >= 64 ?
                `<span class="preview-stack-badge">${formatStackSummary(block.count, stackUnits)}</span>` :
                '';

            html += `
                <div class="preview-block-item${isSelected ? ' selected' : ''}" data-block-name="${this._escapeHtml(block.name)}" title="${block.name}">
                    <div class="preview-block-info">
                        <input
                            type="checkbox"
                            class="preview-block-checkbox"
                            data-block-name="${this._escapeHtml(block.name)}"
                            ${isChecked ? 'checked' : ''}
                            ${this.enabled ? '' : 'disabled'}
                        />
                        <div class="preview-block-swatch" style="background-color: ${block.hexColour};"></div>
                        <span class="preview-block-name">${prefix}${shortName}</span>
                    </div>
                    <div class="preview-block-count-box">
                        <button
                            type="button"
                            class="preview-row-replace-btn"
                            data-block-name="${this._escapeHtml(block.name)}"
                            title="${LOC('preview.components.replace_tooltip')}"
                            ${this.enabled ? '' : 'disabled'}
                        >⇄</button>
                        <span class="preview-block-count">${block.count.toLocaleString()}</span>
                        ${stackBadge}
                        <span class="preview-block-percentage">(${block.percentage.toFixed(1)}%)</span>
                    </div>
                </div>
            `;
        });

        return html;
    }

    private _refreshDisplayedStatsAndList() {
        const displayVal = this._getDisplayedSummary();
        const totalEl = document.getElementById(`${this._getId()}-stats-total`);
        if (totalEl) {
            totalEl.textContent = LOC('preview.components.total_blocks', { count: displayVal.total });
        }
        const typesEl = document.getElementById(`${this._getId()}-stats-types`);
        if (typesEl) {
            typesEl.textContent = LOC('preview.components.unique_types', { count: displayVal.unique });
        }
        const listEl = document.getElementById(`${this._getId()}-list`);
        if (listEl) {
            listEl.innerHTML = this._generateBlocksListHTML();
        }
        const allBtn = document.getElementById(`${this._getId()}-scope-all`);
        const layerBtn = document.getElementById(`${this._getId()}-scope-layer`);
        allBtn?.classList.toggle('active', this._sliceScope === 'all');
        layerBtn?.classList.toggle('active', this._sliceScope === 'layer');
    }

    private _getReplaceButtonLabel(): string {
        const base = LOC('preview.components.replace_btn');
        return this._checkedBlocks.size > 0 ? `${base} (${this._checkedBlocks.size})` : base;
    }

    private _getReplaceButtonTooltip(): string {
        return this._checkedBlocks.size > 0 ?
            LOC('preview.components.replace_batch_tooltip') :
            LOC('preview.components.replace_tooltip');
    }

    private _getAutoFitButtonLabel(): string {
        const base = LOC('preview.components.replace_auto_btn');
        return this._checkedBlocks.size > 0 ? `${base} (${this._checkedBlocks.size})` : base;
    }

    private _getAutoFitButtonTooltip(): string {
        return this._checkedBlocks.size > 0 ?
            LOC('preview.components.replace_auto_batch_tooltip') :
            LOC('preview.components.replace_auto_tooltip');
    }

    private _updateReplaceBatchButtons() {
        if (typeof document === 'undefined') {
            return;
        }
        const replaceBtn = document.getElementById(`${this._getId()}-replace-btn`);
        if (replaceBtn) {
            replaceBtn.textContent = this._getReplaceButtonLabel();
            replaceBtn.title = this._getReplaceButtonTooltip();
        }
        const autoBtn = document.getElementById(`${this._getId()}-replace-auto-btn`);
        if (autoBtn) {
            autoBtn.textContent = this._getAutoFitButtonLabel();
            autoBtn.title = this._getAutoFitButtonTooltip();
        }
    }

    private _renderContent() {
        const container = document.getElementById(`${this._getId()}-container`);
        if (container) {
            container.innerHTML = this._generateInnerHTML();
            this._attachEventListeners();
            this.updateSliceStatus();
        }
    }

    public updateSliceStatus() {
        if (typeof document === 'undefined') {
            return;
        }
        const bar = document.getElementById(`${this._getId()}-slice-bar`);
        if (!bar) {
            return;
        }
        const textEl = document.getElementById(`${this._getId()}-slice-text`);
        if (
            typeof Renderer.Get?.isSliceViewerEnabled !== 'function' ||
            typeof Renderer.Get?.getSliceLayerStats !== 'function' ||
            !Renderer.Get.isSliceViewerEnabled()
        ) {
            bar.classList.add('hide');
            if (this._sliceScope === 'layer') {
                this._sliceScope = 'all';
                this._refreshDisplayedStatsAndList();
            }
            return;
        }
        const stats = Renderer.Get.getSliceLayerStats();
        if (stats.totalLayers <= 0) {
            bar.classList.add('hide');
            return;
        }
        const label = LOC('preview.components.slice_layer_status', {
            layer: stats.layerNumber,
            totalLayers: stats.totalLayers,
            sliceY: stats.sliceY,
            onLayer: stats.blocksOnLayer,
            upToLayer: stats.blocksUpToLayer,
            total: stats.totalBlocks,
        });
        if (textEl) {
            textEl.textContent = label;
        }
        bar.classList.remove('hide');
        if (this._sliceScope === 'layer') {
            this._refreshDisplayedStatsAndList();
        }
    }

    private _setThreshold(newVal: number, updateInput = true) {
        const clamped = Math.max(0.0, Math.min(100.0, newVal));
        this._optimizeThreshold = clamped;
        if (updateInput) {
            const input = document.getElementById(`${this._getId()}-thresh`) as HTMLInputElement | null;
            if (input) {
                input.value = clamped.toFixed(3);
            }
        }
    }

    private _attachEventListeners() {
        const searchInput = document.getElementById(`${this._getId()}-search`) as HTMLInputElement | null;
        if (searchInput) {
            searchInput.addEventListener('input', () => {
                this._searchTerm = searchInput.value;
                const list = document.getElementById(`${this._getId()}-list`);
                if (list) {
                    list.innerHTML = this._generateBlocksListHTML();
                }
            });
        }

        const listContainer = document.getElementById(`${this._getId()}-list`);
        if (listContainer) {
            const onCheckboxToggle = (target: HTMLElement) => {
                const checkbox = target.closest('.preview-block-checkbox') as HTMLInputElement | null;
                if (checkbox) {
                    const blockName = checkbox.getAttribute('data-block-name');
                    if (blockName) {
                        if (checkbox.checked) {
                            this._checkedBlocks.add(blockName);
                        } else {
                            this._checkedBlocks.delete(blockName);
                        }
                        this._updateReplaceBatchButtons();
                    }
                }
            };

            // Checkbox change handler for Take/Optimize selection
            listContainer.addEventListener('change', (e: Event) => {
                onCheckboxToggle(e.target as HTMLElement);
            });

            // Row click handler for 3D model highlighting & transparency + row quick-replace
            listContainer.addEventListener('click', (e: MouseEvent) => {
                const target = e.target as HTMLElement;
                // Clicking on a checkbox must only toggle the checkbox via the 'change' event
                if (target.closest('.preview-block-checkbox')) {
                    return;
                }

                const replaceTrigger = target.closest('.preview-row-replace-btn') as HTMLElement | null;
                if (replaceTrigger) {
                    e.stopPropagation();
                    const blockName = replaceTrigger.getAttribute('data-block-name');
                    if (blockName) {
                        this._replaceSource = blockName;
                        const srcSel = document.getElementById(`${this._getId()}-replace-src`) as HTMLSelectElement | null;
                        if (srcSel) {
                            srcSel.value = blockName;
                        }
                        this._refreshReplaceTargetDropdown();
                        const dstSel = document.getElementById(`${this._getId()}-replace-dst`) as HTMLSelectElement | null;
                        dstSel?.focus();
                    }
                    return;
                }

                const item = target.closest('.preview-block-item') as HTMLElement | null;
                if (!item) {
                    return;
                }

                // Selection only works for view block mesh.
                // If view voxel mesh or view mesh is active, disallow selecting rows and cancel selection.
                if (Renderer.Get.getActiveMeshType() !== MeshType.BlockMesh) {
                    this.clearSelection();
                    return;
                }

                const blockName = item.getAttribute('data-block-name');
                if (!blockName) {
                    return;
                }

                if (this._selectedBlocks.has(blockName)) {
                    this._selectedBlocks.delete(blockName);
                    item.classList.remove('selected');
                } else {
                    this._selectedBlocks.add(blockName);
                    item.classList.add('selected');
                }

                Renderer.Get.setSelectedBlockNames(Array.from(this._selectedBlocks));
            });
        }

        const copyBtn = document.getElementById(`${this._getId()}-copy`);
        if (copyBtn) {
            copyBtn.addEventListener('click', () => {
                this._handleCopy();
            });
        }

        const saveTxtBtn = document.getElementById(`${this._getId()}-save-txt`);
        if (saveTxtBtn) {
            saveTxtBtn.addEventListener('click', () => {
                this._handleSaveTxt();
            });
        }

        // Percentage input and mouse wheel / drag button
        const threshInput = document.getElementById(`${this._getId()}-thresh`) as HTMLInputElement | null;
        const wheelBtn = document.getElementById(`${this._getId()}-wheel`) as HTMLButtonElement | null;
        const step = 0.050;

        if (threshInput) {
            threshInput.addEventListener('input', () => {
                const parsed = parseFloat(threshInput.value);
                if (!isNaN(parsed) && parsed >= 0) {
                    this._setThreshold(parsed, false);
                }
            });

            threshInput.addEventListener('change', () => {
                const parsed = parseFloat(threshInput.value);
                if (!isNaN(parsed)) {
                    this._setThreshold(parsed, true);
                } else {
                    threshInput.value = this._optimizeThreshold.toFixed(3);
                }
            });

            threshInput.addEventListener('wheel', (e: WheelEvent) => {
                e.preventDefault();
                e.stopPropagation();
                const dir = e.deltaY < 0 ? 1 : -1;
                this._setThreshold(this._optimizeThreshold + dir * step);
            }, { passive: false });
        }

        if (wheelBtn) {
            wheelBtn.addEventListener('wheel', (e: WheelEvent) => {
                e.preventDefault();
                e.stopPropagation();
                const dir = e.deltaY < 0 ? 1 : -1;
                this._setThreshold(this._optimizeThreshold + dir * step);
            }, { passive: false });

            wheelBtn.addEventListener('mousedown', (e: MouseEvent) => {
                e.preventDefault();
                const startY = e.clientY;
                const startVal = this._optimizeThreshold;
                const onMouseMove = (moveEvent: MouseEvent) => {
                    const dy = startY - moveEvent.clientY;
                    this._setThreshold(startVal + dy * step);
                };
                const onMouseUp = () => {
                    window.removeEventListener('mousemove', onMouseMove);
                    window.removeEventListener('mouseup', onMouseUp);
                };
                window.addEventListener('mousemove', onMouseMove);
                window.addEventListener('mouseup', onMouseUp);
            });
        }

        const takeBtn = document.getElementById(`${this._getId()}-take-btn`);
        if (takeBtn) {
            takeBtn.addEventListener('click', () => {
                this._handleTake();
            });
        }

        const optimizeBtn = document.getElementById(`${this._getId()}-optimize-btn`);
        if (optimizeBtn) {
            optimizeBtn.addEventListener('click', () => {
                this._handleOptimize();
            });
        }

        const disableUnusedCheckbox = document.getElementById(`${this._getId()}-disable-unused`) as HTMLInputElement | null;
        if (disableUnusedCheckbox) {
            disableUnusedCheckbox.addEventListener('change', () => {
                this._disableUnusedInPalette = disableUnusedCheckbox.checked;
            });
        }

        const scopeAllBtn = document.getElementById(`${this._getId()}-scope-all`);
        if (scopeAllBtn) {
            scopeAllBtn.addEventListener('click', () => {
                if (this._sliceScope !== 'all') {
                    this._sliceScope = 'all';
                    this._refreshDisplayedStatsAndList();
                }
            });
        }

        const scopeLayerBtn = document.getElementById(`${this._getId()}-scope-layer`);
        if (scopeLayerBtn) {
            scopeLayerBtn.addEventListener('click', () => {
                if (this._sliceScope !== 'layer') {
                    this._sliceScope = 'layer';
                    this._refreshDisplayedStatsAndList();
                }
            });
        }

        const replaceSrcSel = document.getElementById(`${this._getId()}-replace-src`) as HTMLSelectElement | null;
        if (replaceSrcSel) {
            replaceSrcSel.addEventListener('change', () => {
                this._replaceSource = replaceSrcSel.value;
                this._refreshReplaceTargetDropdown();
            });
        }

        const replaceDstSel = document.getElementById(`${this._getId()}-replace-dst`) as HTMLSelectElement | null;
        if (replaceDstSel) {
            replaceDstSel.addEventListener('change', () => {
                this._replaceTarget = replaceDstSel.value;
            });
        }

        const replaceBtn = document.getElementById(`${this._getId()}-replace-btn`);
        if (replaceBtn) {
            replaceBtn.addEventListener('click', () => {
                this._handleReplaceBlock('swap');
            });
        }

        const replaceScopeSel = document.getElementById(`${this._getId()}-replace-scope`) as HTMLSelectElement | null;
        if (replaceScopeSel) {
            replaceScopeSel.addEventListener('change', () => {
                this._replaceScope = replaceScopeSel.value as TReplaceScope;
            });
        }

        const replaceAutoBtn = document.getElementById(`${this._getId()}-replace-auto-btn`);
        if (replaceAutoBtn) {
            replaceAutoBtn.addEventListener('click', () => {
                this._handleReplaceBlock('auto-palette');
            });
        }

        const replaceUndoBtn = document.getElementById(`${this._getId()}-replace-undo-btn`);
        if (replaceUndoBtn) {
            replaceUndoBtn.addEventListener('click', () => {
                this._handleReplaceBlock('undo');
            });
        }
    }

    private _handleReplaceBlock(mode: TReplaceMode = 'swap') {
        if (mode === 'undo') {
            if (typeof UI.Get?.replaceBlockInModel === 'function') {
                UI.Get.replaceBlockInModel('', '', { mode: 'undo' });
            }
            return;
        }
        const srcSel = document.getElementById(`${this._getId()}-replace-src`) as HTMLSelectElement | null;
        const dstSel = document.getElementById(`${this._getId()}-replace-dst`) as HTMLSelectElement | null;
        const scopeSel = document.getElementById(`${this._getId()}-replace-scope`) as HTMLSelectElement | null;
        const source = srcSel?.value || this._replaceSource;
        const target = dstSel?.value || this._replaceTarget;
        const scope = (scopeSel?.value as TReplaceScope | undefined) || this._replaceScope;
        this._replaceScope = scope;

        if (this._checkedBlocks.size > 0 && (mode === 'auto-palette' || (mode === 'swap' && target))) {
            const checkedList = Array.from(this._checkedBlocks);
            this._replaceSource = checkedList[0];
            if (mode === 'swap') {
                this._replaceTarget = target;
            }
            if (typeof UI.Get?.replaceBlockInModel === 'function') {
                UI.Get.replaceBlockInModel(checkedList[0], mode === 'auto-palette' ? '' : target, {
                    scope,
                    mode,
                    sourceBlocks: checkedList,
                });
            }
            return;
        }

        if (!source || (mode === 'swap' && !target)) {
            return;
        }
        this._replaceSource = source;
        if (mode === 'swap') {
            this._replaceTarget = target;
        }
        if (typeof UI.Get?.replaceBlockInModel === 'function') {
            UI.Get.replaceBlockInModel(source, mode === 'auto-palette' ? '' : target, { scope, mode });
        }
    }

    private _handleTake() {
        const val = this.getValue();
        if (!val || val.blocks.length === 0) {
            return;
        }

        // Take is the only threshold-driven selection action. Preserve manual
        // checkbox choices when Min % changes, and replace them only on Take.
        this._checkedBlocks.clear();
        val.blocks.forEach((block) => {
            if (block.percentage < this._optimizeThreshold) {
                this._checkedBlocks.add(block.name);
            }
        });

        const list = document.getElementById(`${this._getId()}-list`);
        if (list) {
            list.querySelectorAll<HTMLInputElement>('.preview-block-checkbox').forEach((cb) => {
                const name = cb.getAttribute('data-block-name');
                cb.checked = name !== null && this._checkedBlocks.has(name);
            });
        }
        this._updateReplaceBatchButtons();

        if (this._checkedBlocks.size === 0) {
            AppConsole.warning(LOC('preview.take_none', { threshold: this._optimizeThreshold.toFixed(3) }));
        } else {
            AppConsole.info(LOC('preview.take_success', {
                count: this._checkedBlocks.size,
                threshold: this._optimizeThreshold.toFixed(3),
            }));
        }
    }

    private _handleOptimize() {
        const val = this.getValue();
        if (!val || val.blocks.length === 0) {
            return;
        }

        if (this._checkedBlocks.size === 0 && !this._disableUnusedInPalette) {
            AppConsole.warning(LOC('preview.optimize_none_checked'));
            return;
        }

        const toDisable = Array.from(this._checkedBlocks);
        const modelBlocks = val.blocks.map((b) => b.name);
        const countDisabled = UI.Get.optimizePalette(toDisable, this._disableUnusedInPalette, modelBlocks);

        if (countDisabled === -1) {
            AppConsole.error(LOC('preview.optimized_all_prevented'));
            return;
        }

        if (countDisabled === 0) {
            AppConsole.info(LOC('preview.optimized_none'));
            return;
        }

        if (this._disableUnusedInPalette) {
            AppConsole.success(LOC('preview.optimize_with_unused_success', {
                count: countDisabled,
            }));
        } else {
            AppConsole.success(LOC('preview.optimize_checked_success', {
                count: countDisabled,
            }));
        }

        this._checkedBlocks.clear();
        const list = document.getElementById(`${this._getId()}-list`);
        if (list) {
            list.querySelectorAll<HTMLInputElement>('.preview-block-checkbox').forEach((cb) => {
                cb.checked = false;
            });
        }

        // Roll back state to step 4 Assign so the user can re-assign with the refined palette
        UI.Get.rollbackToAssign();
        AppConsole.info(LOC('preview.reassign_prompt'));
    }

    private _getExportListTitle(): string | undefined {
        if (!this._isSliceLayerModeActive()) {
            return this._structureName;
        }
        const stats = Renderer.Get.getSliceLayerStats();
        const base = this._structureName || 'Structure';
        return `${base} (L${stats.layerNumber}/${stats.totalLayers} Y=${stats.sliceY})`;
    }

    private _handleSaveTxt() {
        const val = this._getDisplayedSummary();
        if (!val || val.blocks.length === 0) {
            return;
        }
        const units = {
            shulker: LOC('preview.components.unit_shulker'),
            stack: LOC('preview.components.unit_stack'),
        };
        const content = formatMaterialListText(val, {
            structureName: this._getExportListTitle(),
            units,
        });
        const baseName = (this._structureName || 'materials').replace(/[^a-zA-Z0-9_\-.]/g, '_');
        const layerSuffix = this._isSliceLayerModeActive() ? `_layer${Renderer.Get.getSliceLayerStats().layerNumber}` : '';
        download(content, `${baseName}${layerSuffix}_blocks.txt`);
    }

    private _handleCopy() {
        const val = this._getDisplayedSummary();
        if (!val || val.blocks.length === 0) {
            return;
        }

        const units = {
            shulker: LOC('preview.components.unit_shulker'),
            stack: LOC('preview.components.unit_stack'),
        };
        const textToCopy = formatMaterialListText(val, {
            structureName: this._getExportListTitle(),
            units,
        });

        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(textToCopy).then(() => {
                this._showCopiedStatus();
            }).catch(() => {
                this._fallbackCopy(textToCopy);
            });
        } else {
            this._fallbackCopy(textToCopy);
        }
    }

    private _fallbackCopy(text: string) {
        const textArea = document.createElement('textarea');
        textArea.value = text;
        textArea.style.position = 'fixed';
        textArea.style.left = '-9999px';
        document.body.appendChild(textArea);
        textArea.select();
        try {
            document.execCommand('copy');
            this._showCopiedStatus();
        } finally {
            document.body.removeChild(textArea);
        }
    }

    private _showCopiedStatus() {
        const copyTextSpan = document.getElementById(`${this._getId()}-copy-text`);
        if (copyTextSpan) {
            copyTextSpan.innerText = LOC('preview.components.copied');
            if (this._copyTimeout) {
                clearTimeout(this._copyTimeout);
            }
            this._copyTimeout = setTimeout(() => {
                const targetSpan = document.getElementById(`${this._getId()}-copy-text`);
                if (targetSpan) {
                    targetSpan.innerText = LOC('preview.components.copy');
                }
            }, 2000);
        }
    }

    public override registerEvents(): void {
        this._attachEventListeners();
    }

    public override refresh(): void {
        super.refresh();
        this._renderContent();
    }

    protected override _onEnabledChanged(): void {
        super._onEnabledChanged();
        const searchInput = document.getElementById(`${this._getId()}-search`) as HTMLInputElement | null;
        if (searchInput) {
            searchInput.disabled = !this.enabled;
        }
        const copyBtn = document.getElementById(`${this._getId()}-copy`) as HTMLButtonElement | null;
        if (copyBtn) {
            copyBtn.disabled = !this.enabled;
        }
        const saveTxtBtn = document.getElementById(`${this._getId()}-save-txt`) as HTMLButtonElement | null;
        if (saveTxtBtn) {
            saveTxtBtn.disabled = !this.enabled;
        }
        const threshInput = document.getElementById(`${this._getId()}-thresh`) as HTMLInputElement | null;
        if (threshInput) {
            threshInput.disabled = !this.enabled;
        }
        const wheelBtn = document.getElementById(`${this._getId()}-wheel`) as HTMLButtonElement | null;
        if (wheelBtn) {
            wheelBtn.disabled = !this.enabled;
        }
        const takeBtn = document.getElementById(`${this._getId()}-take-btn`) as HTMLButtonElement | null;
        if (takeBtn) {
            takeBtn.disabled = !this.enabled;
        }
        const optimizeBtn = document.getElementById(`${this._getId()}-optimize-btn`) as HTMLButtonElement | null;
        if (optimizeBtn) {
            optimizeBtn.disabled = !this.enabled;
        }
        const disableUnusedCheckbox = document.getElementById(`${this._getId()}-disable-unused`) as HTMLInputElement | null;
        if (disableUnusedCheckbox) {
            disableUnusedCheckbox.disabled = !this.enabled;
        }
        const scopeAllBtn = document.getElementById(`${this._getId()}-scope-all`) as HTMLButtonElement | null;
        if (scopeAllBtn) {
            scopeAllBtn.disabled = !this.enabled;
        }
        const scopeLayerBtn = document.getElementById(`${this._getId()}-scope-layer`) as HTMLButtonElement | null;
        if (scopeLayerBtn) {
            scopeLayerBtn.disabled = !this.enabled;
        }
        const replaceSrcSel = document.getElementById(`${this._getId()}-replace-src`) as HTMLSelectElement | null;
        if (replaceSrcSel) {
            replaceSrcSel.disabled = !this.enabled;
        }
        const replaceDstSel = document.getElementById(`${this._getId()}-replace-dst`) as HTMLSelectElement | null;
        if (replaceDstSel) {
            replaceDstSel.disabled = !this.enabled;
        }
        const replaceBtn = document.getElementById(`${this._getId()}-replace-btn`) as HTMLButtonElement | null;
        if (replaceBtn) {
            replaceBtn.disabled = !this.enabled;
        }
        const replaceScopeSel = document.getElementById(`${this._getId()}-replace-scope`) as HTMLSelectElement | null;
        if (replaceScopeSel) {
            replaceScopeSel.disabled = !this.enabled;
        }
        const replaceAutoBtn = document.getElementById(`${this._getId()}-replace-auto-btn`) as HTMLButtonElement | null;
        if (replaceAutoBtn) {
            replaceAutoBtn.disabled = !this.enabled;
        }
        const replaceUndoBtn = document.getElementById(`${this._getId()}-replace-undo-btn`) as HTMLButtonElement | null;
        if (replaceUndoBtn) {
            replaceUndoBtn.disabled = !this.enabled || !this._canUndoReplace;
        }
        const list = document.getElementById(`${this._getId()}-list`);
        if (list) {
            const checkboxes = list.querySelectorAll<HTMLInputElement>('.preview-block-checkbox');
            checkboxes.forEach((cb) => {
                cb.disabled = !this.enabled;
            });
            const rowReplaceBtns = list.querySelectorAll<HTMLButtonElement>('.preview-row-replace-btn');
            rowReplaceBtns.forEach((btn) => {
                btn.disabled = !this.enabled;
            });
        }
    }
}
