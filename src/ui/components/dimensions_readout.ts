import { EstimatedDimensions } from '../../dimension_estimator';
import { LOC } from '../../localiser';
import { ConfigComponent } from './config';

export class DimensionsReadoutComponent extends ConfigComponent<EstimatedDimensions | null, HTMLDivElement> {
    private _isExact = false;

    public constructor() {
        super(null);
    }

    public setDimensions(dims: EstimatedDimensions | null, isExact: boolean) {
        this._isExact = isExact;
        this._setValue(dims);
    }

    public override refresh(): void {
        super.refresh();
        this._updateReadoutDOM();
    }

    protected override _generateInnerHTML(): string {
        return `
            <div class="dimensions-readout-box" id="${this._getId()}-box">
                <span class="dimensions-readout-value" id="${this._getId()}-value">${this._formatDimsText()}</span>
                <span class="dimensions-readout-tag" id="${this._getId()}-tag">${this._formatTagText()}</span>
            </div>
        `;
    }

    public override registerEvents(): void {
    }

    private _formatDimsText(): string {
        const dims = this.getValue();
        if (!dims) {
            return LOC('voxelise.components.dimensions_empty') || '— × — × —';
        }
        return `${dims.x} × ${dims.y} × ${dims.z}`;
    }

    private _formatTagText(): string {
        const dims = this.getValue();
        if (!dims) {
            return '';
        }
        return this._isExact ?
            (LOC('voxelise.components.dimensions_exact') || 'exact') :
            (LOC('voxelise.components.dimensions_estimated') || 'est.');
    }

    private _updateReadoutDOM(): void {
        if (typeof document === 'undefined') {
            return;
        }
        const valueEl = document.getElementById(`${this._getId()}-value`);
        const tagEl = document.getElementById(`${this._getId()}-tag`);
        const boxEl = document.getElementById(`${this._getId()}-box`);
        if (valueEl) {
            valueEl.textContent = this._formatDimsText();
        }
        if (tagEl) {
            tagEl.textContent = this._formatTagText();
        }
        if (boxEl) {
            boxEl.classList.toggle('is-exact', this._isExact && this.getValue() !== null);
            boxEl.classList.toggle('disabled', !this.enabled);
        }
    }

    protected override _onValueChanged(): void {
        this._updateReadoutDOM();
    }

    protected override _onEnabledChanged(): void {
        super._onEnabledChanged();
        this._updateReadoutDOM();
    }
}
