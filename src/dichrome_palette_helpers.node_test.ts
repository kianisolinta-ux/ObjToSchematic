import assert from 'node:assert/strict';
import test from 'node:test';

import { PALETTE_ALL_RELEASE } from '../res/palettes/all';
import { PALETTE_GREYSCALE } from '../res/palettes/greyscale';
import {
    detectMatchingDichromePresetId,
    loadDichromeActivePaletteState,
    parseDichromePaletteText,
    saveDichromeActivePaletteState,
    sortBlocksByLightness,
} from './dichrome_palette_helpers';
import { IStorageLike, MANUAL_SELECTION_PRESET_ID } from './palette_presets';

function createMemoryStorage(): IStorageLike {
    const map = new Map<string, string>();
    return {
        getItem: (key: string) => map.get(key) ?? null,
        setItem: (key: string, value: string) => {
            map.set(key, value);
        },
    };
}

test('parseDichromePaletteText parses blocks, normalizes namespace, skips comments, and deduplicates preserving order', () => {
    const supported = ['minecraft:black_concrete', 'minecraft:stone', 'minecraft:white_concrete'];
    const input = [
        '# My dichrome ramp',
        '',
        'black_concrete',
        '// comment',
        'minecraft:stone',
        'minecraft:unknown_block',
        'minecraft:black_concrete',
        '  white_concrete  ',
    ].join('\n');

    const parsed = parseDichromePaletteText(input, supported);
    assert.deepEqual(parsed.blocks, [
        'minecraft:black_concrete',
        'minecraft:stone',
        'minecraft:white_concrete',
    ]);
    assert.deepEqual(parsed.unsupportedTokens, ['minecraft:unknown_block']);
    assert.equal(parsed.totalTokens, 5);
});

test('sortBlocksByLightness sorts ascending by luminance with deterministic tie-breaker', () => {
    const lightness = new Map<string, number>([
        ['minecraft:white_concrete', 230],
        ['minecraft:gray_concrete', 80],
        ['minecraft:black_concrete', 15],
        ['minecraft:coal_block', 15],
    ]);

    const sorted = sortBlocksByLightness(
        ['minecraft:white_concrete', 'minecraft:gray_concrete', 'minecraft:coal_block', 'minecraft:black_concrete'],
        lightness,
    );

    assert.deepEqual(sorted, [
        'minecraft:black_concrete',
        'minecraft:coal_block',
        'minecraft:gray_concrete',
        'minecraft:white_concrete',
    ]);
});

test('detectMatchingDichromePresetId matches ordered custom presets and unordered built-in presets', () => {
    const customPresets = [
        {
            id: 'custom:ramp',
            name: 'Ramp',
            blocks: ['minecraft:black_concrete', 'minecraft:emerald_block', 'minecraft:white_concrete'],
        },
    ];

    assert.equal(
        detectMatchingDichromePresetId(
            ['minecraft:black_concrete', 'minecraft:emerald_block', 'minecraft:white_concrete'],
            customPresets,
            PALETTE_ALL_RELEASE,
        ),
        'custom:ramp',
    );

    // Reordering a custom preset switches to manual selection because tone order changed
    assert.equal(
        detectMatchingDichromePresetId(
            ['minecraft:white_concrete', 'minecraft:emerald_block', 'minecraft:black_concrete'],
            customPresets,
            PALETTE_ALL_RELEASE,
        ),
        MANUAL_SELECTION_PRESET_ID,
    );

    // Matching built-in greyscale preset sorted in any order resolves to 'greyscale'
    assert.equal(
        detectMatchingDichromePresetId(
            [...PALETTE_GREYSCALE].reverse(),
            customPresets,
            PALETTE_ALL_RELEASE,
            'greyscale',
        ),
        'greyscale',
    );
});

test('saveDichromeActivePaletteState & loadDichromeActivePaletteState require at least 2 supported blocks', () => {
    const storage = createMemoryStorage();
    const supported = ['minecraft:black_concrete', 'minecraft:stone', 'minecraft:white_concrete'];

    assert.equal(
        saveDichromeActivePaletteState({ presetId: 'custom:one', blocks: ['minecraft:stone'] }, supported, storage),
        false,
    );
    assert.equal(loadDichromeActivePaletteState(supported, storage), null);

    assert.equal(
        saveDichromeActivePaletteState(
            { presetId: 'custom:two', blocks: ['minecraft:black_concrete', 'minecraft:white_concrete'] },
            supported,
            storage,
        ),
        true,
    );
    assert.deepEqual(loadDichromeActivePaletteState(supported, storage), {
        presetId: 'custom:two',
        blocks: ['minecraft:black_concrete', 'minecraft:white_concrete'],
    });
});
