import { clamp } from '../../math';
import { UIUtil } from '../../util/ui_util';
import { ConfigComponent } from './config';

export type TSliderParams = {
    min: number,
    max: number,
    value: number,
    decimals: number,
    step: number,
}

export class SliderComponent extends ConfigComponent<number, HTMLDivElement> {
    private _min: number;
    private _max: number;
    private _decimals: number;
    private _step: number;
    private _dragging: boolean;
    private _internalValue: number;
    private _valueHovered: boolean;
    private _thumbStyle: boolean;
    private _commitTypedValueOnBlur: boolean;
    private _cleanup?: () => void;

    public constructor() {
        super();
        this._min = 0;
        this._max = 1;
        this._decimals = 1;
        this._step = 0.1;
        this._internalValue = 0.5;
        this._dragging = false;
        this._valueHovered = false;
        this._thumbStyle = false;
        this._commitTypedValueOnBlur = false;
    }

    public setValue(value: number) {
        this._setValue(value);
    }

    public setThumbStyle(enabled: boolean = true) {
        this._thumbStyle = enabled;
        return this;
    }

    /**
     * Allow temporary out-of-range/empty typed values and validate them on blur.
     */
    public setCommitTypedValueOnBlur(enabled: boolean = true) {
        this._commitTypedValueOnBlur = enabled;
        return this;
    }

    public override setDefaultValue(value: number) {
        super.setDefaultValue(value);
        this._internalValue = value;
        return this;
    }

    /**
     * Set the minimum value the slider can be set to.
     */
    public setMin(min: number) {
        this._min = min;
        if (this.hasValue()) {
            if (this.getValue() < this._min) {
                this.setValue(this._min);
            } else {
                this._onValueChanged();
            }
        }
        const valInput = document.getElementById(this._getSliderValueId()) as HTMLInputElement | null;
        if (valInput) {
            valInput.min = this._min.toString();
        }
        return this;
    }

    /**
     * Set the maximum value the slider can be set to.
     */
    public setMax(max: number) {
        this._max = max;
        if (this.hasValue()) {
            if (this.getValue() > this._max) {
                this.setValue(this._max);
            } else {
                this._onValueChanged();
            }
        }
        const valInput = document.getElementById(this._getSliderValueId()) as HTMLInputElement | null;
        if (valInput) {
            valInput.max = this._max.toString();
        }
        return this;
    }

    /**
     * Set the number of decimals to display the value to.
     */
    public setDecimals(decimals: number) {
        this._decimals = decimals;
        return this;
    }

    /**
     * Set the step the value is increased/decreased by.
     */
    public setStep(step: number) {
        this._step = step;
        return this;
    }

    public override registerEvents() {
        this._cleanup?.();

        const element = this._getElement();
        const elementValue = UIUtil.getElementById(this._getSliderValueId()) as HTMLInputElement;

        const onMouseEnter = () => {
            this._setHovered(true);
            this._updateStyles();
        };

        const onMouseLeave = () => {
            this._setHovered(false);
            this._updateStyles();
        };

        const onPointerDown = (e: PointerEvent) => {
            if (e.button !== 0 || !this.getEnabled()) {
                return;
            }
            e.preventDefault();
            this._dragging = true;
            try {
                element.setPointerCapture(e.pointerId);
            } catch (_) {}
            this._onDragSlider(e.clientX);
        };

        const onPointerMove = (e: PointerEvent) => {
            if (this._dragging) {
                e.preventDefault();
                this._onDragSlider(e.clientX);
            }
        };

        const onPointerUp = (e: PointerEvent) => {
            if (this._dragging) {
                e.preventDefault();
                this._onDragSlider(e.clientX);
                this._dragging = false;
                try {
                    if (element.hasPointerCapture(e.pointerId)) {
                        element.releasePointerCapture(e.pointerId);
                    }
                } catch (_) {}
            }
        };

        const onPointerCancel = (e: PointerEvent) => {
            if (this._dragging) {
                this._dragging = false;
                try {
                    if (element.hasPointerCapture(e.pointerId)) {
                        element.releasePointerCapture(e.pointerId);
                    }
                } catch (_) {}
            }
        };

        const onWindowPointerUp = () => {
            if (this._dragging) {
                this._dragging = false;
            }
        };

        const onWheel = (e: WheelEvent) => {
            if (!this._dragging && this.getEnabled()) {
                e.preventDefault();
                this._onScrollSlider(e);
            }
        };

        const onTypedValue = () => {
            this._onTypedValue();
        };

        const onTypedValueCommit = () => {
            this._commitTypedValue();
        };

        const onValueMouseEnter = () => {
            this._valueHovered = true;
            this._updateStyles();
        };

        const onValueMouseLeave = () => {
            this._valueHovered = false;
            this._updateStyles();
        };

        element.addEventListener('mouseenter', onMouseEnter);
        element.addEventListener('mouseleave', onMouseLeave);
        element.addEventListener('pointerdown', onPointerDown);
        element.addEventListener('pointermove', onPointerMove);
        element.addEventListener('pointerup', onPointerUp);
        element.addEventListener('pointercancel', onPointerCancel);
        element.addEventListener('wheel', onWheel, { passive: false });
        window.addEventListener('pointerup', onWindowPointerUp);

        elementValue.addEventListener('input', onTypedValue);
        if (this._commitTypedValueOnBlur) {
            elementValue.addEventListener('change', onTypedValueCommit);
            elementValue.addEventListener('blur', onTypedValueCommit);
        } else {
            elementValue.addEventListener('change', onTypedValue);
        }
        elementValue.addEventListener('mouseenter', onValueMouseEnter);
        elementValue.addEventListener('mouseleave', onValueMouseLeave);

        this._cleanup = () => {
            element.removeEventListener('mouseenter', onMouseEnter);
            element.removeEventListener('mouseleave', onMouseLeave);
            element.removeEventListener('pointerdown', onPointerDown);
            element.removeEventListener('pointermove', onPointerMove);
            element.removeEventListener('pointerup', onPointerUp);
            element.removeEventListener('pointercancel', onPointerCancel);
            element.removeEventListener('wheel', onWheel);
            window.removeEventListener('pointerup', onWindowPointerUp);

            elementValue.removeEventListener('input', onTypedValue);
            if (this._commitTypedValueOnBlur) {
                elementValue.removeEventListener('change', onTypedValueCommit);
                elementValue.removeEventListener('blur', onTypedValueCommit);
            } else {
                elementValue.removeEventListener('change', onTypedValue);
            }
            elementValue.removeEventListener('mouseenter', onValueMouseEnter);
            elementValue.removeEventListener('mouseleave', onValueMouseLeave);
        };
    }

