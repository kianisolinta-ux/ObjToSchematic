import { PALETTE_ALL_RELEASE } from '../res/palettes/all';
import { PALETTE_COLOURFUL } from '../res/palettes/colourful';
import { PALETTE_GREYSCALE } from '../res/palettes/greyscale';
import { PALETTE_SCHEMATIC_FRIENDLY } from '../res/palettes/schematic-friendly';
import { PALETTE_SURVIVAL_33 } from '../res/palettes/survival-33';

export type TBuiltinPalettePresetId = 'all' | 'survival-33' | 'colourful' | 'greyscale' | 'schematic-friendly';

export const CUSTOM_PRESET_PREFIX = 'custom:';
export const MANUAL_SELECTION_PRESET_ID = '__custom__';
export const CUSTOM_PRESETS_STORAGE_KEY = 'ots_custom_palette_presets_v1';
export const ACTIVE_PALETTE_STORAGE_KEY = 'ots_active_palette_v1';

export interface IStorageLike {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
}

export interface IBuiltinPalettePreset {
    id: TBuiltinPalettePresetId;
    blocks: readonly string[];
}

export interface ICustomPalettePreset {
    id: string;
    name: string;
    blocks: string[];
}

export interface IActivePaletteState {
    presetId: string;
    blocks: string[];
}

export type TSaveCustomPresetResult =
    | { ok: true; preset: ICustomPalettePreset; presets: ICustomPalettePreset[] }
    | { ok: false; reason: 'empty_name' | 'empty_blocks' | 'storage_unavailable' };

export const BUILTIN_PALETTE_PRESETS: readonly IBuiltinPalettePreset[] = [
    { id: 'all', blocks: PALETTE_ALL_RELEASE },
    { id: 'survival-33', blocks: PALETTE_SURVIVAL_33 },
    { id: 'colourful', blocks: PALETTE_COLOURFUL },
    { id: 'greyscale', blocks: PALETTE_GREYSCALE },
    { id: 'schematic-friendly', blocks: PALETTE_SCHEMATIC_FRIENDLY },
];

export function normalizeBlockName(blockName: string): string {
    const trimmed = blockName.trim();
    if (trimmed.length === 0) {
        return '';
    }
    return trimmed.includes(':') ? trimmed : `minecraft:${trimmed}`;
}

export function filterSupportedBlocks(
    blocks: readonly string[],
    supportedBlocks: readonly string[] = PALETTE_ALL_RELEASE,
): string[] {
    const supportedSet = new Set(supportedBlocks.map((b) => normalizeBlockName(b)));
    const result: string[] = [];
    const seen = new Set<string>();

    for (const rawBlock of blocks) {
        const normalized = normalizeBlockName(rawBlock);
        if (normalized.length > 0 && supportedSet.has(normalized) && !seen.has(normalized)) {
            seen.add(normalized);
            result.push(normalized);
        }
    }

    return result;
}

export function getBuiltinPresetBlocks(
    id: TBuiltinPalettePresetId,
    supportedBlocks: readonly string[] = PALETTE_ALL_RELEASE,
): string[] {
    const preset = BUILTIN_PALETTE_PRESETS.find((item) => item.id === id);
    if (!preset) {
        return [];
    }
    return filterSupportedBlocks(preset.blocks, supportedBlocks);
}

export function getDefaultStorage(): IStorageLike | null {
    try {
        if (typeof window !== 'undefined' && typeof window.localStorage !== 'undefined') {
            return window.localStorage;
        }
        if (typeof localStorage !== 'undefined') {
            return localStorage;
        }
    } catch {
        return null;
    }
    return null;
}

export function loadCustomPresets(
    supportedBlocks: readonly string[] = PALETTE_ALL_RELEASE,
    storage: IStorageLike | null = getDefaultStorage(),
): ICustomPalettePreset[] {
    if (!storage) {
        return [];
    }

    try {
        const raw = storage.getItem(CUSTOM_PRESETS_STORAGE_KEY);
        if (!raw) {
            return [];
        }
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) {
            return [];
        }

        const presets: ICustomPalettePreset[] = [];
        const seenIds = new Set<string>();
        for (const item of parsed) {
            if (!item || typeof item !== 'object') {
                continue;
            }
            const name = typeof item.name === 'string' ? item.name.trim() : '';
            const rawId = typeof item.id === 'string' ? item.id.trim() : '';
            const rawBlocks = Array.isArray(item.blocks) ? item.blocks.filter((b: unknown): b is string => typeof b === 'string') : [];
            const filteredBlocks = filterSupportedBlocks(rawBlocks, supportedBlocks);
            if (name.length === 0 || filteredBlocks.length === 0) {
                continue;
            }
            const id = rawId.startsWith(CUSTOM_PRESET_PREFIX) ? rawId : `${CUSTOM_PRESET_PREFIX}${makePresetSlug(name)}`;
            if (seenIds.has(id)) {
                continue;
            }
            seenIds.add(id);
            presets.push({ id, name, blocks: filteredBlocks });
        }
        return presets;
    } catch {
        return [];
    }
}

