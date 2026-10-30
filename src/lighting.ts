import { BlockMesh } from './block_mesh';
import { Bounds } from './bounds';
import { ASSERT } from './util/error_util';
import { LOG } from './util/log_util';
import { TLightingPlacement, TLightingScope, Vector3Hash } from './util/type_util';
import { Vector3 } from './vector';

/* eslint-disable */
enum EFace {
    Up,
    Down,
    North,
    South,
    East,
    West,
    None,
};
/* eslint-enable */

export type TLightLevel = { blockLightValue: number, sunLightValue: number };
export type TLightUpdate = TLightLevel & { pos: Vector3, from: EFace };

export class BlockMeshLighting {
    private _owner: BlockMesh;

    private _limits: Map<number, { x: number, z: number, minY: number, maxY: number }>;
    private _sunLightValues: Map<Vector3Hash, number>;
    private _blockLightValues: Map<Vector3Hash, number>;
    private _updates: number;
    private _skips: number;
    private _bounds: Bounds;

    public constructor(owner: BlockMesh) {
        this._owner = owner;
        this._sunLightValues = new Map();
        this._blockLightValues = new Map();
        this._limits = new Map();
        this._bounds = new Bounds(new Vector3(0, 0, 0), new Vector3(0, 0, 0));

        this._updates = 0;
        this._skips = 0;
    }

    public getLightLevel(vec: Vector3): TLightLevel {
        const hash = vec.hash();
        return {
            sunLightValue: this._sunLightValues.get(hash) ?? 0,
            blockLightValue: this._blockLightValues.get(hash) ?? 0,
        };
    }

    public getBlockLightLevel(vec: Vector3): number {
        return this._blockLightValues.get(vec.hash()) ?? 0;
    }

    public getMaxLightLevel(vec: Vector3): number {
        const light = this.getLightLevel(vec);
        return Math.max(light.blockLightValue, light.sunLightValue);
    }

    public addLightToDarkness(
        threshold: number,
        placement: TLightingPlacement = 'ordered',
        scope: TLightingScope = 'darkness',
        lightBlockChoice: string = 'auto',
    ) {
        if (threshold === 0) {
            return;
        }

        const candidateBlocks: Vector3[] = [];
        const allBlocks = this._owner.getBlocks();

        if (scope === 'all_surface') {
            allBlocks.forEach((block) => {
                const pos = block.voxel.position;
                if (this._owner.isSurfaceBlock(pos)) {
                    if (this.getBlockLightLevel(pos) < threshold) {
                        candidateBlocks.push(pos.copy());
                    }
                }
            });
        } else {
            allBlocks.forEach((block) => {
                const pos = block.voxel.position;
                if (this.getMaxLightLevel(pos) < threshold) {
                    candidateBlocks.push(pos.copy());
                }
            });
        }

        if (placement === 'random') {
            for (let i = candidateBlocks.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                const temp = candidateBlocks[i];
                candidateBlocks[i] = candidateBlocks[j];
                candidateBlocks[j] = temp;
            }
        } else {
            // Ordered: sort consistently by Y, then Z, then X
            candidateBlocks.sort((a, b) => {
                if (a.y !== b.y) return a.y - b.y;
                if (a.z !== b.z) return a.z - b.z;
                return a.x - b.x;
            });
        }

        while (candidateBlocks.length > 0) {
            const candidatePos = candidateBlocks.pop()!;

            const currentLight = scope === 'all_surface' ?
                this.getBlockLightLevel(candidatePos) :
                this.getMaxLightLevel(candidatePos);

            if (currentLight < threshold) {
                const placeResult = this._owner.setLightBlock(candidatePos, lightBlockChoice);

                if (placeResult.placed) {
                    const lightOrigin = placeResult.position;
                    const newBlockLight = 14;
                    this._blockLightValues.set(lightOrigin.hash(), newBlockLight);

                    const attenuatedSun = Math.max(0, this.getLightLevel(lightOrigin).sunLightValue - 1);
                    const attenuatedBlock = newBlockLight - 1;

                    const updates: TLightUpdate[] = [
                        { pos: new Vector3(0, 1, 0).add(lightOrigin), sunLightValue: attenuatedSun, blockLightValue: attenuatedBlock, from: EFace.Down },
                        { pos: new Vector3(0, -1, 0).add(lightOrigin), sunLightValue: attenuatedSun, blockLightValue: attenuatedBlock, from: EFace.Up },
                        { pos: new Vector3(1, 0, 0).add(lightOrigin), sunLightValue: attenuatedSun, blockLightValue: attenuatedBlock, from: EFace.South },
                        { pos: new Vector3(-1, 0, 0).add(lightOrigin), sunLightValue: attenuatedSun, blockLightValue: attenuatedBlock, from: EFace.North },
                        { pos: new Vector3(0, 0, 1).add(lightOrigin), sunLightValue: attenuatedSun, blockLightValue: attenuatedBlock, from: EFace.West },
                        { pos: new Vector3(0, 0, -1).add(lightOrigin), sunLightValue: attenuatedSun, blockLightValue: attenuatedBlock, from: EFace.East },
                    ];
                    this._handleBlockLightUpdates(updates);
                    ASSERT(updates.length === 0);
                }
            }
        }
    }

