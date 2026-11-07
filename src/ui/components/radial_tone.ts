import { PALETTE_ALL_RELEASE } from '../../../res/palettes/all';
import { Atlas } from '../../atlas';
import { RGBAUtil } from '../../colour';
import { LOC } from '../../localiser';
import { AppUtil } from '../../util';
import { UIUtil } from '../../util/ui_util';
import { ConfigComponent } from './config';

export type TToneMode = 'weights' | 'percentages';

export interface TDichromeToneConfig {
    mode: TToneMode;
    values: number[]; // Mode 'weights': array of 0..1 (default 1.0); Mode 'percentages': array of 0..100 (sum=100)
    percentages: number[]; // Normalized percentages summing to 100
}

/**
 * Interactive Radar (Spider) Diagram for Dichrome tone distribution.
 * Displays a multi-axis coordinate spider-web with a draggable polygon.
 * Supports:
 * - Mode 1 ('weights'): independent weight [0..1] per tone (default 1.0 = outer ring).
 * - Mode 2 ('percentages'): direct % per tone with automatic redistribution to 100%.
 * - Scaled coordinate axes so polygon is generously sized and never collapses to a single point.
 * - 2D diamond coordinate polygon for N = 2 so 2-tone mode is fully visible and interactive.
 */
export class RadialToneDistributionComponent extends ConfigComponent<TDichromeToneConfig, HTMLDivElement> {
    private _blockNames: string[];
    private _blockColours: Map<string, string>;
    private _draggingIndex: number;
    private _activeHoverIndex: number;

    // ViewBox dimensions and radar geometry
    private readonly _viewWidth = 380;
    private readonly _viewHeight = 340;
    private readonly _cx = 190;
    private readonly _cy = 168;
    private readonly _radius = 115;
    private readonly _labelRadius = 144;

    public constructor(initialBlocks: string[] = ['minecraft:black_concrete', 'minecraft:white_concrete']) {
        const initialCount = Math.max(2, initialBlocks.length);
        const equalPercents = Array.from({ length: initialCount }, () => 100 / initialCount);

        super({
            mode: 'weights',
            values: Array.from({ length: initialCount }, () => 1.0),
            percentages: equalPercents,
        });

        this._blockNames = [...initialBlocks];
        this._blockColours = new Map();
        this._draggingIndex = -1;
        this._activeHoverIndex = -1;

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
     * Remove the 40% left label column to save space as requested,
     * giving the radar diagram 100% full width of the sidebar.
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
        const n = Math.max(2, current.values.length);

        if (current.mode === 'weights') {
            const sum = current.values.reduce((a, b) => a + Math.max(0, b), 0);
            if (sum <= 0) {
                current.percentages = Array.from({ length: n }, () => Math.round((100 / n) * 10) / 10);
            } else {
                let roundedTotal = 0;
                const p = current.values.map((v, i) => {
                    const frac = Math.max(0, v) / sum;
                    const rounded = Math.round(frac * 1000) / 10;
                    if (i < n - 1) roundedTotal += rounded;
                    return rounded;
                });
                p[n - 1] = Math.max(0, Math.round((100 - roundedTotal) * 10) / 10);
                current.percentages = p;
            }
        } else {
            let sum = current.values.reduce((a, b) => a + Math.max(0, b), 0);
            if (sum <= 0) {
                current.values = Array.from({ length: n }, () => Math.round((100 / n) * 10) / 10);
                sum = 100;
            }
            let roundedTotal = 0;
            const p = current.values.map((v, i) => {
                const rounded = Math.round((v / sum) * 1000) / 10;
                if (i < n - 1) roundedTotal += rounded;
                return rounded;
            });
            p[n - 1] = Math.max(0, Math.round((100 - roundedTotal) * 10) / 10);
            current.percentages = p;
        }
    }

