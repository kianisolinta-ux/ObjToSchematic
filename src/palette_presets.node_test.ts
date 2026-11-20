import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { PALETTE_ALL_RELEASE } from '../res/palettes/all';
import { PALETTE_SURVIVAL_33 } from '../res/palettes/survival-33';
import {
    CUSTOM_PRESETS_STORAGE_KEY,
    deleteCustomPreset,
    detectMatchingPresetId,
    filterSupportedBlocks,
    getBuiltinPresetBlocks,
    IStorageLike,
    loadActivePaletteState,
    loadCustomPresets,
    MANUAL_SELECTION_PRESET_ID,
    saveActivePaletteState,
    saveCustomPreset,
} from './palette_presets';

function createMemoryStorage(): IStorageLike & { store: Map<string, string> } {
    const store = new Map<string, string>();
    return {
        store,
        getItem(key: string): string | null {
            return store.has(key) ? store.get(key)! : null;
        },
        setItem(key: string, value: string): void {
            store.set(key, value);
        },
    };
}

test('PALETTE_SURVIVAL_33 matches the 33-block attachment list and all blocks are in PALETTE_ALL_RELEASE', () => {
    const attachmentPath = path.resolve(process.cwd(), 'public/assets/aistudio/______________________6e490199.txt');
    const attachmentBlocks = fs.readFileSync(attachmentPath, 'utf8')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);

    assert.equal(PALETTE_SURVIVAL_33.length, 33);
    assert.deepEqual([...PALETTE_SURVIVAL_33], attachmentBlocks);

    const allSet = new Set(PALETTE_ALL_RELEASE);
    for (const block of PALETTE_SURVIVAL_33) {
        assert.equal(allSet.has(block), true, `Expected ${block} in PALETTE_ALL_RELEASE`);
    }
});

test('getBuiltinPresetBlocks resolves survival-33 and filters unsupported schematic-friendly entries', () => {
    const survival = getBuiltinPresetBlocks('survival-33', PALETTE_ALL_RELEASE);
    assert.equal(survival.length, 33);

    const schematicFriendly = getBuiltinPresetBlocks('schematic-friendly', PALETTE_ALL_RELEASE);
    assert.ok(schematicFriendly.length > 50);
    assert.equal(schematicFriendly.includes('minecraft:air'), false);
    assert.equal(schematicFriendly.includes('light_blue minecraft:stained_glass'), false);
});

test('filterSupportedBlocks normalizes missing minecraft: namespace and deduplicates', () => {
    const filtered = filterSupportedBlocks(['stone', 'minecraft:stone', '  cobblestone  ', 'nonexistent_block'], PALETTE_ALL_RELEASE);
    assert.deepEqual(filtered, ['minecraft:stone', 'minecraft:cobblestone']);
});

test('custom preset save, overwrite, load, and delete lifecycle works offline with storage adapter', () => {
    const storage = createMemoryStorage();

    const emptyName = saveCustomPreset('   ', ['minecraft:stone'], PALETTE_ALL_RELEASE, storage);
    assert.deepEqual(emptyName, { ok: false, reason: 'empty_name' });

    const emptyBlocks = saveCustomPreset('Empty', [], PALETTE_ALL_RELEASE, storage);
    assert.deepEqual(emptyBlocks, { ok: false, reason: 'empty_blocks' });

    const created = saveCustomPreset('Starter Stone', ['stone', 'minecraft:cobblestone'], PALETTE_ALL_RELEASE, storage);
    assert.equal(created.ok, true);
    if (!created.ok) return;
    assert.equal(created.preset.name, 'Starter Stone');
    assert.deepEqual(created.preset.blocks, ['minecraft:stone', 'minecraft:cobblestone']);
    assert.equal(created.presets.length, 1);

    const updated = saveCustomPreset('starter stone', ['minecraft:andesite', 'minecraft:diorite'], PALETTE_ALL_RELEASE, storage);
    assert.equal(updated.ok, true);
    if (!updated.ok) return;
    assert.equal(updated.presets.length, 1);
    assert.equal(updated.preset.id, created.preset.id);
    assert.deepEqual(updated.preset.blocks, ['minecraft:andesite', 'minecraft:diorite']);

    const loaded = loadCustomPresets(PALETTE_ALL_RELEASE, storage);
    assert.equal(loaded.length, 1);
    assert.deepEqual(loaded[0].blocks, ['minecraft:andesite', 'minecraft:diorite']);

    const afterDelete = deleteCustomPreset(created.preset.id, PALETTE_ALL_RELEASE, storage);
    assert.equal(afterDelete.length, 0);
    assert.equal(loadCustomPresets(PALETTE_ALL_RELEASE, storage).length, 0);
});

test('active palette state save/load handles roundtrip and corrupt JSON safely', () => {
    const storage = createMemoryStorage();
    assert.equal(loadActivePaletteState(PALETTE_ALL_RELEASE, storage), null);

    const saved = saveActivePaletteState({
        presetId: 'survival-33',
        blocks: PALETTE_SURVIVAL_33,
    }, PALETTE_ALL_RELEASE, storage);
    assert.equal(saved, true);

    const loaded = loadActivePaletteState(PALETTE_ALL_RELEASE, storage);
    assert.ok(loaded !== null);
    assert.equal(loaded.presetId, 'survival-33');
    assert.equal(loaded.blocks.length, 33);

    storage.setItem(CUSTOM_PRESETS_STORAGE_KEY, '{broken json');
    assert.deepEqual(loadCustomPresets(PALETTE_ALL_RELEASE, storage), []);
});

test('detectMatchingPresetId matches built-in, custom, and manual selection states', () => {
    const storage = createMemoryStorage();
    const res = saveCustomPreset('My Build', ['minecraft:tuff', 'minecraft:calcite'], PALETTE_ALL_RELEASE, storage);
    assert.equal(res.ok, true);
    if (!res.ok) return;

    assert.equal(detectMatchingPresetId(PALETTE_SURVIVAL_33, res.presets, PALETTE_ALL_RELEASE), 'survival-33');
    assert.equal(detectMatchingPresetId(['minecraft:tuff', 'minecraft:calcite'], res.presets, PALETTE_ALL_RELEASE), res.preset.id);
    assert.equal(detectMatchingPresetId(['minecraft:tuff'], res.presets, PALETTE_ALL_RELEASE), MANUAL_SELECTION_PRESET_ID);
});
