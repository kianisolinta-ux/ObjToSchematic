export interface IVoxelPostControlStateInput {
    groupEnabled: boolean;
    hasVoxelMesh: boolean;
}

export interface IVoxelPostControlState {
    resetButtonEnabled: boolean;
}

export function computeVoxelPostControlState(input: IVoxelPostControlStateInput): IVoxelPostControlState {
    return {
        resetButtonEnabled: input.groupEnabled && input.hasVoxelMesh,
    };
}
