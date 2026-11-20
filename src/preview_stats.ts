export interface StackBreakdown {
    shulkers: number;
    stacks: number;
    remainder: number;
    total: number;
}

export interface MaterialListBlock {
    name: string;
    count: number;
    percentage: number;
}

export const STACK_SIZE = 64;
export const SHULKER_SLOTS = 27;
export const SHULKER_CAPACITY = STACK_SIZE * SHULKER_SLOTS; // 1728

export function computeStackBreakdown(count: number): StackBreakdown {
    const safeCount = Math.max(0, Math.floor(count));
    const shulkers = Math.floor(safeCount / SHULKER_CAPACITY);
    const afterShulkers = safeCount % SHULKER_CAPACITY;
    const stacks = Math.floor(afterShulkers / STACK_SIZE);
    const remainder = afterShulkers % STACK_SIZE;
    return {
        shulkers,
        stacks,
        remainder,
        total: safeCount,
    };
}

/**
 * Formats a block count in compact Survival units (shulker boxes, 64-stacks, remainder).
 * Example (ru): "1ш 2с + 5" or "2с + 5" or "32".
 * Example (en): "1sb 2s + 5" or "2s + 5" or "32".
 */
export function formatStackSummary(
    count: number,
    units: { shulker: string; stack: string } = { shulker: 'sb', stack: 's' },
): string {
    const { shulkers, stacks, remainder, total } = computeStackBreakdown(count);
    if (total < STACK_SIZE) {
        return `${total}`;
    }

    const parts: string[] = [];
    if (shulkers > 0) {
        parts.push(`${shulkers}${units.shulker}`);
    }
    if (stacks > 0) {
        parts.push(`${stacks}${units.stack}`);
    }
    if (remainder > 0) {
        parts.push(`+${remainder}`);
    }
    return parts.join(' ');
}

export function formatMaterialListText(
    summary: { total: number; unique: number; blocks: MaterialListBlock[] },
    options: {
        structureName?: string;
        units?: { shulker: string; stack: string };
    } = {},
): string {
    const units = options.units ?? { shulker: 'sb', stack: 's' };
    const title = options.structureName ? `# ${options.structureName}` : '# Material List';
    const lines: string[] = [
        title,
        `Total: ${summary.total} blocks (${summary.unique} unique types)`,
        '',
    ];

    for (const block of summary.blocks) {
        const stackStr = formatStackSummary(block.count, units);
        lines.push(`${block.name}: ${block.count} (${stackStr}, ${block.percentage.toFixed(1)}%)`);
    }

    return lines.join('\n');
}
