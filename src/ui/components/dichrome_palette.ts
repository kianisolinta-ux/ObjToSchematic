import { PALETTE_ALL_RELEASE } from '../../../res/palettes/all';
import { Atlas } from '../../atlas';
import { RGBAUtil } from '../../colour';
import {
    detectMatchingDichromePresetId,
    loadDichromeActivePaletteState,
    parseDichromePaletteText,
    saveDichromeActivePaletteState,
    sortBlocksByLightness,
} from '../../dichrome_palette_helpers';
import { LOC } from '../../localiser';
import {
    BUILTIN_PALETTE_PRESETS,
    CUSTOM_PRESET_PREFIX,
    deleteCustomPreset,
    getBuiltinPresetBlocks,
    ICustomPalettePreset,
    loadCustomPresets,
    MANUAL_SELECTION_PRESET_ID,
    saveCustomPreset,
    TBuiltinPalettePresetId,
} from '../../palette_presets';
import { AppUtil } from '../../util';
import { download } from '../../util/file_util';
import { UIUtil } from '../../util/ui_util';
import { AppConsole } from '../console';
import { AppIcons } from '../icons';
import { ConfigComponent } from './config';
import { ToolbarItemComponent } from './toolbar_item';

/**
 * Visual multi-tone block picker dedicated to Dichrome.
 * Supports N blocks (N >= 2) ordered from darkest to lightest tone,
 * shared built-in/custom presets, and .txt import/export/copy.
 */
export class DichromePaletteComponent extends ConfigComponent<string[], HTMLDivElement> {
    private _blockNames: string[];
    private _blockColours: Map<string, string>;
    private _blockLightness: Map<string, number>;
    private _activeSlotIndex: number;
    private _customPresets: ICustomPalettePreset[];
    private _activePresetId: string;
    private _isSaveRowOpen: boolean;

    private _importFrom: ToolbarItemComponent;
    private _exportTo: ToolbarItemComponent;
    private _copyList: ToolbarItemComponent;

