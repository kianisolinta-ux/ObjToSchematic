import { UIUtil } from '../../util/ui_util';
import { ConfigComponent } from './config';

export class TextInputComponent extends ConfigComponent<string, HTMLInputElement> {
    private _placeholder: string;
    private _maxLength: number;

    public constructor(defaultValue = '', placeholder = '', maxLength = 64) {
        super();
        this._setValue(defaultValue);
        this._placeholder = placeholder;
        this._maxLength = maxLength;
    }

    public setPlaceholder(placeholder: string) {
        this._placeholder = placeholder;
        return this;
    }

    public setValue(value: string) {
        this._setValue(value);
        if (typeof document !== 'undefined') {
            const el = document.getElementById(this._getId()) as HTMLInputElement | null;
            if (el) {
                el.value = value;
            }
        }
        return this;
    }

    protected override _generateInnerHTML(): string {
        const escapedVal = this._escapeAttr(this.getValue() ?? '');
        const escapedPlaceholder = this._escapeAttr(this._placeholder);
        return `
            <input
                type="text"
                class="struct-prop text-input-field"
                id="${this._getId()}"
                value="${escapedVal}"
                placeholder="${escapedPlaceholder}"
                maxlength="${this._maxLength}"
                ${this.enabled ? '' : 'disabled'}
            />
        `;
    }

    private _escapeAttr(text: string): string {
        return text
            .replace(/&/g, '&amp;')
            .replace(/"/g, '&quot;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    public override registerEvents(): void {
        const el = UIUtil.getElementById(this._getId()) as HTMLInputElement;
        el.addEventListener('input', () => {
            this._setValue(el.value);
            this._onValueChanged();
        });
        el.addEventListener('mouseenter', () => {
            this._setHovered(true);
            this._updateStyles();
        });
        el.addEventListener('mouseleave', () => {
            this._setHovered(false);
            this._updateStyles();
        });
    }

    public override finalise(): void {
        this._updateStyles();
    }

    protected override _onEnabledChanged(): void {
        super._onEnabledChanged();
        const el = document.getElementById(this._getId()) as HTMLInputElement | null;
        if (el) {
            el.disabled = !this.enabled;
        }
        this._updateStyles();
    }

    protected override _updateStyles(): void {
        const el = document.getElementById(this._getId());
        if (el) {
            UIUtil.updateStyles(el, {
                isActive: false,
                isEnabled: this.enabled,
                isHovered: this.hovered,
            });
        }
    }
}
