import { PALETTE_ALL_RELEASE } from '../../../res/palettes/all';
import { Atlas } from '../../atlas';
import { RGBAUtil } from '../../colour';
import { LOC } from '../../localiser';
import { AppUtil } from '../../util';
import { UIUtil } from '../../util/ui_util';
import { ConfigComponent } from './config';

type DichromeRole = 'dark' | 'light';

/**
 * Visual block picker dedicated to Dichrome.
 * The user chooses a role first, then picks a block from the colour-coded grid.
 */
export class DichromePaletteComponent extends ConfigComponent<string[], HTMLDivElement> {
    private _blockNames: string[];
    private _blockColours: Map<string, string>;
    private _blockLightness: Map<string, number>;
    private _activeRole: DichromeRole;

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
        this._activeRole = 'dark';
    }

    protected override _generateInnerHTML(): string {
        return `
            <div class="dichrome-palette" id="${this._getId()}">
                <div class="dichrome-palette-selected">
                    <button type="button" class="dichrome-palette-slot" id="${this._getId()}-dark-slot" aria-pressed="true">
                        <span class="dichrome-palette-slot-label" id="${this._getId()}-dark-label">${LOC('assign.components.dichrome_dark_block')}</span>
                        <span class="dichrome-palette-slot-swatch" id="${this._getId()}-dark-swatch"></span>
                        <span class="dichrome-palette-slot-name" id="${this._getId()}-dark-name"></span>
                    </button>
                    <button type="button" class="dichrome-palette-slot" id="${this._getId()}-light-slot" aria-pressed="false">
                        <span class="dichrome-palette-slot-label" id="${this._getId()}-light-label">${LOC('assign.components.dichrome_light_block')}</span>
                        <span class="dichrome-palette-slot-swatch" id="${this._getId()}-light-swatch"></span>
                        <span class="dichrome-palette-slot-name" id="${this._getId()}-light-name"></span>
                    </button>
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

    private _renderGrid(searchValue = '') {
        const grid = document.getElementById(this._getId() + '-grid') as HTMLDivElement | null;
        if (!grid) {
            return;
        }

        const normalizedSearch = searchValue.trim().toLowerCase();
        const [darkBlock, lightBlock] = this.getValue();
        const selectedBlock = this._activeRole === 'dark' ? darkBlock : lightBlock;
        const otherBlock = this._activeRole === 'dark' ? lightBlock : darkBlock;

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
                return (this._activeRole === 'dark' ? difference : -difference) || a.localeCompare(b);
            });

        if (matchingBlocks.length === 0) {
            grid.innerHTML = `<div class="dichrome-palette-empty">${LOC('assign.components.empty_search')}</div>`;
            return;
        }

        grid.innerHTML = matchingBlocks.map((name) => {
            const isSelected = name === selectedBlock;
            const isAssignedToOtherRole = name === otherBlock;
            const colour = this._blockColours.get(name) ?? 'var(--gray-600)';
            return `
                <button
                    type="button"
                    class="dichrome-palette-option${isSelected ? ' is-selected' : ''}${isAssignedToOtherRole ? ' is-assigned' : ''}"
                    data-block="${this._escapeHTML(name)}"
                    title="${this._escapeHTML(name)}"
                    aria-pressed="${isSelected}"
                    ${isAssignedToOtherRole || this.disabled ? 'disabled' : ''}
                >
                    <span class="dichrome-palette-option-swatch" style="background-color: ${colour}"></span>
                    <span class="dichrome-palette-option-name">${this._escapeHTML(this._getDisplayName(name))}</span>
                </button>
            `;
        }).join('');
    }

    private _updateSelectionUI() {
        const [darkBlock, lightBlock] = this.getValue();
        const darkSlot = document.getElementById(this._getId() + '-dark-slot') as HTMLButtonElement | null;
        const lightSlot = document.getElementById(this._getId() + '-light-slot') as HTMLButtonElement | null;
        const darkSwatch = document.getElementById(this._getId() + '-dark-swatch') as HTMLSpanElement | null;
        const lightSwatch = document.getElementById(this._getId() + '-light-swatch') as HTMLSpanElement | null;
        const darkName = document.getElementById(this._getId() + '-dark-name');
        const lightName = document.getElementById(this._getId() + '-light-name');

        if (!darkSlot || !lightSlot || !darkSwatch || !lightSwatch || !darkName || !lightName) {
            return;
        }

        darkSlot.classList.toggle('is-active', this._activeRole === 'dark');
        lightSlot.classList.toggle('is-active', this._activeRole === 'light');
        darkSlot.setAttribute('aria-pressed', String(this._activeRole === 'dark'));
        lightSlot.setAttribute('aria-pressed', String(this._activeRole === 'light'));
        darkSlot.disabled = this.disabled;
        lightSlot.disabled = this.disabled;

        darkName.textContent = this._getDisplayName(darkBlock);
        lightName.textContent = this._getDisplayName(lightBlock);
        darkSlot.title = darkBlock;
        lightSlot.title = lightBlock;
        darkSwatch.style.backgroundColor = this._blockColours.get(darkBlock) ?? 'var(--gray-600)';
        lightSwatch.style.backgroundColor = this._blockColours.get(lightBlock) ?? 'var(--gray-600)';
    }

    private _refreshOptions() {
        const search = document.getElementById(this._getId() + '-search') as HTMLInputElement | null;
        if (!search) {
            return;
        }

        this._updateSelectionUI();
        this._renderGrid(search.value);
    }

    public override registerEvents(): void {
        const search = UIUtil.getElementById(this._getId() + '-search') as HTMLInputElement;
        const darkSlot = UIUtil.getElementById(this._getId() + '-dark-slot') as HTMLButtonElement;
        const lightSlot = UIUtil.getElementById(this._getId() + '-light-slot') as HTMLButtonElement;
        const grid = UIUtil.getElementById(this._getId() + '-grid') as HTMLDivElement;

        search.addEventListener('input', () => this._renderGrid(search.value));
        darkSlot.addEventListener('click', () => {
            this._activeRole = 'dark';
            this._refreshOptions();
        });
        lightSlot.addEventListener('click', () => {
            this._activeRole = 'light';
            this._refreshOptions();
        });
        grid.addEventListener('click', (event: MouseEvent) => {
            const target = event.target as HTMLElement | null;
            const option = target?.closest<HTMLButtonElement>('.dichrome-palette-option');
            const blockName = option?.dataset.block;
            if (!option || option.disabled || !blockName) {
                return;
            }

            const [darkBlock, lightBlock] = this.getValue();
            if (this._activeRole === 'dark' && blockName !== lightBlock) {
                this._setValue([blockName, lightBlock]);
            } else if (this._activeRole === 'light' && blockName !== darkBlock) {
                this._setValue([darkBlock, blockName]);
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

        this._refreshOptions();
    }

    protected override _onValueChanged(): void {
        this._refreshOptions();
    }

    protected override _onEnabledChanged(): void {
        super._onEnabledChanged();

        const search = document.getElementById(this._getId() + '-search') as HTMLInputElement | null;
        if (search) {
            search.disabled = this.disabled;
        }
        this._updateSelectionUI();
        this._renderGrid(search?.value ?? '');
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
        const darkLabel = document.getElementById(this._getId() + '-dark-label');
        const lightLabel = document.getElementById(this._getId() + '-light-label');
        if (search) search.placeholder = LOC('assign.components.search');
        if (darkLabel) darkLabel.textContent = LOC('assign.components.dichrome_dark_block');
        if (lightLabel) lightLabel.textContent = LOC('assign.components.dichrome_light_block');
        this._refreshOptions();
    }
}