    public constructor() {
        const atlas = Atlas.load('vanilla');
        const supportedBlocks = PALETTE_ALL_RELEASE.filter((name) =>
            atlas === undefined || atlas.getBlocks().has(AppUtil.Text.namespaceBlock(name)),
        );
        const savedState = loadDichromeActivePaletteState(supportedBlocks);
        const initialBlocks = savedState !== null ? savedState.blocks : ['minecraft:black_concrete', 'minecraft:white_concrete'];

        super(initialBlocks);

        this._blockNames = supportedBlocks;
        this._blockColours = new Map();
        this._blockLightness = new Map();
        atlas?.getBlocks().forEach((block) => {
            this._blockColours.set(block.name, RGBAUtil.toHexString(block.colour));
            this._blockLightness.set(
                block.name,
                0.2126 * block.colour.r + 0.7152 * block.colour.g + 0.0722 * block.colour.b,
            );
        });
        this._activeSlotIndex = 0;
        this._isSaveRowOpen = false;
        this._customPresets = loadCustomPresets(this._blockNames);
        this._activePresetId = detectMatchingDichromePresetId(
            initialBlocks,
            this._customPresets,
            this._blockNames,
            savedState?.presetId,
        );

        this._importFrom = new ToolbarItemComponent({ iconSVG: AppIcons.IMPORT, id: 'dichrome-import' })
            .setTooltip('assign.components.dichrome_import_palette', 'top')
            .onClick(() => {
                if (this.disabled) return;
                const fileInput = document.getElementById(this._getId() + '-file-input') as HTMLInputElement | null;
                if (fileInput) {
                    fileInput.value = '';
                    fileInput.click();
                }
            });

        this._exportTo = new ToolbarItemComponent({ iconSVG: AppIcons.EXPORT, id: 'dichrome-export' })
            .setTooltip('assign.components.dichrome_export_palette', 'top')
            .onClick(() => {
                if (this.disabled) return;
                const textPalette = this.getValue().join('\n');
                download(textPalette, 'dichrome-palette.txt');
            });

        this._copyList = new ToolbarItemComponent({ iconSVG: AppIcons.COPY, id: 'dichrome-copy-list' })
            .setTooltip('assign.components.copy_list', 'top')
            .onClick(() => {
                if (this.disabled) return;
                const selectedBlocks = this.getValue();
                const textPalette = selectedBlocks.join('\n');
                const fallbackCopy = () => {
                    const textArea = document.createElement('textarea');
                    textArea.value = textPalette;
                    textArea.style.position = 'fixed';
                    textArea.style.left = '-9999px';
                    document.body.appendChild(textArea);
                    textArea.select();
                    try {
                        if (!document.execCommand('copy')) {
                            AppConsole.error(LOC('assign.copy_list_failed'));
                            return;
                        }
                        AppConsole.info(LOC('assign.dichrome_copy_list_success', { count: selectedBlocks.length }));
                    } finally {
                        document.body.removeChild(textArea);
                    }
                };
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    navigator.clipboard.writeText(textPalette).then(() => {
                        AppConsole.info(LOC('assign.dichrome_copy_list_success', { count: selectedBlocks.length }));
                    }).catch(fallbackCopy);
                } else {
                    fallbackCopy();
                }
            });
    }

    protected override _generateInnerHTML(): string {
        return `
            <div class="dichrome-palette" id="${this._getId()}">
                <div class="palette-preset-bar">
                    <div class="palette-preset-select-wrap">
                        <select
                            class="struct-prop palette-preset-select"
                            id="${this._getId()}-preset-select"
                            aria-label="${this._escapeHTML(LOC('assign.components.preset_label'))}"
                        >
                            ${this._renderPresetOptionsHTML()}
                        </select>
                        <div class="checkbox-arrow">
                            ${AppIcons.ARROW_DOWN}
                        </div>
                    </div>
                    <button
                        type="button"
                        class="palette-preset-btn"
                        id="${this._getId()}-preset-save"
                        title="${this._escapeHTML(LOC('assign.components.preset_save_tooltip'))}"
                    >${this._escapeHTML(LOC('assign.components.preset_save'))}</button>
                    <button
                        type="button"
                        class="palette-preset-btn palette-preset-delete-btn"
                        id="${this._getId()}-preset-delete"
                        title="${this._escapeHTML(LOC('assign.components.preset_delete_tooltip'))}"
                    >${this._escapeHTML(LOC('assign.components.preset_delete'))}</button>
                </div>
                <div class="palette-preset-save-row ${this._isSaveRowOpen ? '' : 'hide'}" id="${this._getId() + '-preset-save-row'}">
                    <input
                        class="struct-prop palette-preset-name-input"
                        type="text"
                        id="${this._getId()}-preset-name"
                        placeholder="${this._escapeHTML(LOC('assign.components.preset_name_placeholder'))}"
                        maxlength="48"
                    />
                    <button type="button" class="palette-preset-btn palette-preset-confirm-btn" id="${this._getId()}-preset-confirm">${this._escapeHTML(LOC('assign.components.preset_confirm_save'))}</button>
                    <button type="button" class="palette-preset-btn" id="${this._getId()}-preset-cancel">${this._escapeHTML(LOC('assign.components.preset_cancel_save'))}</button>
                </div>
                <div class="dichrome-palette-header">
                    <span class="dichrome-palette-count" id="${this._getId()}-count"></span>
                    <div class="dichrome-palette-toolbar">
                        <div class="col-item">
                            ${this._importFrom.generateHTML()}
                        </div>
                        <div class="col-item">
                            ${this._exportTo.generateHTML()}
                        </div>
                        <div class="col-item">
                            ${this._copyList.generateHTML()}
                        </div>
                    </div>
                    <div class="dichrome-palette-actions">
                        <button type="button" class="dichrome-palette-action-btn" id="${this._getId()}-add-btn">
                            ${LOC('assign.components.dichrome_add_tone')}
                        </button>
                        <button type="button" class="dichrome-palette-action-btn" id="${this._getId()}-sort-btn">
                            ${LOC('assign.components.dichrome_sort_tones')}
                        </button>
                    </div>
                </div>
                <input
                    type="file"
                    accept=".txt"
                    id="${this._getId()}-file-input"
                    class="hide"
                    aria-label="${this._escapeHTML(LOC('assign.components.dichrome_import_palette'))}"
                />
                <div class="dichrome-palette-selected-container">
                    <div class="dichrome-palette-selected" id="${this._getId()}-selected" role="group"></div>
                    <div class="dichrome-palette-resizer" id="${this._getId()}-resizer" title="${LOC('assign.components.dichrome_resize_tooltip')}">
                        <span class="dichrome-palette-resizer-grip"></span>
                    </div>
                </div>
                <input
                    class="struct-prop dichrome-palette-search"
                    type="search"
                    id="${this._getId()}-search"
                    placeholder="${LOC('assign.components.search')}"
                    autocomplete="off"
                >
                <div class="dichrome-palette-grid" id="${this._getId()}-grid" role="group"></div>
            </div>
        `;
    }

    private _escapeHTML(value: string): string {
        return value
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    private _getDisplayName(blockName: string): string {
        return blockName
            .replace(/^minecraft:/, '')
            .replace(/_/g, ' ')
            .replace(/\b\w/g, (letter) => letter.toUpperCase());
    }

    private _getToneLabel(index: number, total: number): string {
        if (index === 0) {
            return LOC('assign.components.dichrome_tone_darkest');
        }
        if (index === total - 1) {
            return LOC('assign.components.dichrome_tone_lightest', { index: index + 1 });
        }
        return LOC('assign.components.dichrome_tone_num', { index: index + 1 });
    }

    private _getBuiltinPresetLabel(id: TBuiltinPalettePresetId): string {
        switch (id) {
            case 'all':
                return LOC('assign.components.preset_all');
            case 'survival-33':
                return LOC('assign.components.preset_survival_33');
            case 'colourful':
                return LOC('assign.components.preset_colourful');
            case 'greyscale':
                return LOC('assign.components.preset_greyscale');
            case 'schematic-friendly':
                return LOC('assign.components.preset_schematic_friendly');
        }
    }

    private _isCustomPresetActive(): boolean {
        return this._activePresetId.startsWith(CUSTOM_PRESET_PREFIX) &&
            this._customPresets.some((p) => p.id === this._activePresetId);
    }

    private _renderPresetOptionsHTML(): string {
        let html = '';

        for (const preset of BUILTIN_PALETTE_PRESETS) {
            const selectedAttr = this._activePresetId === preset.id ? ' selected' : '';
            html += `<option value="${preset.id}"${selectedAttr}>${this._escapeHTML(this._getBuiltinPresetLabel(preset.id))}</option>`;
        }

        for (const customPreset of this._customPresets) {
            const selectedAttr = this._activePresetId === customPreset.id ? ' selected' : '';
            const label = `${customPreset.name} ${LOC('assign.components.preset_custom_suffix')}`;
            html += `<option value="${this._escapeHTML(customPreset.id)}"${selectedAttr}>${this._escapeHTML(label)}</option>`;
        }

        const customSelectedAttr = this._activePresetId === MANUAL_SELECTION_PRESET_ID ? ' selected' : '';
        html += `<option value="${MANUAL_SELECTION_PRESET_ID}"${customSelectedAttr}>${this._escapeHTML(LOC('assign.components.preset_custom_selection'))}</option>`;

        return html;
    }

    private _syncCustomPresetsFromStorage(): void {
        this._customPresets = loadCustomPresets(this._blockNames);
        this._activePresetId = detectMatchingDichromePresetId(
            this.getValue(),
            this._customPresets,
            this._blockNames,
            this._activePresetId,
        );
        this._refreshPresetSelect();
    }

    private _refreshPresetSelect(): void {
        const selectEl = document.getElementById(this._getId() + '-preset-select') as HTMLSelectElement | null;
        if (!selectEl) {
            return;
        }
        selectEl.innerHTML = this._renderPresetOptionsHTML();
        selectEl.value = this._activePresetId;
        this._updatePresetButtons();
    }

    private _updatePresetButtons(): void {
        const selectEl = document.getElementById(this._getId() + '-preset-select') as HTMLSelectElement | null;
        if (selectEl) {
            selectEl.disabled = this.disabled;
        }

        const saveBtn = document.getElementById(this._getId() + '-preset-save') as HTMLButtonElement | null;
        if (saveBtn) {
            saveBtn.disabled = this.disabled;
        }

        const deleteBtn = document.getElementById(this._getId() + '-preset-delete') as HTMLButtonElement | null;
        if (deleteBtn) {
            deleteBtn.disabled = this.disabled || !this._isCustomPresetActive();
        }

        const nameInput = document.getElementById(this._getId() + '-preset-name') as HTMLInputElement | null;
        if (nameInput) {
            nameInput.disabled = this.disabled;
        }

        const confirmBtn = document.getElementById(this._getId() + '-preset-confirm') as HTMLButtonElement | null;
        if (confirmBtn) {
            confirmBtn.disabled = this.disabled;
        }

        const cancelBtn = document.getElementById(this._getId() + '-preset-cancel') as HTMLButtonElement | null;
        if (cancelBtn) {
            cancelBtn.disabled = this.disabled;
        }
    }

    private _setSaveRowVisible(visible: boolean): void {
        this._isSaveRowOpen = visible;
        const rowEl = document.getElementById(this._getId() + '-preset-save-row');
        if (rowEl) {
            rowEl.classList.toggle('hide', !visible);
        }
        const nameInput = document.getElementById(this._getId() + '-preset-name') as HTMLInputElement | null;
        if (nameInput) {
            if (visible) {
                const activeCustom = this._customPresets.find((p) => p.id === this._activePresetId);
                nameInput.value = activeCustom ? activeCustom.name : '';
                nameInput.focus();
                nameInput.select();
            } else {
                nameInput.value = '';
            }
        }
    }

    private _persistActivePalette(): void {
        saveDichromeActivePaletteState({
            presetId: this._activePresetId,
            blocks: this.getValue(),
        }, this._blockNames);
    }

    private _applyBlocks(blocks: string[], preferredPresetId?: string): void {
        if (blocks.length < 2) {
            return;
        }
        this._activeSlotIndex = 0;
        this._activePresetId = detectMatchingDichromePresetId(
            blocks,
            this._customPresets,
            this._blockNames,
            preferredPresetId,
        );
        this._setValue(blocks);
        this._persistActivePalette();
        this._refreshPresetSelect();
    }

    private _onSelectPreset(presetId: string): void {
        this._customPresets = loadCustomPresets(this._blockNames);

        const builtin = BUILTIN_PALETTE_PRESETS.find((p) => p.id === presetId);
        if (builtin) {
            const rawBlocks = getBuiltinPresetBlocks(builtin.id, this._blockNames);
            if (rawBlocks.length < 2) {
                AppConsole.warning(LOC('assign.dichrome_requires_two_blocks'));
                this._refreshPresetSelect();
                return;
            }
            // Built-in palettes are alphabetical; sort dark -> light for Dichrome tone mapping
            const sortedBlocks = sortBlocksByLightness(rawBlocks, this._blockLightness);
            this._applyBlocks(sortedBlocks, builtin.id);
            AppConsole.info(LOC('assign.preset_loaded', {
                name: this._getBuiltinPresetLabel(builtin.id),
                count: sortedBlocks.length,
            }));
            return;
        }

        const custom = this._customPresets.find((p) => p.id === presetId);
        if (custom) {
            if (custom.blocks.length < 2) {
                AppConsole.warning(LOC('assign.dichrome_requires_two_blocks'));
                this._refreshPresetSelect();
                return;
            }
            this._applyBlocks([...custom.blocks], custom.id);
            AppConsole.info(LOC('assign.preset_loaded', {
                name: custom.name,
                count: custom.blocks.length,
            }));
        }
    }

    private _onConfirmSavePreset(): void {
        const nameInput = document.getElementById(this._getId() + '-preset-name') as HTMLInputElement | null;
        const rawName = nameInput?.value ?? '';
        const selectedBlocks = this.getValue();

        const result = saveCustomPreset(rawName, selectedBlocks, this._blockNames);
        if (!result.ok) {
            if (result.reason === 'empty_name') {
                AppConsole.warning(LOC('assign.preset_save_empty_name'));
            } else if (result.reason === 'empty_blocks') {
                AppConsole.warning(LOC('assign.preset_save_empty_blocks'));
            }
            return;
        }

        this._customPresets = result.presets;
        this._activePresetId = result.preset.id;
        this._setSaveRowVisible(false);
        this._refreshPresetSelect();
        this._persistActivePalette();
        AppConsole.success(LOC('assign.preset_saved', {
            name: result.preset.name,
            count: result.preset.blocks.length,
        }));
    }

    private _onDeleteActiveCustomPreset(): void {
        if (!this._isCustomPresetActive()) {
            return;
        }
        const target = this._customPresets.find((p) => p.id === this._activePresetId);
        if (!target) {
            return;
        }

        this._customPresets = deleteCustomPreset(target.id, this._blockNames);
        this._activePresetId = detectMatchingDichromePresetId(
            this.getValue(),
            this._customPresets,
            this._blockNames,
        );
        this._refreshPresetSelect();
        this._persistActivePalette();
        AppConsole.info(LOC('assign.preset_deleted', { name: target.name }));
    }

    private _onReadPaletteFile(fileName: string, text: string): void {
        const parsed = parseDichromePaletteText(text, this._blockNames);
        for (const unsupported of parsed.unsupportedTokens) {
            AppConsole.warning(LOC('assign.could_not_use_block', { block_name: unsupported }));
        }

        if (parsed.blocks.length < 2) {
            AppConsole.warning(LOC('assign.dichrome_palette_import_too_few', {
                file_name: fileName,
                count: parsed.blocks.length,
            }));
            return;
        }

        this._applyBlocks(parsed.blocks);
        AppConsole.info(LOC('assign.dichrome_palette_imported', {
            file_name: fileName,
            count: parsed.blocks.length,
        }));
    }

    private _renderSlots() {
        const container = document.getElementById(this._getId() + '-selected') as HTMLDivElement | null;
        const countBadge = document.getElementById(this._getId() + '-count') as HTMLSpanElement | null;
        if (!container) {
            return;
        }

        const blocks = this.getValue();
        if (this._activeSlotIndex >= blocks.length) {
            this._activeSlotIndex = Math.max(0, blocks.length - 1);
        }

        if (countBadge) {
            countBadge.textContent = LOC('assign.components.dichrome_tones_count', { count: blocks.length });
        }

        const canRemove = blocks.length > 2;

        container.innerHTML = blocks.map((blockName, index) => {
            const isActive = index === this._activeSlotIndex;
            const colour = this._blockColours.get(blockName) ?? 'var(--gray-600)';
            const label = this._getToneLabel(index, blocks.length);
            const displayName = this._getDisplayName(blockName);

            return `
                <div
                    class="dichrome-palette-slot${isActive ? ' is-active' : ''}"
                    data-slot-index="${index}"
                    role="button"
                    tabindex="0"
                    aria-pressed="${isActive}"
                    title="${this._escapeHTML(blockName)}"
                >
                    <div class="dichrome-palette-slot-header">
                        <span class="dichrome-palette-slot-label">${this._escapeHTML(label)}</span>
                        ${canRemove && !this.disabled ? `
                            <button
                                type="button"
                                class="dichrome-palette-slot-remove"
                                data-remove-index="${index}"
                                title="${LOC('assign.components.dichrome_remove_tone')}"
                                aria-label="${LOC('assign.components.dichrome_remove_tone')}"
                            >×</button>
                        ` : ''}
                    </div>
                    <div class="dichrome-palette-slot-body">
                        <span class="dichrome-palette-slot-swatch" style="background-color: ${colour}"></span>
                        <span class="dichrome-palette-slot-name">${this._escapeHTML(displayName)}</span>
                    </div>
                </div>
            `;
        }).join('');
    }

    private _renderGrid(searchValue = '') {
        const grid = document.getElementById(this._getId() + '-grid') as HTMLDivElement | null;
        if (!grid) {
            return;
        }

        const normalizedSearch = searchValue.trim().toLowerCase();
        const blocks = this.getValue();
        const activeBlock = blocks[this._activeSlotIndex] ?? blocks[0];

        const matchingBlocks = this._blockNames
            .filter((name) =>
                !normalizedSearch ||
                name.toLowerCase().includes(normalizedSearch) ||
                name.toLowerCase().replace(/_/g, ' ').includes(normalizedSearch),
            )
            .sort((a, b) => {
                const lightnessA = this._blockLightness.get(a) ?? 0;
                const lightnessB = this._blockLightness.get(b) ?? 0;
                const difference = lightnessA - lightnessB;
                if (this._activeSlotIndex === 0) {
                    return difference || a.localeCompare(b);
                } else if (this._activeSlotIndex === blocks.length - 1) {
                    return -difference || a.localeCompare(b);
                }
                return difference || a.localeCompare(b);
            });

        if (matchingBlocks.length === 0) {
            grid.innerHTML = `<div class="dichrome-palette-empty">${LOC('assign.components.empty_search')}</div>`;
            return;
        }

        grid.innerHTML = matchingBlocks.map((name) => {
            const isSelected = name === activeBlock;
            const isAssigned = blocks.includes(name) && !isSelected;
            const colour = this._blockColours.get(name) ?? 'var(--gray-600)';
            return `
                <button
                    type="button"
                    class="dichrome-palette-option${isSelected ? ' is-selected' : ''}${isAssigned ? ' is-assigned' : ''}"
                    data-block="${this._escapeHTML(name)}"
                    title="${this._escapeHTML(name)}"
                    aria-pressed="${isSelected}"
                    ${this.disabled ? 'disabled' : ''}
                >
                    <span class="dichrome-palette-option-swatch" style="background-color: ${colour}"></span>
                    <span class="dichrome-palette-option-name">${this._escapeHTML(this._getDisplayName(name))}</span>
                </button>
            `;
        }).join('');
    }

    private _refreshOptions() {
        const search = document.getElementById(this._getId() + '-search') as HTMLInputElement | null;
        const addBtn = document.getElementById(this._getId() + '-add-btn') as HTMLButtonElement | null;
        const sortBtn = document.getElementById(this._getId() + '-sort-btn') as HTMLButtonElement | null;
        const fileInput = document.getElementById(this._getId() + '-file-input') as HTMLInputElement | null;

        if (addBtn) addBtn.disabled = this.disabled;
        if (sortBtn) sortBtn.disabled = this.disabled;
        if (search) search.disabled = this.disabled;
        if (fileInput) fileInput.disabled = this.disabled;

        this._updatePresetButtons();
        this._renderSlots();
        this._renderGrid(search?.value ?? '');
    }

    public override registerEvents(): void {
        const search = UIUtil.getElementById(this._getId() + '-search') as HTMLInputElement;
        const selectedContainer = UIUtil.getElementById(this._getId() + '-selected') as HTMLDivElement;
        const grid = UIUtil.getElementById(this._getId() + '-grid') as HTMLDivElement;
        const addBtn = UIUtil.getElementById(this._getId() + '-add-btn') as HTMLButtonElement;
        const sortBtn = UIUtil.getElementById(this._getId() + '-sort-btn') as HTMLButtonElement;
        const fileInput = UIUtil.getElementById(this._getId() + '-file-input') as HTMLInputElement;

        const presetSelect = document.getElementById(this._getId() + '-preset-select') as HTMLSelectElement | null;
        presetSelect?.addEventListener('focus', () => {
            this._syncCustomPresetsFromStorage();
        });
        presetSelect?.addEventListener('mousedown', () => {
            this._syncCustomPresetsFromStorage();
        });
        presetSelect?.addEventListener('change', () => {
            if (this.disabled) return;
            this._onSelectPreset(presetSelect.value);
        });

        const saveBtn = document.getElementById(this._getId() + '-preset-save') as HTMLButtonElement | null;
        saveBtn?.addEventListener('click', () => {
            if (this.disabled) return;
            this._setSaveRowVisible(!this._isSaveRowOpen);
        });

        const deleteBtn = document.getElementById(this._getId() + '-preset-delete') as HTMLButtonElement | null;
        deleteBtn?.addEventListener('click', () => {
            if (this.disabled) return;
            this._onDeleteActiveCustomPreset();
        });

        const confirmSaveBtn = document.getElementById(this._getId() + '-preset-confirm') as HTMLButtonElement | null;
        confirmSaveBtn?.addEventListener('click', () => {
            if (this.disabled) return;
            this._onConfirmSavePreset();
        });

        const cancelSaveBtn = document.getElementById(this._getId() + '-preset-cancel') as HTMLButtonElement | null;
        cancelSaveBtn?.addEventListener('click', () => {
            this._setSaveRowVisible(false);
        });

        const presetNameInput = document.getElementById(this._getId() + '-preset-name') as HTMLInputElement | null;
        presetNameInput?.addEventListener('keydown', (e: KeyboardEvent) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                this._onConfirmSavePreset();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                this._setSaveRowVisible(false);
            }
        });

        fileInput.addEventListener('change', () => {
            const files = fileInput.files;
            if (files?.length === 1) {
                const file = files.item(0);
                if (file) {
                    AppConsole.info(LOC('assign.reading_palette', { file_name: file.name }));
                    file.text().then((text) => {
                        this._onReadPaletteFile(file.name, text);
                    });
                }
            }
        });

        this._importFrom.registerEvents();
        this._exportTo.registerEvents();
        this._copyList.registerEvents();

        search.addEventListener('input', () => this._renderGrid(search.value));

        selectedContainer.addEventListener('click', (event: MouseEvent) => {
            const target = event.target as HTMLElement | null;
            if (!target) return;

            const removeBtn = target.closest<HTMLButtonElement>('.dichrome-palette-slot-remove');
            if (removeBtn && !this.disabled) {
                event.stopPropagation();
                const removeIdx = parseInt(removeBtn.dataset.removeIndex ?? '-1', 10);
                if (removeIdx >= 0 && this.getValue().length > 2) {
                    const currentBlocks = [...this.getValue()];
                    currentBlocks.splice(removeIdx, 1);
                    if (this._activeSlotIndex >= currentBlocks.length) {
                        this._activeSlotIndex = currentBlocks.length - 1;
                    }
                    this._setValue(currentBlocks);
                    this._persistActivePalette();
                }
                return;
            }

            const slot = target.closest<HTMLDivElement>('.dichrome-palette-slot');
            if (slot && !this.disabled) {
                const slotIdx = parseInt(slot.dataset.slotIndex ?? '0', 10);
                if (!isNaN(slotIdx) && slotIdx !== this._activeSlotIndex) {
                    this._activeSlotIndex = slotIdx;
                    this._refreshOptions();
                }
            }
        });

        addBtn.addEventListener('click', () => {
            if (this.disabled) return;
            const currentBlocks = this.getValue();
            let candidate = this._blockNames.find((name) => !currentBlocks.includes(name));
            if (!candidate) {
                candidate = 'minecraft:stone';
            }
            const updated = [...currentBlocks, candidate];
            this._activeSlotIndex = updated.length - 1;
            this._setValue(updated);
            this._persistActivePalette();
        });

        sortBtn.addEventListener('click', () => {
            if (this.disabled) return;
            const sorted = sortBlocksByLightness(this.getValue(), this._blockLightness);
            this._setValue(sorted);
            this._persistActivePalette();
        });

        grid.addEventListener('click', (event: MouseEvent) => {
            const target = event.target as HTMLElement | null;
            const option = target?.closest<HTMLButtonElement>('.dichrome-palette-option');
            const blockName = option?.dataset.block;
            if (!option || option.disabled || !blockName || this.disabled) {
                return;
            }

            const currentBlocks = [...this.getValue()];
            const existingIdx = currentBlocks.indexOf(blockName);

            if (existingIdx !== -1) {
                if (existingIdx !== this._activeSlotIndex) {
                    const temp = currentBlocks[this._activeSlotIndex];
                    currentBlocks[this._activeSlotIndex] = blockName;
                    currentBlocks[existingIdx] = temp;
                    this._setValue(currentBlocks);
                    this._persistActivePalette();
                }
            } else {
                currentBlocks[this._activeSlotIndex] = blockName;
                this._setValue(currentBlocks);
                this._persistActivePalette();
            }
        });

        search.addEventListener('mouseenter', () => {
            this._setHovered(true);
            this._updateStyles();
        });
        search.addEventListener('mouseleave', () => {
            this._setHovered(false);
            this._updateStyles();
        });

        const resizer = UIUtil.getElementById(this._getId() + '-resizer') as HTMLDivElement;
        let isResizing = false;
        let startY = 0;
        let startHeight = 0;

        resizer.addEventListener('mousedown', (e: MouseEvent) => {
            if (this.disabled) return;
            isResizing = true;
            startY = e.clientY;
            startHeight = selectedContainer.offsetHeight;
            document.body.classList.add('is-resizing-vertically');
            e.preventDefault();
        });

        window.addEventListener('mousemove', (e: MouseEvent) => {
            if (!isResizing) return;
            const deltaY = e.clientY - startY;
            const newHeight = Math.max(120, Math.min(650, startHeight + deltaY));
            selectedContainer.style.height = `${newHeight}px`;
        });

        window.addEventListener('mouseup', () => {
            if (isResizing) {
                isResizing = false;
                document.body.classList.remove('is-resizing-vertically');
            }
        });

        this._refreshOptions();
    }

    public override finalise(): void {
        super.finalise();
        this._importFrom.finalise();
        this._exportTo.finalise();
        this._copyList.finalise();
        this._importFrom.setEnabled(this.enabled);
        this._exportTo.setEnabled(this.enabled);
        this._copyList.setEnabled(this.enabled);
        this._syncCustomPresetsFromStorage();
        this._updateStyles();
    }

    protected override _onValueChanged(): void {
        this._activePresetId = detectMatchingDichromePresetId(
            this.getValue(),
            this._customPresets,
            this._blockNames,
            this._activePresetId,
        );
        this._refreshPresetSelect();
        this._refreshOptions();
    }

    protected override _onEnabledChanged(): void {
        super._onEnabledChanged();
        if (!this.enabled) {
            this._setSaveRowVisible(false);
        } else {
            this._syncCustomPresetsFromStorage();
        }
        this._importFrom.setEnabled(this.enabled);
        this._exportTo.setEnabled(this.enabled);
        this._copyList.setEnabled(this.enabled);
        this._refreshOptions();
        this._updateStyles();
    }

    protected override _updateStyles(): void {
        const search = document.getElementById(this._getId() + '-search');
        if (search) {
            UIUtil.updateStyles(search, {
                isHovered: this.hovered,
                isEnabled: this.enabled,
                isActive: false,
            });
        }
        const presetSelectEl = document.getElementById(this._getId() + '-preset-select');
        if (presetSelectEl) {
            UIUtil.updateStyles(presetSelectEl, {
                isActive: false,
                isEnabled: this.enabled,
                isHovered: false,
            });
        }
        const presetNameEl = document.getElementById(this._getId() + '-preset-name');
        if (presetNameEl) {
            UIUtil.updateStyles(presetNameEl, {
                isActive: false,
                isEnabled: this.enabled,
                isHovered: false,
            });
        }
    }

    public override refresh(): void {
        super.refresh();

        const search = document.getElementById(this._getId() + '-search') as HTMLInputElement | null;
        const addBtn = document.getElementById(this._getId() + '-add-btn');
        const sortBtn = document.getElementById(this._getId() + '-sort-btn');
        const resizer = document.getElementById(this._getId() + '-resizer');
        const fileInput = document.getElementById(this._getId() + '-file-input') as HTMLInputElement | null;
        if (search) search.placeholder = LOC('assign.components.search');
        if (addBtn) addBtn.textContent = LOC('assign.components.dichrome_add_tone');
        if (sortBtn) sortBtn.textContent = LOC('assign.components.dichrome_sort_tones');
        if (resizer) resizer.title = LOC('assign.components.dichrome_resize_tooltip');
        if (fileInput) fileInput.setAttribute('aria-label', LOC('assign.components.dichrome_import_palette'));

        this._importFrom.updateTranslation();
        this._exportTo.updateTranslation();
        this._copyList.updateTranslation();

        const presetSelect = document.getElementById(this._getId() + '-preset-select') as HTMLSelectElement | null;
        if (presetSelect) {
            presetSelect.setAttribute('aria-label', LOC('assign.components.preset_label'));
        }
        this._syncCustomPresetsFromStorage();

        const saveBtn = document.getElementById(this._getId() + '-preset-save') as HTMLButtonElement | null;
        if (saveBtn) {
            saveBtn.textContent = LOC('assign.components.preset_save');
            saveBtn.title = LOC('assign.components.preset_save_tooltip');
        }

        const deleteBtn = document.getElementById(this._getId() + '-preset-delete') as HTMLButtonElement | null;
        if (deleteBtn) {
            deleteBtn.textContent = LOC('assign.components.preset_delete');
            deleteBtn.title = LOC('assign.components.preset_delete_tooltip');
        }

        const nameInput = document.getElementById(this._getId() + '-preset-name') as HTMLInputElement | null;
        if (nameInput) {
            nameInput.placeholder = LOC('assign.components.preset_name_placeholder');
        }

        const confirmBtn = document.getElementById(this._getId() + '-preset-confirm') as HTMLButtonElement | null;
        if (confirmBtn) {
            confirmBtn.textContent = LOC('assign.components.preset_confirm_save');
        }

        const cancelBtn = document.getElementById(this._getId() + '-preset-cancel') as HTMLButtonElement | null;
        if (cancelBtn) {
            cancelBtn.textContent = LOC('assign.components.preset_cancel_save');
        }

        this._refreshOptions();
    }
}
