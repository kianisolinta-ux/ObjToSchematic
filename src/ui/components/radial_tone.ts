import { PALETTE_ALL_RELEASE } from '../../../res/palettes/all';
import { Atlas } from '../../atlas';
import { RGBAUtil } from '../../colour';
import { loadDichromeActivePaletteState } from '../../dichrome_palette_helpers';
import { LOC } from '../../localiser';
import {
    applyFloatingMove,
    applyFloatingResize,
    clampDragFraction,
    clampFloatingBounds,
    clampToneWeight,
    computeEqualizerFractionFromClientY,
    computePercentagesFromValues,
    getPercentageMaxScale,
    loadDichromeFloatingBounds,
    loadDichromeViewMode,
    redistributePercentages,
    saveDichromeFloatingBounds,
    saveDichromeViewMode,
    TRadialFloatingBounds,
    TRadialViewMode,
    TResizeEdge,
} from '../../radial_tone_helpers';
import { AppUtil } from '../../util';
import { UIUtil } from '../../util/ui_util';
import { ConfigComponent } from './config';

export type TToneMode = 'weights' | 'percentages';

export interface TDichromeToneConfig {
    mode: TToneMode;
    values: number[]; // Mode 'weights': array of 0..1 (default 1.0); Mode 'percentages': array of 0..100 (sum=100)
    percentages: number[]; // Normalized percentages summing to 100
}

const ICON_EQUALIZER = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <line x1="5" y1="20" x2="5" y2="12"></line>
        <line x1="5" y1="8" x2="5" y2="4"></line>
        <circle cx="5" cy="10" r="2"></circle>
        <line x1="12" y1="20" x2="12" y2="16"></line>
        <line x1="12" y1="12" x2="12" y2="4"></line>
        <circle cx="12" cy="14" r="2"></circle>
        <line x1="19" y1="20" x2="19" y2="9"></line>
        <line x1="19" y1="5" x2="19" y2="4"></line>
        <circle cx="19" cy="7" r="2"></circle>
    </svg>
`;

const ICON_RADAR = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <polygon points="12 3 20 8.5 17.5 18.5 6.5 18.5 4 8.5"></polygon>
        <polygon points="12 7.5 16 10.5 14.5 15.5 9.5 15.5 8 10.5" stroke-opacity="0.65"></polygon>
        <line x1="12" y1="12" x2="12" y2="3" stroke-opacity="0.45"></line>
        <line x1="12" y1="12" x2="20" y2="8.5" stroke-opacity="0.45"></line>
        <line x1="12" y1="12" x2="17.5" y2="18.5" stroke-opacity="0.45"></line>
        <line x1="12" y1="12" x2="6.5" y2="18.5" stroke-opacity="0.45"></line>
        <line x1="12" y1="12" x2="4" y2="8.5" stroke-opacity="0.45"></line>
    </svg>
`;

const ICON_DETACH = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M15 3h6v6"></path>
        <path d="M10 14L21 3"></path>
        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
    </svg>
`;

const ICON_DOCK = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M4 14h6v6"></path>
        <path d="M20 10h-6V4"></path>
        <path d="M14 10l7-7"></path>
        <path d="M3 21l7-7"></path>
    </svg>
`;

const ICON_GRIP = `
    <svg class="radar-floating-grip" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
        <circle cx="4" cy="4" r="1.2"></circle>
        <circle cx="9" cy="4" r="1.2"></circle>
        <circle cx="4" cy="8" r="1.2"></circle>
        <circle cx="9" cy="8" r="1.2"></circle>
        <circle cx="4" cy="12" r="1.2"></circle>
        <circle cx="9" cy="12" r="1.2"></circle>
    </svg>
`;

/**
 * Interactive Radar (Spider) Diagram & Block Equalizer for Dichrome tone distribution.
 * Displays:
 * - Radar view: 1D polar line for N = 2, multi-axis spider-web polygon for N >= 3.
 * - Equalizer view: vertical interactive fader columns for each block (0..N-1), with horizontal scroll for large N.
 * Top-right switcher toggles between Radar and Equalizer; top-left button detaches into a movable/resizable window.
 */
export class RadialToneDistributionComponent extends ConfigComponent<TDichromeToneConfig, HTMLDivElement> {
    private _blockNames: string[];
    private _blockColours: Map<string, string>;
    private _draggingIndex: number;
    private _draggingType: 'radar' | 'equalizer' | null;
    private _dragMaxScale: number | null;
    private _activeHoverIndex: number;
    private _viewMode: TRadialViewMode;
    private _isDetached: boolean;
    private _floatingBounds: TRadialFloatingBounds | null;
    private _floatingWindowEl: HTMLDivElement | null;
    private _floatingBodyEl: HTMLDivElement | null;
    private _windowDragState: {
        type: 'move' | 'resize';
        edge?: TResizeEdge;
        startX: number;
        startY: number;
        startBounds: TRadialFloatingBounds;
    } | null;

    // ViewBox dimensions and radar geometry
    private readonly _viewWidth = 380;
    private readonly _viewHeight = 340;
    private readonly _cx = 190;
    private readonly _cy = 168;
    private readonly _radius = 115;
    private readonly _labelRadius = 144;

    public constructor(initialBlocks?: string[]) {
        const resolvedInitialBlocks = initialBlocks ??
            loadDichromeActivePaletteState()?.blocks ??
            ['minecraft:black_concrete', 'minecraft:white_concrete'];
        const initialCount = Math.max(2, resolvedInitialBlocks.length);
        const equalPercents = Array.from({ length: initialCount }, () => Math.round((100 / initialCount) * 10) / 10);
        const diff = 100 - equalPercents.reduce((a, b) => a + b, 0);
        equalPercents[initialCount - 1] = Math.round((equalPercents[initialCount - 1] + diff) * 10) / 10;

        super({
            mode: 'percentages',
            values: [...equalPercents],
            percentages: equalPercents,
        });

        this._blockNames = [...resolvedInitialBlocks];
        this._blockColours = new Map();
        this._draggingIndex = -1;
        this._draggingType = null;
        this._dragMaxScale = null;
        this._activeHoverIndex = -1;
        this._viewMode = loadDichromeViewMode();
        this._isDetached = false;
        this._floatingBounds = null;
        this._floatingWindowEl = null;
        this._floatingBodyEl = null;
        this._windowDragState = null;

        const atlas = Atlas.load('vanilla');
        atlas?.getBlocks().forEach((block) => {
            this._blockColours.set(block.name, RGBAUtil.toHexString(block.colour));
        });
        PALETTE_ALL_RELEASE.forEach((name) => {
            const namespaced = AppUtil.Text.namespaceBlock(name);
            if (!this._blockColours.has(namespaced) && atlas) {
                const b = atlas.getBlocks().get(namespaced);
                if (b) {
                    this._blockColours.set(namespaced, RGBAUtil.toHexString(b.colour));
                }
            }
        });

        this._recomputePercentages();
    }

    /**
     * Remove the 40% left label column to save space,
     * giving the diagram/equalizer 100% full width of the sidebar.
     */
    public override generateHTML(): string {
        return `
            <div class="property radar-tone-property" style="flex-direction: column; align-items: stretch; width: 100%; padding: 0;">
                <div style="display: none;" id="${this._getLabelId()}"></div>
                <div class="prop-value-container" id="${this._getId()}-prop" style="width: 100%; display: block;">
                    ${this._generateInnerHTML()}
                </div>
            </div>
        `;
    }

