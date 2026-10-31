import { ArcballCamera } from './camera';
import { MeshType, Renderer } from './renderer';
import { Vector3 } from './vector';

export type TInteractionTarget =
    | { type: 'mesh', position: Vector3, normal: Vector3 }
    | { type: 'voxel', gridPos: [number, number, number], center: Vector3 }
    | { type: 'block', gridPos: [number, number, number], center: Vector3 };

export class InteractionManager {
    private static _instance: InteractionManager;
    public static get Get() {
        return this._instance || (this._instance = new this());
    }

    public hoveredTarget: TInteractionTarget | null = null;
    public selectedTarget: TInteractionTarget | null = null;

    private _isEnabled = false;

    private _isMouseDown = false;
    private _isDragging = false;
    private _mouseDownPos = { x: 0, y: 0 };
    private _holdTimer?: number;

    private _isRadialMenuOpen = false;
    private _radialMenuCenter = { x: 0, y: 0 };
    private _isRightOptionActive = false;

    private _radialMenuElement?: HTMLDivElement;
    private _rightOptionElement?: HTMLDivElement;

    private constructor() {
    }

    public isEnabled(): boolean {
        return this._isEnabled;
    }

    public setEnabled(enabled: boolean): void {
        if (this._isEnabled === enabled) return;
        this._isEnabled = enabled;
        if (!this._isEnabled) {
            this.hoveredTarget = null;
            this.selectedTarget = null;
            this._closeRadialMenu();
            if (this._holdTimer) {
                window.clearTimeout(this._holdTimer);
                this._holdTimer = undefined;
            }
            this._isMouseDown = false;
            this._isDragging = false;
            if (typeof document !== 'undefined') {
                ArcballCamera.Get.isRotationLocked = false;
            }
        }
        if (typeof document !== 'undefined') {
            Renderer.Get.forceRedraw();
        }
    }

    public toggleEnabled(): boolean {
        this.setEnabled(!this._isEnabled);
        return this._isEnabled;
    }

    public init() {
        this._createRadialMenuDOM();

        const canvas = document.getElementById('canvas');
        if (!canvas) return;

        canvas.addEventListener('mousedown', (e: MouseEvent) => {
            this._onMouseDown(e);
        });

        document.addEventListener('mousemove', (e: MouseEvent) => {
            this._onMouseMove(e);
        });

        document.addEventListener('mouseup', (e: MouseEvent) => {
            this._onMouseUp(e);
        });
    }

    public onModelChanged() {
        this.hoveredTarget = null;
        this.selectedTarget = null;
        this._closeRadialMenu();
    }

    public targetsEqual(a: TInteractionTarget | null, b: TInteractionTarget | null): boolean {
        if (!a || !b) return a === b;
        if (a.type !== b.type) return false;
        if (a.type === 'mesh' && b.type === 'mesh') {
            return Vector3.sub(a.position, b.position).magnitude() < 0.001;
        }
        if (a.type === 'voxel' && b.type === 'voxel') {
            return a.gridPos[0] === b.gridPos[0] && a.gridPos[1] === b.gridPos[1] && a.gridPos[2] === b.gridPos[2];
        }
        if (a.type === 'block' && b.type === 'block') {
            return a.gridPos[0] === b.gridPos[0] && a.gridPos[1] === b.gridPos[1] && a.gridPos[2] === b.gridPos[2];
        }
        return false;
    }

    public raycast(screenX: number, screenY: number): TInteractionTarget | null {
        if (!this._isEnabled) return null;

        const canvas = document.getElementById('canvas') as HTMLCanvasElement;
        if (!canvas) return null;

        const rect = canvas.getBoundingClientRect();
        if (screenX < rect.left || screenX > rect.right || screenY < rect.top || screenY > rect.bottom) {
            return null;
        }

        const meshType = Renderer.Get.getActiveMeshType();
        if (meshType === MeshType.None) return null;

        const ray = ArcballCamera.Get.getRayFromScreen(screenX, screenY, canvas);

        if (meshType === MeshType.TriangleMesh) {
            return this._raycastMesh(ray.origin, ray.dir);
        } else if (meshType === MeshType.VoxelMesh) {
            return this._raycastVoxel(ray.origin, ray.dir);
        } else if (meshType === MeshType.BlockMesh) {
            return this._raycastBlock(ray.origin, ray.dir);
        }

        return null;
    }

