export type TLitematicAnchor = 'min-corner' | 'center-base' | 'center';

export interface IntVec3 {
    x: number;
    y: number;
    z: number;
}

function negateZeroSafe(value: number): number {
    return value === 0 ? 0 : -value;
}

/**
 * Computes the Litematica Region.Position offset relative to the player's placement
 * cursor so the schematic can align by its minimum corner, centered floor base, or full center.
 */
export function computeLitematicRegionPosition(
    size: IntVec3,
    anchor: TLitematicAnchor = 'min-corner',
): IntVec3 {
    const sx = Math.max(1, Math.floor(size.x));
    const sy = Math.max(1, Math.floor(size.y));
    const sz = Math.max(1, Math.floor(size.z));

    switch (anchor) {
        case 'center-base':
            return {
                x: negateZeroSafe(Math.floor(sx / 2)),
                y: 0,
                z: negateZeroSafe(Math.floor(sz / 2)),
            };
        case 'center':
            return {
                x: negateZeroSafe(Math.floor(sx / 2)),
                y: negateZeroSafe(Math.floor(sy / 2)),
                z: negateZeroSafe(Math.floor(sz / 2)),
            };
        case 'min-corner':
        default:
            return { x: 0, y: 0, z: 0 };
    }
}
