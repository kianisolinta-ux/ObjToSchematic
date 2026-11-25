import assert from 'node:assert/strict';
import test from 'node:test';

import {
    clampBrightnessOffset,
    clampContrastOffset,
    computeAssignControlState,
    createAutoAssignScheduler,
    formatSignedOffset,
    isMultiBlockWeightedAlgorithm,
} from './auto_assign_helpers';

test('isMultiBlockWeightedAlgorithm matches only dichrome and polychrome', () => {
    assert.equal(isMultiBlockWeightedAlgorithm('dichrome'), true);
    assert.equal(isMultiBlockWeightedAlgorithm('polychrome'), true);
    assert.equal(isMultiBlockWeightedAlgorithm('nearest-color'), false);
    assert.equal(isMultiBlockWeightedAlgorithm('ciede2000'), false);
});

test('computeAssignControlState forces calculateLighting off and disabled when auto-assign is active on dichrome/polychrome', () => {
    const dichromeAuto = computeAssignControlState({
        algorithm: 'dichrome',
        groupEnabled: true,
        autoAssignEnabled: true,
        requestedCalculateLighting: true,
    });
    assert.deepEqual(dichromeAuto, {
        isWeightedAlgo: true,
        autoAssignButtonVisible: true,
        autoAssignButtonEnabled: true,
        autoAssignActive: true,
        calculateLightingEnabled: false,
        effectiveCalculateLighting: false,
    });

    const polychromeAuto = computeAssignControlState({
        algorithm: 'polychrome',
        groupEnabled: true,
        autoAssignEnabled: true,
        requestedCalculateLighting: false,
    });
    assert.equal(polychromeAuto.autoAssignActive, true);
    assert.equal(polychromeAuto.calculateLightingEnabled, false);
    assert.equal(polychromeAuto.effectiveCalculateLighting, false);
});

test('computeAssignControlState restores calculateLighting availability when auto-assign is off or another algorithm is selected', () => {
    const dichromeOff = computeAssignControlState({
        algorithm: 'dichrome',
        groupEnabled: true,
        autoAssignEnabled: false,
        requestedCalculateLighting: true,
    });
    assert.equal(dichromeOff.autoAssignButtonVisible, true);
    assert.equal(dichromeOff.autoAssignActive, false);
    assert.equal(dichromeOff.calculateLightingEnabled, true);
    assert.equal(dichromeOff.effectiveCalculateLighting, true);

    const otherAlgo = computeAssignControlState({
        algorithm: 'nearest-color',
        groupEnabled: true,
        autoAssignEnabled: true,
        requestedCalculateLighting: true,
    });
    assert.equal(otherAlgo.autoAssignButtonVisible, false);
    assert.equal(otherAlgo.autoAssignButtonEnabled, false);
    assert.equal(otherAlgo.autoAssignActive, false);
    assert.equal(otherAlgo.calculateLightingEnabled, true);
    assert.equal(otherAlgo.effectiveCalculateLighting, true);

    const lockedGroup = computeAssignControlState({
        algorithm: 'dichrome',
        groupEnabled: false,
        autoAssignEnabled: false,
        requestedCalculateLighting: false,
    });
    assert.equal(lockedGroup.autoAssignButtonVisible, true);
    assert.equal(lockedGroup.autoAssignButtonEnabled, false);
    assert.equal(lockedGroup.calculateLightingEnabled, false);
});

test('clampBrightnessOffset and clampContrastOffset clamp and snap to step 5', () => {
    assert.equal(clampBrightnessOffset(0), 0);
    assert.equal(clampBrightnessOffset(-0), 0);
    assert.equal(clampBrightnessOffset(13), 15);
    assert.equal(clampBrightnessOffset(-12), -10);
    assert.equal(clampBrightnessOffset(999), 50);
    assert.equal(clampBrightnessOffset(-999), -50);
    assert.equal(clampBrightnessOffset(NaN), 0);

    assert.equal(clampContrastOffset(0), 0);
    assert.equal(clampContrastOffset(-0), 0);
    assert.equal(clampContrastOffset(18), 20);
    assert.equal(clampContrastOffset(-17), -15);
    assert.equal(clampContrastOffset(999), 40);
    assert.equal(clampContrastOffset(-999), -40);
    assert.equal(clampContrastOffset(Infinity), 0);

    assert.equal(formatSignedOffset(0), '0');
    assert.equal(formatSignedOffset(-0), '0');
    assert.equal(formatSignedOffset(15), '+15');
    assert.equal(formatSignedOffset(-25), '-25');
});

test('createAutoAssignScheduler debounces rapid edits and coalesces concurrent edits into one trailing run', async () => {
    let runCount = 0;
    let canRun = true;
    let resolveFirst: (() => void) | null = null;

    const scheduler = createAutoAssignScheduler({
        debounceMs: 25,
        canRun: () => canRun,
        runAssign: async () => {
            runCount++;
            if (runCount === 1) {
                await new Promise<void>((res) => {
                    resolveFirst = res;
                });
            }
        },
    });

    // Rapid calls collapse into 1 run
    scheduler.schedule();
    scheduler.schedule();
    scheduler.schedule();
    assert.equal(scheduler.getState().hasTimer, true);

    await new Promise((r) => setTimeout(r, 45));
    assert.equal(runCount, 1);
    assert.equal(scheduler.getState().isRunning, true);

    // Schedules while in-flight coalesce into a single pending trailing run
    scheduler.schedule();
    scheduler.schedule();
    scheduler.schedule();
    assert.equal(scheduler.getState().hasPending, true);

    resolveFirst?.();
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(runCount, 2);
    assert.equal(scheduler.getState().isRunning, false);
    assert.equal(scheduler.getState().hasPending, false);

    // Cancelling stops queued work cleanly
    scheduler.schedule();
    assert.equal(scheduler.getState().hasTimer, true);
    scheduler.cancel();
    assert.equal(scheduler.getState().hasTimer, false);
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(runCount, 2);

    // Turning canRun false skips scheduled work
    canRun = false;
    scheduler.schedule();
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(runCount, 2);

    scheduler.dispose();
});