    public override _generateInnerHTML() {
        const val = this.hasValue() ? this.getValue() : this._internalValue;
        const range = this._max - this._min;
        const norm = range > 0 ? clamp((val - this._min) / range, 0.0, 1.0) : 0.0;

        if (this._thumbStyle) {
            const thumbLeft = `calc(${norm * 100}% - ${norm * 16}px + 8px)`;
            return `
                <input class="struct-prop comp-slider-value" type="number" style="display: none;" id="${this._getSliderValueId()}" min="${this._min}" max="${this._max}" step="${this._step}" value="${val.toFixed(this._decimals)}">
                <div class="struct-prop comp-slider comp-slider-outer comp-slider-thumb-outer" id="${this._getId()}">
                    <div class="comp-slider-track"></div>
                    <div class="comp-slider-thumb" id="${this._getSliderBarId()}" style="left: ${thumbLeft}"></div>
                </div>
            `;
        }

        return `
            <input class="struct-prop comp-slider-value" type="number" id="${this._getSliderValueId()}" min="${this._min}" max="${this._max}" step="${this._step}" value="${val.toFixed(this._decimals)}">
            <div class="struct-prop comp-slider comp-slider-outer" id="${this._getId()}">
                <div class="struct-prop comp-slider comp-slider-inner" id="${this._getSliderBarId()}" style="width: ${norm * 100}%">
                </div>
            </div>
        `;
    }

    protected override _onEnabledChanged() {
        super._onEnabledChanged();

        const elementValue = UIUtil.getElementById(this._getSliderValueId()) as HTMLInputElement;
        elementValue.disabled = this.disabled;

        const elementBar = UIUtil.getElementById(this._getSliderBarId());
        const elementSlider = UIUtil.getElementById(this._getId());
        if (this.enabled) {
            elementBar.classList.add('enabled');
            elementSlider.classList.add('enabled');
        } else {
            elementBar.classList.remove('enabled');
            elementSlider.classList.remove('enabled');
        }

        this._updateStyles();
    }

    protected override _onValueChanged(): void {
        if (!this.hasValue()) {
            return;
        }

        const range = this._max - this._min;
        const percentage = range > 0 ? clamp((this.getValue() - this._min) / range, 0.0, 1.0) : 0.0;

        const bar = document.getElementById(this._getSliderBarId());
        if (bar) {
            if (this._thumbStyle) {
                bar.style.left = `calc(${percentage * 100}% - ${percentage * 16}px + 8px)`;
            } else {
                bar.style.width = `${percentage * 100}%`;
            }
        }
        const valInput = document.getElementById(this._getSliderValueId()) as HTMLInputElement | null;
        if (valInput) {
            valInput.value = this.getValue().toFixed(this._decimals);
        }
    }

    private _onScrollSlider(e: WheelEvent) {
        if (!this.getEnabled()) {
            return;
        }

        const dir = e.deltaY < 0 ? 1 : -1;
        const step = this._step > 0 ? this._step : Math.pow(10, -this._decimals);
        let rawVal = this._internalValue + dir * step;
        if (this._step > 0) {
            const numSteps = Math.round((rawVal - this._min) / this._step);
            rawVal = this._min + numSteps * this._step;
        }
        this._internalValue = clamp(rawVal, this._min, this._max);

        this._onInternalValueUpdated();
    }

