import { TTranslationMap } from '../../../loc/base';
import { DeepLeafKeys, LOC } from '../../localiser';
import { UIUtil } from '../../util/ui_util';
import { TVoxelRotationAlgorithm } from '../../voxel_rotate_types';
import { AppIcons } from '../icons';
import { ConfigComponent } from './config';

export interface IVoxelRotationAlgorithmConfig {
    algorithm: TVoxelRotationAlgorithm;
    closeHoles: boolean;
}

interface IRotationAlgorithmItem {
    payload: TVoxelRotationAlgorithm;
    displayLocKey: DeepLeafKeys<TTranslationMap>;
}

const ROTATION_ALGORITHM_ITEMS: readonly IRotationAlgorithmItem[] = [
    { payload: 'forward', displayLocKey: 'voxel_post.components.algo_forward' },
    { payload: 'nearest', displayLocKey: 'voxel_post.components.algo_nearest' },
    { payload: 'trilinear', displayLocKey: 'voxel_post.components.algo_trilinear' },
    { payload: 'shear', displayLocKey: 'voxel_post.components.algo_shear' },
    { payload: 'sdf', displayLocKey: 'voxel_post.components.algo_sdf' },
    { payload: 'rotsprite', displayLocKey: 'voxel_post.components.algo_rotsprite' },
    { payload: 'surface-nets', displayLocKey: 'voxel_post.components.algo_surface_nets' },
];

export class RotationAlgorithmComponent extends ConfigComponent<IVoxelRotationAlgorithmConfig, HTMLSelectElement> {
    private _holesHovered = false;

    public constructor() {
        super({
            algorithm: 'sdf',
            closeHoles: true,
        });
    }

    public getAlgorithm(): TVoxelRotationAlgorithm {
        return this.getValue().algorithm;
    }

    public getCloseHoles(): boolean {
        return this.getValue().closeHoles;
    }

    public setAlgorithm(algorithm: TVoxelRotationAlgorithm): void {
        const cur = this.getValue();
        this._setValue({
            algorithm,
            closeHoles: cur.closeHoles,
        });
    }

    public setCloseHoles(closeHoles: boolean): void {
        const cur = this.getValue();
        this._setValue({
            algorithm: cur.algorithm,
            closeHoles,
        });
    }

    private _getHolesToggleId(): string {
        return `${this._getId()}-holes-toggle`;
    }

    private _getHolesBoxId(): string {
        return `${this._getId()}-holes-box`;
    }

    private _getHolesPipId(): string {
        return `${this._getId()}-holes-pip`;
    }

    private _getHolesTextId(): string {
        return `${this._getId()}-holes-label`;
    }

    public override registerEvents(): void {
        const selectElement = this._getElement() as HTMLSelectElement;
        selectElement.addEventListener('mouseenter', () => {
            this._setHovered(true);
            this._updateStyles();
        });
        selectElement.addEventListener('mouseleave', () => {
            this._setHovered(false);
            this._updateStyles();
        });
        selectElement.addEventListener('change', () => {
            const item = ROTATION_ALGORITHM_ITEMS[selectElement.selectedIndex];
            if (item) {
                const cur = this.getValue();
                this._setValue({
                    algorithm: item.payload,
                    closeHoles: cur.closeHoles,
                });
            }
        });

        const holesToggle = document.getElementById(this._getHolesToggleId());
        if (holesToggle) {
            holesToggle.addEventListener('mouseenter', () => {
                this._holesHovered = true;
                this._updateStyles();
            });
            holesToggle.addEventListener('mouseleave', () => {
                this._holesHovered = false;
                this._updateStyles();
            });
            holesToggle.addEventListener('click', () => {
                if (this.enabled) {
                    const cur = this.getValue();
                    this._setValue({
                        algorithm: cur.algorithm,
                        closeHoles: !cur.closeHoles,
                    });
                }
            });
        }
    }

