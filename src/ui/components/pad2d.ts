import { LOC } from '../../localiser';
import { UIUtil } from '../../util/ui_util';
import { ConfigComponent } from './config';

export interface Point2D {
    x: number;
    y: number;
}

/**
 * Interactive 2D pad controller for tone threshold and curvature.
 * Allows moving freely in 2 dimensions:
 * - X: Dark/Light tone bias (-100 to +100)
 * - Y: Contrast / midtone spread curve (-100 to +100)
 */
export class Pad2DComponent extends ConfigComponent<Point2D, HTMLDivElement> {
    private _isDragging: boolean;

    public constructor() {
        super({ x: 0, y: 0 });
        this._isDragging = false;
    }

    protected override _generateInnerHTML(): string {
        return `
            <div class="pad2d-container" id="${this._getId()}">
                <div class="pad2d-header">
                    <span class="pad2d-readout" id="${this._getId()}-readout">X: 0, Y: 0</span>
                    <button type="button" class="pad2d-reset-btn" id="${this._getId()}-reset" title="${LOC('assign.components.dichrome_pad_reset')}">
                        ${LOC('assign.components.dichrome_pad_reset')}
                    </button>
                </div>
                <div
                    class="pad2d-area"
                    id="${this._getId()}-area"
                    tabindex="0"
                    role="slider"
                    aria-label="2D Tone Pad"
                    aria-valuemin="-100"
                    aria-valuemax="100"
                >
                    <div class="pad2d-crosshair-x"></div>
                    <div class="pad2d-crosshair-y"></div>
                    <div class="pad2d-quadrant-label pad2d-label-top" id="${this._getId()}-label-top">${LOC('assign.components.dichrome_pad_top')}</div>
                    <div class="pad2d-quadrant-label pad2d-label-bottom" id="${this._getId()}-label-bottom">${LOC('assign.components.dichrome_pad_bottom')}</div>
                    <div class="pad2d-quadrant-label pad2d-label-left" id="${this._getId()}-label-left">${LOC('assign.components.dichrome_pad_left')}</div>
                    <div class="pad2d-quadrant-label pad2d-label-right" id="${this._getId()}-label-right">${LOC('assign.components.dichrome_pad_right')}</div>
                    <div class="pad2d-handle" id="${this._getId()}-handle"></div>
                </div>
                <div class="pad2d-inputs">
                    <div class="pad2d-input-group">
                        <span class="pad2d-input-label">X:</span>
                        <input
                            type="number"
                            class="struct-prop pad2d-input"
                            id="${this._getId()}-input-x"
                            min="-100"
                            max="100"
                            value="${this.getValue().x}"
                        >
                    </div>
                    <div class="pad2d-input-group">
                        <span class="pad2d-input-label">Y:</span>
                        <input
                            type="number"
                            class="struct-prop pad2d-input"
                            id="${this._getId()}-input-y"
                            min="-100"
                            max="100"
                            value="${this.getValue().y}"
                        >
                    </div>
                </div>
            </div>
        `;
    }

    private _updateUI(): void {
        const val = this.getValue();
        const handle = document.getElementById(this._getId() + '-handle');
        const readout = document.getElementById(this._getId() + '-readout');
        const inputX = document.getElementById(this._getId() + '-input-x') as HTMLInputElement | null;
        const inputY = document.getElementById(this._getId() + '-input-y') as HTMLInputElement | null;
        const resetBtn = document.getElementById(this._getId() + '-reset') as HTMLButtonElement | null;
        const area = document.getElementById(this._getId() + '-area');

        if (handle) {
            const leftPercent = Math.max(0, Math.min(100, (val.x + 100) / 2));
            const topPercent = Math.max(0, Math.min(100, (100 - val.y) / 2));
            handle.style.left = `${leftPercent}%`;
            handle.style.top = `${topPercent}%`;
        }
        if (readout) {
            const signX = val.x > 0 ? '+' : '';
            const signY = val.y > 0 ? '+' : '';
            readout.textContent = `X: ${signX}${val.x}, Y: ${signY}${val.y}`;
        }
        if (inputX && document.activeElement !== inputX) {
            inputX.value = String(val.x);
            inputX.disabled = this.disabled;
        }
        if (inputY && document.activeElement !== inputY) {
            inputY.value = String(val.y);
            inputY.disabled = this.disabled;
        }
        if (resetBtn) {
            resetBtn.disabled = this.disabled;
        }
        if (area) {
            area.setAttribute('aria-valuenow', `${val.x},${val.y}`);
        }
    }