    private _calculateLimits() {
        this._bounds = this._owner.getVoxelMesh().getBounds();

        this._limits.clear();

        const updateLimit = (pos: Vector3) => {
            const key = pos.copy();
            key.y = 0;

            const blockLimit = this._limits.get(key.hash());
            if (blockLimit !== undefined) {
                blockLimit.maxY = Math.max(blockLimit.maxY, pos.y);
                blockLimit.minY = Math.min(blockLimit.minY, pos.y);
            } else {
                this._limits.set(key.hash(), {
                    x: pos.x,
                    z: pos.z,
                    minY: pos.y,
                    maxY: pos.y,
                });
            }
        };

        this._owner.getBlocks().forEach((block) => {
            updateLimit(block.voxel.position);
            updateLimit(new Vector3(1, 0, 0).add(block.voxel.position));
            updateLimit(new Vector3(-1, 0, 0).add(block.voxel.position));
            updateLimit(new Vector3(0, 0, 1).add(block.voxel.position));
            updateLimit(new Vector3(0, 0, -1).add(block.voxel.position));
        });
    }

    public init() {
        this._calculateLimits();
    }

    public addSunLightValues() {
        // Actually commit the light level changes.
        const updates: TLightUpdate[] = [];
        this._limits.forEach((limit, key) => {
            updates.push({
                pos: new Vector3(0, 1, 0).add(new Vector3(limit.x, limit.maxY, limit.z)),
                sunLightValue: 15,
                blockLightValue: 0,
                from: EFace.None,
            });
        });
        this._handleSunLightUpdates(updates);
        ASSERT(updates.length === 0, 'Updates still remaining');
    }

    public addEmissiveBlocks() {
        const updates: TLightUpdate[] = [];
        this._owner.getBlocks().forEach((block) => {
            if (this._owner.isEmissiveBlock(block)) {
                updates.push({
                    pos: block.voxel.position,
                    sunLightValue: 0,
                    blockLightValue: 14,
                    from: EFace.None,
                });
            }
        });
        this._handleBlockLightUpdates(updates);
        ASSERT(updates.length === 0, 'Updates still remaining');
    }

