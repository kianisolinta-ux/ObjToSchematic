export type TLitematicRotationY = 0 | 90 | 180 | 270;

export interface LitematicCoord {
    x: number;
    y: number;
    z: number;
}

const CARDINALS_CW = ['north', 'east', 'south', 'west'] as const;

/**
 * Computes rotated XZY grid dimensions after rotating by 0/90/180/270 degrees clockwise around Y.
 */
export function rotateBoundsSizeY(size: LitematicCoord, rotationY: TLitematicRotationY): LitematicCoord {
    if (rotationY === 90 || rotationY === 270) {
        return { x: size.z, y: size.y, z: size.x };
    }
    return { x: size.x, y: size.y, z: size.z };
}

/**
 * Maps a local voxel index (0 <= dx < size.x, 0 <= dy < size.y, 0 <= dz < size.z)
 * rotated clockwise around Y (top-down Minecraft compass: North -Z -> East +X -> South +Z -> West -X).
 */
export function rotateLocalBlockCoordY(
    dx: number,
    dy: number,
    dz: number,
    size: LitematicCoord,
    rotationY: TLitematicRotationY,
): LitematicCoord {
    switch (rotationY) {
        case 90:
            return { x: size.z - 1 - dz, y: dy, z: dx };
        case 180:
            return { x: size.x - 1 - dx, y: dy, z: size.z - 1 - dz };
        case 270:
            return { x: dz, y: dy, z: size.x - 1 - dx };
        case 0:
        default:
            return { x: dx, y: dy, z: dz };
    }
}

/**
 * Rotates horizontal `facing=` blockstate properties (e.g. wall_torch) when rotating schematic Y orientation.
 */
export function rotateBlockNameFacingY(blockName: string, rotationY: TLitematicRotationY): string {
    if (rotationY === 0 || !blockName.includes('facing=')) {
        return blockName;
    }
    const step = (rotationY / 90) % 4;
    return blockName.replace(/facing=(north|east|south|west)\b/g, (_match, dir: string) => {
        const idx = CARDINALS_CW.indexOf(dir as typeof CARDINALS_CW[number]);
        if (idx === -1) {
            return `facing=${dir}`;
        }
        return `facing=${CARDINALS_CW[(idx + step) % 4]}`;
    });
}
