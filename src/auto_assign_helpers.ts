export type TAutoAssignAlgorithm = string;

export interface IAssignControlStateInput {
    algorithm: TAutoAssignAlgorithm;
    groupEnabled: boolean;
    autoAssignEnabled: boolean;
    requestedCalculateLighting: boolean;
}

export interface IAssignControlState {
    isWeightedAlgo: boolean;
    autoAssignButtonVisible: boolean;
    autoAssignButtonEnabled: boolean;
    autoAssignActive: boolean;
    calculateLightingEnabled: boolean;
    effectiveCalculateLighting: boolean;
}

export function isMultiBlockWeightedAlgorithm(algorithm: TAutoAssignAlgorithm): boolean {
    return algorithm === 'dichrome' || algorithm === 'polychrome';
}

export function computeAssignControlState(input: IAssignControlStateInput): IAssignControlState {
    const isWeightedAlgo = isMultiBlockWeightedAlgorithm(input.algorithm);
    const autoAssignActive = isWeightedAlgo && input.autoAssignEnabled;
    return {
        isWeightedAlgo,
        autoAssignButtonVisible: isWeightedAlgo,
        autoAssignButtonEnabled: isWeightedAlgo && input.groupEnabled,
        autoAssignActive,
        calculateLightingEnabled: input.groupEnabled && !autoAssignActive,
        effectiveCalculateLighting: autoAssignActive ? false : input.requestedCalculateLighting,
    };
}

export function clampBrightnessOffset(value: number): number {
    if (!Number.isFinite(value)) {
        return 0;
    }
    const clamped = Math.max(-50, Math.min(50, value));
    const stepped = Math.round(clamped / 5) * 5;
    return stepped === 0 ? 0 : stepped;
}

export function clampContrastOffset(value: number): number {
    if (!Number.isFinite(value)) {
        return 0;
    }
    const clamped = Math.max(-40, Math.min(40, value));
    const stepped = Math.round(clamped / 5) * 5;
    return stepped === 0 ? 0 : stepped;
}

export function formatSignedOffset(value: number): string {
    const rounded = Math.round(value);
    if (rounded === 0) {
        return '0';
    }
    return rounded > 0 ? `+${rounded}` : `${rounded}`;
}

export interface IAutoAssignSchedulerOptions {
    debounceMs: number;
    canRun: () => boolean;
    runAssign: () => Promise<void>;
    isBusyExternally?: () => boolean;
}

export interface IAutoAssignSchedulerState {
    hasTimer: boolean;
    isRunning: boolean;
    hasPending: boolean;
}

export interface IAutoAssignScheduler {
    schedule: () => void;
    cancel: () => void;
    dispose: () => void;
    getState: () => IAutoAssignSchedulerState;
}

/**
 * Coalescing debounced scheduler for live auto-assign updates:
 * - Rapid slider/diagram changes reset the debounce timer so only the latest state runs.
 * - If a worker run is already in progress when triggered, at most one follow-up run is queued.
 */
export function createAutoAssignScheduler(options: IAutoAssignSchedulerOptions): IAutoAssignScheduler {
    const debounceMs = Math.max(0, Math.floor(options.debounceMs));
    let timerId: ReturnType<typeof setTimeout> | null = null;
    let isRunning = false;
    let hasPending = false;
    let isDisposed = false;

    const clearPendingTimer = () => {
        if (timerId !== null) {
            clearTimeout(timerId);
            timerId = null;
        }
    };

    const executeLoop = async (): Promise<void> => {
        if (isDisposed || isRunning) {
            return;
        }
        if (!options.canRun()) {
            hasPending = false;
            return;
        }
        if (options.isBusyExternally?.()) {
            hasPending = true;
            if (timerId === null && !isDisposed) {
                timerId = setTimeout(() => {
                    timerId = null;
                    void executeLoop();
                }, Math.max(30, Math.min(debounceMs || 80, 100)));
            }
            return;
        }

        isRunning = true;
        hasPending = false;
        try {
            await options.runAssign();
        } finally {
            isRunning = false;
            if (!isDisposed && hasPending && options.canRun()) {
                hasPending = false;
                void executeLoop();
            } else {
                hasPending = false;
            }
        }
    };

    const schedule = (): void => {
        if (isDisposed || !options.canRun()) {
            return;
        }
        clearPendingTimer();
        if (isRunning) {
            hasPending = true;
            return;
        }
        timerId = setTimeout(() => {
            timerId = null;
            void executeLoop();
        }, debounceMs);
    };

    const cancel = (): void => {
        clearPendingTimer();
        hasPending = false;
    };

    const dispose = (): void => {
        isDisposed = true;
        cancel();
    };

    const getState = (): IAutoAssignSchedulerState => ({
        hasTimer: timerId !== null,
        isRunning,
        hasPending,
    });

    return {
        schedule,
        cancel,
        dispose,
        getState,
    };
}