    private _raycastMesh(rayOrigin: Vector3, rayDir: Vector3): TInteractionTarget | null {
        const meshBuffers = Renderer.Get.getMeshBuffersData();
        if (!meshBuffers || meshBuffers.length === 0) return null;

        let closestDist = Infinity;
        let closestPoint: Vector3 | null = null;
        let closestNormal: Vector3 | null = null;

        for (const buf of meshBuffers) {
            const pos = buf.positions;
            const idx = buf.indices;
            const numTris = idx.length / 3;

            for (let t = 0; t < numTris; ++t) {
                const i0 = idx[t * 3] * 3;
                const i1 = idx[t * 3 + 1] * 3;
                const i2 = idx[t * 3 + 2] * 3;

                const v0x = pos[i0], v0y = pos[i0 + 1], v0z = pos[i0 + 2];
                const v1x = pos[i1], v1y = pos[i1 + 1], v1z = pos[i1 + 2];
                const v2x = pos[i2], v2y = pos[i2 + 1], v2z = pos[i2 + 2];

                const e1x = v1x - v0x, e1y = v1y - v0y, e1z = v1z - v0z;
                const e2x = v2x - v0x, e2y = v2y - v0y, e2z = v2z - v0z;

                const hx = rayDir.y * e2z - rayDir.z * e2y;
                const hy = rayDir.z * e2x - rayDir.x * e2z;
                const hz = rayDir.x * e2y - rayDir.y * e2x;

                const a = e1x * hx + e1y * hy + e1z * hz;
                if (a > -1e-7 && a < 1e-7) continue;
                const f = 1.0 / a;

                const sx = rayOrigin.x - v0x;
                const sy = rayOrigin.y - v0y;
                const sz = rayOrigin.z - v0z;

                const u = f * (sx * hx + sy * hy + sz * hz);
                if (u < 0.0 || u > 1.0) continue;

                const qx = sy * e1z - sz * e1y;
                const qy = sz * e1x - sx * e1z;
                const qz = sx * e1y - sy * e1x;

                const v = f * (rayDir.x * qx + rayDir.y * qy + rayDir.z * qz);
                if (v < 0.0 || u + v > 1.0) continue;

                const dist = f * (e2x * qx + e2y * qy + e2z * qz);
                if (dist > 1e-4 && dist < closestDist) {
                    closestDist = dist;
                    closestPoint = new Vector3(
                        rayOrigin.x + rayDir.x * dist,
                        rayOrigin.y + rayDir.y * dist,
                        rayOrigin.z + rayDir.z * dist,
                    );
                    const nx = e1y * e2z - e1z * e2y;
                    const ny = e1z * e2x - e1x * e2z;
                    const nz = e1x * e2y - e1y * e2x;
                    closestNormal = new Vector3(nx, ny, nz).normalise();
                }
            }
        }

        if (closestPoint && closestNormal) {
            return {
                type: 'mesh',
                position: closestPoint,
                normal: closestNormal,
            };
        }
        return null;
    }