    /**
     * Goes through each block location in `updates` and sets the light value
     * to the maximum of its current value and its update value.
     *
     * @Note **Modifies `updates`**
     */
    /*
    private _handleUpdates(updates: TLightUpdate[], updateSunLight: boolean, updateBlockLight: boolean) {
        while (updates.length > 0) {
            this._updates += 1;
            const update = updates.pop()!;

            // Only update light values inside the bounds of the block mesh.
            // Values outside the bounds are assumed to have sunLightValue of 15
            // and blockLightValue of 0.
            if (updateSunLight && !updateBlockLight && update.sunLightValue < 0) {
                this._skips += 1;
                ASSERT(false, 'SKIP SUNLIGHT');
                continue;
            }
            if (updateBlockLight && !updateSunLight && update.blockLightValue < 0) {
                this._skips += 1;
                ASSERT(false, 'SKIP BLOCKLIGHT');
                continue;
            }
            if (!this._isPosValid(update.pos)) {
                this._skips += 1;
                continue;
            }
            const current = this.getLightLevel(update.pos);
            const toSet: TLightLevel = { sunLightValue: current.sunLightValue, blockLightValue: current.blockLightValue };

            const hash = update.pos.hash();

            // Update sunLight value
            if (updateSunLight && current.sunLightValue < update.sunLightValue) {
                toSet.sunLightValue = update.sunLightValue;
                this._sunLightValues.set(hash, toSet.sunLightValue);
            }

            // Update blockLight values
            if (updateBlockLight && current.blockLightValue < update.blockLightValue) {
                toSet.blockLightValue = update.blockLightValue;
                this._blockLightValues.set(hash, toSet.blockLightValue);
            }

            const blockHere = this._owner.getBlockAt(update.pos);
            const isBlockHere = blockHere !== undefined;

            const shouldPropagate = isBlockHere ?
                this._owner.isTransparentBlock(blockHere) :
                true;

            // Actually commit the light value changes and notify neighbours to
            // update their values.
            if (shouldPropagate) {
                const sunLightChanged = current.sunLightValue !== toSet.sunLightValue && toSet.sunLightValue > 0;
                const blockLightChanged = current.blockLightValue !== toSet.blockLightValue && toSet.blockLightValue > 0;
                if ((sunLightChanged || blockLightChanged)) {
                    const attenuated: TLightLevel = {
                        sunLightValue: toSet.sunLightValue - 1,
                        blockLightValue: toSet.blockLightValue - 1,
                    };
                    if (update.from !== EFace.Up) {
                        updates.push({
                            pos: new Vector3(0, 1, 0).add(update.pos),
                            sunLightValue: attenuated.sunLightValue,
                            blockLightValue: attenuated.blockLightValue,
                            from: EFace.Down,
                        });
                    }
                    if (update.from !== EFace.Down) {
                        updates.push({
                            pos: new Vector3(0, -1, 0).add(update.pos),
                            sunLightValue: toSet.sunLightValue === 15 ? 15 : toSet.sunLightValue - 1,
                            blockLightValue: toSet.blockLightValue - 1,
                            from: EFace.Up,
                        });
                    }
                    if (update.from !== EFace.North) {
                        updates.push({
                            pos: new Vector3(1, 0, 0).add(update.pos),
                            sunLightValue: attenuated.sunLightValue,
                            blockLightValue: attenuated.blockLightValue,
                            from: EFace.South,
                        });
                    }
                    if (update.from !== EFace.South) {
                        updates.push({
                            pos: new Vector3(-1, 0, 0).add(update.pos),
                            sunLightValue: attenuated.sunLightValue,
                            blockLightValue: attenuated.blockLightValue,
                            from: EFace.North,
                        });
                    }
                    if (update.from !== EFace.East) {
                        updates.push({
                            pos: new Vector3(0, 0, 1).add(update.pos),
                            sunLightValue: attenuated.sunLightValue,
                            blockLightValue: attenuated.blockLightValue,
                            from: EFace.West,
                        });
                    }
                    if (update.from !== EFace.West) {
                        updates.push({
                            pos: new Vector3(0, 0, -1).add(update.pos),
                            sunLightValue: attenuated.sunLightValue,
                            blockLightValue: attenuated.blockLightValue,
                            from: EFace.East,
                        });
                    }
                }
            }
        }
    }
    */

    private _handleBlockLightUpdates(updates: TLightUpdate[]) {
        while (updates.length > 0) {
            this._updates += 1;
            const update = updates.pop()!;

            if (!this._isPosValid(update.pos)) {
                this._skips += 1;
                continue;
            }
            const current = this.getLightLevel(update.pos);
            let toSet = current.blockLightValue;

            const hash = update.pos.hash();

            // Update blockLight values
            if (current.blockLightValue < update.blockLightValue) {
                toSet = update.blockLightValue;
                this._blockLightValues.set(hash, toSet);
            }

            const blockHere = this._owner.getBlockAt(update.pos);
            const isBlockHere = blockHere !== undefined;

            const shouldPropagate = isBlockHere ?
                this._owner.isTransparentBlock(blockHere) :
                true;

            // Actually commit the light value changes and notify neighbours to
            // update their values.
            if (shouldPropagate) {
                const blockLightChanged = current.blockLightValue !== toSet && toSet > 0;
                if (blockLightChanged) {
                    if (update.from !== EFace.Up) {
                        updates.push({
                            pos: new Vector3(0, 1, 0).add(update.pos),
                            sunLightValue: current.sunLightValue,
                            blockLightValue: toSet - 1,
                            from: EFace.Down,
                        });
                    }
                    if (update.from !== EFace.Down) {
                        updates.push({
                            pos: new Vector3(0, -1, 0).add(update.pos),
                            sunLightValue: current.sunLightValue,
                            blockLightValue: toSet - 1,
                            from: EFace.Up,
                        });
                    }
                    if (update.from !== EFace.North) {
                        updates.push({
                            pos: new Vector3(1, 0, 0).add(update.pos),
                            sunLightValue: current.sunLightValue,
                            blockLightValue: toSet - 1,
                            from: EFace.South,
                        });
                    }
                    if (update.from !== EFace.South) {
                        updates.push({
                            pos: new Vector3(-1, 0, 0).add(update.pos),
                            sunLightValue: current.sunLightValue,
                            blockLightValue: toSet - 1,
                            from: EFace.North,
                        });
                    }
                    if (update.from !== EFace.East) {
                        updates.push({
                            pos: new Vector3(0, 0, 1).add(update.pos),
                            sunLightValue: current.sunLightValue,
                            blockLightValue: toSet - 1,
                            from: EFace.West,
                        });
                    }
                    if (update.from !== EFace.West) {
                        updates.push({
                            pos: new Vector3(0, 0, -1).add(update.pos),
                            sunLightValue: current.sunLightValue,
                            blockLightValue: toSet - 1,
                            from: EFace.East,
                        });
                    }
                }
            }
        }
    }

