export const SIDEBAR_FILTER_SECTIONS = [
    'settings',
    'import',
    'materials',
    'voxelise',
    'assign',
    'export',
] as const;

export type TSidebarSectionId = typeof SIDEBAR_FILTER_SECTIONS[number];

export function toggleSidebarSection(
    activeSections: ReadonlySet<TSidebarSectionId>,
    section: TSidebarSectionId,
): Set<TSidebarSectionId> {
    const next = new Set<TSidebarSectionId>(activeSections);
    if (next.has(section)) {
        next.delete(section);
    } else {
        next.add(section);
    }
    return next;
}

export function computeVisibleSidebarSections(
    activeSections: ReadonlySet<TSidebarSectionId>,
): Record<TSidebarSectionId, boolean> {
    const showAll = activeSections.size === 0;
    return {
        settings: showAll || activeSections.has('settings'),
        import: showAll || activeSections.has('import'),
        materials: showAll || activeSections.has('materials'),
        voxelise: showAll || activeSections.has('voxelise'),
        assign: showAll || activeSections.has('assign'),
        export: showAll || activeSections.has('export'),
    };
}
