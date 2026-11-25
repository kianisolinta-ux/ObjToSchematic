import { PALETTE_ALL_RELEASE } from '../res/palettes/all';
import {
    BUILTIN_PALETTE_PRESETS,
    filterSupportedBlocks,
    getBuiltinPresetBlocks,
    getDefaultStorage,
    IActivePaletteState,
    ICustomPalettePreset,
    IStorageLike,
    MANUAL_SELECTION_PRESET_ID,
    normalizeBlockName,
} from './palette_presets';

export const DICHROME_ACTIVE_PALETTE_STORAGE_KEY = 'ots_dichrome_active_palette_v1';

export interface IDichromeParsedPaletteResult {
    blocks: string[];
    unsupportedTokens: string[];
    totalTokens: number;
}

export function parseDichromePaletteText(
    text: string,
    supportedBlocks: readonly string[] = PALETTE_ALL_RELEASE,
): IDichromeParsedPaletteResult {
    const supportedSet = new Set(supportedBlocks.map((b) => normalizeBlockName(b)));
    const lines = text.split(/\r?\n/);
    const blocks: string[] = [];
    const seen = new Set<string>();
    const unsupportedTokens: string[] = [];
    let totalTokens = 0;

    for (const rawLine of lines) {
        const trimmed = rawLine.trim();
        if (trimmed.length === 0 || trimmed.startsWith('#') || trimmed.startsWith('//')) {
            continue;
        }
        ++totalTokens;
        const normalized = normalizeBlockName(trimmed);
        if (!supportedSet.has(normalized)) {
            unsupportedTokens.push(trimmed);
            continue;
        }
        if (!seen.has(normalized)) {
            seen.add(normalized);
            blocks.push(normalized);
        }
    }

    return {
        blocks,
        unsupportedTokens,
        totalTokens,
    };
}

export function sortBlocksByLightness(
    blocks: readonly string[],
    lightnessMap: ReadonlyMap<string, number>,
): string[] {
    return [...blocks].sort((a, b) => {
        const lA = lightnessMap.get(a) ?? 0;
        const lB = lightnessMap.get(b) ?? 0;
        return lA - lB || a.localeCompare(b);
    });
}

function areBlockSetsEqual(a: readonly string[], b: readonly string[]): boolean {
    if (a.length !== b.length) {
        return false;
    }
    const setB = new Set(b);
    for (const item of a) {
        if (!setB.has(item)) {
            return false;
        }
    }
    return true;
}

function areBlockArraysEqual(a: readonly string[], b: readonly string[]): boolean {
    if (a.length !== b.length) {
        return false;
    }
    for (let i = 0; i < a.length; ++i) {
        if (a[i] !== b[i]) {
            return false;
        }
    }
    return true;
}

export function detectMatchingDichromePresetId(
    selectedBlocks: readonly string[],
    customPresets: readonly ICustomPalettePreset[],
    supportedBlocks: readonly string[] = PALETTE_ALL_RELEASE,
    preferredPresetId?: string,
): string {
    const normalizedSelected = filterSupportedBlocks(selectedBlocks, supportedBlocks);

    if (preferredPresetId) {
        const preferredCustom = customPresets.find((p) => p.id === preferredPresetId);
        if (preferredCustom && areBlockArraysEqual(normalizedSelected, preferredCustom.blocks)) {
            return preferredCustom.id;
        }
        const preferredBuiltin = BUILTIN_PALETTE_PRESETS.find((p) => p.id === preferredPresetId);
        if (preferredBuiltin) {
            const builtinBlocks = getBuiltinPresetBlocks(preferredBuiltin.id, supportedBlocks);
            if (areBlockSetsEqual(normalizedSelected, builtinBlocks)) {
                return preferredBuiltin.id;
            }
        }
    }

    for (const custom of customPresets) {
        if (areBlockArraysEqual(normalizedSelected, custom.blocks)) {
            return custom.id;
        }
    }

    for (const builtin of BUILTIN_PALETTE_PRESETS) {
        const builtinBlocks = getBuiltinPresetBlocks(builtin.id, supportedBlocks);
        if (areBlockSetsEqual(normalizedSelected, builtinBlocks)) {
            return builtin.id;
        }
    }

    return MANUAL_SELECTION_PRESET_ID;
}

export function loadDichromeActivePaletteState(
    supportedBlocks: readonly string[] = PALETTE_ALL_RELEASE,
    storage: IStorageLike | null = getDefaultStorage(),
): IActivePaletteState | null {
    if (!storage) {
        return null;
    }

    try {
        const raw = storage.getItem(DICHROME_ACTIVE_PALETTE_STORAGE_KEY);
        if (!raw) {
            return null;
        }
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.blocks)) {
            return null;
        }

        const rawBlocks = parsed.blocks.filter((b: unknown): b is string => typeof b === 'string');
        const blocks = filterSupportedBlocks(rawBlocks, supportedBlocks);
        if (blocks.length < 2) {
            return null;
        }
        const presetId = typeof parsed.presetId === 'string' ? parsed.presetId : MANUAL_SELECTION_PRESET_ID;
        return { presetId, blocks };
    } catch {
        return null;
    }
}

export function saveDichromeActivePaletteState(
    state: IActivePaletteState,
    supportedBlocks: readonly string[] = PALETTE_ALL_RELEASE,
    storage: IStorageLike | null = getDefaultStorage(),
): boolean {
    if (!storage) {
        return false;
    }

    const blocks = filterSupportedBlocks(state.blocks, supportedBlocks);
    if (blocks.length < 2) {
        return false;
    }

    try {
        storage.setItem(DICHROME_ACTIVE_PALETTE_STORAGE_KEY, JSON.stringify({
            presetId: state.presetId,
            blocks,
        }));
        return true;
    } catch {
        return false;
    }
}