    public override _generateInnerHTML(): string {
        const optionsHTML = ROTATION_ALGORITHM_ITEMS.map((item, index) => (
            `<option id="${this._getId()}-${index}" value="${item.payload}">${LOC(item.displayLocKey)}</option>`
        )).join('');

        return `
            <div class="voxel-post-algo-row">
                <div class="voxel-post-algo-select-wrap">
                    <select class="struct-prop" name="${this._getId()}" id="${this._getId()}">
                        ${optionsHTML}
                    </select>
                    <div id="${this._getId()}-arrow" class="checkbox-arrow">
                        ${AppIcons.ARROW_DOWN}
                    </div>
                </div>
                <div
                    class="voxel-post-holes-toggle"
                    id="${this._getHolesToggleId()}"
                    title="${LOC('voxel_post.components.close_holes_tooltip')}"
                >
                    <div class="struct-prop container-checkbox" id="${this._getHolesBoxId()}">
                        <svg id="${this._getHolesPipId()}" width="44" height="44" viewBox="0 0 24 24" stroke-width="1.5" stroke="#2c3e50" fill="none" stroke-linecap="round" stroke-linejoin="round">
                            <path stroke="none" d="M0 0h24v24H0z" fill="none"/>
                            <path d="M5 12l5 5l10 -10" />
                        </svg>
                    </div>
                    <div class="checkbox-text voxel-post-holes-label" id="${this._getHolesTextId()}">${LOC('voxel_post.components.close_holes')}</div>
                </div>
            </div>
        `;
    }

    protected override _onValueChanged(): void {
        super._onValueChanged();
        this._syncSelectFromValue();
        this._updateStyles();
    }

    protected override _onEnabledChanged(): void {
        super._onEnabledChanged();
        const selectEl = document.getElementById(this._getId()) as HTMLSelectElement | null;
        if (selectEl) {
            selectEl.disabled = this.disabled;
        }
        this._updateStyles();
    }

    private _syncSelectFromValue(): void {
        const selectEl = document.getElementById(this._getId()) as HTMLSelectElement | null;
        if (!selectEl) {
            return;
        }
        const curAlgo = this.getValue().algorithm;
        const selectedIndex = ROTATION_ALGORITHM_ITEMS.findIndex((item) => item.payload === curAlgo);
        if (selectedIndex >= 0) {
            selectEl.selectedIndex = selectedIndex;
        }
    }

    protected override _updateStyles(): void {
        const selectEl = document.getElementById(this._getId());
        if (selectEl) {
            UIUtil.updateStyles(selectEl, {
                isHovered: this.hovered,
                isEnabled: this.enabled,
                isActive: false,
            });
        }

        const arrowElement = document.getElementById(`${this._getId()}-arrow`);
        if (arrowElement) {
            arrowElement.classList.remove('text-dark', 'text-standard', 'text-light');
            if (this.enabled) {
                arrowElement.classList.add(this.hovered ? 'text-light' : 'text-standard');
            } else {
                arrowElement.classList.add('text-dark');
            }
        }

        const closeHoles = this.getValue().closeHoles;
        const holesBox = document.getElementById(this._getHolesBoxId());
        if (holesBox) {
            UIUtil.updateStyles(holesBox, {
                isEnabled: this.enabled,
                isHovered: this._holesHovered,
                isActive: closeHoles,
            });
        }

        const holesPip = document.getElementById(this._getHolesPipId());
        if (holesPip) {
            holesPip.style.visibility = closeHoles ? 'visible' : 'hidden';
        }

        const holesText = document.getElementById(this._getHolesTextId());
        if (holesText) {
            holesText.classList.remove('text-dark', 'text-standard', 'text-light');
            if (this.enabled) {
                holesText.classList.add(this._holesHovered ? 'text-light' : 'text-standard');
            } else {
                holesText.classList.add('text-dark');
            }
        }

        const holesToggle = document.getElementById(this._getHolesToggleId());
        if (holesToggle) {
            holesToggle.classList.toggle('is-disabled', !this.enabled);
        }
    }

    public override finalise(): void {
        super.finalise();
        this._syncSelectFromValue();
        this._updateStyles();
    }

    public override refresh(): void {
        super.refresh();

        ROTATION_ALGORITHM_ITEMS.forEach((item, index) => {
            const optionEl = document.getElementById(`${this._getId()}-${index}`) as HTMLOptionElement | null;
            if (optionEl) {
                optionEl.text = LOC(item.displayLocKey);
            }
        });

        const holesText = document.getElementById(this._getHolesTextId());
        if (holesText) {
            holesText.textContent = LOC('voxel_post.components.close_holes');
        }
        const holesToggle = document.getElementById(this._getHolesToggleId());
        if (holesToggle) {
            holesToggle.setAttribute('title', LOC('voxel_post.components.close_holes_tooltip'));
        }
    }
}
