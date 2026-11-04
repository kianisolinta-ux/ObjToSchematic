import { PALETTE_ALL_RELEASE } from '../../../res/palettes/all';
import { Atlas } from '../../atlas';
import { RGBAUtil } from '../../colour';
import { LOC } from '../../localiser';
import { AppUtil } from '../../util';
import { UIUtil } from '../../util/ui_util';
import { ConfigComponent } from './config';

/**
 * Compact two-block palette dedicated to the Dichrome algorithm.
 * The first selection is the dark tone, the second is the light tone.
 */
export class DichromePaletteComponent extends ConfigComponent<string[], HTMLDivElement> {
    private _blockNames: string[];
    private _blockColours: Map<string, string>;

    public constructor() {
        super(['minecraft:black_concrete', 'minecraft:white_concrete']);

        const atlas = Atlas.load('vanilla');
        this._blockNames = PALETTE_ALL_RELEASE.filter((name) =>
            atlas === undefined || atlas.getBlocks().has(AppUtil.Text.namespaceBlock(name)),
        );
        this._blockColours = new Map();
        atlas?.getBlocks().forEach((block) => {
            this._blockColours.set(block.name, RGBAUtil.toHexString(block.colour));
        });
    }

    protected override _generateInnerHTML(): string {
        const [darkBlock, lightBlock] = this.getValue();
        return `
            <div class="dichrome-palette" id="${this._getId()}">
                <input
                    class="struct-prop dichrome-palette-search"
                    type="search"
                    id="${this._getId()}-search"
                    placeholder="${LOC('assign.components.search')}"
                    autocomplete="off"
                >
                <div class="dichrome-palette-rows">
                    <div class="dichrome-palette-row">
                        <div class="dichrome-palette-row-heading">
                            <span id="${this._getId()}-dark-label">${LOC('assign.components.dichrome_dark_block')}</span>
                            <span class="dichrome-palette-swatch" id="${this._getId()}-dark-swatch"></span>
                        </div>
                        <select class="struct-prop dichrome-palette-select" id="${this._getId()}-dark-select">
                            ${this._getOptionsHTML(darkBlock, lightBlock)}
                        </select>
                    </div>
                    <div class="dichrome-palette-row">
                        <div class="dichrome-palette-row-heading">
                            <span id="${this._getId()}-light-label">${LOC('assign.components.dichrome_light_block')}</span>
                            <span class="dichrome-palette-swatch" id="${this._getId()}-light-swatch"></span>
                        </div>
                        <select class="struct-prop dichrome-palette-select" id="${this._getId()}-light-select">
                            ${this._getOptionsHTML(lightBlock, darkBlock)}
                        </select>
                    </div>
                </div>
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

    private _getOptionsHTML(selected: string, otherSelected: string, search = ''): string {
        const normalizedSearch = search.trim().toLowerCase();
        const options = this._blockNames.filter((name) =>
            name !== otherSelected &&
            (!normalizedSearch ||
                name.toLowerCase().includes(normalizedSearch) ||
                name.toLowerCase().replace(/_/g, ' ').includes(normalizedSearch)),
        );

        if (!options.includes(selected)) {
            options.unshift(selected);
        }

        return options.map((name) =>
            `<option value="${this._escapeHTML(name)}"${name === selected ? ' selected' : ''}>${this._escapeHTML(name)}</option>`,
        ).join('');
    }

    private _populateSelect(select: HTMLSelectElement, selected: string, otherSelected: string, search: string) {
        select.innerHTML = this._getOptionsHTML(selected, otherSelected, search);
        select.value = selected;
    }

    private _updateSelectionUI() {
        const value = this.getValue();
        const darkSwatch = document.getElementById(this._getId() + '-dark-swatch') as HTMLSpanElement | null;
        const lightSwatch = document.getElementById(this._getId() + '-light-swatch') as HTMLSpanElement | null;
        if (!darkSwatch || !lightSwatch) {
            return;
        }

        darkSwatch.style.backgroundColor = this._blockColours.get(value[0]) ?? 'var(--gray-500)';
        darkSwatch.title = value[0];
        lightSwatch.style.backgroundColor = this._blockColours.get(value[1]) ?? 'var(--gray-500)';
        lightSwatch.title = value[1];
    }

    private _refreshOptions() {
        const search = document.getElementById(this._getId() + '-search') as HTMLInputElement | null;
        const darkSelect = document.getElementById(this._getId() + '-dark-select') as HTMLSelectElement | null;
        const lightSelect = document.getElementById(this._getId() + '-light-select') as HTMLSelectElement | null;
        if (!search || !darkSelect || !lightSelect) {
            return;
        }

        const [darkBlock, lightBlock] = this.getValue();
        this._populateSelect(darkSelect, darkBlock, lightBlock, search.value);
        this._populateSelect(lightSelect, lightBlock, darkBlock, search.value);
        this._updateSelectionUI();
    }

    public override registerEvents(): void {
        const search = UIUtil.getElementById(this._getId() + '-search') as HTMLInputElement;
        const darkSelect = UIUtil.getElementById(this._getId() + '-dark-select') as HTMLSelectElement;
        const lightSelect = UIUtil.getElementById(this._getId() + '-light-select') as HTMLSelectElement;

        search.addEventListener('input', () => this._refreshOptions());

        darkSelect.addEventListener('change', () => {
            const [previousDark, lightBlock] = this.getValue();
            const selectedDark = darkSelect.value;
            if (selectedDark !== lightBlock) {
                this._setValue([selectedDark, lightBlock]);
            } else {
                darkSelect.value = previousDark;
            }
        });

        lightSelect.addEventListener('change', () => {
            const [darkBlock, previousLight] = this.getValue();
            const selectedLight = lightSelect.value;
            if (selectedLight !== darkBlock) {
                this._setValue([darkBlock, selectedLight]);
            } else {
                lightSelect.value = previousLight;
            }
        });

        [search, darkSelect, lightSelect].forEach((element) => {
            element.addEventListener('mouseenter', () => {
                this._setHovered(true);
                this._updateStyles();
            });
            element.addEventListener('mouseleave', () => {
                this._setHovered(false);
                this._updateStyles();
            });
        });
    }

    protected override _onValueChanged(): void {
        this._refreshOptions();
    }

    protected override _onEnabledChanged(): void {
        super._onEnabledChanged();

        const search = document.getElementById(this._getId() + '-search') as HTMLInputElement | null;
        const darkSelect = document.getElementById(this._getId() + '-dark-select') as HTMLSelectElement | null;
        const lightSelect = document.getElementById(this._getId() + '-light-select') as HTMLSelectElement | null;
        if (search) search.disabled = this.disabled;
        if (darkSelect) darkSelect.disabled = this.disabled;
        if (lightSelect) lightSelect.disabled = this.disabled;

        this._updateStyles();
    }

    protected override _updateStyles(): void {
        const search = document.getElementById(this._getId() + '-search');
        const darkSelect = document.getElementById(this._getId() + '-dark-select');
        const lightSelect = document.getElementById(this._getId() + '-light-select');
        [search, darkSelect, lightSelect].forEach((element) => {
            if (element) {
                UIUtil.updateStyles(element, {
                    isHovered: this.hovered,
                    isEnabled: this.enabled,
                    isActive: false,
                });
            }
        });
    }

    public override refresh(): void {
        super.refresh();

        const search = document.getElementById(this._getId() + '-search') as HTMLInputElement | null;
        const darkLabel = document.getElementById(this._getId() + '-dark-label');
        const lightLabel = document.getElementById(this._getId() + '-light-label');
        if (search) search.placeholder = LOC('assign.components.search');
        if (darkLabel) darkLabel.textContent = LOC('assign.components.dichrome_dark_block');
        if (lightLabel) lightLabel.textContent = LOC('assign.components.dichrome_light_block');
    }
}
