import assert from 'node:assert/strict';
import test from 'node:test';

import { computeStackBreakdown, formatMaterialListText, formatStackSummary } from './preview_stats';

test('computeStackBreakdown converts block counts into shulkers, stacks, and remainder', () => {
    assert.deepEqual(computeStackBreakdown(32), { shulkers: 0, stacks: 0, remainder: 32, total: 32 });
    assert.deepEqual(computeStackBreakdown(64), { shulkers: 0, stacks: 1, remainder: 0, total: 64 });
    assert.deepEqual(computeStackBreakdown(130), { shulkers: 0, stacks: 2, remainder: 2, total: 130 });
    assert.deepEqual(computeStackBreakdown(1728 + 65), { shulkers: 1, stacks: 1, remainder: 1, total: 1793 });
});

test('formatStackSummary renders compact Survival counts', () => {
    assert.equal(formatStackSummary(45, { shulker: 'ш', stack: 'с' }), '45');
    assert.equal(formatStackSummary(64, { shulker: 'ш', stack: 'с' }), '1с');
    assert.equal(formatStackSummary(130, { shulker: 'ш', stack: 'с' }), '2с +2');
    assert.equal(formatStackSummary(1800, { shulker: 'ш', stack: 'с' }), '1ш 1с +8');
});

test('formatMaterialListText produces readable offline shopping list', () => {
    const text = formatMaterialListText(
        {
            total: 130,
            unique: 1,
            blocks: [{ name: 'minecraft:stone', count: 130, percentage: 100 }],
        },
        { structureName: 'Dragon', units: { shulker: 'sb', stack: 's' } },
    );
    assert.ok(text.includes('# Dragon'));
    assert.ok(text.includes('minecraft:stone: 130 (2s +2, 100.0%)'));
});
