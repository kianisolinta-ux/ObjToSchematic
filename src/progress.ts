import { EAppEvent, EventManager } from './event';
import { ASSERT } from './util/error_util';
import { LOGF } from './util/log_util';

export type TTaskID =
    | 'Importing'
    | 'MeshRepair'
    | 'MeshBuffer'
    | 'Voxelising'
    | 'VoxelMeshBuffer'
    | 'Assigning'
    | 'BlockMeshBuffer'
    | 'Exporting';

export type TTaskHandle = {
    nextPercentage: number,
    id: TTaskID,
    lastPhase?: string,
    lastBroadcastTime?: number,
}

export class ProgressManager {
    /* Singleton */
    private static _instance: ProgressManager;
    public static get Get() {
        return this._instance || (this._instance = new this());
    }

    private _tasks: TTaskID[];

    private constructor() {
        this._tasks = [];
    }

    /**
     * Start tracking the progress of a task.
     * @param taskId The id of the task (created here).
     */
    public start(taskId: TTaskID): TTaskHandle {
        ASSERT(!this._tasks.includes(taskId), `Task with id '${taskId}' already being tracked`);
        this._tasks.push(taskId);
        EventManager.Get.broadcast(EAppEvent.onTaskStart, taskId);

        LOGF(`[PROGRESS]: Start '${taskId} (${this._tasks.length} task(s))'`);

        return {
            nextPercentage: 0.0,
            id: taskId,
        };
    }

    /**
     * Announce progress has been made on a task.
     * @param taskId The id of the task (created in `start`).
     * @param percentage A number between 0.0 and 1.0, inclusive.
     * @param phase Optional human-readable description of current sub-stage.
     */
    public progress(tracker: TTaskHandle, percentage: number, phase?: string) {
        const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
        const timeElapsed = tracker.lastBroadcastTime ? (now - tracker.lastBroadcastTime) : 999;
        const phaseChanged = phase !== undefined && phase !== tracker.lastPhase;
        const pctAdvanced = percentage >= tracker.nextPercentage;

        if (pctAdvanced || (phaseChanged && timeElapsed >= 25) || percentage >= 1.0) {
            EventManager.Get.broadcast(EAppEvent.onTaskProgress, tracker.id, percentage, phase);
            tracker.nextPercentage = Math.min(1.0, percentage + 0.002);
            tracker.lastPhase = phase;
            tracker.lastBroadcastTime = now;
        }
    }

    /**
     * Announce a task has completed.
     * @param taskId The id of the task (created in `start`).
     */
    public end(tracker: TTaskHandle) {
        LOGF(`[PROGRESS]: End '${tracker.id}' (${this._tasks.length} task(s))'`);

        const taskIndex = this._tasks.findIndex((task) => { return task === tracker.id; });
        ASSERT(taskIndex !== -1, `Task with that id '${tracker.id}' is not being tracked, ${this._tasks}`);
        this._tasks.splice(taskIndex, 1);
        EventManager.Get.broadcast(EAppEvent.onTaskEnd, tracker.id);
    }

    public clear() {
        this._tasks = [];
    }
}