    public setBlocks(blocks: string[]): void {
        this._blockNames = [...blocks];
        const numBlocks = Math.max(2, this._blockNames.length);
        const current = this.getValue();

        let newValues: number[];
        if (current.mode === 'weights') {
            newValues = Array.from({ length: numBlocks }, (_, i) => current.values[i] ?? 1.0);
        } else {
            newValues = Array.from({ length: numBlocks }, () => Math.round((100 / numBlocks) * 10) / 10);
            const diff = 100 - newValues.reduce((a, b) => a + b, 0);
            newValues[numBlocks - 1] = Math.round((newValues[numBlocks - 1] + diff) * 10) / 10;
        }

        current.values = newValues;
        this._recomputePercentages();
        this._setValue({ ...current });
    }

    private _recomputePercentages(): void {
        const current = this.getValue();
        const computed = computePercentagesFromValues(current.mode, current.values);
        current.values = computed.values;
        current.percentages = computed.percentages;
    }

    private _getViewToggleTooltip(): string {
        return this._viewMode === 'radar' ?
            LOC('assign.components.dichrome_view_to_equalizer') :
            LOC('assign.components.dichrome_view_to_radar');
    }

    private _getViewToggleIcon(): string {
        return this._viewMode === 'radar' ? ICON_EQUALIZER : ICON_RADAR;
    }

    private _getDetachToggleTooltip(): string {
        return this._isDetached ?
            LOC('assign.components.dichrome_dock_window') :
            LOC('assign.components.dichrome_detach_window');
    }

    private _getDetachToggleIcon(): string {
        return this._isDetached ? ICON_DOCK : ICON_DETACH;
    }