    private _intersectAABB(
        rayOrigin: Vector3,
        invDir: { x: number, y: number, z: number },
        min: Vector3,
        max: Vector3,
    ): number {
        let tmin = (min.x - rayOrigin.x) * invDir.x;
        let tmax = (max.x - rayOrigin.x) * invDir.x;
        if (tmin > tmax) { const tmp = tmin; tmin = tmax; tmax = tmp; }

        let tymin = (min.y - rayOrigin.y) * invDir.y;
        let tymax = (max.y - rayOrigin.y) * invDir.y;
        if (tymin > tymax) { const tmp = tymin; tymin = tymax; tymax = tmp; }

        if (tmin > tymax || tymin > tmax) return Infinity;
        if (tymin > tmin) tmin = tymin;
        if (tymax < tmax) tmax = tymax;

        let tzmin = (min.z - rayOrigin.z) * invDir.z;
        let tzmax = (max.z - rayOrigin.z) * invDir.z;
        if (tzmin > tzmax) { const tmp = tzmin; tzmin = tzmax; tzmax = tmp; }

        if (tmin > tzmax || tzmin > tmax) return Infinity;
        if (tzmin > tmin) tmin = tzmin;
        if (tzmax < tmax) tmax = tzmax;

        if (tmax < 0) return Infinity;
        return tmin > 0 ? tmin : tmax;
    }

    private _raycastVoxel(rayOrigin: Vector3, rayDir: Vector3): TInteractionTarget | null {
        const voxelData = Renderer.Get.getVoxelData();
        if (!voxelData || voxelData.length === 0) return null;

        const voxelSize = Renderer.Get.getVoxelSize();
        const gridOffset = Renderer.Get.getGridOffset();
        const halfSize = voxelSize / 2;

        const invDir = {
            x: Math.abs(rayDir.x) > 1e-8 ? 1.0 / rayDir.x : (rayDir.x >= 0 ? 1e8 : -1e8),
            y: Math.abs(rayDir.y) > 1e-8 ? 1.0 / rayDir.y : (rayDir.y >= 0 ? 1e8 : -1e8),
            z: Math.abs(rayDir.z) > 1e-8 ? 1.0 / rayDir.z : (rayDir.z >= 0 ? 1e8 : -1e8),
        };

        let closestDist = Infinity;
        let closestVoxel: { gridPos: [number, number, number], center: Vector3 } | null = null;

        for (let i = 0; i < voxelData.length; ++i) {
            const v = voxelData[i];
            const cx = (v.position[0] + gridOffset.x) * voxelSize;
            const cy = (v.position[1] + gridOffset.y) * voxelSize;
            const cz = (v.position[2] + gridOffset.z) * voxelSize;

            const min = new Vector3(cx - halfSize, cy - halfSize, cz - halfSize);
            const max = new Vector3(cx + halfSize, cy + halfSize, cz + halfSize);

            const dist = this._intersectAABB(rayOrigin, invDir, min, max);
            if (dist < closestDist) {
                closestDist = dist;
                closestVoxel = {
                    gridPos: v.position,
                    center: new Vector3(cx, cy, cz),
                };
            }
        }

        if (closestVoxel) {
            return {
                type: 'voxel',
                gridPos: closestVoxel.gridPos,
                center: closestVoxel.center,
            };
        }
        return null;
    }

