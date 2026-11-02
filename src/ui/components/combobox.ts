import { TTranslationMap } from '../../../loc/base';
import { DeepLeafKeys, LOC } from '../../localiser';
import { UIUtil } from '../../util/ui_util';
import { AppIcons } from '../icons';
import { HTMLBuilder } from '../misc';
import { ConfigComponent } from './config';

export type ComboBoxItem<T> = {
    payload: T,
    displayLocKey: DeepLeafKeys<TTranslationMap>,
} | {
    payload: T,
    displayText: string,
};

export class ComboboxComponent<T> extends ConfigComponent<T, HTMLSelectElement | HTMLDivElement> {
    private _items: ComboBoxItem<T>[];
    private _maxVisibleItems?: number;
    private _isOpen = false;
    private _clickOutsideHandler?: (e: Event) => void;
    private _scrollRepositionHandler?: () => void;

    public constructor() {
        super();
        this._items = [];
    }

    public setMaxVisibleItems(count: number) {
        this._maxVisibleItems = count;
        return this;
    }

    public addItems(items: ComboBoxItem<T>[]) {
        items.forEach((item) => {
            this.addItem(item);
        });
        return this;
    }

    public addItem(item: ComboBoxItem<T>) {
        if (this._items.length === 0) {
            this.setDefaultValue(item.payload);
        }

        this._items.push(item);
        return this;
    }

    private _getDisplayTextForPayload(payload?: T): string {
        const item = this._items.find((x) => x.payload === payload);
        if (!item) return '';
        return 'displayLocKey' in item ? LOC(item.displayLocKey) : item.displayText;
    }

