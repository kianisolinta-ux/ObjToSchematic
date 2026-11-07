import { PALETTE_ALL_RELEASE } from '../../../res/palettes/all';
import { Atlas } from '../../atlas';
import { RGBAUtil } from '../../colour';
import { LOC } from '../../localiser';
import { AppUtil } from '../../util';
import { UIUtil } from '../../util/ui_util';
import { ConfigComponent } from './config';

/**
 * Visual multi-tone block picker dedicated to Dichrome.
 * Supports N blocks (N >= 2) ordered from darkest to lightest tone.
 */
export class DichromePaletteComponent extends ConfigComponent<string[], HTMLDivElement> {
    private _blockNames: string[];
    private _blockColours: Map<string, string>;
    private _blockLightness: Map<string, number>;
    private _activeSlotIndex: number;

    public constructor() {
        super(['minecraft:black_concrete', 'minecraft:white_concrete']);

        const atlas = Atlas.load('vanilla');
        this._blockNames = PALETTE_ALL_RELEASE.filter((name) =>
            atlas === undefined || atlas.getBlocks().has(AppUtil.Text.namespaceBlock(name)),
        );
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
    }

    protected override _generateInnerHTML(): string {
        return `
            <div class="dichrome-palette" id="${this._getId()}">
                <div class="dichrome-palette-header">
                    <span class="dichrome-palette-count" id="${this._getId()}-count"></span>
                    <div class="dichrome-palette-actions">
                        <button type="button" class="dichrome-palette-action-btn" id="${this._getId()}-add-btn">
                            ${LOC('assign.components.dichrome_add_tone')}
                        </button>
                        <button type="button" class="dichrome-palette-action-btn" id="${this._getId()}-sort-btn">
                            ${LOC('assign.components.dichrome_sort_tones')}
                        </button>
                    </div>
                </div>
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
                // If active slot is the darkest, prioritize darker blocks first.
                // If active slot is the lightest, prioritize lighter blocks first.
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

        if (addBtn) addBtn.disabled = this.disabled;
        if (sortBtn) sortBtn.disabled = this.disabled;
        if (search) search.disabled = this.disabled;

        this._renderSlots();
        this._renderGrid(search?.value ?? '');
    }

    public override registerEvents(): void {
        const search = UIUtil.getElementById(this._getId() + '-search') as HTMLInputElement;
        const selectedContainer = UIUtil.getElementById(this._getId() + '-selected') as HTMLDivElement;
        const grid = UIUtil.getElementById(this._getId() + '-grid') as HTMLDivElement;
        const addBtn = UIUtil.getElementById(this._getId() + '-add-btn') as HTMLButtonElement;
        const sortBtn = UIUtil.getElementById(this._getId() + '-sort-btn') as HTMLButtonElement;

        search.addEventListener('input', () => this._renderGrid(search.value));

        selectedContainer.addEventListener('click', (event: MouseEvent) => {
            const target = event.target as HTMLElement | null;
            if (!target) return;

            // Handle remove button click
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
                }
                return;
            }

            // Handle slot click
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
            // Pick candidate block not currently present in palette
            let candidate = this._blockNames.find((name) => !currentBlocks.includes(name));
            if (!candidate) {
                candidate = 'minecraft:stone';
            }
            const updated = [...currentBlocks, candidate];
            this._activeSlotIndex = updated.length - 1;
            this._setValue(updated);
        });

        sortBtn.addEventListener('click', () => {
            if (this.disabled) return;
            const currentBlocks = [...this.getValue()];
            currentBlocks.sort((a, b) => {
                const lA = this._blockLightness.get(a) ?? 0;
                const lB = this._blockLightness.get(b) ?? 0;
                return lA - lB;
            });
            this._setValue(currentBlocks);
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
                // If clicked block is already in another slot, swap them!
                if (existingIdx !== this._activeSlotIndex) {
                    const temp = currentBlocks[this._activeSlotIndex];
                    currentBlocks[this._activeSlotIndex] = blockName;
                    currentBlocks[existingIdx] = temp;
                    this._setValue(currentBlocks);
                }
            } else {
                currentBlocks[this._activeSlotIndex] = blockName;
                this._setValue(currentBlocks);
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

        // Interactive vertical resize handle
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

    protected override _onValueChanged(): void {
        this._refreshOptions();
    }

    protected override _onEnabledChanged(): void {
        super._onEnabledChanged();
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
    }

    public override refresh(): void {
        super.refresh();

        const search = document.getElementById(this._getId() + '-search') as HTMLInputElement | null;
        const addBtn = document.getElementById(this._getId() + '-add-btn');
        const sortBtn = document.getElementById(this._getId() + '-sort-btn');
        const resizer = document.getElementById(this._getId() + '-resizer');
        if (search) search.placeholder = LOC('assign.components.search');
        if (addBtn) addBtn.textContent = LOC('assign.components.dichrome_add_tone');
        if (sortBtn) sortBtn.textContent = LOC('assign.components.dichrome_sort_tones');
        if (resizer) resizer.title = LOC('assign.components.dichrome_resize_tooltip');
        this._refreshOptions();
    }
}
