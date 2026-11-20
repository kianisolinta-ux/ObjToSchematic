/**
 * @jest-environment jsdom
 */

import { PALETTE_ALL_RELEASE } from '../res/palettes/all';
import { PALETTE_SURVIVAL_33 } from '../res/palettes/survival-33';
import { RGBAColours } from '../src/colour';
import { Localiser } from '../src/localiser';
import { Palette } from '../src/palette';
import { UVTriangle } from '../src/triangle';
import { PaletteComponent } from '../src/ui/components/palette';
import { UV } from '../src/util';
import { Vector3 } from '../src/vector';
import { IVoxeliser } from '../src/voxelisers/base-voxeliser';
import { TEST_PREAMBLE } from './preamble';

class TestVoxeliser extends IVoxeliser {
    protected override _voxelise(): any {
        return null;
    }

    public testInternalGetVoxelColour(mesh: any, triangle: UVTriangle, materialName: string, location: Vector3) {
        return (this as any)._internalGetVoxelColour(mesh, triangle, materialName, location);
    }
}

describe('Step 1 Foundation: Voxeliser UV NaN fix & Offline Palette Presets', () => {
    beforeAll(async () => {
        TEST_PREAMBLE();
        await Localiser.Get.init();
    });

    beforeEach(() => {
        window.localStorage.clear();
    });

    afterEach(() => {
        window.localStorage.clear();
        document.body.innerHTML = '';
    });

    test('IVoxeliser._internalGetVoxelColour returns MAGENTA fallback for degenerate zero-area triangles without calling texture sampling with NaN', () => {
        const voxeliser = new TestVoxeliser();
        const sampleTextureMaterial = jest.fn();
        const fakeMesh = {
            getMaterialByName: () => ({ type: 1 /* MaterialType.textured */ }),
            sampleTextureMaterial,
        };

        // Collinear / collapsed triangle (zero area)
        const degenerateTri = new UVTriangle(
            new Vector3(0, 0, 0),
            new Vector3(0, 0, 0),
            new Vector3(0, 0, 0),
            new Vector3(0, 1, 0),
            new Vector3(0, 1, 0),
            new Vector3(0, 1, 0),
            new UV(0, 0),
            new UV(1, 0),
            new UV(0, 1),
        );

        const colour = voxeliser.testInternalGetVoxelColour(fakeMesh, degenerateTri, 'mat', new Vector3(0, 0, 0));
        expect(sampleTextureMaterial).not.toHaveBeenCalled();
        expect(colour).toEqual(RGBAColours.MAGENTA);
        expect(Number.isNaN(colour.r)).toBe(false);
    });

    test('PaletteComponent applies Survival 33 preset, saves custom preset offline, and restores across instances', () => {
        const comp1 = new PaletteComponent();
        document.body.innerHTML = comp1.generateHTML();
        comp1.registerEvents();
        comp1.finalise();
        comp1.setEnabled(true);

        const id1 = (comp1 as any)._getId();
        const presetSelect = document.getElementById(`${id1}-preset-select`) as HTMLSelectElement;
        expect(presetSelect).not.toBeNull();
        expect(comp1.getValue().count()).toBe(PALETTE_ALL_RELEASE.length);

        // Select survival-33 preset
        presetSelect.value = 'survival-33';
        presetSelect.dispatchEvent(new Event('change', { bubbles: true }));

        expect(comp1.getValue().count()).toBe(33);
        for (const block of PALETTE_SURVIVAL_33) {
            expect(comp1.getValue().has(block)).toBe(true);
        }

        const badge = document.getElementById(`${id1}-count`);
        expect(badge?.textContent).toBe(`33 / ${PALETTE_ALL_RELEASE.length}`);

        // Open inline save row and save custom preset
        const saveBtn = document.getElementById(`${id1}-preset-save`) as HTMLButtonElement;
        saveBtn.click();

        const nameInput = document.getElementById(`${id1}-preset-name`) as HTMLInputElement;
        nameInput.value = 'My Survival Mix';
        const confirmBtn = document.getElementById(`${id1}-preset-confirm`) as HTMLButtonElement;
        confirmBtn.click();

        // Reload simulation: instantiate a fresh PaletteComponent
        const comp2 = new PaletteComponent();
        document.body.innerHTML = comp2.generateHTML();
        comp2.registerEvents();
        comp2.finalise();
        comp2.setEnabled(true);

        expect(comp2.getValue().count()).toBe(33);
        const id2 = (comp2 as any)._getId();
        const presetSelect2 = document.getElementById(`${id2}-preset-select`) as HTMLSelectElement;
        expect(presetSelect2.value).toContain('custom:');

        const deleteBtn2 = document.getElementById(`${id2}-preset-delete`) as HTMLButtonElement;
        expect(deleteBtn2.disabled).toBe(false);
        deleteBtn2.click();

        expect(presetSelect2.value).toBe('survival-33');
        expect(deleteBtn2.disabled).toBe(true);
    });

    test('Palette.load supports survival-33', () => {
        const p = Palette.load('survival-33');
        expect(p).toBeDefined();
        expect(p?.count()).toBe(33);
    });
});
