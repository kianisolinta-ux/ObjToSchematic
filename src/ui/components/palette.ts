import { PALETTE_ALL_RELEASE } from '../../../res/palettes/all';
import { LOC } from '../../localiser';
import { Palette } from '../../palette';
import {
    BUILTIN_PALETTE_PRESETS,
    CUSTOM_PRESET_PREFIX,
    deleteCustomPreset,
    detectMatchingPresetId,
    getBuiltinPresetBlocks,
    ICustomPalettePreset,
    loadActivePaletteState,
    loadCustomPresets,
    MANUAL_SELECTION_PRESET_ID,
    saveActivePaletteState,
    saveCustomPreset,
    TBuiltinPalettePresetId,
} from '../../palette_presets';
import { AppUtil } from '../../util';
import { ASSERT } from '../../util/error_util';
import { download } from '../../util/file_util';
import { UIUtil } from '../../util/ui_util';
import { AppConsole } from '../console';
import { AppIcons } from '../icons';
import { CheckboxComponent } from './checkbox';
import { ConfigComponent } from './config';
import { ToolbarItemComponent } from './toolbar_item';

export class PaletteComponent extends ConfigComponent<Palette, HTMLDivElement> {
    private _checkboxes: { block: string, element: CheckboxComponent }[];
    private _palette: Palette;
    private _selectAll: ToolbarItemComponent;
    private _deselectAll: ToolbarItemComponent;
    private _importFrom: ToolbarItemComponent;
    private _exportTo: ToolbarItemComponent;
    private _copyList: ToolbarItemComponent;
    private _customPresets: ICustomPalettePreset[];
    private _activePresetId: string;
    private _isBatchUpdating: boolean;
    private _isSaveRowOpen: boolean;

