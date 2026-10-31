import { DebugGeometryTemplates } from '../src/geometry';
import { InteractionManager, TInteractionTarget } from '../src/interaction';
import { Vector3 } from '../src/vector';
import { ArcballCamera } from '../src/camera';

describe('Camera Block Interactions & Radial Menu', () => {
    test('DebugGeometryTemplates.dot generates valid buffer data with 3 rings and cross', () => {
        const centre = new Vector3(1, 2, 3);
        const radius = 0.05;
        const colour = { r: 0.65, g: 0.65, b: 0.65, a: 1.0 };
        const normal = new Vector3(0, 1, 0);

        const dotData = DebugGeometryTemplates.dot(centre, radius, colour, normal);
        expect(dotData).toBeDefined();
        expect(dotData.indices.length).toBeGreaterThan(0);
        expect(dotData.custom.position.length).toBeGreaterThan(0);
        expect(dotData.custom.colour.length).toBe(dotData.custom.position.length / 3 * 4);

        // Position coordinates should be centered around (1, 2, 3)
        let foundCentreNear = false;
        for (let i = 0; i < dotData.custom.position.length; i += 3) {
            const x = dotData.custom.position[i];
            const y = dotData.custom.position[i + 1];
            const z = dotData.custom.position[i + 2];
            const dist = Math.hypot(x - centre.x, y - centre.y, z - centre.z);
            expect(dist).toBeLessThanOrEqual(radius * 2);
            if (dist < 0.1) {
                foundCentreNear = true;
            }
        }
        expect(foundCentreNear).toBe(true);
    });

    test('InteractionManager targetsEqual correctly compares targets', () => {
        const mgr = InteractionManager.Get;

        const meshA: TInteractionTarget = { type: 'mesh', position: new Vector3(1, 2, 3), normal: new Vector3(0, 1, 0) };
        const meshB: TInteractionTarget = { type: 'mesh', position: new Vector3(1, 2, 3), normal: new Vector3(0, 1, 0) };
        const meshC: TInteractionTarget = { type: 'mesh', position: new Vector3(1.1, 2, 3), normal: new Vector3(0, 1, 0) };

        expect(mgr.targetsEqual(meshA, meshB)).toBe(true);
        expect(mgr.targetsEqual(meshA, meshC)).toBe(false);

        const voxelA: TInteractionTarget = { type: 'voxel', gridPos: [10, 20, 30], center: new Vector3(1, 2, 3) };
        const voxelB: TInteractionTarget = { type: 'voxel', gridPos: [10, 20, 30], center: new Vector3(1, 2, 3) };
        const voxelC: TInteractionTarget = { type: 'voxel', gridPos: [10, 21, 30], center: new Vector3(1, 2.1, 3) };

        expect(mgr.targetsEqual(voxelA, voxelB)).toBe(true);
        expect(mgr.targetsEqual(voxelA, voxelC)).toBe(false);
        expect(mgr.targetsEqual(meshA, voxelA)).toBe(false);

        const blockA: TInteractionTarget = { type: 'block', gridPos: [5, 6, 7], center: new Vector3(0.5, 0.6, 0.7) };
        const blockB: TInteractionTarget = { type: 'block', gridPos: [5, 6, 7], center: new Vector3(0.5, 0.6, 0.7) };
        expect(mgr.targetsEqual(blockA, blockB)).toBe(true);
        expect(mgr.targetsEqual(blockA, voxelA)).toBe(false);
    });

    test('ArcballCamera target setting updates target smoothly and resets pan velocity', () => {
        const camera = Object.create(ArcballCamera.prototype) as any;
        camera._target = {
            _target: new Vector3(0, 0, 0),
            setTarget: function (v: Vector3) { this._target = v; },
            getTarget: function () { return this._target; },
        };
        camera._panVelocity = new Vector3(1, 1, 1);
        camera.setTarget = ArcballCamera.prototype.setTarget;
        camera.getTarget = ArcballCamera.prototype.getTarget;

        const newTarget = new Vector3(5, 10, -3);
        camera.setTarget(newTarget);

        expect(camera.getTarget()).toEqual(newTarget);
        expect(camera._panVelocity).toEqual(new Vector3(0, 0, 0));
    });

    test('onModelChanged resets hover and selection targets', () => {
        const mgr = InteractionManager.Get;
        mgr.hoveredTarget = { type: 'mesh', position: new Vector3(0, 0, 0), normal: new Vector3(0, 1, 0) };
        mgr.selectedTarget = { type: 'block', gridPos: [1, 2, 3], center: new Vector3(1, 2, 3) };

        mgr.onModelChanged();

        expect(mgr.hoveredTarget).toBeNull();
        expect(mgr.selectedTarget).toBeNull();
    });

    test('InteractionManager toggleEnabled and setEnabled manage active state', () => {
        const mgr = InteractionManager.Get;
        mgr.setEnabled(false);
        expect(mgr.isEnabled()).toBe(false);

        expect(mgr.toggleEnabled()).toBe(true);
        expect(mgr.isEnabled()).toBe(true);

        mgr.hoveredTarget = { type: 'mesh', position: new Vector3(0, 0, 0), normal: new Vector3(0, 1, 0) };
        mgr.selectedTarget = { type: 'voxel', gridPos: [1, 2, 3], center: new Vector3(1, 2, 3) };

        expect(mgr.toggleEnabled()).toBe(false);
        expect(mgr.isEnabled()).toBe(false);
        expect(mgr.hoveredTarget).toBeNull();
        expect(mgr.selectedTarget).toBeNull();
    });
});
