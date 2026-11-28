import assert from 'node:assert/strict';
import test from 'node:test';

import { createAutoAssignScheduler } from './auto_assign_helpers';
import { computeVoxelPostControlState } from './voxel_post_helpers';

test('computeVoxelPostControlState disables action buttons when group or mesh is unavailable', () => {
    const noGroup = computeVoxelPostControlState({
        groupEnabled: false,
        hasVoxelMesh: true,
        autoApplyEnabled: true,
        autoApplyRunning: false,
    });
    assert.equal(noGroup.autoButtonEnabled, false);
    assert.equal(noGroup.autoButtonActive, true);
    assert.equal(noGroup.resetButtonEnabled, false);
    assert.equal(noGroup.canRunAutoApply, false);

    const noMesh = computeVoxelPostControlState({
        groupEnabled: true,
        hasVoxelMesh: false,
        autoApplyEnabled: true,
        autoApplyRunning: false,
    });
    assert.equal(noMesh.autoButtonEnabled, false);
    assert.equal(noMesh.resetButtonEnabled, false);
    assert.equal(noMesh.canRunAutoApply, false);
});

test('computeVoxelPostControlState keeps auto button clickable and prevents reset during auto run', () => {
    const running = computeVoxelPostControlState({
        groupEnabled: true,
        hasVoxelMesh: true,
        autoApplyEnabled: true,
        autoApplyRunning: true,
    });
    assert.equal(running.autoButtonEnabled, true);
    assert.equal(running.autoButtonActive, true);
    assert.equal(running.resetButtonEnabled, false);
    assert.equal(running.canRunAutoApply, true);

    const idleOff = computeVoxelPostControlState({
        groupEnabled: true,
        hasVoxelMesh: true,
        autoApplyEnabled: false,
        autoApplyRunning: false,
    });
    assert.equal(idleOff.autoButtonEnabled, true);
    assert.equal(idleOff.autoButtonActive, false);
    assert.equal(idleOff.resetButtonEnabled, true);
    assert.equal(idleOff.canRunAutoApply, false);
});

test('createAutoAssignScheduler debounces rapid rotation changes and coalesces follow-up run', async () => {
    let runCount = 0;
    const resolvers: Array<() => void> = [];
    let enabled = true;

    const scheduler = createAutoAssignScheduler({
        debounceMs: 25,
        canRun: () => enabled,
        runAssign: () => {
            runCount++;
            return new Promise<void>((resolve) => {
                resolvers.push(resolve);
            });
        },
    });

    scheduler.schedule();
    scheduler.schedule();
    scheduler.schedule();

    await new Promise((r) => setTimeout(r, 45));
    assert.equal(runCount, 1);

    // Schedule another update while first run is active
    scheduler.schedule();
    scheduler.schedule();
    assert.equal(scheduler.getState().hasPending, true);

    resolvers.shift()?.();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(runCount, 2);

    // Cancelling clears timer and prevents queued runs
    scheduler.schedule();
    scheduler.cancel();
    assert.equal(scheduler.getState().hasPending, false);
    assert.equal(scheduler.getState().hasTimer, false);

    enabled = false;
    resolvers.shift()?.();
    await new Promise((r) => setTimeout(r, 35));
    assert.equal(runCount, 2);
    scheduler.dispose();
});