function makePresetSlug(name: string): string {
    const ascii = name
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9\u0400-\u04ff_-]+/gi, '_')
        .replace(/^_+|_+$/g, '');
    return ascii.length > 0 ? ascii : `preset_${Date.now()}`;
}

export function saveCustomPreset(
    name: string,
    blocks: readonly string[],
    supportedBlocks: readonly string[] = PALETTE_ALL_RELEASE,
    storage: IStorageLike | null = getDefaultStorage(),
): TSaveCustomPresetResult {
    const trimmedName = name.trim();
    if (trimmedName.length === 0) {
        return { ok: false, reason: 'empty_name' };
    }

    const filteredBlocks = filterSupportedBlocks(blocks, supportedBlocks);
    if (filteredBlocks.length === 0) {
        return { ok: false, reason: 'empty_blocks' };
    }

    if (!storage) {
        return { ok: false, reason: 'storage_unavailable' };
    }

    const existing = loadCustomPresets(supportedBlocks, storage);
    const matchIndex = existing.findIndex((p) => p.name.toLowerCase() === trimmedName.toLowerCase());

    let presetId = `${CUSTOM_PRESET_PREFIX}${makePresetSlug(trimmedName)}`;
    if (matchIndex >= 0) {
        presetId = existing[matchIndex].id;
    } else if (existing.some((p) => p.id === presetId)) {
        presetId = `${presetId}_${existing.length + 1}`;
    }

    const newPreset: ICustomPalettePreset = {
        id: presetId,
        name: trimmedName,
        blocks: filteredBlocks,
    };

    const nextPresets = [...existing];
    if (matchIndex >= 0) {
        nextPresets[matchIndex] = newPreset;
    } else {
        nextPresets.push(newPreset);
    }

    try {
        storage.setItem(CUSTOM_PRESETS_STORAGE_KEY, JSON.stringify(nextPresets));
        return { ok: true, preset: newPreset, presets: nextPresets };
    } catch {
        return { ok: false, reason: 'storage_unavailable' };
    }
}

export function deleteCustomPreset(
    presetId: string,
    supportedBlocks: readonly string[] = PALETTE_ALL_RELEASE,
    storage: IStorageLike | null = getDefaultStorage(),
): ICustomPalettePreset[] {
    const existing = loadCustomPresets(supportedBlocks, storage);
    const nextPresets = existing.filter((p) => p.id !== presetId);

    if (storage) {
        try {
            storage.setItem(CUSTOM_PRESETS_STORAGE_KEY, JSON.stringify(nextPresets));
        } catch {
            return existing;
        }
    }

    return nextPresets;
}

export function loadActivePaletteState(
    supportedBlocks: readonly string[] = PALETTE_ALL_RELEASE,
    storage: IStorageLike | null = getDefaultStorage(),
): IActivePaletteState | null {
    if (!storage) {
        return null;
    }

    try {
        const raw = storage.getItem(ACTIVE_PALETTE_STORAGE_KEY);
        if (!raw) {
            return null;
        }
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.blocks)) {
            return null;
        }

        const rawBlocks = parsed.blocks.filter((b: unknown): b is string => typeof b === 'string');
        const blocks = filterSupportedBlocks(rawBlocks, supportedBlocks);
        const presetId = typeof parsed.presetId === 'string' ? parsed.presetId : MANUAL_SELECTION_PRESET_ID;

        return { presetId, blocks };
    } catch {
        return null;
    }
}

export function saveActivePaletteState(
    state: IActivePaletteState,
    supportedBlocks: readonly string[] = PALETTE_ALL_RELEASE,
    storage: IStorageLike | null = getDefaultStorage(),
): boolean {
    if (!storage) {
        return false;
    }

    try {
        const payload: IActivePaletteState = {
            presetId: state.presetId,
            blocks: filterSupportedBlocks(state.blocks, supportedBlocks),
        };
        storage.setItem(ACTIVE_PALETTE_STORAGE_KEY, JSON.stringify(payload));
        return true;
    } catch {
        return false;
    }
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

export function detectMatchingPresetId(
    selectedBlocks: readonly string[],
    customPresets: readonly ICustomPalettePreset[],
    supportedBlocks: readonly string[] = PALETTE_ALL_RELEASE,
    preferredPresetId?: string,
): string {
    const normalizedSelected = filterSupportedBlocks(selectedBlocks, supportedBlocks);

    if (preferredPresetId) {
        const preferredCustom = customPresets.find((p) => p.id === preferredPresetId);
        if (preferredCustom && areBlockSetsEqual(normalizedSelected, preferredCustom.blocks)) {
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

    for (const builtin of BUILTIN_PALETTE_PRESETS) {
        const builtinBlocks = getBuiltinPresetBlocks(builtin.id, supportedBlocks);
        if (areBlockSetsEqual(normalizedSelected, builtinBlocks)) {
            return builtin.id;
        }
    }

    for (const custom of customPresets) {
        if (areBlockSetsEqual(normalizedSelected, custom.blocks)) {
            return custom.id;
        }
    }

    return MANUAL_SELECTION_PRESET_ID;
}
