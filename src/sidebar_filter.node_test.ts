import assert from 'node:assert/strict';
import test from 'node:test';

import {
    computeVisibleSidebarSections,
    SIDEBAR_FILTER_SECTIONS,
    toggleSidebarSection,
    TSidebarSectionId,
} from './sidebar_filter';

test('computeVisibleSidebarSections shows all sections when none are active', () => {
    const visible = computeVisibleSidebarSections(new Set());
    for (const section of SIDEBAR_FILTER_SECTIONS) {
        assert.equal(visible[section], true);
    }
});

test('computeVisibleSidebarSections shows only the single pressed section', () => {
    const active = toggleSidebarSection(new Set(), 'voxelise');
    const visible = computeVisibleSidebarSections(active);

    assert.equal(visible.voxelise, true);
    assert.equal(visible.settings, false);
    assert.equal(visible.import, false);
    assert.equal(visible.materials, false);
    assert.equal(visible.assign, false);
    assert.equal(visible.export, false);
});

test('computeVisibleSidebarSections shows all pressed sections when multiple are active and restores all when cleared', () => {
    let active: Set<TSidebarSectionId> = new Set();
    active = toggleSidebarSection(active, 'import');
    active = toggleSidebarSection(active, 'assign');
    active = toggleSidebarSection(active, 'export');

    let visible = computeVisibleSidebarSections(active);
    assert.deepEqual(visible, {
        settings: false,
        import: true,
        materials: false,
        voxelise: false,
        assign: true,
        export: true,
    });

    active = toggleSidebarSection(active, 'import');
    active = toggleSidebarSection(active, 'assign');
    active = toggleSidebarSection(active, 'export');
    assert.equal(active.size, 0);

    visible = computeVisibleSidebarSections(active);
    for (const section of SIDEBAR_FILTER_SECTIONS) {
        assert.equal(visible[section], true);
    }
});