    /**
     * Calculates the accurate visual bounding rectangle in viewport coordinates,
     * accounting for CSS zoom discrepancies between Chromium versions (such as Electron).
     */
    private _getVisualRect(): { left: number, width: number } {
        const element = this._getElement();
        const box = element.getBoundingClientRect();
        const width = box.width || element.offsetWidth || 1;
        const left = box.left !== undefined ? box.left : box.x;

        // In Chromium < 128 (e.g. Electron 28 used in compiled builds),
        // CSS zoom on ancestor elements causes getBoundingClientRect() to return
        // unzoomed layout coordinates, while mouse event clientX is in viewport CSS pixels.
        const container = element.closest('.container-properties') as HTMLElement | null;
        const zoom = container ? (parseFloat(container.style.zoom) || 1) : 1;

        if (zoom !== 1 && element.offsetWidth > 0) {
            const scaledWidth = element.offsetWidth * zoom;
            // In Chromium >= 128, box.width is already scaled (matches scaledWidth).
            // In Chromium < 128 (compiled Electron app), box.width is unscaled (matches offsetWidth).
            const isAlreadyScaled = Math.abs(box.width - scaledWidth) < Math.abs(box.width - element.offsetWidth);
            if (!isAlreadyScaled) {
                const scrollCol = element.closest('.column-properties') as HTMLElement | null;
                const colLeft = scrollCol ? scrollCol.getBoundingClientRect().left : 0;
                const unzoomedOffset = left - colLeft;
                const visualLeft = colLeft + unzoomedOffset * zoom;
                const visualWidth = width * zoom;
                return { left: visualLeft, width: Math.max(1, visualWidth) };
            }
        }

        return { left, width: Math.max(1, width) };
    }

    private _onDragSlider(clientX: number) {
        if (!this.getEnabled()) {
            return;
        }

        const rect = this._getVisualRect();
        const inset = this._thumbStyle ? 8 : 0;
        const usableWidth = Math.max(1, rect.width - inset * 2);
        const norm = clamp((clientX - rect.left - inset) / usableWidth, 0.0, 1.0);
        let rawVal = this._min + norm * (this._max - this._min);

        if (this._step > 0) {
            const numSteps = Math.round((rawVal - this._min) / this._step);
            rawVal = this._min + numSteps * this._step;
        }

        this._internalValue = clamp(rawVal, this._min, this._max);
        this._onInternalValueUpdated();
    }

    private _onTypedValue() {
        const elementValue = UIUtil.getElementById(this._getSliderValueId()) as HTMLInputElement;
        const rawValue = elementValue.value.trim();

        if (this._commitTypedValueOnBlur) {
            // Keep the field editable while the user is clearing or replacing its value.
            if (rawValue.length === 0) {
                return;
            }

            const typedNumber = Number(rawValue);
            if (!Number.isFinite(typedNumber)) {
                return;
            }

            this._internalValue = typedNumber;
            this._setValue(parseFloat(typedNumber.toFixed(this._decimals)));
            return;
        }

        const typedNumber = parseFloat(rawValue);
        if (!isNaN(typedNumber)) {
            this._internalValue = clamp(typedNumber, this._min, this._max);
        }
        this._onInternalValueUpdated();
    }

    private _commitTypedValue() {
        if (!this._commitTypedValueOnBlur) {
            return;
        }

        const elementValue = UIUtil.getElementById(this._getSliderValueId()) as HTMLInputElement;
        const rawValue = elementValue.value.trim();
        const typedNumber = rawValue.length > 0 ? Number(rawValue) : NaN;
        const roundedValue = Number.isFinite(typedNumber)
            ? parseFloat(typedNumber.toFixed(this._decimals))
            : NaN;

        this._internalValue = Number.isFinite(roundedValue) && roundedValue >= this._min
            ? clamp(roundedValue, this._min, this._max)
            : this._min;
        this._onInternalValueUpdated();
    }

    private _onInternalValueUpdated() {
        const displayString = this._internalValue.toFixed(this._decimals);
        this._setValue(parseFloat(displayString));
    }

    /**
     * Gets the ID of the DOM element for the slider's value.
     */
    private _getSliderValueId() {
        return this._getId() + '-value';
    }

    /**
     * Gets the ID of the DOM element for the slider's bar.
     */
    private _getSliderBarId() {
        return this._getId() + '-bar';
    }

    protected override _updateStyles(): void {
        const elementValue = UIUtil.getElementById(this._getSliderValueId()) as HTMLInputElement;
        UIUtil.updateStyles(elementValue, {
            isHovered: this._valueHovered,
            isActive: false,
            isEnabled: this.enabled,
        });

        const elementBar = UIUtil.getElementById(this._getSliderBarId()) as HTMLInputElement;
        UIUtil.updateStyles(elementBar, {
            isHovered: this.hovered,
            isActive: true,
            isEnabled: this.enabled,
        });

        const elementSlider = UIUtil.getElementById(this._getId()) as HTMLInputElement;
        UIUtil.updateStyles(elementSlider, {
            isHovered: this.hovered,
            isActive: false,
            isEnabled: this.enabled,
        });
    }
}
