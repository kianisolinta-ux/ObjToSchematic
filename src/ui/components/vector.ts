import { TAxis } from '../../util/type_util';
import { UIUtil } from '../../util/ui_util';
import { Vector3 } from '../../vector';
import { ConfigComponent } from './config';

export class VectorComponent extends ConfigComponent<Vector3, HTMLDivElement> {
    private _mouseover: TAxis | null;
    private _showY: boolean;
    private _onMouseEnterExit?: (state: 'enter' | 'exit', component: TAxis) => void;

    public constructor() {
        super(new Vector3(0, 0, 0));
        this._mouseover = null;
        this._showY = true;
    }

    /**
     * Set whether or not the Y axis has a UI element
     */
    public setShowY(showY: boolean) {
        this._showY = showY;
        return this;
    }

    protected override _generateInnerHTML() {
        let html = '<div class="spinbox-main-container">';
        html += `
            <div class="spinbox-element-container">
                <div class="spinbox-key" id="${this._getKeyId('x')}">X</div>
                <input type="number" step="any" class="spinbox-value struct-prop" min="-360" max="360" value="${this.getValue().x}" id="${this._getValueId('x')}"></input>
            </div>
        `;
        if (this._showY) {
            html += `
                <div class="spinbox-element-container">
                    <div class="spinbox-key" id="${this._getKeyId('y')}">Y</div>
                    <input type="number" step="any" class="spinbox-value struct-prop" min="-360" max="360" value="${this.getValue().y}" id="${this._getValueId('y')}"></input>
                </div>
            `;
        }
        html += `
            <div class="spinbox-element-container">
                <div class="spinbox-key" id="${this._getKeyId('z')}">Z</div>
                <input type="number" step="any" class="spinbox-value struct-prop" min="-360" max="360" value="${this.getValue().z}" id="${this._getValueId('z')}"></input>
            </div>
        `;
        html += '</div>';
        return html;
    }

    private _getKeyId(axis: TAxis) {
        return this._getId() + '-k' + axis;
    }

    private _getValueId(axis: TAxis) {
        return this._getId() + '-v' + axis;
    }

    private _registerAxis(axis: TAxis) {
        const elementValue = UIUtil.getElementById(this._getValueId(axis)) as HTMLInputElement;

        elementValue.onmouseenter = () => {
            this._mouseover = axis;
            this._updateStyles();
            this._onMouseEnterExit?.('enter', axis);
        };

        elementValue.onmouseleave = () => {
            this._mouseover = null;
            this._updateStyles();
            this._onMouseEnterExit?.('exit', axis);
        };

        elementValue.addEventListener('input', () => {
            const parsed = parseFloat(elementValue.value);
            if (Number.isFinite(parsed)) {
                const clamped = Math.max(-360, Math.min(360, parsed));
                const next = this.getValue().copy();
                next[axis] = clamped;
                this._setValue(next);
            }
        });

        elementValue.addEventListener('change', () => {
            const parsed = parseFloat(elementValue.value);
            if (Number.isFinite(parsed)) {
                const clamped = Math.max(-360, Math.min(360, Math.round(parsed * 1000) / 1000));
                const next = this.getValue().copy();
                next[axis] = clamped;
                elementValue.value = String(clamped);
                this._setValue(next);
            } else {
                elementValue.value = String(this.getValue()[axis]);
            }
        });
    }

    public registerEvents() {
        this._registerAxis('x');
        if (this._showY) {
            this._registerAxis('y');
        }
        this._registerAxis('z');
    }

    public setOnMouseEnterExit(delegate: (state: 'enter' | 'exit', component: TAxis) => void) {
        this._onMouseEnterExit = delegate;
        return this;
    }

    protected override _updateStyles(): void {
        if (typeof document === 'undefined') {
            return;
        }
        const axes: TAxis[] = this._showY ? ['x', 'y', 'z'] : ['x', 'z'];
        for (const axis of axes) {
            const keyEl = document.getElementById(this._getKeyId(axis));
            if (keyEl) {
                keyEl.classList.remove('text-standard', 'text-dark');
                keyEl.classList.add(this.enabled ? 'text-standard' : 'text-dark');
            }
            const valEl = document.getElementById(this._getValueId(axis)) as HTMLInputElement | null;
            if (valEl) {
                valEl.disabled = !this.enabled;
                UIUtil.updateStyles(valEl, {
                    isActive: false,
                    isEnabled: this.enabled,
                    isHovered: this._mouseover === axis,
                });
            }
        }
    }

    protected override _onEnabledChanged() {
        super._onEnabledChanged();
        this._updateStyles();
    }

    public setValue(value: Vector3) {
        this._setValue(value.copy());
        return this;
    }

    protected override _onValueChanged(): void {
        if (typeof document !== 'undefined') {
            const axes: TAxis[] = this._showY ? ['x', 'y', 'z'] : ['x', 'z'];
            for (const axis of axes) {
                const input = document.getElementById(this._getValueId(axis)) as HTMLInputElement | null;
                if (input && document.activeElement !== input) {
                    input.value = String(this.getValue()[axis]);
                }
            }
        }
        this._updateStyles();
    }
}