    private _raycastBlock(rayOrigin: Vector3, rayDir: Vector3): TInteractionTarget | null {
        const blockData = Renderer.Get.getBlockSelectionData();
        if (!blockData || blockData.length === 0) return null;

        const voxelSize = Renderer.Get.getVoxelSize();
        const gridOffset = Renderer.Get.getGridOffset();
        const halfSize = voxelSize / 2;
        const sliceEnabled = Renderer.Get.isSliceViewerEnabled();
        const sliceHeight = Renderer.Get.getSliceHeight();

        const invDir = {
            x: Math.abs(rayDir.x) > 1e-8 ? 1.0 / rayDir.x : (rayDir.x >= 0 ? 1e8 : -1e8),
            y: Math.abs(rayDir.y) > 1e-8 ? 1.0 / rayDir.y : (rayDir.y >= 0 ? 1e8 : -1e8),
            z: Math.abs(rayDir.z) > 1e-8 ? 1.0 / rayDir.z : (rayDir.z >= 0 ? 1e8 : -1e8),
        };

        let closestDist = Infinity;
        let closestBlock: { gridPos: [number, number, number], center: Vector3 } | null = null;

        for (let i = 0; i < blockData.length; ++i) {
            const b = blockData[i];
            if (sliceEnabled && b.position[1] > sliceHeight) {
                continue;
            }

            const cx = (b.position[0] + gridOffset.x) * voxelSize;
            const cy = (b.position[1] + gridOffset.y) * voxelSize;
            const cz = (b.position[2] + gridOffset.z) * voxelSize;

            const min = new Vector3(cx - halfSize, cy - halfSize, cz - halfSize);
            const max = new Vector3(cx + halfSize, cy + halfSize, cz + halfSize);

            const dist = this._intersectAABB(rayOrigin, invDir, min, max);
            if (dist < closestDist) {
                closestDist = dist;
                closestBlock = {
                    gridPos: b.position,
                    center: new Vector3(cx, cy, cz),
                };
            }
        }

        if (closestBlock) {
            return {
                type: 'block',
                gridPos: closestBlock.gridPos,
                center: closestBlock.center,
            };
        }
        return null;
    }

    private _onMouseDown(e: MouseEvent) {
        if (!this._isEnabled || e.button !== 0) return;

        this._isMouseDown = true;
        this._isDragging = false;
        this._mouseDownPos = { x: e.clientX, y: e.clientY };

        const hit = this.raycast(e.clientX, e.clientY);

        // If clicking on an already selected element, initiate hold timer for radial menu
        if (hit && this.selectedTarget && this.targetsEqual(hit, this.selectedTarget)) {
            ArcballCamera.Get.isRotationLocked = true;
            this._holdTimer = window.setTimeout(() => {
                this._openRadialMenu(e.clientX, e.clientY);
            }, 220);
        } else if (hit) {
            // Also allow pressing and holding on an unselected element to select and open radial menu
            this._holdTimer = window.setTimeout(() => {
                this.selectedTarget = hit;
                this._openRadialMenu(e.clientX, e.clientY);
            }, 260);
        }
    }

    private _onMouseMove(e: MouseEvent) {
        if (!this._isEnabled) return;

        if (this._isMouseDown && !this._isRadialMenuOpen) {
            const dist = Math.hypot(e.clientX - this._mouseDownPos.x, e.clientY - this._mouseDownPos.y);
            if (dist >= 5) {
                this._isDragging = true;
                if (this._holdTimer) {
                    window.clearTimeout(this._holdTimer);
                    this._holdTimer = undefined;
                }
                ArcballCamera.Get.isRotationLocked = false;
                ArcballCamera.Get.isUserRotating = true;
            }
        }

        if (this._isRadialMenuOpen) {
            const dx = e.clientX - this._radialMenuCenter.x;
            const dy = e.clientY - this._radialMenuCenter.y;
            const dist = Math.hypot(dx, dy);
            const angle = Math.atan2(dy, dx); // 0 is pointing right

            const isRightActive = dist >= 20 && Math.abs(angle) <= (Math.PI / 3.2);
            if (this._isRightOptionActive !== isRightActive) {
                this._isRightOptionActive = isRightActive;
                this._updateRadialMenuUI(isRightActive);
            }
        } else if (!this._isMouseDown) {
            const hit = this.raycast(e.clientX, e.clientY);
            if (!this.targetsEqual(hit, this.hoveredTarget)) {
                this.hoveredTarget = hit;
                Renderer.Get.forceRedraw();
            }
        }
    }

