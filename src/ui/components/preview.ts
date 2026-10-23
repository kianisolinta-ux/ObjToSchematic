import { LOC } from '../../localiser';
import { MeshType, Renderer } from '../../renderer';
import { PreviewParams } from '../../worker_types';
import { AppConsole } from '../console';
import { UI } from '../layout';
import { ConfigComponent } from './config';

export class PreviewComponent extends ConfigComponent<PreviewParams.Output, HTMLDivElement> {
    private _searchTerm: string;
    private _copyTimeout?: any;
    private _optimizeThreshold: number;
    private _selectedBlocks: Set<string>;
    private _checkedBlocks: Set<string>;

    public constructor() {
        super();
        this._searchTerm = '';
        this._optimizeThreshold = 1.000;
        this._selectedBlocks = new Set();
        this._checkedBlocks = new Set();
        this._setValue({
            total: 0,
            unique: 0,
            blocks: [],
        });
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

    protected override _generateInnerHTML(): string {
        const val = this.getValue();
        if (!val || val.blocks.length === 0) {
            return `
                <div class="preview-placeholder" id="${this._getId()}-placeholder">
                    ${LOC('preview.components.placeholder')}
                </div>
            `;
        }

        return `
            <div class="preview-header-row">
                <div class="preview-stats-box">
                    <span class="preview-stats-total">
                        ${LOC('preview.components.total_blocks', { count: val.total })}
                    </span>
                    <span class="preview-stats-types">
                        ${LOC('preview.components.unique_types', { count: val.unique })}
                    </span>
                </div>
                <button type="button" class="preview-copy-btn" id="${this._getId()}-copy" ${this.enabled ? '' : 'disabled'}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink: 0;"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
                    <span id="${this._getId()}-copy-text">${LOC('preview.components.copy')}</span>
                </button>
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
                    <span style="color: var(--text-dim); font-size: 11px;">%</span>
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
        `;
    }

    private _escapeHtml(text: string): string {
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    private _generateBlocksListHTML(): string {
        const val = this.getValue();
        if (!val || val.blocks.length === 0) {
            return '';
        }

        const filter = this._searchTerm.trim().toLowerCase();
        const filteredBlocks = filter.length === 0 ?
            val.blocks :
            val.blocks.filter((b) => b.name.toLowerCase().includes(filter));

        if (filteredBlocks.length === 0) {
            return `
                <div style="padding: 14px; text-align: center; color: var(--text-dark); font-style: italic; font-size: var(--font-size-small);">
                    ${LOC('preview.components.empty_search')}
                </div>
            `;
        }

        let html = '';
        filteredBlocks.forEach((block) => {
            let prefix = '';
            let shortName = block.name;
            if (block.name.startsWith('minecraft:')) {
                prefix = '<span style="color: var(--text-dim); font-size: 10.5px;">minecraft:</span>';
                shortName = block.name.substring(10);
            }
            const isSelected = this._selectedBlocks.has(block.name);
            const isChecked = this._checkedBlocks.has(block.name);

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
                        <span class="preview-block-count">${block.count.toLocaleString()}</span>
                        <span class="preview-block-percentage">(${block.percentage.toFixed(1)}%)</span>
                    </div>
                </div>
            `;
        });

        return html;
    }

    private _renderContent() {
        const container = document.getElementById(`${this._getId()}-container`);
        if (container) {
            container.innerHTML = this._generateInnerHTML();
            this._attachEventListeners();
        }
    }

    private _syncCheckedBlocksWithThreshold() {
        const val = this.getValue();
        if (!val || !val.blocks || val.blocks.length === 0) {
            return;
        }

        const threshold = this._optimizeThreshold;
        val.blocks.forEach((block) => {
            if (block.percentage < threshold) {
                this._checkedBlocks.add(block.name);
            } else {
                this._checkedBlocks.delete(block.name);
            }
        });

        const list = document.getElementById(`${this._getId()}-list`);
        if (list) {
            const checkboxes = list.querySelectorAll<HTMLInputElement>('.preview-block-checkbox');
            checkboxes.forEach((cb) => {
                const name = cb.getAttribute('data-block-name');
                if (name) {
                    cb.checked = this._checkedBlocks.has(name);
                }
            });
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
        this._syncCheckedBlocksWithThreshold();
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
                    }
                }
            };

            // Checkbox change handler for Take/Optimize selection
            listContainer.addEventListener('change', (e: Event) => {
                onCheckboxToggle(e.target as HTMLElement);
            });

            // Row click handler for 3D model highlighting & transparency
            listContainer.addEventListener('click', (e: MouseEvent) => {
                const target = e.target as HTMLElement;
                // Clicking on a checkbox must never toggle row selection
                if (target.closest('.preview-block-checkbox')) {
                    onCheckboxToggle(target);
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
    }

    private _handleTake() {
        const val = this.getValue();
        if (!val || val.blocks.length === 0) {
            return;
        }

        this._syncCheckedBlocksWithThreshold();

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

        if (this._checkedBlocks.size === 0) {
            AppConsole.warning(LOC('preview.optimize_none_checked'));
            return;
        }

        const toDisable = Array.from(this._checkedBlocks);
        const countDisabled = UI.Get.optimizePalette(toDisable);
        AppConsole.success(LOC('preview.optimize_checked_success', {
            count: countDisabled,
        }));

        this._checkedBlocks.clear();

        // Roll back state to step 4 Assign so the user can re-assign with the refined palette
        UI.Get.rollbackToAssign();
        AppConsole.info(LOC('preview.reassign_prompt'));
    }

    private _handleCopy() {
        const val = this.getValue();
        if (!val || val.blocks.length === 0) {
            return;
        }

        const lines = val.blocks.map((b) => `${b.name}: ${b.count}`);
        lines.push('');
        lines.push(`Total: ${val.total} blocks (${val.unique} unique types)`);
        const textToCopy = lines.join('\n');

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
        const list = document.getElementById(`${this._getId()}-list`);
        if (list) {
            const checkboxes = list.querySelectorAll<HTMLInputElement>('.preview-block-checkbox');
            checkboxes.forEach((cb) => {
                cb.disabled = !this.enabled;
            });
        }
    }
}