    private _setFromPointer(clientX: number, clientY: number): void {
        if (this.disabled) return;
        const area = document.getElementById(this._getId() + '-area');
        if (!area) return;

        const rect = area.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return;

        const clampU = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
        const clampV = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));

        const newX = Math.round((clampU - 0.5) * 200);
        const newY = Math.round((0.5 - clampV) * 200);

        this._setValue({ x: newX, y: newY });
    }

    public override registerEvents(): void {
        const area = UIUtil.getElementById(this._getId() + '-area') as HTMLDivElement;
        const resetBtn = UIUtil.getElementById(this._getId() + '-reset') as HTMLButtonElement;
        const inputX = UIUtil.getElementById(this._getId() + '-input-x') as HTMLInputElement;
        const inputY = UIUtil.getElementById(this._getId() + '-input-y') as HTMLInputElement;

        area.addEventListener('mousedown', (e: MouseEvent) => {
            if (this.disabled) return;
            this._isDragging = true;
            this._setFromPointer(e.clientX, e.clientY);
            area.focus();
            e.preventDefault();
        });

        window.addEventListener('mousemove', (e: MouseEvent) => {
            if (this._isDragging) {
                this._setFromPointer(e.clientX, e.clientY);
            }
        });

        window.addEventListener('mouseup', () => {
            this._isDragging = false;
        });

        area.addEventListener('touchstart', (e: TouchEvent) => {
            if (this.disabled) return;
            if (e.touches.length > 0) {
                this._isDragging = true;
                this._setFromPointer(e.touches[0].clientX, e.touches[0].clientY);
                e.preventDefault();
            }
        }, { passive: false });

        window.addEventListener('touchmove', (e: TouchEvent) => {
            if (this._isDragging && e.touches.length > 0) {
                this._setFromPointer(e.touches[0].clientX, e.touches[0].clientY);
                e.preventDefault();
            }
        }, { passive: false });

        window.addEventListener('touchend', () => {
            this._isDragging = false;
        });

        area.addEventListener('dblclick', () => {
            if (!this.disabled) {
                this._setValue({ x: 0, y: 0 });
            }
        });

        resetBtn.addEventListener('click', () => {
            if (!this.disabled) {
                this._setValue({ x: 0, y: 0 });
            }
        });

        const handleInput = (input: HTMLInputElement, axis: 'x' | 'y') => {
            let val = parseInt(input.value, 10);
            if (isNaN(val)) val = 0;
            val = Math.max(-100, Math.min(100, val));
            const current = this.getValue();
            if (axis === 'x') {
                this._setValue({ x: val, y: current.y });
            } else {
                this._setValue({ x: current.x, y: val });
            }
        };

        inputX.addEventListener('change', () => handleInput(inputX, 'x'));
        inputY.addEventListener('change', () => handleInput(inputY, 'y'));

        // Keyboard arrows on area
        area.addEventListener('keydown', (e: KeyboardEvent) => {
            if (this.disabled) return;
            const step = e.shiftKey ? 5 : 1;
            const current = this.getValue();
            let newX = current.x;
            let newY = current.y;

            if (e.key === 'ArrowLeft') {
                newX = Math.max(-100, current.x - step);
                e.preventDefault();
            } else if (e.key === 'ArrowRight') {
                newX = Math.min(100, current.x + step);
                e.preventDefault();
            } else if (e.key === 'ArrowUp') {
                newY = Math.min(100, current.y + step);
                e.preventDefault();
            } else if (e.key === 'ArrowDown') {
                newY = Math.max(-100, current.y - step);
                e.preventDefault();
            } else if (e.key === 'Home') {
                newX = 0;
                newY = 0;
                e.preventDefault();
            }

            if (newX !== current.x || newY !== current.y) {
                this._setValue({ x: newX, y: newY });
            }
        });

        this._updateUI();
    }

    protected override _onValueChanged(): void {
        this._updateUI();
    }

    protected override _onEnabledChanged(): void {
        super._onEnabledChanged();
        const area = document.getElementById(this._getId() + '-area');
        if (area) {
            area.classList.toggle('disabled', this.disabled);
        }
        this._updateUI();
        this._updateStyles();
    }

    protected override _updateStyles(): void {
        const area = document.getElementById(this._getId() + '-area');
        if (area) {
            UIUtil.updateStyles(area, {
                isHovered: this.hovered,
                isEnabled: this.enabled,
                isActive: false,
            });
        }
    }

    public override refresh(): void {
        super.refresh();
        const resetBtn = document.getElementById(this._getId() + '-reset');
        const labelTop = document.getElementById(this._getId() + '-label-top');
        const labelBottom = document.getElementById(this._getId() + '-label-bottom');
        const labelLeft = document.getElementById(this._getId() + '-label-left');
        const labelRight = document.getElementById(this._getId() + '-label-right');

        if (resetBtn) resetBtn.textContent = LOC('assign.components.dichrome_pad_reset');
        if (labelTop) labelTop.textContent = LOC('assign.components.dichrome_pad_top');
        if (labelBottom) labelBottom.textContent = LOC('assign.components.dichrome_pad_bottom');
        if (labelLeft) labelLeft.textContent = LOC('assign.components.dichrome_pad_left');
        if (labelRight) labelRight.textContent = LOC('assign.components.dichrome_pad_right');

        this._updateUI();
    }
}
