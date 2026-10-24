import { PALETTE_ALL_RELEASE } from '../../../res/palettes/all';
import { LOC } from '../../localiser';
import { Palette } from '../../palette';
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

    public constructor() {
        super();

        this._palette = Palette.create();
        this._palette.add(PALETTE_ALL_RELEASE);
        this._setValue(this._palette);

        this._checkboxes = [];
        PALETTE_ALL_RELEASE.forEach((block) => {
            this._checkboxes.push({
                block: block,
                element: new CheckboxComponent()
                    .setDefaultValue(true)
                    .setUnlocalisedCheckedText(block)
                    .setUnlocalisedUncheckedText(block),
            });
        });

        this._selectAll = new ToolbarItemComponent({ iconSVG: AppIcons.SELECT_ALL, id: 'select-all' })
            .onClick(() => {
                this._checkboxes.forEach((checkbox) => {
                    checkbox.element.check();
                });
                this._onCountSelectedChanged();
            });


        this._deselectAll = new ToolbarItemComponent({ iconSVG: AppIcons.DESELECT_ALL, id: 'deselect-all' })
            .onClick(() => {
                this._checkboxes.forEach((checkbox) => {
                    checkbox.element.uncheck();
                });
                this._onCountSelectedChanged();
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

    private _onCountSelectedChanged() {
        const countSelected = this.getValue().count();

        this._deselectAll.setEnabled(this.enabled && countSelected > 0);
        this._selectAll.setEnabled(this.enabled && countSelected < PALETTE_ALL_RELEASE.length);
    }

    public disableBlocks(blockNames: string[]): number {
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

        let count = 0;
        this._checkboxes.forEach((checkbox) => {
            const cbRaw = checkbox.block.toLowerCase().trim();
            const cbStripped = cbRaw.replace(/^minecraft:/, '');
            const cbNorm = normalize(checkbox.block);

            const isMatch =
                targetExact.has(cbRaw) ||
                targetExact.has(cbStripped) ||
                targetNormalized.has(cbNorm) ||
                targetNormalized.has(cbStripped);

            if (isMatch) {
                if (checkbox.element.getValue()) {
                    checkbox.element.uncheck();
                    count++;
                }
                this._palette.remove(checkbox.block);
            }
        });

        this._onCountSelectedChanged();
        return count;
    }

    private _onReadPaletteFile(text: string) {
        const blockNames = text.split('\n');

        let countDeselected = 0;
        this._checkboxes.forEach((checkbox) => {
            if (checkbox.element.getValue()) {
                checkbox.element.uncheck();
                ++countDeselected;
            }
        });
        AppConsole.info(LOC('assign.deselected_blocks', { count: countDeselected }));

        let countFound = 0;
        let countChecked = 0;
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
                    ++countChecked;
                }
            }
        });

        AppConsole.info(LOC('assign.found_blocks', { count: countFound }));
        AppConsole.info(LOC('assign.selected_blocks', { count: countChecked }));

        this._onCountSelectedChanged();
    }

    protected override _generateInnerHTML(): string {
        let checkboxesHTML = '';
        this._checkboxes.forEach((checkbox) => {
            checkboxesHTML += `<div class="col-container" id="${this._getId() + '-block-' + checkbox.block}">`;
            checkboxesHTML += checkbox.element._generateInnerHTML();
            checkboxesHTML += '</div>';
        });

        return `
            <div class="row-container" style="width: 100%; gap: 5px;">
                <input class="struct-prop" type="text" style="width: 100%; text-align: start;" placeholder="${LOC('assign.components.search')}" id="${this._getId() + '-search'}"></input>
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

        this._checkboxes.forEach((checkbox) => {
            checkbox.element.setEnabled(this.getEnabled());
        });

        this._selectAll.setEnabled(this.enabled);
        this._deselectAll.setEnabled(this.enabled);
        this._importFrom.setEnabled(this.enabled);
        this._exportTo.setEnabled(this.enabled);
        this._copyList.setEnabled(this.enabled);

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

        this._checkboxes.forEach((checkbox) => {
            checkbox.element.registerEvents();
            checkbox.element.addValueChangedListener(() => {
                const isTicked = checkbox.element.getValue();
                if (isTicked) {
                    this._palette.add([checkbox.block]);
                } else {
                    this._palette.remove(checkbox.block);
                }
                this._onCountSelectedChanged();
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

        this._onCountSelectedChanged();

        this._updateStyles();
        //this._selectAll.finalise();
        //this._deselectAll.finalise();
        //this._importFrom.finalise();
        //this._exportTo.finalise();
    }

    private _onSearchBoxChanged(search: string) {
        this._checkboxes.forEach((checkbox) => {
            const row = UIUtil.getElementById(this._getId() + '-block-' + checkbox.block);
            if (checkbox.block.toLocaleLowerCase().includes(search.toLowerCase()) || checkbox.block.toLowerCase().replace(/_/g, ' ').includes(search.toLocaleLowerCase())) {
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
    }

    public override refresh(): void {
        super.refresh();

        const element = UIUtil.getElementById(this._getId() + '-search') as HTMLInputElement;
        element.placeholder = LOC('assign.components.search');
    }
}
