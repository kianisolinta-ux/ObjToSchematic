export interface IVoxelPostControlStateInput {
    groupEnabled: boolean;
    hasVoxelMesh: boolean;
    autoApplyEnabled: boolean;
    autoApplyRunning: boolean;
}

export interface IVoxelPostControlState {
    autoButtonEnabled: boolean;
    autoButtonActive: boolean;
    resetButtonEnabled: boolean;
    canRunAutoApply: boolean;
}

export function computeVoxelPostControlState(input: IVoxelPostControlStateInput): IVoxelPostControlState {
    const canInteract = input.groupEnabled && input.hasVoxelMesh;
    return {
        autoButtonEnabled: canInteract,
        autoButtonActive: input.autoApplyEnabled,
        resetButtonEnabled: canInteract && !input.autoApplyRunning,
        canRunAutoApply: canInteract && input.autoApplyEnabled,
    };
}