    protected override _generateInnerHTML(): string {
        const toggleTooltip = this._escapeHTML(this._getViewToggleTooltip());
        const detachTooltip = this._escapeHTML(this._getDetachToggleTooltip());
        return `
            <div class="radar-tone-container" id="${this._getId()}">
                <div class="radar-tone-header">
                    <div class="radar-tone-mode-toggle" role="tablist">
                        <button
                            type="button"
                            class="radar-tone-mode-btn ${this.getValue().mode === 'percentages' ? 'is-active' : ''}"
                            id="${this._getId()}-mode-percentages"
                            role="tab"
                            aria-selected="${this.getValue().mode === 'percentages'}"
                        >
                            ${LOC('assign.components.dichrome_mode_percentages')}
                        </button>
                        <button
                            type="button"
                            class="radar-tone-mode-btn ${this.getValue().mode === 'weights' ? 'is-active' : ''}"
                            id="${this._getId()}-mode-weights"
                            role="tab"
                            aria-selected="${this.getValue().mode === 'weights'}"
                        >
                            ${LOC('assign.components.dichrome_mode_weights')}
                        </button>
                    </div>
                    <div class="radar-tone-presets">
                        <button type="button" class="radar-tone-preset-btn" id="${this._getId()}-preset-equal" title="Поровну: равные доли всех тонов (1/N)">
                            ${LOC('assign.components.dichrome_preset_equal')}
                        </button>
                        <button type="button" class="radar-tone-preset-btn" id="${this._getId()}-preset-bright" title="Светлый: преобладание светлых блоков, тёмные как акцент">
                            ${LOC('assign.components.dichrome_preset_bright')}
                        </button>
                        <button type="button" class="radar-tone-preset-btn" id="${this._getId()}-preset-dark" title="Тёмный: преобладание тёмных блоков, светлые как блики">
                            ${LOC('assign.components.dichrome_preset_dark')}
                        </button>
                        <button type="button" class="radar-tone-preset-btn" id="${this._getId()}-preset-contrast" title="Контраст: глубокие тени и яркие света, минимум полутонов">
                            ${LOC('assign.components.dichrome_preset_contrast')}
                        </button>
                    </div>
                </div>

                <div class="radar-tone-canvas-card" id="${this._getId()}-card" data-view-mode="${this._viewMode}">
                    <button
                        type="button"
                        class="radar-detach-corner-toggle${this._isDetached ? ' is-detached' : ''}"
                        id="${this._getId()}-detach-toggle"
                        title="${detachTooltip}"
                        aria-label="${detachTooltip}"
                        aria-pressed="${this._isDetached}"
                    >
                        ${this._getDetachToggleIcon()}
                    </button>
                    <button
                        type="button"
                        class="radar-view-corner-toggle"
                        id="${this._getId()}-view-toggle"
                        title="${toggleTooltip}"
                        aria-label="${toggleTooltip}"
                        aria-pressed="${this._viewMode === 'equalizer'}"
                    >
                        ${this._getViewToggleIcon()}
                    </button>
                    <div class="radar-tone-diagram-wrapper" id="${this._getId()}-diagram"></div>
                </div>
            </div>
            <div class="radar-detached-placeholder is-hidden" id="${this._getId()}-placeholder">
                <span class="radar-detached-notice" id="${this._getId()}-detached-notice">
                    ${this._escapeHTML(LOC('assign.components.dichrome_detached_notice'))}
                </span>
                <button type="button" class="radar-dock-placeholder-btn" id="${this._getId()}-dock-placeholder-btn">
                    ${this._escapeHTML(LOC('assign.components.dichrome_dock_window'))}
                </button>
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

    private _getToneLabel(index: number, total: number): string {
        if (index === 0) {
            return '1 (Dark)';
        }
        if (index === total - 1) {
            return `${index + 1} (Light)`;
        }
        return `T${index + 1}`;
    }

    private _getDisplayName(blockName: string): string {
        return blockName
            .replace(/^minecraft:/, '')
            .replace(/_/g, ' ')
            .replace(/\b\w/g, (letter) => letter.toUpperCase());
    }

    /**
     * Compute the maximum percentage scale for the diagram/equalizer in percentage mode.
     * For N = 2: strictly 100%.
     * For N >= 3: scales so that baseline equal share sits near 55% of the axis/track.
     */
    private _getPercentageMaxScale(): number {
        const current = this.getValue();
        return getPercentageMaxScale(current.percentages, current.values.length);
    }

    private _renderRadarSVG(): void {
        const container = document.getElementById(this._getId() + '-diagram');
        if (!container) return;

        const current = this.getValue();
        const mode = current.mode;
        const n = current.values.length;

        const width = this._viewWidth;
        const height = this._viewHeight;
        const cx = this._cx;
        const cy = this._cy;
        const R = this._radius;
        const labelR = this._labelRadius;
        const maxScale = this._dragMaxScale ?? this._getPercentageMaxScale();

        const levels = [0.25, 0.5, 0.75, 1.0];

        const gridCircles: string[] = [];
        levels.forEach((lvl) => {
            const r = (R * lvl).toFixed(1);
            gridCircles.push(`
                <circle
                    cx="${cx}"
                    cy="${cy}"
                    r="${r}"
                    fill="none"
                    stroke="rgba(255, 255, 255, ${lvl === 1.0 ? '0.22' : '0.08'})"
                    stroke-width="${lvl === 1.0 ? '1.5' : '1'}"
                    stroke-dasharray="${lvl === 1.0 ? 'none' : '3 3'}"
                />
            `);
        });

        const levelLabels: string[] = [];
        levels.forEach((lvl) => {
            const lx = cx + R * lvl * 0.707 + 3;
            const ly = cy - R * lvl * 0.707 - 2;
            const text = mode === 'weights' ?
                lvl.toFixed(2).replace(/\.00$/, '') :
                `${Math.round(lvl * maxScale)}%`;

            levelLabels.push(`
                <text
                    x="${lx.toFixed(1)}"
                    y="${ly.toFixed(1)}"
                    fill="rgba(255, 255, 255, 0.35)"
                    font-size="9"
                    font-family="ui-monospace, SFMono-Regular, Consolas, monospace"
                    text-anchor="start"
                >
                    ${text}
                </text>
            `);
        });

        let dataElementHTML = '';
        const axisLines: string[] = [];
        const gridPolygons: string[] = [];
        const handles: string[] = [];
        const labels: string[] = [];

        if (n === 2) {
            let frac0: number;
            let frac1: number;
            if (mode === 'weights') {
                frac0 = Math.max(0, Math.min(1.0, current.values[0] ?? 1.0));
                frac1 = Math.max(0, Math.min(1.0, current.values[1] ?? 1.0));
            } else {
                frac0 = Math.max(0, Math.min(1.0, (current.percentages[0] ?? 50) / 100));
                frac1 = Math.max(0, Math.min(1.0, (current.percentages[1] ?? 50) / 100));
            }

            const y0 = cy - R * frac0;
            const y1 = cy + R * frac1;

            axisLines.push(`
                <line x1="${cx}" y1="${(cy - R).toFixed(1)}" x2="${cx}" y2="${(cy + R).toFixed(1)}" stroke="rgba(255, 255, 255, 0.22)" stroke-width="1.5" />
                <line x1="${(cx - 30).toFixed(1)}" y1="${cy}" x2="${(cx + 30).toFixed(1)}" y2="${cy}" stroke="rgba(255, 255, 255, 0.15)" stroke-width="1" stroke-dasharray="2 2" />
            `);

            dataElementHTML = `
                <line
                    x1="${cx}"
                    y1="${y0.toFixed(1)}"
                    x2="${cx}"
                    y2="${y1.toFixed(1)}"
                    stroke="rgba(0, 229, 255, 0.3)"
                    stroke-width="12"
                    stroke-linecap="round"
                />
                <line
                    x1="${cx}"
                    y1="${y0.toFixed(1)}"
                    x2="${cx}"
                    y2="${y1.toFixed(1)}"
                    stroke="#00e5ff"
                    stroke-width="5"
                    stroke-linecap="round"
                    filter="url(#${this._getId()}-glow)"
                    class="radar-tone-line"
                />
                <line
                    x1="${cx}"
                    y1="${y0.toFixed(1)}"
                    x2="${cx}"
                    y2="${y1.toFixed(1)}"
                    stroke="#ffffff"
                    stroke-width="2"
                    stroke-linecap="round"
                />
            `;

            const endpoints = [
                { x: cx, y: y0, name: this._blockNames[0] ?? 'minecraft:black_concrete', defaultCol: '#111827' },
                { x: cx, y: y1, name: this._blockNames[1] ?? 'minecraft:white_concrete', defaultCol: '#f9fafb' },
            ];

            for (let i = 0; i < 2; ++i) {
                const ep = endpoints[i];
                const colour = this._blockColours.get(ep.name) ?? ep.defaultCol;
                const isDragging = i === this._draggingIndex;
                const isHovered = i === this._activeHoverIndex;

                handles.push(`
                    <g class="radar-handle-group" data-handle-index="${i}">
                        <circle cx="${ep.x.toFixed(1)}" cy="${ep.y.toFixed(1)}" r="18" fill="transparent" class="radar-handle-hit" />
                        <circle
                            cx="${ep.x.toFixed(1)}"
                            cy="${ep.y.toFixed(1)}"
                            r="${isDragging || isHovered ? '9.5' : '8'}"
                            fill="${colour}"
                            stroke="${isDragging ? '#00e5ff' : '#ffffff'}"
                            stroke-width="2.5"
                            class="radar-handle-circle ${isDragging ? 'is-dragging' : ''}"
                        />
                    </g>
                `);
            }

            for (let i = 0; i < 2; ++i) {
                const ep = endpoints[i];
                const colour = this._blockColours.get(ep.name) ?? ep.defaultCol;
                const toneLabel = this._getToneLabel(i, 2);
                const ly = i === 0 ? cy - labelR : cy + labelR;
                const swatchY = i === 0 ? cy - (R + 10) : cy + (R + 10);

                const valStr = mode === 'weights' ?
                    `${(current.values[i] ?? 1.0).toFixed(2)} (${(current.percentages[i] ?? 50).toFixed(1)}%)` :
                    `${(current.percentages[i] ?? 50).toFixed(1)}%`;

                labels.push(`
                    <g class="radar-axis-label-group" transform="translate(${cx}, ${ly.toFixed(1)})" text-anchor="middle">
                        <text x="0" y="${i === 0 ? -4 : 10}" class="radar-label-tone" fill="var(--text-bright)" font-size="11.5" font-weight="600">
                            ${this._escapeHTML(toneLabel)}
                        </text>
                        <text x="0" y="${i === 0 ? 9 : 22}" class="radar-label-val" fill="var(--blue-700)" font-size="11" font-family="ui-monospace, SFMono-Regular, Consolas, monospace">
                            ${this._escapeHTML(valStr)}
                        </text>
                    </g>
                    <circle cx="${cx}" cy="${swatchY.toFixed(1)}" r="5" fill="${colour}" stroke="rgba(255,255,255,0.4)" stroke-width="1.2" />
                `);
            }
        } else {
            const angles: number[] = [];
            for (let i = 0; i < n; ++i) {
                angles.push(-Math.PI / 2 + (2 * Math.PI * i) / n);
            }

            levels.forEach((lvl) => {
                const levelPoints: string[] = [];
                for (let i = 0; i < n; ++i) {
                    const rx = cx + R * lvl * Math.cos(angles[i]);
                    const ry = cy + R * lvl * Math.sin(angles[i]);
                    levelPoints.push(`${rx.toFixed(1)},${ry.toFixed(1)}`);
                }
                gridPolygons.push(`
                    <polygon
                        points="${levelPoints.join(' ')}"
                        fill="none"
                        stroke="rgba(255, 255, 255, ${lvl === 1.0 ? '0.18' : '0.06'})"
                        stroke-width="${lvl === 1.0 ? '1.5' : '1'}"
                        stroke-dasharray="${lvl === 1.0 ? 'none' : '3 3'}"
                    />
                `);
            });

            for (let i = 0; i < n; ++i) {
                const ox = cx + R * Math.cos(angles[i]);
                const oy = cy + R * Math.sin(angles[i]);
                axisLines.push(`
                    <line
                        x1="${cx}"
                        y1="${cy}"
                        x2="${ox.toFixed(1)}"
                        y2="${oy.toFixed(1)}"
                        stroke="rgba(255, 255, 255, 0.18)"
                        stroke-width="1.2"
                    />
                `);
            }

            const polyPoints: Array<{ x: number, y: number }> = [];
            for (let i = 0; i < n; ++i) {
                let frac: number;
                if (mode === 'weights') {
                    frac = Math.max(0, Math.min(1.0, current.values[i] ?? 1.0));
                } else {
                    frac = Math.max(0, Math.min(1.0, (current.percentages[i] ?? 0) / maxScale));
                }
                const px = cx + R * frac * Math.cos(angles[i]);
                const py = cy + R * frac * Math.sin(angles[i]);
                polyPoints.push({ x: px, y: py });
            }

            const polygonString = polyPoints.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
            dataElementHTML = `
                <polygon
                    points="${polygonString}"
                    fill="url(#${this._getId()}-polygrad)"
                    stroke="#22d3ee"
                    stroke-width="2.5"
                    stroke-linejoin="round"
                    filter="url(#${this._getId()}-glow)"
                    class="radar-polygon"
                />
            `;

            for (let i = 0; i < n; ++i) {
                const p = polyPoints[i];
                const blockName = this._blockNames[i] ?? 'minecraft:stone';
                const colour = this._blockColours.get(blockName) ?? 'var(--blue-500)';
                const isDragging = i === this._draggingIndex;
                const isHovered = i === this._activeHoverIndex;

                handles.push(`
                    <g class="radar-handle-group" data-handle-index="${i}">
                        <circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="18" fill="transparent" class="radar-handle-hit" />
                        <circle
                            cx="${p.x.toFixed(1)}"
                            cy="${p.y.toFixed(1)}"
                            r="${isDragging || isHovered ? '9.5' : '7.5'}"
                            fill="${colour}"
                            stroke="${isDragging ? '#00e5ff' : '#ffffff'}"
                            stroke-width="2.5"
                            class="radar-handle-circle ${isDragging ? 'is-dragging' : ''}"
                        />
                    </g>
                `);
            }

            for (let i = 0; i < n; ++i) {
                const blockName = this._blockNames[i] ?? 'minecraft:stone';
                const colour = this._blockColours.get(blockName) ?? '#888';
                const toneLabel = this._getToneLabel(i, n);
                const cos = Math.cos(angles[i]);
                const sin = Math.sin(angles[i]);

                const lx = cx + labelR * cos;
                const ly = cy + labelR * sin;

                let anchor = 'middle';
                let dx = 0;
                if (cos > 0.25) {
                    anchor = 'start';
                    dx = 8;
                } else if (cos < -0.25) {
                    anchor = 'end';
                    dx = -8;
                }

                const dy = sin < -0.3 ? -6 : sin > 0.3 ? 10 : 2;

                const valStr = mode === 'weights' ?
                    `${(current.values[i] ?? 1.0).toFixed(2)} (${(current.percentages[i] ?? 0).toFixed(1)}%)` :
                    `${(current.percentages[i] ?? 0).toFixed(1)}%`;

                const swatchX = cx + (R + 10) * cos;
                const swatchY = cy + (R + 10) * sin;

                labels.push(`
                    <g class="radar-axis-label-group" transform="translate(${(lx + dx).toFixed(1)}, ${(ly + dy).toFixed(1)})" text-anchor="${anchor}">
                        <text x="0" y="-3" class="radar-label-tone" fill="var(--text-bright)" font-size="11" font-weight="600">
                            ${this._escapeHTML(toneLabel)}
                        </text>
                        <text x="0" y="10" class="radar-label-val" fill="var(--blue-700)" font-size="10.5" font-family="ui-monospace, SFMono-Regular, Consolas, monospace">
                            ${this._escapeHTML(valStr)}
                        </text>
                    </g>
                    <circle cx="${swatchX.toFixed(1)}" cy="${swatchY.toFixed(1)}" r="4.5" fill="${colour}" stroke="rgba(255,255,255,0.4)" stroke-width="1.2" />
                `);
            }
        }

        container.innerHTML = `
            <svg
                class="radar-tone-svg"
                id="${this._getId()}-svg"
                viewBox="0 0 ${width} ${height}"
                preserveAspectRatio="xMidYMid meet"
                style="user-select: none; display: block;"
            >
                <defs>
                    <filter id="${this._getId()}-glow" filterUnits="userSpaceOnUse" x="0" y="0" width="${width}" height="${height}">
                        <feDropShadow dx="0" dy="0" stdDeviation="5" flood-color="#00e5ff" flood-opacity="0.8" />
                    </filter>
                    <radialGradient id="${this._getId()}-polygrad" cx="50%" cy="50%" r="50%">
                        <stop offset="0%" stop-color="rgba(34, 211, 238, 0.38)" />
                        <stop offset="100%" stop-color="rgba(6, 182, 212, 0.16)" />
                    </radialGradient>
                </defs>

                <g class="radar-grid">
                    ${gridCircles.join('')}
                    ${gridPolygons.join('')}
                    ${axisLines.join('')}
                    ${levelLabels.join('')}
                    <circle cx="${cx}" cy="${cy}" r="3" fill="rgba(255,255,255,0.5)" />
                </g>

                ${dataElementHTML}

                <g class="radar-handles">
                    ${handles.join('')}
                </g>

                <g class="radar-labels">
                    ${labels.join('')}
                </g>
            </svg>
        `;
    }

    private _renderEqualizerHTML(): void {
        const container = document.getElementById(this._getId() + '-diagram');
        if (!container) return;

        const existingCols = container.querySelector('.radar-eq-columns') as HTMLDivElement | null;
        const prevScrollLeft = existingCols ? existingCols.scrollLeft : 0;

        const current = this.getValue();
        const mode = current.mode;
        const n = current.values.length;
        const maxScale = this._dragMaxScale ?? this._getPercentageMaxScale();
        const isScrollable = n > 8;

        const columnsHTML: string[] = [];
        for (let i = 0; i < n; ++i) {
            const blockName = this._blockNames[i] ?? (i === 0 ? 'minecraft:black_concrete' : 'minecraft:white_concrete');
            const displayName = this._getDisplayName(blockName);
            const defaultCol = i === 0 ? '#111827' : '#f9fafb';
            const colour = this._blockColours.get(blockName) ?? defaultCol;

            const weightVal = current.values[i] ?? 1.0;
            const pctVal = current.percentages[i] ?? 0;

            const frac = mode === 'weights' ?
                Math.max(0, Math.min(1.0, weightVal)) :
                Math.max(0, Math.min(1.0, pctVal / maxScale));

            const fillPct = (frac * 100).toFixed(2);
            const valueText = mode === 'weights' ? weightVal.toFixed(2) : `${pctVal.toFixed(1)}%`;
            const tooltipText = mode === 'weights' ?
                `${displayName} (${blockName}): ${weightVal.toFixed(2)} · ${pctVal.toFixed(1)}%` :
                `${displayName} (${blockName}): ${pctVal.toFixed(1)}%`;

            const isDragging = this._draggingType === 'equalizer' && this._draggingIndex === i;
            const shortTone = i === 0 ? '1' : i === n - 1 ? `${n}` : `${i + 1}`;

            columnsHTML.push(`
                <div class="radar-eq-col${isDragging ? ' is-dragging' : ''}" data-eq-index="${i}">
                    <span class="radar-eq-value" title="${this._escapeHTML(tooltipText)}">${this._escapeHTML(valueText)}</span>
                    <div
                        class="radar-eq-track"
                        data-eq-index="${i}"
                        role="slider"
                        tabindex="${this.disabled ? -1 : 0}"
                        aria-label="${this._escapeHTML(displayName)}"
                        aria-valuemin="0"
                        aria-valuemax="${mode === 'weights' ? '1' : maxScale}"
                        aria-valuenow="${mode === 'weights' ? weightVal.toFixed(2) : pctVal.toFixed(1)}"
                        title="${this._escapeHTML(tooltipText)}"
                    >
                        <div class="radar-eq-gridlines" aria-hidden="true">
                            <span></span>
                            <span></span>
                            <span></span>
                        </div>
                        <div class="radar-eq-fill" style="height: ${fillPct}%;"></div>
                        <div class="radar-eq-thumb" style="bottom: ${fillPct}%; background-color: ${colour};"></div>
                    </div>
                    <div class="radar-eq-block-badge" title="${this._escapeHTML(tooltipText)}">
                        <span class="radar-eq-swatch" style="background-color: ${colour};"></span>
                        <span class="radar-eq-label">${this._escapeHTML(shortTone)}</span>
                    </div>
                </div>
            `);
        }

        const scaleTopLabel = mode === 'weights' ? '1.00' : `${maxScale}%`;

        container.innerHTML = `
            <div class="radar-eq-wrapper" id="${this._getId()}-equalizer">
                <div class="radar-eq-scale-hint" aria-hidden="true">
                    <span>${this._escapeHTML(scaleTopLabel)}</span>
                    <span>0</span>
                </div>
                <div class="radar-eq-columns${isScrollable ? ' is-scrollable' : ''}">
                    ${columnsHTML.join('')}
                </div>
            </div>
        `;

        if (isScrollable && prevScrollLeft > 0) {
            const nextCols = container.querySelector('.radar-eq-columns') as HTMLDivElement | null;
            if (nextCols) {
                nextCols.scrollLeft = prevScrollLeft;
            }
        }
    }

    private _updateViewToggleUI(): void {
        const card = document.getElementById(this._getId() + '-card');
        if (card) {
            card.dataset.viewMode = this._viewMode;
        }
        const toggleBtn = document.getElementById(this._getId() + '-view-toggle') as HTMLButtonElement | null;
        if (toggleBtn) {
            const tip = this._getViewToggleTooltip();
            toggleBtn.innerHTML = this._getViewToggleIcon();
            toggleBtn.title = tip;
            toggleBtn.setAttribute('aria-label', tip);
            toggleBtn.setAttribute('aria-pressed', String(this._viewMode === 'equalizer'));
            toggleBtn.disabled = this.disabled;
        }
        const detachBtn = document.getElementById(this._getId() + '-detach-toggle') as HTMLButtonElement | null;
        if (detachBtn) {
            const detachTip = this._getDetachToggleTooltip();
            detachBtn.innerHTML = this._getDetachToggleIcon();
            detachBtn.classList.toggle('is-detached', this._isDetached);
            detachBtn.title = detachTip;
            detachBtn.setAttribute('aria-label', detachTip);
            detachBtn.setAttribute('aria-pressed', String(this._isDetached));
            detachBtn.disabled = this.disabled;
        }
        this._syncFloatingVisibility();
    }

    private _applyFloatingBounds(bounds: TRadialFloatingBounds): void {
        const clamped = clampFloatingBounds(bounds, window.innerWidth, window.innerHeight);
        this._floatingBounds = clamped;
        if (this._floatingWindowEl) {
            this._floatingWindowEl.style.left = `${clamped.left}px`;
            this._floatingWindowEl.style.top = `${clamped.top}px`;
            this._floatingWindowEl.style.width = `${clamped.width}px`;
            this._floatingWindowEl.style.height = `${clamped.height}px`;
        }
    }

    private _ensureFloatingWindow(): void {
        if (this._floatingWindowEl && document.body.contains(this._floatingWindowEl)) {
            return;
        }

        const win = document.createElement('div');
        win.className = 'radar-floating-window is-hidden';
        win.id = `${this._getId()}-floating`;
        win.setAttribute('role', 'dialog');
        win.setAttribute('aria-label', LOC('assign.components.dichrome_floating_title'));

        const dockLabel = this._escapeHTML(LOC('assign.components.dichrome_dock_window'));
        const titleLabel = this._escapeHTML(LOC('assign.components.dichrome_floating_title'));

        win.innerHTML = `
            <div class="radar-floating-header" id="${this._getId()}-floating-header">
                <div class="radar-floating-title-group">
                    ${ICON_GRIP}
                    <span class="radar-floating-title-text" id="${this._getId()}-floating-title">${titleLabel}</span>
                </div>
                <button
                    type="button"
                    class="radar-floating-dock-btn"
                    id="${this._getId()}-floating-dock"
                    title="${dockLabel}"
                    aria-label="${dockLabel}"
                >
                    ${ICON_DOCK}
                </button>
            </div>
            <div class="radar-floating-body" id="${this._getId()}-floating-body"></div>
            <div class="radar-resize-handle radar-resize-n" data-resize-edge="n"></div>
            <div class="radar-resize-handle radar-resize-s" data-resize-edge="s"></div>
            <div class="radar-resize-handle radar-resize-w" data-resize-edge="w"></div>
            <div class="radar-resize-handle radar-resize-e" data-resize-edge="e"></div>
            <div class="radar-resize-handle radar-resize-nw" data-resize-edge="nw"></div>
            <div class="radar-resize-handle radar-resize-ne" data-resize-edge="ne"></div>
            <div class="radar-resize-handle radar-resize-sw" data-resize-edge="sw"></div>
            <div class="radar-resize-handle radar-resize-se" data-resize-edge="se"></div>
        `;

        document.body.appendChild(win);
        this._floatingBodyEl = win.querySelector('.radar-floating-body') as HTMLDivElement | null;

        const headerEl = win.querySelector('.radar-floating-header') as HTMLDivElement | null;
        const dockBtn = win.querySelector('.radar-floating-dock-btn') as HTMLButtonElement | null;
        this._floatingWindowEl = win;

        dockBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            this._setDetached(false);
        });

        headerEl?.addEventListener('mousedown', (e: MouseEvent) => {
            if (e.button !== 0) return;
            const target = e.target as HTMLElement | null;
            if (target?.closest('.radar-floating-dock-btn')) return;
            if (!this._floatingBounds) return;
            this._windowDragState = {
                type: 'move',
                startX: e.clientX,
                startY: e.clientY,
                startBounds: { ...this._floatingBounds },
            };
            this._floatingWindowEl?.classList.add('is-moving');
            e.preventDefault();
        });

        headerEl?.addEventListener('touchstart', (e: TouchEvent) => {
            if (e.touches.length === 0) return;
            const target = e.target as HTMLElement | null;
            if (target?.closest('.radar-floating-dock-btn')) return;
            if (!this._floatingBounds) return;
            this._windowDragState = {
                type: 'move',
                startX: e.touches[0].clientX,
                startY: e.touches[0].clientY,
                startBounds: { ...this._floatingBounds },
            };
            this._floatingWindowEl?.classList.add('is-moving');
            e.preventDefault();
        }, { passive: false });

        win.addEventListener('mousedown', (e: MouseEvent) => {
            if (e.button !== 0) return;
            const target = e.target as HTMLElement | null;
            const handle = target?.closest('.radar-resize-handle') as HTMLDivElement | null;
            const edge = handle?.dataset.resizeEdge as TResizeEdge | undefined;
            if (!handle || !edge || !this._floatingBounds) return;
            this._windowDragState = {
                type: 'resize',
                edge,
                startX: e.clientX,
                startY: e.clientY,
                startBounds: { ...this._floatingBounds },
            };
            e.preventDefault();
        });

        win.addEventListener('touchstart', (e: TouchEvent) => {
            if (e.touches.length === 0) return;
            const target = e.target as HTMLElement | null;
            const handle = target?.closest('.radar-resize-handle') as HTMLDivElement | null;
            const edge = handle?.dataset.resizeEdge as TResizeEdge | undefined;
            if (!handle || !edge || !this._floatingBounds) return;
            this._windowDragState = {
                type: 'resize',
                edge,
                startX: e.touches[0].clientX,
                startY: e.touches[0].clientY,
                startBounds: { ...this._floatingBounds },
            };
            e.preventDefault();
        }, { passive: false });
    }

    private _syncFloatingVisibility(): void {
        if (this._floatingWindowEl) {
            const shouldShow = this._isDetached && this.visible;
            this._floatingWindowEl.classList.toggle('is-hidden', !shouldShow);
        }
        const placeholder = document.getElementById(`${this._getId()}-placeholder`);
        if (placeholder) {
            placeholder.classList.toggle('is-hidden', !this._isDetached);
        }
    }

    private _setDetached(detached: boolean): void {
        const container = document.getElementById(this._getId()) as HTMLDivElement | null;
        const propContainer = document.getElementById(`${this._getId()}-prop`) as HTMLDivElement | null;
        const placeholder = document.getElementById(`${this._getId()}-placeholder`) as HTMLDivElement | null;
        if (!container || !propContainer) {
            return;
        }

        this._isDetached = detached;
        if (detached) {
            this._ensureFloatingWindow();
            if (!this._floatingBounds) {
                this._floatingBounds = loadDichromeFloatingBounds(window.innerWidth, window.innerHeight);
            }
            this._applyFloatingBounds(this._floatingBounds);
            if (this._floatingBodyEl && container.parentElement !== this._floatingBodyEl) {
                this._floatingBodyEl.appendChild(container);
            }
        } else if (container.parentElement !== propContainer) {
            if (placeholder && placeholder.parentElement === propContainer) {
                propContainer.insertBefore(container, placeholder);
            } else {
                propContainer.appendChild(container);
            }
        }

        this._updateViewToggleUI();
    }

    public override setVisible(isVisible: boolean): void {
        super.setVisible(isVisible);
        this._syncFloatingVisibility();
    }

    private _updateUI(): void {
        this._updateViewToggleUI();

        if (this._viewMode === 'equalizer') {
            this._renderEqualizerHTML();
        } else {
            this._renderRadarSVG();
        }

        const btnWeights = document.getElementById(this._getId() + '-mode-weights') as HTMLButtonElement | null;
        const btnPercents = document.getElementById(this._getId() + '-mode-percentages') as HTMLButtonElement | null;
        const btnEqual = document.getElementById(this._getId() + '-preset-equal') as HTMLButtonElement | null;
        const btnBright = document.getElementById(this._getId() + '-preset-bright') as HTMLButtonElement | null;
        const btnDark = document.getElementById(this._getId() + '-preset-dark') as HTMLButtonElement | null;
        const btnContrast = document.getElementById(this._getId() + '-preset-contrast') as HTMLButtonElement | null;

        const isWeights = this.getValue().mode === 'weights';
        if (btnWeights) {
            btnWeights.classList.toggle('is-active', isWeights);
            btnWeights.setAttribute('aria-selected', String(isWeights));
            btnWeights.disabled = this.disabled;
        }
        if (btnPercents) {
            btnPercents.classList.toggle('is-active', !isWeights);
            btnPercents.setAttribute('aria-selected', String(!isWeights));
            btnPercents.disabled = this.disabled;
        }
        if (btnEqual) btnEqual.disabled = this.disabled;
        if (btnBright) btnBright.disabled = this.disabled;
        if (btnDark) btnDark.disabled = this.disabled;
        if (btnContrast) btnContrast.disabled = this.disabled;
    }

    private _setWeightTone(index: number, newWeight: number): void {
        const current = this.getValue();
        current.values[index] = clampToneWeight(newWeight);
        this._recomputePercentages();
        this._setValue({ ...current });
    }

    private _setPercentageTone(index: number, targetPercent: number): void {
        const current = this.getValue();
        current.values = redistributePercentages(current.values, index, targetPercent);
        this._recomputePercentages();
        this._setValue({ ...current });
    }

    private _onDragRadar(clientX: number, clientY: number): void {
        if (this._draggingIndex < 0 || this.disabled) return;
        const svg = document.getElementById(this._getId() + '-svg') as SVGSVGElement | null;
        if (!svg) return;

        const rect = svg.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return;

        const scaleX = this._viewWidth / rect.width;
        const scaleY = this._viewHeight / rect.height;
        const mx = (clientX - rect.left) * scaleX;
        const my = (clientY - rect.top) * scaleY;

        const cx = this._cx;
        const cy = this._cy;
        const R = this._radius;

        const current = this.getValue();
        const mode = current.mode;
        const n = current.values.length;
        const maxScale = this._dragMaxScale ?? this._getPercentageMaxScale();

        if (n === 2) {
            if (this._draggingIndex === 0) {
                const frac = clampDragFraction((cy - my) / R);
                if (mode === 'weights') {
                    this._setWeightTone(0, frac);
                } else {
                    this._setPercentageTone(0, frac * 100);
                }
            } else if (this._draggingIndex === 1) {
                const frac = clampDragFraction((my - cy) / R);
                if (mode === 'weights') {
                    this._setWeightTone(1, frac);
                } else {
                    this._setPercentageTone(1, frac * 100);
                }
            }
        } else {
            const angle = -Math.PI / 2 + (2 * Math.PI * this._draggingIndex) / n;
            const cos = Math.cos(angle);
            const sin = Math.sin(angle);
            const proj = (mx - cx) * cos + (my - cy) * sin;
            const frac = clampDragFraction(proj / R);

            if (mode === 'weights') {
                this._setWeightTone(this._draggingIndex, frac);
            } else {
                this._setPercentageTone(this._draggingIndex, frac * maxScale);
            }
        }
    }

    private _onDragEqualizer(clientY: number): void {
        if (this._draggingIndex < 0 || this.disabled) return;
        const equalizerEl = document.getElementById(this._getId() + '-equalizer');
        const track = equalizerEl?.querySelector(
            `.radar-eq-track[data-eq-index="${this._draggingIndex}"]`,
        ) as HTMLDivElement | null;
        if (!track) return;

        const rect = track.getBoundingClientRect();
        if (rect.height <= 0) return;

        const frac = computeEqualizerFractionFromClientY(clientY, rect.top, rect.height);
        const current = this.getValue();
        const maxScale = this._dragMaxScale ?? this._getPercentageMaxScale();

        if (current.mode === 'weights') {
            this._setWeightTone(this._draggingIndex, frac);
        } else {
            this._setPercentageTone(this._draggingIndex, frac * maxScale);
        }
    }

    private _onDrag(clientX: number, clientY: number): void {
        if (this._draggingType === 'equalizer') {
            this._onDragEqualizer(clientY);
        } else if (this._draggingType === 'radar') {
            this._onDragRadar(clientX, clientY);
        }
    }

    public override registerEvents(): void {
        const container = UIUtil.getElementById(this._getId()) as HTMLDivElement;
        const btnWeights = UIUtil.getElementById(this._getId() + '-mode-weights') as HTMLButtonElement;
        const btnPercents = UIUtil.getElementById(this._getId() + '-mode-percentages') as HTMLButtonElement;
        const btnEqual = UIUtil.getElementById(this._getId() + '-preset-equal') as HTMLButtonElement;
        const btnBright = UIUtil.getElementById(this._getId() + '-preset-bright') as HTMLButtonElement;
        const btnDark = UIUtil.getElementById(this._getId() + '-preset-dark') as HTMLButtonElement;
        const btnContrast = UIUtil.getElementById(this._getId() + '-preset-contrast') as HTMLButtonElement;
        const btnViewToggle = UIUtil.getElementById(this._getId() + '-view-toggle') as HTMLButtonElement;
        const btnDetachToggle = UIUtil.getElementById(this._getId() + '-detach-toggle') as HTMLButtonElement;
        const btnDockPlaceholder = UIUtil.getElementById(this._getId() + '-dock-placeholder-btn') as HTMLButtonElement;

        btnViewToggle.addEventListener('click', () => {
            if (this.disabled) return;
            this._viewMode = this._viewMode === 'radar' ? 'equalizer' : 'radar';
            saveDichromeViewMode(this._viewMode);
            this._updateUI();
        });

        btnDetachToggle.addEventListener('click', () => {
            if (this.disabled) return;
            this._setDetached(!this._isDetached);
        });

        btnDockPlaceholder.addEventListener('click', () => {
            this._setDetached(false);
        });

        btnWeights.addEventListener('click', () => {
            if (this.disabled) return;
            const current = this.getValue();
            if (current.mode === 'weights') return;
            current.mode = 'weights';
            const maxP = Math.max(...current.percentages, 1);
            current.values = current.percentages.map((p) => Math.max(0, Math.round((p / maxP) * 100) / 100));
            this._recomputePercentages();
            this._setValue({ ...current });
        });

        btnPercents.addEventListener('click', () => {
            if (this.disabled) return;
            const current = this.getValue();
            if (current.mode === 'percentages') return;
            current.mode = 'percentages';
            current.values = [...current.percentages];
            this._recomputePercentages();
            this._setValue({ ...current });
        });

        btnEqual.addEventListener('click', () => {
            if (this.disabled) return;
            const current = this.getValue();
            const n = current.values.length;
            if (current.mode === 'weights') {
                current.values = Array.from({ length: n }, () => 1.0);
            } else {
                current.values = Array.from({ length: n }, () => Math.round((100 / n) * 10) / 10);
                const diff = 100 - current.values.reduce((a, b) => a + b, 0);
                current.values[n - 1] = Math.round((current.values[n - 1] + diff) * 10) / 10;
            }
            this._recomputePercentages();
            this._setValue({ ...current });
        });

        btnBright.addEventListener('click', () => {
            if (this.disabled) return;
            const current = this.getValue();
            const n = current.values.length;
            if (n === 2) {
                current.values = current.mode === 'weights' ? [0.33, 1.0] : [25.0, 75.0];
            } else {
                const rawWeights = Array.from({ length: n }, (_, i) => 0.2 + 0.8 * (i / (n - 1)));
                if (current.mode === 'weights') {
                    current.values = rawWeights.map((w) => Math.round(w * 100) / 100);
                } else {
                    const sumW = rawWeights.reduce((a, b) => a + b, 0);
                    let allocated = 0;
                    current.values = rawWeights.map((w, i) => {
                        if (i < n - 1) {
                            const p = Math.round((w / sumW) * 1000) / 10;
                            allocated += p;
                            return p;
                        }
                        return Math.max(0, Math.round((100 - allocated) * 10) / 10);
                    });
                }
            }
            this._recomputePercentages();
            this._setValue({ ...current });
        });

        btnDark.addEventListener('click', () => {
            if (this.disabled) return;
            const current = this.getValue();
            const n = current.values.length;
            if (n === 2) {
                current.values = current.mode === 'weights' ? [1.0, 0.33] : [75.0, 25.0];
            } else {
                const rawWeights = Array.from({ length: n }, (_, i) => 1.0 - 0.8 * (i / (n - 1)));
                if (current.mode === 'weights') {
                    current.values = rawWeights.map((w) => Math.round(w * 100) / 100);
                } else {
                    const sumW = rawWeights.reduce((a, b) => a + b, 0);
                    let allocated = 0;
                    current.values = rawWeights.map((w, i) => {
                        if (i < n - 1) {
                            const p = Math.round((w / sumW) * 1000) / 10;
                            allocated += p;
                            return p;
                        }
                        return Math.max(0, Math.round((100 - allocated) * 10) / 10);
                    });
                }
            }
            this._recomputePercentages();
            this._setValue({ ...current });
        });

        btnContrast.addEventListener('click', () => {
            if (this.disabled) return;
            const current = this.getValue();
            const n = current.values.length;
            if (n === 2) {
                current.values = current.mode === 'weights' ? [1.0, 1.0] : [50.0, 50.0];
            } else if (current.mode === 'weights') {
                current.values = Array.from({ length: n }, (_, i) => (i === 0 || i === n - 1) ? 1.0 : 0.2);
            } else {
                const extremeShare = n === 3 ? 45.0 : n === 4 ? 40.0 : 35.0;
                const midTotal = 100 - (2 * extremeShare);
                const midCount = Math.max(1, n - 2);
                const midShare = Math.round((midTotal / midCount) * 10) / 10;
                let allocated = 0;
                current.values = Array.from({ length: n }, (_, i) => {
                    if (i === 0) {
                        allocated += extremeShare;
                        return extremeShare;
                    }
                    if (i === n - 1) {
                        return Math.max(0, Math.round((100 - allocated) * 10) / 10);
                    }
                    allocated += midShare;
                    return midShare;
                });
            }
            this._recomputePercentages();
            this._setValue({ ...current });
        });

        container.addEventListener('keydown', (e: KeyboardEvent) => {
            if (this.disabled) return;
            const target = e.target as HTMLElement | null;
            const eqTrack = target?.closest('.radar-eq-track') as HTMLDivElement | null;
            if (!eqTrack) return;
            if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;

            const idx = parseInt(eqTrack.dataset.eqIndex ?? '-1', 10);
            if (idx < 0) return;

            e.preventDefault();
            const delta = e.key === 'ArrowUp' ? 1 : -1;
            const current = this.getValue();
            if (current.mode === 'weights') {
                this._setWeightTone(idx, (current.values[idx] ?? 1.0) + delta * 0.05);
            } else {
                this._setPercentageTone(idx, (current.percentages[idx] ?? 0) + delta * 2.5);
            }
        });

        container.addEventListener('mousedown', (e: MouseEvent) => {
            if (this.disabled) return;
            const target = e.target as HTMLElement | null;

            const handleGroup = target?.closest('.radar-handle-group') as SVGElement | null;
            if (handleGroup) {
                const idx = parseInt(handleGroup.dataset.handleIndex ?? '-1', 10);
                if (idx >= 0) {
                    this._draggingIndex = idx;
                    this._draggingType = 'radar';
                    this._dragMaxScale = this._getPercentageMaxScale();
                    this._onDrag(e.clientX, e.clientY);
                    e.preventDefault();
                }
                return;
            }

            const eqTrack = target?.closest('.radar-eq-track') as HTMLDivElement | null;
            if (eqTrack) {
                const idx = parseInt(eqTrack.dataset.eqIndex ?? '-1', 10);
                if (idx >= 0) {
                    this._draggingIndex = idx;
                    this._draggingType = 'equalizer';
                    this._dragMaxScale = this._getPercentageMaxScale();
                    this._onDrag(e.clientX, e.clientY);
                    e.preventDefault();
                }
            }
        });

        window.addEventListener('mousemove', (e: MouseEvent) => {
            if (this._windowDragState) {
                const dx = e.clientX - this._windowDragState.startX;
                const dy = e.clientY - this._windowDragState.startY;
                if (this._windowDragState.type === 'move') {
                    this._applyFloatingBounds(
                        applyFloatingMove(this._windowDragState.startBounds, dx, dy, window.innerWidth, window.innerHeight),
                    );
                } else if (this._windowDragState.type === 'resize' && this._windowDragState.edge) {
                    this._applyFloatingBounds(
                        applyFloatingResize(
                            this._windowDragState.startBounds,
                            this._windowDragState.edge,
                            dx,
                            dy,
                            window.innerWidth,
                            window.innerHeight,
                        ),
                    );
                }
                return;
            }
            if (this._draggingIndex >= 0 && this._draggingType !== null) {
                this._onDrag(e.clientX, e.clientY);
            }
        });

        window.addEventListener('mouseup', () => {
            if (this._windowDragState) {
                this._windowDragState = null;
                this._floatingWindowEl?.classList.remove('is-moving');
                if (this._floatingBounds) {
                    saveDichromeFloatingBounds(this._floatingBounds);
                }
            }
            if (this._draggingIndex >= 0) {
                this._draggingIndex = -1;
                this._draggingType = null;
                this._dragMaxScale = null;
                this._updateUI();
            }
        });

        container.addEventListener('touchstart', (e: TouchEvent) => {
            if (this.disabled || e.touches.length === 0) return;
            const target = e.target as HTMLElement | null;

            const handleGroup = target?.closest('.radar-handle-group') as SVGElement | null;
            if (handleGroup) {
                const idx = parseInt(handleGroup.dataset.handleIndex ?? '-1', 10);
                if (idx >= 0) {
                    this._draggingIndex = idx;
                    this._draggingType = 'radar';
                    this._dragMaxScale = this._getPercentageMaxScale();
                    this._onDrag(e.touches[0].clientX, e.touches[0].clientY);
                    e.preventDefault();
                }
                return;
            }

            const eqTrack = target?.closest('.radar-eq-track') as HTMLDivElement | null;
            if (eqTrack) {
                const idx = parseInt(eqTrack.dataset.eqIndex ?? '-1', 10);
                if (idx >= 0) {
                    this._draggingIndex = idx;
                    this._draggingType = 'equalizer';
                    this._dragMaxScale = this._getPercentageMaxScale();
                    this._onDrag(e.touches[0].clientX, e.touches[0].clientY);
                    e.preventDefault();
                }
            }
        }, { passive: false });

        window.addEventListener('touchmove', (e: TouchEvent) => {
            if (this._windowDragState && e.touches.length > 0) {
                const dx = e.touches[0].clientX - this._windowDragState.startX;
                const dy = e.touches[0].clientY - this._windowDragState.startY;
                if (this._windowDragState.type === 'move') {
                    this._applyFloatingBounds(
                        applyFloatingMove(this._windowDragState.startBounds, dx, dy, window.innerWidth, window.innerHeight),
                    );
                } else if (this._windowDragState.type === 'resize' && this._windowDragState.edge) {
                    this._applyFloatingBounds(
                        applyFloatingResize(
                            this._windowDragState.startBounds,
                            this._windowDragState.edge,
                            dx,
                            dy,
                            window.innerWidth,
                            window.innerHeight,
                        ),
                    );
                }
                e.preventDefault();
                return;
            }
            if (this._draggingIndex >= 0 && this._draggingType !== null && e.touches.length > 0) {
                this._onDrag(e.touches[0].clientX, e.touches[0].clientY);
                e.preventDefault();
            }
        }, { passive: false });

        window.addEventListener('touchend', () => {
            if (this._windowDragState) {
                this._windowDragState = null;
                this._floatingWindowEl?.classList.remove('is-moving');
                if (this._floatingBounds) {
                    saveDichromeFloatingBounds(this._floatingBounds);
                }
            }
            if (this._draggingIndex >= 0) {
                this._draggingIndex = -1;
                this._draggingType = null;
                this._dragMaxScale = null;
                this._updateUI();
            }
        });

        window.addEventListener('resize', () => {
            if (this._isDetached && this._floatingBounds) {
                this._applyFloatingBounds(this._floatingBounds);
            }
        });

        this._updateUI();
    }

    protected override _onValueChanged(): void {
        this._recomputePercentages();
        this._updateUI();
    }

    protected override _onEnabledChanged(): void {
        super._onEnabledChanged();
        this._updateUI();
    }

    public override refresh(): void {
        super.refresh();
        const btnWeights = document.getElementById(this._getId() + '-mode-weights');
        const btnPercents = document.getElementById(this._getId() + '-mode-percentages');
        const btnEqual = document.getElementById(this._getId() + '-preset-equal');
        const btnBright = document.getElementById(this._getId() + '-preset-bright');
        const btnDark = document.getElementById(this._getId() + '-preset-dark');
        const btnContrast = document.getElementById(this._getId() + '-preset-contrast');
        const noticeEl = document.getElementById(this._getId() + '-detached-notice');
        const placeholderDockBtn = document.getElementById(this._getId() + '-dock-placeholder-btn');
        const floatingTitle = document.getElementById(this._getId() + '-floating-title');
        const floatingDockBtn = document.getElementById(this._getId() + '-floating-dock');

        if (btnWeights) btnWeights.textContent = LOC('assign.components.dichrome_mode_weights');
        if (btnPercents) btnPercents.textContent = LOC('assign.components.dichrome_mode_percentages');
        if (btnEqual) btnEqual.textContent = LOC('assign.components.dichrome_preset_equal');
        if (btnBright) btnBright.textContent = LOC('assign.components.dichrome_preset_bright');
        if (btnDark) btnDark.textContent = LOC('assign.components.dichrome_preset_dark');
        if (btnContrast) btnContrast.textContent = LOC('assign.components.dichrome_preset_contrast');
        if (noticeEl) noticeEl.textContent = LOC('assign.components.dichrome_detached_notice');
        if (placeholderDockBtn) placeholderDockBtn.textContent = LOC('assign.components.dichrome_dock_window');
        if (floatingTitle) floatingTitle.textContent = LOC('assign.components.dichrome_floating_title');
        if (floatingDockBtn) {
            const dockTip = LOC('assign.components.dichrome_dock_window');
            floatingDockBtn.setAttribute('title', dockTip);
            floatingDockBtn.setAttribute('aria-label', dockTip);
        }
        if (this._floatingWindowEl) {
            this._floatingWindowEl.setAttribute('aria-label', LOC('assign.components.dichrome_floating_title'));
        }

        this._updateUI();
    }
}