    private _handleSunLightUpdates(updates: TLightUpdate[]) {
        while (updates.length > 0) {
            this._updates += 1;
            const update = updates.pop()!;

            if (!this._isPosValid(update.pos)) {
                this._skips += 1;
                continue;
            }

            const current = this.getLightLevel(update.pos);
            let toSet = current.sunLightValue;

            const hash = update.pos.hash();

            // Update sunLight value
            if (current.sunLightValue < update.sunLightValue) {
                toSet = update.sunLightValue;
                this._sunLightValues.set(hash, toSet);
            }

            const blockHere = this._owner.getBlockAt(update.pos);
            const isBlockHere = blockHere !== undefined;

            const shouldPropagate = isBlockHere ?
                this._owner.isTransparentBlock(blockHere) :
                true;

            // Actually commit the light value changes and notify neighbours to
            // update their values.
            if (shouldPropagate) {
                const sunLightChanged = current.sunLightValue !== toSet && toSet > 0;
                if ((sunLightChanged)) {
                    if (update.from !== EFace.Up) {
                        updates.push({
                            pos: new Vector3(0, 1, 0).add(update.pos),
                            sunLightValue: toSet - 1,
                            blockLightValue: current.blockLightValue,
                            from: EFace.Down,
                        });
                    }
                    if (update.from !== EFace.Down) {
                        updates.push({
                            pos: new Vector3(0, -1, 0).add(update.pos),
                            sunLightValue: toSet === 15 ? 15 : toSet - 1,
                            blockLightValue: current.blockLightValue,
                            from: EFace.Up,
                        });
                    }
                    if (update.from !== EFace.North) {
                        updates.push({
                            pos: new Vector3(1, 0, 0).add(update.pos),
                            sunLightValue: toSet - 1,
                            blockLightValue: current.blockLightValue,
                            from: EFace.South,
                        });
                    }
                    if (update.from !== EFace.South) {
                        updates.push({
                            pos: new Vector3(-1, 0, 0).add(update.pos),
                            sunLightValue: toSet - 1,
                            blockLightValue: current.blockLightValue,
                            from: EFace.North,
                        });
                    }
                    if (update.from !== EFace.East) {
                        updates.push({
                            pos: new Vector3(0, 0, 1).add(update.pos),
                            sunLightValue: toSet - 1,
                            blockLightValue: current.blockLightValue,
                            from: EFace.West,
                        });
                    }
                    if (update.from !== EFace.West) {
                        updates.push({
                            pos: new Vector3(0, 0, -1).add(update.pos),
                            sunLightValue: toSet - 1,
                            blockLightValue: current.blockLightValue,
                            from: EFace.East,
                        });
                    }
                }
            }
        }
    }

    private _isPosValid(vec: Vector3) {
        const key = vec.copy();
        key.y = 0;

        const limit = this._limits.get(key.hash());
        if (limit !== undefined) {
            return vec.y >= this._bounds.min.y - 1 && vec.y <= limit.maxY + 1;
        } else {
            return false;
        }
    }

    public dumpInfo() {
        LOG(`Skipped ${this._skips} out of ${this._updates} (${(100 * this._skips / this._updates).toFixed(4)}%)`);
    }
}