    private _onMouseUp(e: MouseEvent) {
        if (!this._isEnabled || e.button !== 0) return;

        this._isMouseDown = false;
        if (this._holdTimer) {
            window.clearTimeout(this._holdTimer);
            this._holdTimer = undefined;
        }

        if (this._isRadialMenuOpen) {
            if (this._isRightOptionActive && this.selectedTarget) {
                const targetPos = this.selectedTarget.type === 'mesh' ?
                    this.selectedTarget.position :
                    this.selectedTarget.center;
                ArcballCamera.Get.setTarget(targetPos);
            }
            this._closeRadialMenu();
            return;
        }

        if (!this._isDragging) {
            // Click without dragging: select or deselect
            const hit = this.raycast(e.clientX, e.clientY);
            if (hit) {
                this.selectedTarget = hit;
            } else {
                this.selectedTarget = null; // Click outside model clears selection
            }
            Renderer.Get.forceRedraw();
        }

        this._isDragging = false;
        ArcballCamera.Get.isRotationLocked = false;
        ArcballCamera.Get.isUserRotating = false;
    }

    private _openRadialMenu(clientX: number, clientY: number) {
        if (!this.selectedTarget) return;

        this._isRadialMenuOpen = true;
        this._radialMenuCenter = { x: clientX, y: clientY };
        this._isRightOptionActive = false;

        ArcballCamera.Get.isRotationLocked = true;
        ArcballCamera.Get.isUserRotating = false;

        if (this._radialMenuElement) {
            const colCanvas = document.getElementById('col-canvas');
            const rect = colCanvas ? colCanvas.getBoundingClientRect() : { left: 0, top: 0 };
            const localX = clientX - rect.left;
            const localY = clientY - rect.top;

            this._radialMenuElement.style.left = `${localX}px`;
            this._radialMenuElement.style.top = `${localY}px`;
            this._radialMenuElement.classList.remove('hide');
            this._updateRadialMenuUI(false);
        }
        Renderer.Get.forceRedraw();
    }

    private _closeRadialMenu() {
        this._isRadialMenuOpen = false;
        this._isRightOptionActive = false;
        if (this._holdTimer) {
            window.clearTimeout(this._holdTimer);
            this._holdTimer = undefined;
        }
        if (typeof document !== 'undefined') {
            ArcballCamera.Get.isRotationLocked = false;
            ArcballCamera.Get.isUserRotating = false;
            if (this._radialMenuElement) {
                this._radialMenuElement.classList.add('hide');
            }
            Renderer.Get.forceRedraw();
        }
    }

    private _updateRadialMenuUI(isRightActive: boolean) {
        if (!this._rightOptionElement) return;

        if (isRightActive) {
            this._rightOptionElement.classList.add('active');
        } else {
            this._rightOptionElement.classList.remove('active');
        }
    }

    private _createRadialMenuDOM() {
        const colCanvas = document.getElementById('col-canvas') || document.body;

        const menu = document.createElement('div');
        menu.id = 'radial-menu';
        menu.className = 'radial-menu hide';

        menu.innerHTML = `
            <div class="radial-menu-backdrop"></div>
            <div class="radial-menu-center">
                <div class="radial-center-dot"></div>
            </div>
            <div class="radial-menu-item item-right" id="radial-item-right">
                <div class="radial-item-icon">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                        <circle cx="12" cy="12" r="10"></circle>
                        <circle cx="12" cy="12" r="3"></circle>
                        <line x1="12" y1="2" x2="12" y2="6"></line>
                        <line x1="12" y1="18" x2="12" y2="22"></line>
                        <line x1="2" y1="12" x2="6" y2="12"></line>
                        <line x1="18" y1="12" x2="22" y2="12"></line>
                    </svg>
                </div>
                <div class="radial-item-text">
                    <div class="radial-item-title">Центр орбиты</div>
                    <div class="radial-item-desc">Установить точку камеры</div>
                </div>
                <div class="radial-item-arrow">→</div>
            </div>
        `;

        colCanvas.appendChild(menu);
        this._radialMenuElement = menu;
        this._rightOptionElement = menu.querySelector('#radial-item-right') as HTMLDivElement;
    }
}