    public constructor() {
        super();

        this._isBatchUpdating = false;
        this._isSaveRowOpen = false;
        this._customPresets = loadCustomPresets(PALETTE_ALL_RELEASE);

        const savedState = loadActivePaletteState(PALETTE_ALL_RELEASE);
        const initialBlocks = savedState !== null ? savedState.blocks : PALETTE_ALL_RELEASE;
        const initialSet = new Set(initialBlocks);

        this._palette = Palette.create();
        this._palette.add(initialBlocks);
        this._setValue(this._palette);

        this._activePresetId = detectMatchingPresetId(
            initialBlocks,
            this._customPresets,
            PALETTE_ALL_RELEASE,
            savedState?.presetId,
        );

        this._checkboxes = [];
        PALETTE_ALL_RELEASE.forEach((block) => {
            this._checkboxes.push({
                block: block,
                element: new CheckboxComponent()
                    .setDefaultValue(initialSet.has(block))
                    .setUnlocalisedCheckedText(block)
                    .setUnlocalisedUncheckedText(block),
            });
        });

        this._selectAll = new ToolbarItemComponent({ iconSVG: AppIcons.SELECT_ALL, id: 'select-all' })
            .onClick(() => {
                this._applyBlocks(PALETTE_ALL_RELEASE, 'all', true);
            });

        this._deselectAll = new ToolbarItemComponent({ iconSVG: AppIcons.DESELECT_ALL, id: 'deselect-all' })
            .onClick(() => {
                this._applyBlocks([], MANUAL_SELECTION_PRESET_ID, true);
            });

        this._importFrom = new ToolbarItemComponent({ iconSVG: AppIcons.IMPORT, id: 'import' })
            .onClick(() => {
                const a = document.createElement('input');
                a.setAttribute('type', 'file');
                a.setAttribute('accept', '.txt');

                a.addEventListener('change', () => {
                    const files = a.files;
                    if (files?.length === 1) {
                        const file = files.item(0);
                        ASSERT(file !== null);
                        AppConsole.info(LOC('assign.reading_palette', { file_name: file.name }));
                        file.text().then((text) => {
                            this._onReadPaletteFile(text);
                        });
                    }
                });

                a.click();
            });

        this._exportTo = new ToolbarItemComponent({ iconSVG: AppIcons.EXPORT, id: 'export' })
            .onClick(() => {
                const textPalette = this._checkboxes.filter((x) => x.element.getValue())
                    .map((x) => x.block)
                    .join('\n');
                download(textPalette, 'block-palette.txt');
            });

        this._copyList = new ToolbarItemComponent({ iconSVG: AppIcons.COPY, id: 'copy-list' })
            .setTooltip('assign.components.copy_list')
            .onClick(() => {
                const selectedBlocks = this._checkboxes.filter((x) => x.element.getValue()).map((x) => x.block);
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
                        AppConsole.info(LOC('assign.copy_list_success', { count: selectedBlocks.length }));
                    } finally {
                        document.body.removeChild(textArea);
                    }
                };
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    navigator.clipboard.writeText(textPalette).then(() => {
                        AppConsole.info(LOC('assign.copy_list_success', { count: selectedBlocks.length }));
                    }).catch(fallbackCopy);
                } else {
                    fallbackCopy();
                }
            });
    }

    private _escapeHTML(text?: string): string {
        return String(text ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
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
            selectEl.disabled = !this.enabled;
        }

        const saveBtn = document.getElementById(this._getId() + '-preset-save') as HTMLButtonElement | null;
        if (saveBtn) {
            saveBtn.disabled = !this.enabled;
        }

        const deleteBtn = document.getElementById(this._getId() + '-preset-delete') as HTMLButtonElement | null;
        if (deleteBtn) {
            deleteBtn.disabled = !this.enabled || !this._isCustomPresetActive();
        }

        const nameInput = document.getElementById(this._getId() + '-preset-name') as HTMLInputElement | null;
        if (nameInput) {
            nameInput.disabled = !this.enabled;
        }

        const confirmBtn = document.getElementById(this._getId() + '-preset-confirm') as HTMLButtonElement | null;
        if (confirmBtn) {
            confirmBtn.disabled = !this.enabled;
        }

        const cancelBtn = document.getElementById(this._getId() + '-preset-cancel') as HTMLButtonElement | null;
        if (cancelBtn) {
            cancelBtn.disabled = !this.enabled;
        }
    }

    private _updateSelectedCountBadge(): void {
        const badgeEl = document.getElementById(this._getId() + '-count');
        if (badgeEl) {
            const selected = this.getValue().count();
            const total = PALETTE_ALL_RELEASE.length;
            badgeEl.textContent = LOC('assign.components.selected_count', {
                selected,
                total,
            }) ?? `${selected} / ${total}`;
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
        saveActivePaletteState({
            presetId: this._activePresetId,
            blocks: this._palette.getBlocks(),
        }, PALETTE_ALL_RELEASE);
    }

    private _syncUIAfterSelectionChange(persist: boolean, preferredPresetId?: string): void {
        this._activePresetId = detectMatchingPresetId(
            this._palette.getBlocks(),
            this._customPresets,
            PALETTE_ALL_RELEASE,
            preferredPresetId,
        );
        this._refreshPresetSelect();
        this._onCountSelectedChanged();
        if (persist) {
            this._persistActivePalette();
        }
    }

    private _applyBlocks(blocks: readonly string[], preferredPresetId: string, persist: boolean): void {
        const blockSet = new Set(blocks);
        this._isBatchUpdating = true;
        try {
            this._checkboxes.forEach((checkbox) => {
                if (blockSet.has(checkbox.block)) {
                    checkbox.element.check();
                    this._palette.add([checkbox.block]);
                } else {
                    checkbox.element.uncheck();
                    this._palette.remove(checkbox.block);
                }
            });
        } finally {
            this._isBatchUpdating = false;
        }
        this._syncUIAfterSelectionChange(persist, preferredPresetId);
    }

    private _onSelectPreset(presetId: string): void {
        const builtin = BUILTIN_PALETTE_PRESETS.find((p) => p.id === presetId);
        if (builtin) {
            const blocks = getBuiltinPresetBlocks(builtin.id, PALETTE_ALL_RELEASE);
            this._applyBlocks(blocks, builtin.id, true);
            AppConsole.info(LOC('assign.preset_loaded', {
                name: this._getBuiltinPresetLabel(builtin.id),
                count: blocks.length,
            }));
            return;
        }

        const custom = this._customPresets.find((p) => p.id === presetId);
        if (custom) {
            this._applyBlocks(custom.blocks, custom.id, true);
            AppConsole.info(LOC('assign.preset_loaded', {
                name: custom.name,
                count: custom.blocks.length,
            }));
        }
    }

    private _onConfirmSavePreset(): void {
        const nameInput = document.getElementById(this._getId() + '-preset-name') as HTMLInputElement | null;
        const rawName = nameInput?.value ?? '';
        const selectedBlocks = this._palette.getBlocks();

        const result = saveCustomPreset(rawName, selectedBlocks, PALETTE_ALL_RELEASE);
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

        this._customPresets = deleteCustomPreset(target.id, PALETTE_ALL_RELEASE);
        this._syncUIAfterSelectionChange(true);
        AppConsole.info(LOC('assign.preset_deleted', { name: target.name }));
    }

    private _onCountSelectedChanged() {
        const countSelected = this.getValue().count();

        this._deselectAll.setEnabled(this.enabled && countSelected > 0);
        this._selectAll.setEnabled(this.enabled && countSelected < PALETTE_ALL_RELEASE.length);
        this._updateSelectedCountBadge();
    }

    public disableBlocks(blockNames: string[], disableUnused: boolean = false, modelBlockNames: string[] = []): number {
        const normalize = (name: string) => {
            return name
                .toLowerCase()
                .trim()
                .replace(/^minecraft:/, '')
                .replace(/_horizontal$/, '')
                .replace(/_slab_double$/, '')
                .replace(/_slab$/, '')
                .replace(/_double$/, '')
                .replace(/_front$/, '')
                .replace(/_top$/, '')
                .replace(/_bottom$/, '')
                .replace(/_side$/, '')
                .replace(/_\d+$/, '')
                .replace(/^suspicious_/, '')
                .replace(/^frosted_/, '');
        };

        const targetNormalized = new Set<string>();
        const targetExact = new Set<string>();
        for (const name of blockNames) {
            const trimmed = name.toLowerCase().trim();
            targetExact.add(trimmed);
            targetExact.add(trimmed.replace(/^minecraft:/, ''));
            targetExact.add('minecraft:' + trimmed.replace(/^minecraft:/, ''));
            targetNormalized.add(normalize(name));
        }

        const keepNormalized = new Set<string>();
        const keepExact = new Set<string>();
        if (disableUnused) {
            for (const name of modelBlockNames) {
                const trimmed = name.toLowerCase().trim();
                const stripped = trimmed.replace(/^minecraft:/, '');
                const norm = normalize(name);

                const isTargetedToDisable =
                    targetExact.has(trimmed) ||
                    targetExact.has(stripped) ||
                    targetNormalized.has(norm) ||
                    targetNormalized.has(stripped);

                if (!isTargetedToDisable) {
                    keepExact.add(trimmed);
                    keepExact.add(stripped);
                    keepExact.add('minecraft:' + stripped);
                    keepNormalized.add(norm);
                }
            }
        }

        // Safety check: ensure optimization doesn't disable 100% of palette blocks
        let wouldKeepCount = 0;
        this._checkboxes.forEach((checkbox) => {
            const cbRaw = checkbox.block.toLowerCase().trim();
            const cbStripped = cbRaw.replace(/^minecraft:/, '');
            const cbNorm = normalize(checkbox.block);

            let shouldDisable = false;
            if (disableUnused) {
                const isKept =
                    keepExact.has(cbRaw) ||
                    keepExact.has(cbStripped) ||
                    keepNormalized.has(cbNorm) ||
                    keepNormalized.has(cbStripped);
                shouldDisable = !isKept;
            } else {
                shouldDisable =
                    targetExact.has(cbRaw) ||
                    targetExact.has(cbStripped) ||
                    targetNormalized.has(cbNorm) ||
                    targetNormalized.has(cbStripped);
            }

            if (!shouldDisable) {
                wouldKeepCount++;
            }
        });

        if (wouldKeepCount === 0) {
            return -1;
        }

        let count = 0;
        this._isBatchUpdating = true;
        try {
            this._checkboxes.forEach((checkbox) => {
                const cbRaw = checkbox.block.toLowerCase().trim();
                const cbStripped = cbRaw.replace(/^minecraft:/, '');
                const cbNorm = normalize(checkbox.block);

                let shouldDisable = false;
                if (disableUnused) {
                    const isKept =
                        keepExact.has(cbRaw) ||
                        keepExact.has(cbStripped) ||
                        keepNormalized.has(cbNorm) ||
                        keepNormalized.has(cbStripped);
                    shouldDisable = !isKept;
                } else {
                    shouldDisable =
                        targetExact.has(cbRaw) ||
                        targetExact.has(cbStripped) ||
                        targetNormalized.has(cbNorm) ||
                        targetNormalized.has(cbStripped);
                }

                if (shouldDisable) {
                    if (checkbox.element.getValue()) {
                        checkbox.element.uncheck();
                        count++;
                    }
                    this._palette.remove(checkbox.block);
                }
            });
        } finally {
            this._isBatchUpdating = false;
        }

        this._syncUIAfterSelectionChange(false);
        return count;
    }

    private _onReadPaletteFile(text: string) {
        const blockNames = text.split('\n');

        let countDeselected = 0;
        this._isBatchUpdating = true;
        let countFound = 0;
        let countChecked = 0;

        try {
            this._checkboxes.forEach((checkbox) => {
                if (checkbox.element.getValue()) {
                    checkbox.element.uncheck();
                    this._palette.remove(checkbox.block);
                    ++countDeselected;
                }
            });
            AppConsole.info(LOC('assign.deselected_blocks', { count: countDeselected }));

            blockNames.forEach((blockName) => {
                blockName = blockName.trim();
                if (blockName.length === 0) {
                    return;
                }
                ++countFound;

                if (!AppUtil.Text.isNamespacedBlock(blockName)) {
                    AppConsole.error(LOC('assign.block_not_namespaced', { block_name: blockName }));
                } else {
                    const checkboxIndex = this._checkboxes.findIndex((x) => x.block === blockName);
                    if (checkboxIndex === -1) {
                        AppConsole.error(LOC('assign.could_not_use_block', { block_name: blockName }));
                    } else {
                        this._checkboxes[checkboxIndex].element.check();
                        this._palette.add([this._checkboxes[checkboxIndex].block]);
                        ++countChecked;
                    }
                }
            });
        } finally {
            this._isBatchUpdating = false;
        }

        AppConsole.info(LOC('assign.found_blocks', { count: countFound }));
        AppConsole.info(LOC('assign.selected_blocks', { count: countChecked }));

        this._syncUIAfterSelectionChange(true);
    }

    protected override _generateInnerHTML(): string {
        let checkboxesHTML = '';
        this._checkboxes.forEach((checkbox) => {
            checkboxesHTML += `<div class="col-container" id="${this._getId() + '-block-' + checkbox.block}">`;
            checkboxesHTML += checkbox.element._generateInnerHTML();
            checkboxesHTML += '</div>';
        });

        const selected = this.getValue().count();
        const total = PALETTE_ALL_RELEASE.length;
        const selectedCountText = LOC('assign.components.selected_count', {
            selected,
            total,
        }) ?? `${selected} / ${total}`;

        return `
            <div class="row-container" style="width: 100%; gap: 5px;">
                <div class="palette-preset-bar">
                    <div class="palette-preset-select-wrap">
                        <select class="struct-prop palette-preset-select" id="${this._getId() + '-preset-select'}" aria-label="${this._escapeHTML(LOC('assign.components.preset_label'))}">
                            ${this._renderPresetOptionsHTML()}
                        </select>
                        <div class="checkbox-arrow">
                            ${AppIcons.ARROW_DOWN}
                        </div>
                    </div>
                    <button type="button" class="palette-preset-btn" id="${this._getId() + '-preset-save'}" title="${this._escapeHTML(LOC('assign.components.preset_save_tooltip'))}">${this._escapeHTML(LOC('assign.components.preset_save'))}</button>
                    <button type="button" class="palette-preset-btn palette-preset-delete-btn" id="${this._getId() + '-preset-delete'}" title="${this._escapeHTML(LOC('assign.components.preset_delete_tooltip'))}">${this._escapeHTML(LOC('assign.components.preset_delete'))}</button>
                </div>
                <div class="palette-preset-save-row ${this._isSaveRowOpen ? '' : 'hide'}" id="${this._getId() + '-preset-save-row'}">
                    <input class="struct-prop palette-preset-name-input" type="text" id="${this._getId() + '-preset-name'}" placeholder="${this._escapeHTML(LOC('assign.components.preset_name_placeholder'))}" maxlength="48" />
                    <button type="button" class="palette-preset-btn palette-preset-confirm-btn" id="${this._getId() + '-preset-confirm'}">${this._escapeHTML(LOC('assign.components.preset_confirm_save'))}</button>
                    <button type="button" class="palette-preset-btn" id="${this._getId() + '-preset-cancel'}">${this._escapeHTML(LOC('assign.components.preset_cancel_save'))}</button>
                </div>
                <div class="palette-search-row">
                    <input class="struct-prop" type="text" style="width: 100%; text-align: start;" placeholder="${LOC('assign.components.search')}" id="${this._getId() + '-search'}"></input>
                    <span class="palette-count-badge" id="${this._getId() + '-count'}">${this._escapeHTML(selectedCountText)}</span>
                </div>
                <div class="col-container header-cols" style="padding-top: 0px;">
                    <div class="col-container">
                        <div class="col-item">
                            ${this._importFrom.generateHTML()}
                        </div>
                        <div class="col-item">
                            ${this._exportTo.generateHTML()}
                        </div>
                    </div>
                    <div class="col-container">
                        <div class="col-item">
                            ${this._copyList.generateHTML()}
                        </div>
                        <div class="col-item">
                            ${this._selectAll.generateHTML()}
                        </div>
                        <div class="col-item">
                            ${this._deselectAll.generateHTML()}
                        </div>
                    </div>
                </div>
                <div class="row-container" style="gap: 5px; border-radius: 5px; width: 100%; height: 200px; overflow-y: auto; overflow-x: hidden;" id="${this._getId() + '-list'}">
                    ${checkboxesHTML}
                </div>
            </div>
        `;
    }

    protected override _onValueChanged(): void {
    }

    protected override _onEnabledChanged(): void {
        super._onEnabledChanged();

        const searchElement = UIUtil.getElementById(this._getId() + '-search') as HTMLInputElement;
        searchElement.disabled = !this.enabled;

        if (!this.enabled) {
            this._setSaveRowVisible(false);
        }

        this._checkboxes.forEach((checkbox) => {
            checkbox.element.setEnabled(this.getEnabled());
        });

        this._selectAll.setEnabled(this.enabled);
        this._deselectAll.setEnabled(this.enabled);
        this._importFrom.setEnabled(this.enabled);
        this._exportTo.setEnabled(this.enabled);
        this._copyList.setEnabled(this.enabled);

        this._updatePresetButtons();
        this._onCountSelectedChanged();
        this._updateStyles();
    }

    public override registerEvents(): void {
        const searchElement = UIUtil.getElementById(this._getId() + '-search') as HTMLInputElement;
        searchElement.addEventListener('keyup', () => {
            this._onSearchBoxChanged(searchElement.value);
        });
        searchElement.addEventListener('mouseenter', () => {
            this._setHovered(true);
            this._updateStyles();
        });
        searchElement.addEventListener('mouseleave', () => {
            this._setHovered(false);
            this._updateStyles();
        });

        const presetSelect = document.getElementById(this._getId() + '-preset-select') as HTMLSelectElement | null;
        presetSelect?.addEventListener('change', () => {
            if (!this.enabled) {
                return;
            }
            this._onSelectPreset(presetSelect.value);
        });

        const saveBtn = document.getElementById(this._getId() + '-preset-save') as HTMLButtonElement | null;
        saveBtn?.addEventListener('click', () => {
            if (!this.enabled) {
                return;
            }
            this._setSaveRowVisible(!this._isSaveRowOpen);
        });

        const deleteBtn = document.getElementById(this._getId() + '-preset-delete') as HTMLButtonElement | null;
        deleteBtn?.addEventListener('click', () => {
            if (!this.enabled) {
                return;
            }
            this._onDeleteActiveCustomPreset();
        });

        const confirmSaveBtn = document.getElementById(this._getId() + '-preset-confirm') as HTMLButtonElement | null;
        confirmSaveBtn?.addEventListener('click', () => {
            if (!this.enabled) {
                return;
            }
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

        this._checkboxes.forEach((checkbox) => {
            checkbox.element.registerEvents();
            checkbox.element.addValueChangedListener(() => {
                const isTicked = checkbox.element.getValue();
                if (isTicked) {
                    this._palette.add([checkbox.block]);
                } else {
                    this._palette.remove(checkbox.block);
                }
                if (!this._isBatchUpdating) {
                    this._syncUIAfterSelectionChange(true);
                }
            });
        });

        this._selectAll.registerEvents();
        this._deselectAll.registerEvents();
        this._importFrom.registerEvents();
        this._exportTo.registerEvents();
        this._copyList.registerEvents();
    }

    public override finalise(): void {
        super.finalise();

        this._checkboxes.forEach((checkbox) => {
            checkbox.element.finalise();
        });

        this._selectAll.finalise();
        this._deselectAll.finalise();
        this._importFrom.finalise();
        this._exportTo.finalise();
        this._copyList.finalise();

        this._refreshPresetSelect();
        this._onCountSelectedChanged();

        this._updateStyles();
    }

    private _onSearchBoxChanged(search: string) {
        this._checkboxes.forEach((checkbox) => {
            const row = UIUtil.getElementById(this._getId() + '-block-' + checkbox.block);
            if (checkbox.block.toLocaleLowerCase().includes(search.toLowerCase()) || checkbox.block.toLowerCase().replace(/_/g, ' ').includes(search.toLowerCase())) {
                row.style.display = '';
            } else {
                row.style.display = 'none';
            }
        });
    }

    protected override _updateStyles(): void {
        UIUtil.updateStyles(UIUtil.getElementById(this._getId() + '-search'), {
            isActive: false,
            isEnabled: this.enabled,
            isHovered: this.hovered,
        });
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

        const element = UIUtil.getElementById(this._getId() + '-search') as HTMLInputElement;
        element.placeholder = LOC('assign.components.search');

        const presetSelect = document.getElementById(this._getId() + '-preset-select') as HTMLSelectElement | null;
        if (presetSelect) {
            presetSelect.setAttribute('aria-label', LOC('assign.components.preset_label'));
        }
        this._refreshPresetSelect();

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

        this._updateSelectedCountBadge();
    }
}