    public override registerEvents(): void {
        if (this._maxVisibleItems === undefined) {
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
                const selectedValue = this._items[selectElement.selectedIndex].payload;
                this._setValue(selectedValue);
            });
            return;
        }

        const trigger = this._getElement();
        const dropdown = UIUtil.getElementById(`${this._getId()}-dropdown`);

        if (typeof document !== 'undefined' && document.body) {
            const dropdownId = `${this._getId()}-dropdown`;
            Array.from(document.body.children).forEach((child) => {
                if (child.id === dropdownId && child !== dropdown) {
                    child.remove();
                }
            });
            if (dropdown && dropdown.parentElement !== document.body) {
                document.body.appendChild(dropdown);
            }
        }

        trigger.addEventListener('mouseenter', () => {
            this._setHovered(true);
            this._updateStyles();
        });

        trigger.addEventListener('mouseleave', () => {
            this._setHovered(false);
            this._updateStyles();
        });

        const closeDropdown = () => {
            if (!this._isOpen) return;
            this._isOpen = false;
            dropdown.classList.add('hide');
            this._updateStyles();
        };

        const updatePosition = () => {
            if (!this._isOpen) return;
            const rect = trigger.getBoundingClientRect();
            if (rect.width === 0 && rect.height === 0) {
                closeDropdown();
                return;
            }
            if (rect.bottom < 0 || rect.top > window.innerHeight) {
                closeDropdown();
                return;
            }

            const container = trigger.closest('.container-properties') as HTMLElement | null;
            const scale = container ? (parseFloat(container.style.zoom) || 1) : 1;

            if (dropdown.style.zoom !== `${scale}`) {
                dropdown.style.zoom = `${scale}`;
            }

            const itemHeight = 32;
            const maxVisible = this._maxVisibleItems ?? 10;
            const desiredHeight = Math.min(this._items.length * itemHeight, maxVisible * itemHeight);

            const spaceBelow = (window.innerHeight - rect.bottom - 8) / scale;
            const spaceAbove = (rect.top - 8) / scale;

            let openAbove = false;
            // If space below is not enough for the desired height and space above has more room, flip above
            if (spaceBelow < desiredHeight && spaceAbove > spaceBelow) {
                openAbove = true;
            }

            if (openAbove) {
                const actualHeight = Math.max(itemHeight, Math.min(desiredHeight, spaceAbove));
                dropdown.style.maxHeight = `${actualHeight}px`;
                dropdown.style.top = `${Math.max(4, Math.round((rect.top - 2) / scale - actualHeight))}px`;
                dropdown.style.bottom = 'auto';
            } else {
                const actualHeight = Math.max(itemHeight, Math.min(desiredHeight, spaceBelow));
                dropdown.style.maxHeight = `${actualHeight}px`;
                dropdown.style.top = `${Math.round((rect.bottom + 2) / scale)}px`;
                dropdown.style.bottom = 'auto';
            }

            let left = Math.round(rect.left / scale);
            const width = Math.round(rect.width / scale);
            const maxLeft = Math.round((window.innerWidth - 4) / scale - width);
            if (left > maxLeft) {
                left = Math.max(4, maxLeft);
            }
            if (left < 4) {
                left = 4;
            }

            dropdown.style.left = `${left}px`;
            dropdown.style.width = `${width}px`;
        };

        const openDropdown = () => {
            if (this.disabled || this._isOpen) return;
            if (typeof document !== 'undefined' && document.body && dropdown.parentElement !== document.body) {
                document.body.appendChild(dropdown);
            }
            this._isOpen = true;
            updatePosition();
            dropdown.classList.remove('hide');
            this._updateStyles();

            const selectedIdx = this._items.findIndex((x) => x.payload === this.getValue());
            if (selectedIdx >= 0) {
                const opt = document.getElementById(`${this._getId()}-opt-${selectedIdx}`);
                if (opt) {
                    dropdown.scrollTop = opt.offsetTop - (dropdown.clientHeight / 2) + 16;
                }
            }
        };

        trigger.addEventListener('click', (e: Event) => {
            e.stopPropagation();
            if (this._isOpen) {
                closeDropdown();
            } else {
                openDropdown();
            }
        });

        trigger.addEventListener('keydown', (e: Event) => {
            if (this.disabled) return;
            const keyEvent = e as KeyboardEvent;
            if (keyEvent.key === ' ' || keyEvent.key === 'Enter' || keyEvent.key === 'ArrowDown') {
                keyEvent.preventDefault();
                if (!this._isOpen) {
                    openDropdown();
                }
            } else if (keyEvent.key === 'Escape') {
                closeDropdown();
            }
        });

        this._items.forEach((item, index) => {
            const opt = document.getElementById(`${this._getId()}-opt-${index}`);
            if (!opt) return;

            opt.addEventListener('mouseenter', () => {
                if (item.payload !== this.getValue()) {
                    opt.style.background = 'var(--gray-500)';
                    opt.style.color = 'var(--text-bright)';
                }
            });

            opt.addEventListener('mouseleave', () => {
                if (item.payload !== this.getValue()) {
                    opt.style.background = 'transparent';
                    opt.style.color = 'var(--text-standard)';
                }
            });

            opt.addEventListener('click', (e: Event) => {
                e.stopPropagation();
                this._setValue(item.payload);
                this._updateCustomDisplayText();
                closeDropdown();
            });
        });

        dropdown.addEventListener('wheel', (e: Event) => {
            const wheelEvent = e as WheelEvent;
            dropdown.scrollTop += wheelEvent.deltaY;
            wheelEvent.preventDefault();
            wheelEvent.stopPropagation();
        }, { passive: false });

        if (this._clickOutsideHandler) {
            window.removeEventListener('mousedown', this._clickOutsideHandler);
        }
        this._clickOutsideHandler = (e: Event) => {
            const target = e.target as Node;
            if (!trigger.contains(target) && !dropdown.contains(target)) {
                closeDropdown();
            }
        };
        window.addEventListener('mousedown', this._clickOutsideHandler);

        if (this._scrollRepositionHandler) {
            window.removeEventListener('resize', this._scrollRepositionHandler);
            document.removeEventListener('scroll', this._scrollRepositionHandler, true);
            document.removeEventListener('sidebar-resize', this._scrollRepositionHandler);
        }
        this._scrollRepositionHandler = () => {
            if (this._isOpen) {
                updatePosition();
            }
        };
        window.addEventListener('resize', this._scrollRepositionHandler);
        document.addEventListener('scroll', this._scrollRepositionHandler, true);
        document.addEventListener('sidebar-resize', this._scrollRepositionHandler);
    }

    public setOptionEnabled(index: number, enabled: boolean) {
        if (this._maxVisibleItems === undefined) {
            const option = UIUtil.getElementById(this._getId() + '-' + index) as HTMLOptionElement;
            option.disabled = !enabled;
        } else {
            const opt = document.getElementById(`${this._getId()}-opt-${index}`);
            if (opt) {
                opt.style.pointerEvents = enabled ? 'auto' : 'none';
                opt.style.opacity = enabled ? '1' : '0.4';
            }
        }
    }

    public override _generateInnerHTML() {
        const builder = new HTMLBuilder();

        if (this._maxVisibleItems !== undefined) {
            const currentText = this._getDisplayTextForPayload(this.getValue());
            builder.add('<div class="custom-combobox-wrapper" style="position: relative; width: 100%;">');
            builder.add(`  <div class="struct-prop custom-combobox-trigger" id="${this._getId()}" tabindex="0">`);
            builder.add(`    <span id="${this._getId()}-display-text" style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding-right: 18px; pointer-events: none;">`);
            builder.add(`      ${currentText}`);
            builder.add(`    </span>`);
            builder.add(`    <div id="${this._getId()}-arrow" class="checkbox-arrow" style="pointer-events: none;">`);
            builder.add(AppIcons.ARROW_DOWN);
            builder.add(`    </div>`);
            builder.add(`  </div>`);
            builder.add(`  <div id="${this._getId()}-dropdown" class="custom-combobox-dropdown hide" style="max-height: ${this._maxVisibleItems * 32}px;">`);
            this._items.forEach((item, index) => {
                const text = 'displayLocKey' in item ? LOC(item.displayLocKey) : item.displayText;
                const isSelected = item.payload === this.getValue();
                builder.add(`    <div class="custom-combobox-option ${isSelected ? 'selected' : ''}" id="${this._getId()}-opt-${index}" data-index="${index}" title="${text}">${text}</div>`);
            });
            builder.add(`  </div>`);
            builder.add('</div>');
            return builder.toString();
        }

        builder.add('<div style="position: relative; width: 100%;">');
        builder.add(`<select class="struct-prop" name="${this._getId()}" id="${this._getId()}">`);
        this._items.forEach((item, index) => {
            if ('displayLocKey' in item) {
                builder.add(`<option id="${this._getId()}-${index}" value="${item.payload}">${LOC(item.displayLocKey)}</option>`);
            } else {
                builder.add(`<option id="${this._getId()}-${index}" value="${item.payload}">${item.displayText}</option>`);
            }
        });
        builder.add('</select>');

        builder.add(`<div id="${this._getId()}-arrow" class="checkbox-arrow">`);
        builder.add(AppIcons.ARROW_DOWN);
        builder.add(`</div>`);
        builder.add('</div>');

        return builder.toString();
    }

    private _updateCustomDisplayText() {
        const textElement = document.getElementById(`${this._getId()}-display-text`);
        if (textElement) {
            textElement.textContent = this._getDisplayTextForPayload(this.getValue());
        }

        const currentVal = this.getValue();
        this._items.forEach((item, index) => {
            const opt = document.getElementById(`${this._getId()}-opt-${index}`);
            if (opt) {
                const isSelected = item.payload === currentVal;
                opt.classList.toggle('selected', isSelected);
                opt.style.background = isSelected ? 'var(--blue-500)' : 'transparent';
                opt.style.color = isSelected ? 'var(--text-bright)' : 'var(--text-standard)';
                opt.style.fontWeight = isSelected ? '500' : 'normal';
            }
        });
    }

    protected override _onValueChanged(): void {
        super._onValueChanged();
        if (this._maxVisibleItems !== undefined) {
            this._updateCustomDisplayText();
        }
    }

    protected override _onEnabledChanged(): void {
        super._onEnabledChanged();
        if (this._maxVisibleItems === undefined) {
            (this._getElement() as HTMLSelectElement).disabled = this.disabled;
        } else {
            if (this.disabled && this._isOpen) {
                const dropdown = document.getElementById(`${this._getId()}-dropdown`);
                dropdown?.classList.add('hide');
                this._isOpen = false;
            }
        }
        this._updateStyles();
    }

    protected override _updateStyles(): void {
        UIUtil.updateStyles(this._getElement(), {
            isHovered: this.hovered,
            isEnabled: this.enabled,
            isActive: this._isOpen,
        });

        const arrowElement = document.getElementById(this._getId() + '-arrow');
        if (arrowElement) {
            arrowElement.classList.remove('text-dark', 'text-standard', 'text-light');
            if (this.enabled) {
                if (this.hovered || this._isOpen) {
                    arrowElement.classList.add('text-light');
                } else {
                    arrowElement.classList.add('text-standard');
                }
            } else {
                arrowElement.classList.add('text-dark');
            }
        }
    }

    public override finalise(): void {
        super.finalise();

        if (this._maxVisibleItems === undefined) {
            const selectedIndex = this._items.findIndex((item) => item.payload === this.getValue());
            const element = this._getElement() as HTMLSelectElement;
            element.selectedIndex = selectedIndex;
        } else {
            this._updateCustomDisplayText();
        }

        this._updateStyles();
    }

    public override refresh(): void {
        super.refresh();

        if (this._maxVisibleItems === undefined) {
            this._items.forEach((item, index) => {
                if ('displayLocKey' in item) {
                    const element = UIUtil.getElementById(this._getId() + '-' + index) as HTMLOptionElement;
                    element.text = LOC(item.displayLocKey);
                }
            });
        } else {
            this._items.forEach((item, index) => {
                if ('displayLocKey' in item) {
                    const opt = document.getElementById(`${this._getId()}-opt-${index}`);
                    if (opt) {
                        opt.textContent = LOC(item.displayLocKey);
                    }
                }
            });
            this._updateCustomDisplayText();
        }
    }

    public setValue(value: T) {
        this._setValue(value);
    }
}