    protected override _generateInnerHTML(): string {
        return `
            <div class="radar-tone-container" id="${this._getId()}">
                <div class="radar-tone-header">
                    <div class="radar-tone-mode-toggle" role="tablist">
                        <button
                            type="button"
                            class="radar-tone-mode-btn ${this.getValue().mode === 'weights' ? 'is-active' : ''}"
                            id="${this._getId()}-mode-weights"
                            role="tab"
                            aria-selected="${this.getValue().mode === 'weights'}"
                        >
                            ${LOC('assign.components.dichrome_mode_weights')}
                        </button>
                        <button
                            type="button"
                            class="radar-tone-mode-btn ${this.getValue().mode === 'percentages' ? 'is-active' : ''}"
                            id="${this._getId()}-mode-percentages"
                            role="tab"
                            aria-selected="${this.getValue().mode === 'percentages'}"
                        >
                            ${LOC('assign.components.dichrome_mode_percentages')}
                        </button>
                    </div>
                    <div class="radar-tone-presets">
                        <button type="button" class="radar-tone-preset-btn" id="${this._getId()}-preset-equal" title="Equal distribution">
                            ${LOC('assign.components.dichrome_preset_equal')}
                        </button>
                        <button type="button" class="radar-tone-preset-btn" id="${this._getId()}-preset-contrast" title="Contrast: extreme tones">
                            ${LOC('assign.components.dichrome_preset_contrast')}
                        </button>
                        <button type="button" class="radar-tone-preset-btn" id="${this._getId()}-preset-midtones" title="Midtones: center tones">
                            ${LOC('assign.components.dichrome_preset_midtones')}
                        </button>
                    </div>
                </div>

                <div class="radar-tone-canvas-card">
                    <div class="radar-tone-diagram-wrapper" id="${this._getId()}-diagram"></div>
                </div>
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

    /**
     * Compute the maximum percentage scale for the radar chart in percentage mode,
     * so that equal distribution (100/N%) sits comfortably at 55%-60% of the radius,
     * preventing nodes from ever collapsing into an indistinguishable central cluster.
     */
    private _getPercentageMaxScale(): number {
        const current = this.getValue();
        const n = Math.max(2, current.values.length);
        const baseline = (100 / n) * 1.75;
        const maxVal = Math.max(...current.percentages, baseline);
        return Math.min(100, Math.max(30, Math.ceil(maxVal / 5) * 5));
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
        const maxScale = this._getPercentageMaxScale();

        const levels = [0.25, 0.5, 0.75, 1.0];

        // 1. Concentric circles & rings
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

        // 2. Level numeric scale labels along upper-right diagonal
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
                    font-family="'Martian Mono', monospace"
                    text-anchor="start"
                >
                    ${text}
                </text>
            `);
        });

        let gridPolygons: string[] = [];
        let axisLines: string[] = [];
        let polyPoints: Array<{ x: number, y: number }> = [];
        let handles: string[] = [];
        let labels: string[] = [];

        if (n === 2) {
            // N = 2: 2D diamond coordinate polygon
            // Tone 0 (Dark) on Top, Tone 1 (Light) on Bottom
            // Horizontal wings at East and West ensure a full 2D polygon with area & fill
            let frac0: number;
            let frac1: number;
            if (mode === 'weights') {
                frac0 = Math.max(0.04, Math.min(1.0, current.values[0] ?? 1.0));
                frac1 = Math.max(0.04, Math.min(1.0, current.values[1] ?? 1.0));
            } else {
                frac0 = Math.max(0.04, Math.min(1.0, (current.percentages[0] ?? 50) / maxScale));
                frac1 = Math.max(0.04, Math.min(1.0, (current.percentages[1] ?? 50) / maxScale));
            }

            const wingFrac = Math.max(0.12, ((frac0 + frac1) / 2) * 0.65);
            const topPt = { x: cx, y: cy - R * frac0 };
            const bottomPt = { x: cx, y: cy + R * frac1 };
            const rightPt = { x: cx + R * wingFrac, y: cy };
            const leftPt = { x: cx - R * wingFrac, y: cy };

            polyPoints = [topPt, rightPt, bottomPt, leftPt];

            // Primary vertical axis + subtle horizontal balance axis
            axisLines.push(`
                <line x1="${cx}" y1="${(cy - R).toFixed(1)}" x2="${cx}" y2="${(cy + R).toFixed(1)}" stroke="rgba(255, 255, 255, 0.22)" stroke-width="1.5" />
                <line x1="${(cx - R * 0.85).toFixed(1)}" y1="${cy}" x2="${(cx + R * 0.85).toFixed(1)}" y2="${cy}" stroke="rgba(255, 255, 255, 0.12)" stroke-width="1" stroke-dasharray="2 2" />
            `);

            // Draggable handles for Tone 0 (Top) and Tone 1 (Bottom)
            const pts = [topPt, bottomPt];
            for (let i = 0; i < 2; ++i) {
                const p = pts[i];
                const blockName = this._blockNames[i] ?? (i === 0 ? 'minecraft:black_concrete' : 'minecraft:white_concrete');
                const colour = this._blockColours.get(blockName) ?? (i === 0 ? '#111827' : '#f9fafb');
                const isDragging = i === this._draggingIndex;
                const isHovered = i === this._activeHoverIndex;

                handles.push(`
                    <g class="radar-handle-group" data-handle-index="${i}">
                        <circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="18" fill="transparent" class="radar-handle-hit" />
                        <circle
                            cx="${p.x.toFixed(1)}"
                            cy="${p.y.toFixed(1)}"
                            r="${isDragging || isHovered ? '9.5' : '8'}"
                            fill="${colour}"
                            stroke="${isDragging ? '#00e5ff' : '#ffffff'}"
                            stroke-width="2.5"
                            class="radar-handle-circle ${isDragging ? 'is-dragging' : ''}"
                        />
                    </g>
                `);
            }

            // Labels: Tone 0 Top, Tone 1 Bottom
            for (let i = 0; i < 2; ++i) {
                const blockName = this._blockNames[i] ?? (i === 0 ? 'minecraft:black_concrete' : 'minecraft:white_concrete');
                const colour = this._blockColours.get(blockName) ?? '#888';
                const toneLabel = this._getToneLabel(i, 2);
                const ly = i === 0 ? cy - labelR : cy + labelR;
                const swatchY = i === 0 ? cy - (R + 10) : cy + (R + 10);

                const valStr = mode === 'weights' ?
                    `${(current.values[i] ?? 1.0).toFixed(2)} (${(current.percentages[i] ?? 50).toFixed(0)}%)` :
                    `${(current.percentages[i] ?? 50).toFixed(1)}%`;

                labels.push(`
                    <g class="radar-axis-label-group" transform="translate(${cx}, ${ly.toFixed(1)})" text-anchor="middle">
                        <text x="0" y="${i === 0 ? -4 : 10}" class="radar-label-tone" fill="var(--text-bright)" font-size="11.5" font-weight="600">
                            ${this._escapeHTML(toneLabel)}
                        </text>
                        <text x="0" y="${i === 0 ? 9 : 22}" class="radar-label-val" fill="var(--blue-700)" font-size="11" font-family="'Martian Mono', monospace">
                            ${this._escapeHTML(valStr)}
                        </text>
                    </g>
                    <circle cx="${cx}" cy="${swatchY.toFixed(1)}" r="5" fill="${colour}" stroke="rgba(255,255,255,0.4)" stroke-width="1.2" />
                `);
            }
        } else {
            // N >= 3: Multi-axis radar polygon
            const angles: number[] = [];
            for (let i = 0; i < n; ++i) {
                angles.push(-Math.PI / 2 + (2 * Math.PI * i) / n);
            }

            // Concentric N-gon webs
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

            // Radial axis lines
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

            // Polygon points
            for (let i = 0; i < n; ++i) {
                let frac: number;
                if (mode === 'weights') {
                    frac = Math.max(0.04, Math.min(1.0, current.values[i] ?? 1.0));
                } else {
                    frac = Math.max(0.04, Math.min(1.0, (current.percentages[i] ?? 0) / maxScale));
                }
                const px = cx + R * frac * Math.cos(angles[i]);
                const py = cy + R * frac * Math.sin(angles[i]);
                polyPoints.push({ x: px, y: py });
            }

            // Draggable vertex handles
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

            // Perimeter labels
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
                    `${(current.values[i] ?? 1.0).toFixed(2)} (${(current.percentages[i] ?? 0).toFixed(0)}%)` :
                    `${(current.percentages[i] ?? 0).toFixed(1)}%`;

                const swatchX = cx + (R + 10) * cos;
                const swatchY = cy + (R + 10) * sin;

                labels.push(`
                    <g class="radar-axis-label-group" transform="translate(${(lx + dx).toFixed(1)}, ${(ly + dy).toFixed(1)})" text-anchor="${anchor}">
                        <text x="0" y="-3" class="radar-label-tone" fill="var(--text-bright)" font-size="11" font-weight="600">
                            ${this._escapeHTML(toneLabel)}
                        </text>
                        <text x="0" y="10" class="radar-label-val" fill="var(--blue-700)" font-size="10.5" font-family="'Martian Mono', monospace">
                            ${this._escapeHTML(valStr)}
                        </text>
                    </g>
                    <circle cx="${swatchX.toFixed(1)}" cy="${swatchY.toFixed(1)}" r="4.5" fill="${colour}" stroke="rgba(255,255,255,0.4)" stroke-width="1.2" />
                `);
            }
        }

        const polygonString = polyPoints.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');

        container.innerHTML = `
            <svg
                class="radar-tone-svg"
                id="${this._getId()}-svg"
                viewBox="0 0 ${width} ${height}"
                preserveAspectRatio="xMidYMid meet"
                style="user-select: none; display: block;"
            >
                <defs>
                    <filter id="${this._getId()}-glow" x="-20%" y="-20%" width="140%" height="140%">
                        <feDropShadow dx="0" dy="2" stdDeviation="5" flood-color="rgba(0, 200, 255, 0.55)" />
                    </filter>
                    <radialGradient id="${this._getId()}-polygrad" cx="50%" cy="50%" r="50%">
                        <stop offset="0%" stop-color="rgba(34, 211, 238, 0.38)" />
                        <stop offset="100%" stop-color="rgba(6, 182, 212, 0.16)" />
                    </radialGradient>
                </defs>

                <!-- Grid Web & Levels -->
                <g class="radar-grid">
                    ${gridCircles.join('')}
                    ${gridPolygons.join('')}
                    ${axisLines.join('')}
                    ${levelLabels.join('')}
                    <circle cx="${cx}" cy="${cy}" r="3" fill="rgba(255,255,255,0.5)" />
                </g>

                <!-- Data Polygon -->
                <polygon
                    points="${polygonString}"
                    fill="url(#${this._getId()}-polygrad)"
                    stroke="#22d3ee"
                    stroke-width="2.5"
                    stroke-linejoin="round"
                    filter="url(#${this._getId()}-glow)"
                    class="radar-polygon"
                />

                <!-- Draggable Handles -->
                <g class="radar-handles">
                    ${handles.join('')}
                </g>

                <!-- Axis Labels -->
                <g class="radar-labels">
                    ${labels.join('')}
                </g>
            </svg>
        `;
    }

    private _updateUI(): void {
        this._renderRadarSVG();

        const btnWeights = document.getElementById(this._getId() + '-mode-weights');
        const btnPercents = document.getElementById(this._getId() + '-mode-percentages');
        const isWeights = this.getValue().mode === 'weights';
        if (btnWeights) {
            btnWeights.classList.toggle('is-active', isWeights);
            btnWeights.setAttribute('aria-selected', String(isWeights));
        }
        if (btnPercents) {
            btnPercents.classList.toggle('is-active', !isWeights);
            btnPercents.setAttribute('aria-selected', String(!isWeights));
        }
    }

    private _setWeightTone(index: number, newWeight: number): void {
        const current = this.getValue();
        current.values[index] = Math.max(0.04, Math.min(1.0, Math.round(newWeight * 100) / 100));
        this._recomputePercentages();
        this._setValue({ ...current });
    }

    private _setPercentageTone(index: number, targetPercent: number): void {
        const current = this.getValue();
        const n = current.values.length;
        const clampedTarget = Math.max(0.5, Math.min(99.5, Math.round(targetPercent * 10) / 10));

        current.values[index] = clampedTarget;

        const targetOthers = 100 - clampedTarget;
        const otherIndices = Array.from({ length: n }, (_, i) => i).filter((i) => i !== index);
        const sumOthers = otherIndices.reduce((sum, i) => sum + (current.values[i] ?? 0), 0);

        if (targetOthers <= 0) {
            otherIndices.forEach((i) => {
                current.values[i] = 0;
            });
        } else if (sumOthers <= 0) {
            const share = Math.round((targetOthers / otherIndices.length) * 10) / 10;
            let allocated = 0;
            otherIndices.forEach((i, idx) => {
                if (idx < otherIndices.length - 1) {
                    current.values[i] = share;
                    allocated += share;
                } else {
                    current.values[i] = Math.max(0, Math.round((targetOthers - allocated) * 10) / 10);
                }
            });
        } else {
            let allocated = 0;
            otherIndices.forEach((i, idx) => {
                const ratio = current.values[i] / sumOthers;
                const rounded = Math.round(ratio * targetOthers * 10) / 10;
                if (idx < otherIndices.length - 1) {
                    current.values[i] = rounded;
                    allocated += rounded;
                } else {
                    current.values[i] = Math.max(0, Math.round((targetOthers - allocated) * 10) / 10);
                }
            });
        }

        this._recomputePercentages();
        this._setValue({ ...current });
    }

    private _onDrag(clientX: number, clientY: number): void {
        if (this._draggingIndex < 0 || this.disabled) return;
        const svg = document.getElementById(this._getId() + '-svg') as SVGSVGElement | null;
        if (!svg) return;

        const rect = svg.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return;

        // Map mouse/touch coordinates to SVG viewBox
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
        const maxScale = this._getPercentageMaxScale();

        if (n === 2) {
            // N = 2: dragging along vertical axis
            if (this._draggingIndex === 0) {
                // Top handle (Tone 0: Dark)
                const frac = Math.max(0.04, Math.min(1.0, (cy - my) / R));
                if (mode === 'weights') {
                    this._setWeightTone(0, frac);
                } else {
                    this._setPercentageTone(0, frac * maxScale);
                }
            } else if (this._draggingIndex === 1) {
                // Bottom handle (Tone 1: Light)
                const frac = Math.max(0.04, Math.min(1.0, (my - cy) / R));
                if (mode === 'weights') {
                    this._setWeightTone(1, frac);
                } else {
                    this._setPercentageTone(1, frac * maxScale);
                }
            }
        } else {
            // N >= 3: project mouse vector onto radial axis
            const angle = -Math.PI / 2 + (2 * Math.PI * this._draggingIndex) / n;
            const cos = Math.cos(angle);
            const sin = Math.sin(angle);
            const proj = (mx - cx) * cos + (my - cy) * sin;
            const frac = Math.max(0.04, Math.min(1.0, proj / R));

            if (mode === 'weights') {
                this._setWeightTone(this._draggingIndex, frac);
            } else {
                this._setPercentageTone(this._draggingIndex, frac * maxScale);
            }
        }
    }

    public override registerEvents(): void {
        const container = UIUtil.getElementById(this._getId()) as HTMLDivElement;
        const btnWeights = UIUtil.getElementById(this._getId() + '-mode-weights') as HTMLButtonElement;
        const btnPercents = UIUtil.getElementById(this._getId() + '-mode-percentages') as HTMLButtonElement;
        const btnEqual = UIUtil.getElementById(this._getId() + '-preset-equal') as HTMLButtonElement;
        const btnContrast = UIUtil.getElementById(this._getId() + '-preset-contrast') as HTMLButtonElement;
        const btnMidtones = UIUtil.getElementById(this._getId() + '-preset-midtones') as HTMLButtonElement;

        btnWeights.addEventListener('click', () => {
            if (this.disabled) return;
            const current = this.getValue();
            if (current.mode === 'weights') return;
            current.mode = 'weights';
            const maxP = Math.max(...current.percentages, 1);
            current.values = current.percentages.map((p) => Math.max(0.05, Math.round((p / maxP) * 100) / 100));
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

        btnContrast.addEventListener('click', () => {
            if (this.disabled) return;
            const current = this.getValue();
            const n = current.values.length;
            if (current.mode === 'weights') {
                current.values = Array.from({ length: n }, (_, i) => {
                    return (i === 0 || i === n - 1) ? 1.0 : 0.25;
                });
            } else {
                const extremeShare = 35;
                const midtoneTotal = 30;
                const midCount = Math.max(1, n - 2);
                current.values = Array.from({ length: n }, (_, i) => {
                    if (i === 0 || i === n - 1) return extremeShare;
                    return Math.round((midtoneTotal / midCount) * 10) / 10;
                });
                const diff = 100 - current.values.reduce((a, b) => a + b, 0);
                current.values[n - 1] = Math.round((current.values[n - 1] + diff) * 10) / 10;
            }
            this._recomputePercentages();
            this._setValue({ ...current });
        });

        btnMidtones.addEventListener('click', () => {
            if (this.disabled) return;
            const current = this.getValue();
            const n = current.values.length;
            if (current.mode === 'weights') {
                current.values = Array.from({ length: n }, (_, i) => {
                    return (i === 0 || i === n - 1) ? 0.2 : 1.0;
                });
            } else {
                const extremeShare = 15;
                const midtoneTotal = 70;
                const midCount = Math.max(1, n - 2);
                current.values = Array.from({ length: n }, (_, i) => {
                    if (i === 0 || i === n - 1) return extremeShare;
                    return Math.round((midtoneTotal / midCount) * 10) / 10;
                });
                const diff = 100 - current.values.reduce((a, b) => a + b, 0);
                current.values[n - 1] = Math.round((current.values[n - 1] + diff) * 10) / 10;
            }
            this._recomputePercentages();
            this._setValue({ ...current });
        });

        // Mouse drag on SVG handles
        container.addEventListener('mousedown', (e: MouseEvent) => {
            if (this.disabled) return;
            const target = e.target as HTMLElement | null;
            const handleGroup = target?.closest('.radar-handle-group') as SVGElement | null;
            if (handleGroup) {
                const idx = parseInt(handleGroup.dataset.handleIndex ?? '-1', 10);
                if (idx >= 0) {
                    this._draggingIndex = idx;
                    this._onDrag(e.clientX, e.clientY);
                    e.preventDefault();
                }
            }
        });

        window.addEventListener('mousemove', (e: MouseEvent) => {
            if (this._draggingIndex >= 0) {
                this._onDrag(e.clientX, e.clientY);
            }
        });

        window.addEventListener('mouseup', () => {
            this._draggingIndex = -1;
        });

        // Touch drag on mobile / tablet
        container.addEventListener('touchstart', (e: TouchEvent) => {
            if (this.disabled || e.touches.length === 0) return;
            const target = e.target as HTMLElement | null;
            const handleGroup = target?.closest('.radar-handle-group') as SVGElement | null;
            if (handleGroup) {
                const idx = parseInt(handleGroup.dataset.handleIndex ?? '-1', 10);
                if (idx >= 0) {
                    this._draggingIndex = idx;
                    this._onDrag(e.touches[0].clientX, e.touches[0].clientY);
                    e.preventDefault();
                }
            }
        }, { passive: false });

        window.addEventListener('touchmove', (e: TouchEvent) => {
            if (this._draggingIndex >= 0 && e.touches.length > 0) {
                this._onDrag(e.touches[0].clientX, e.touches[0].clientY);
                e.preventDefault();
            }
        }, { passive: false });

        window.addEventListener('touchend', () => {
            this._draggingIndex = -1;
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
        const btnContrast = document.getElementById(this._getId() + '-preset-contrast');
        const btnMidtones = document.getElementById(this._getId() + '-preset-midtones');

        if (btnWeights) btnWeights.textContent = LOC('assign.components.dichrome_mode_weights');
        if (btnPercents) btnPercents.textContent = LOC('assign.components.dichrome_mode_percentages');
        if (btnEqual) btnEqual.textContent = LOC('assign.components.dichrome_preset_equal');
        if (btnContrast) btnContrast.textContent = LOC('assign.components.dichrome_preset_contrast');
        if (btnMidtones) btnMidtones.textContent = LOC('assign.components.dichrome_preset_midtones');

        this._updateUI();
    }
}
