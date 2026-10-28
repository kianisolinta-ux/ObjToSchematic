import * as path from 'path';

import { LOC } from '../../localiser';
import { ASSERT } from '../../util/error_util';
import { UIUtil } from '../../util/ui_util';
import { ConfigComponent } from './config';

export class FileComponent extends ConfigComponent<File, HTMLDivElement> {
    private _loadedFilePath: string | null;

    public constructor() {
        super();
        this._loadedFilePath = null;
    }

    protected override _generateInnerHTML() {
        return `
            <div class="input-file struct-prop" id="${this._getId()}">
                <input type="file" accept=".obj,.glb,.gltf" style="display: none;" id="${this._getId()}-input">
                ${this._loadedFilePath ?? LOC('import.components.no_file_chosen')}
            </div>
        `;
    }

    public override registerEvents(): void {
        const element = this._getElement();

        element.addEventListener('mouseenter', () => {
            this._setHovered(true);
            this._updateStyles();
        });

        element.addEventListener('mouseleave', () => {
            this._setHovered(false);
            this._updateStyles();
        });

        element.addEventListener('dragover', (e: DragEvent) => {
            e.preventDefault();
            this._setHovered(true);
            this._updateStyles();
        });

        element.addEventListener('dragleave', (e: DragEvent) => {
            e.preventDefault();
            this._setHovered(false);
            this._updateStyles();
        });

        element.addEventListener('drop', (e: DragEvent) => {
            e.preventDefault();
            this._setHovered(false);
            this._updateStyles();
            if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                const file = e.dataTransfer.files[0];
                this._loadedFilePath = file.name;
                this._setValue(file);
            }
        });

        const inputElement = UIUtil.getElementById(this._getId() + '-input') as HTMLInputElement;

        inputElement.addEventListener('change', () => {
            const files = inputElement.files;
            if (files?.length === 1) {
                const file = files.item(0);
                ASSERT(file !== null);
                this._loadedFilePath = file.name;
                this._setValue(file);
            }
        });

        element.addEventListener('click', () => {
            if (this.enabled) {
                inputElement.click();
            }
        });
    }

    protected _onValueChanged(): void {
        this._updateStyles();
    }

    protected _onEnabledChanged(): void {
        super._onEnabledChanged();

        this._updateStyles();
    }

    protected override _updateStyles() {
        if (this._loadedFilePath) {
            const parsedPath = path.parse(this._loadedFilePath);
            this._getElement().innerHTML = parsedPath.name + parsedPath.ext;
        } else {
            this._getElement().innerHTML = `<i>${LOC('import.components.no_file_chosen')}</i>`;
        }

        UIUtil.updateStyles(this._getElement(), {
            isHovered: this.hovered,
            isEnabled: this.enabled,
            isActive: false,
        });
    }

    public override refresh(): void {
        this._getElement().innerHTML = `<i>${LOC('import.components.no_file_chosen')}</i>`;
    }
}
