import Split from 'split.js';

import { locales } from '../../loc/base';
import { PALETTE_ALL_RELEASE } from '../../res/palettes/all';
import { AppContext } from '../app_context';
import {
    computeAssignControlState,
    createAutoAssignScheduler,
    IAssignControlState,
    IAutoAssignScheduler,
    isMultiBlockWeightedAlgorithm,
} from '../auto_assign_helpers';
import { FallableBehaviour } from '../block_mesh';
import { TMaterialFilter } from '../block_styles';
import { ArcballCamera } from '../camera';
import { TColourStyle } from '../colour_styles';
import { AppConfig } from '../config';
import { EstimatedDimensions } from '../dimension_estimator';
import { EAppEvent, EventManager } from '../event';
import { TExporters } from '../exporters/exporters';
import { InteractionManager } from '../interaction';
import { LOC, Localiser, TLocalisedString } from '../localiser';
import { MaterialMapManager } from '../material-map';
import { MaterialType } from '../mesh';
import { MeshType, Renderer } from '../renderer';
import {
    computeVisibleSidebarSections,
    SIDEBAR_FILTER_SECTIONS,
    toggleSidebarSection,
    TSidebarSectionId,
} from '../sidebar_filter';
import { EAction } from '../util';
import { ASSERT } from '../util/error_util';
import { LOG } from '../util/log_util';
import { TAxis } from '../util/type_util';
import { TBlockSelectionAlgorithm, TDithering, TLightingPlacement, TLightingScope } from '../util/type_util';
import { UIUtil } from '../util/ui_util';
import { Vector3 } from '../vector';
import { TVoxelOverlapRule } from '../voxel_mesh';
import { computeVoxelPostControlState } from '../voxel_post_helpers';
import { TMorphMode, TVoxelMirrorAxis } from '../voxel_postprocess';
import { TVoxelisers } from '../voxelisers/voxelisers';
import { PreviewParams, TReplaceMode, TReplaceScope } from '../worker_types';
import { ButtonComponent } from './components/button';
import { CheckboxComponent } from './components/checkbox';
import { ComboboxComponent } from './components/combobox';
import { ConfigComponent } from './components/config';
import { DichromePaletteComponent } from './components/dichrome_palette';
import { DimensionsReadoutComponent } from './components/dimensions_readout';
import { FileComponent } from './components/file_input';
import { HeaderComponent } from './components/header';
import { PaletteComponent } from './components/palette';
import { PlaceholderComponent } from './components/placeholder';
import { PreviewComponent } from './components/preview';
import { RadialToneDistributionComponent } from './components/radial_tone';
import { SliderComponent } from './components/slider';
import { SolidMaterialComponent } from './components/solid_material';
import { TextInputComponent } from './components/text_input';
import { TexturedMaterialComponent } from './components/textured_material';
import { ToolbarItemComponent } from './components/toolbar_item';
import { VectorComponent } from './components/vector';
import { AppConsole } from './console';
import { AppIcons } from './icons';
import { HTMLBuilder, MiscComponents } from './misc';

export type Group = {
    id: string,
    label: TLocalisedString;
    components: { [key: string]: ConfigComponent<any, any> };
    componentOrder: string[];
    execButton?: ButtonComponent;
}

export interface ToolbarGroup {
    components: { [key: string]: ToolbarItemComponent };
    componentOrder: string[];
}

export class UI {
    /* Singleton */
    private static _instance: UI;
    public static get Get() {
        return this._instance || (this._instance = new this());
    }

    public constructor() {
        const languageComponents = new ComboboxComponent<string>()
            .setLabel('settings.components.language')
            .addValueChangedListener((newLanguageCode) => {
                AppConsole.info(LOC('settings.changing_language'));
                Localiser.Get.changeLanguage(newLanguageCode);
            });

        locales.forEach((locale) => {
            languageComponents.addItem({
                displayText: locale.display_name,
                payload: locale.language_code,
            });
        });
        this._ui.settings.components.language = languageComponents;

        EventManager.Get.add(EAppEvent.onLanguageChanged, () => {
            this._handleLanguageChange();
        });

        EventManager.Get.add(EAppEvent.onTaskProgress, (e: any) => {
            const lastAction = this._appContext?.getLastAction();
            if (lastAction !== undefined) {
                this.getActionButton(lastAction)?.setProgress(e[1]);
            }
        });

        this._autoAssignScheduler = createAutoAssignScheduler({
            debounceMs: 160,
            canRun: () => this.canRunAutoAssign(),
            runAssign: async () => {
                await this._appContext?.runAutoAssign();
            },
            isBusyExternally: () => this._appContext?.isActionBusy() ?? false,
        });

        this._autoVoxelPostScheduler = createAutoAssignScheduler({
            debounceMs: 150,
            canRun: () => this.canRunAutoVoxelPost(),
            runAssign: async () => {
                await this._appContext?.runAutoVoxelPost();
            },
            isBusyExternally: () => this._appContext?.isActionBusy() ?? false,
        });
    }

    public uiOrder = ['settings', 'import', 'materials', 'voxelise', 'voxelPost', 'assign', 'preview', 'export'];
    public _ui = {
        'settings': {
            id: 'settings',
            label: LOC('settings.heading'),
            components: {
                'language': new ComboboxComponent<string>(), // Handled in constructor
                'overrideHeight': new SliderComponent()
                    .setMin(16)
                    .setMax(10000)
                    .setDefaultValue(380)
                    .setDecimals(0)
                    .setStep(1)
                    .setLabel('settings.components.overrideHeight')
                    .addValueChangedListener((newValue) => {
                        AppConfig.Get.CONSTRAINT_MAXIMUM_HEIGHT = newValue;
                    }),
            },
            componentOrder: ['language', 'overrideHeight'],
        },
        'import': {
            id: 'import',
            label: LOC('import.heading'),
            components: {
                'input': new FileComponent()
                    .setLabel('import.components.input')
                    .addValueChangedListener(() => {
                        this.getActionButton(EAction.Import)?.setEnabled(true);
                    }),
                'rotation': new VectorComponent()
                    .setLabel('import.components.rotation')
                    .addValueChangedListener(() => {
                        this._appContext?.onRotationChanged();
                    })
                    .setOnMouseEnterExit((state, component) => {
                        if (state === 'exit') {
                            Renderer.Get.clearAxisToHighlight();
                        } else {
                            Renderer.Get.setAxisToHighlight(component);
                        }
                    }),
            },
            componentOrder: ['input', 'rotation'],
            execButton: new ButtonComponent()
                .setOnClick(() => {
                    this._appContext?.do(EAction.Import);
                })
                .setLabel(LOC('import.button')),
        },
        'materials': {
            id: 'materials',
            label: LOC('materials.heading'),
            components: {
            },
            componentOrder: [],
            execButton: new ButtonComponent()
                .setOnClick(() => {
                    this._appContext?.do(EAction.Materials);
                })
                .setLabel(LOC('materials.button')),
        },
        'voxelise': {
            id: 'voxelise',
            label: LOC('voxelise.heading'),
            components: {
                'constraintAxis': new ComboboxComponent<TAxis>()
                    .addItem({ payload: 'y', displayLocKey: 'voxelise.components.y_axis' })
                    .addItem({ payload: 'x', displayLocKey: 'voxelise.components.x_axis' })
                    .addItem({ payload: 'z', displayLocKey: 'voxelise.components.z_axis' })
                    .setLabel('voxelise.components.constraint_axis')
                    .addValueChangedListener((value: TAxis) => {
                        switch (value) {
                            case 'x': {
                                ASSERT(this._appContext !== undefined && this._appContext.minConstraint !== undefined && this._appContext.maxConstraint !== undefined);
                                LOG('min', this._appContext.minConstraint, 'max', this._appContext.maxConstraint);
                                this._ui.voxelise.components.size.setMin(this._appContext.minConstraint.x);
                                this._ui.voxelise.components.size.setMax(this._appContext.maxConstraint.x);
                                break;
                            }
                            case 'y': {
                                this._ui.voxelise.components.size.setMin(AppConfig.Get.CONSTRAINT_MINIMUM_HEIGHT);
                                this._ui.voxelise.components.size.setMax(AppConfig.Get.CONSTRAINT_MAXIMUM_HEIGHT);
                                break;
                            }
                            case 'z': {
                                ASSERT(this._appContext !== undefined && this._appContext.minConstraint !== undefined && this._appContext.maxConstraint !== undefined);
                                LOG('min', this._appContext.minConstraint, 'max', this._appContext.maxConstraint);
                                this._ui.voxelise.components.size.setMin(this._appContext.minConstraint.z);
                                this._ui.voxelise.components.size.setMax(this._appContext.maxConstraint.z);
                                break;
                            }
                        }
                        this._appContext?.updateEstimatedVoxelDimensions(false);
                    }),
                'size': new SliderComponent()
                    .setMin(3)
                    .setMax(380)
                    .setDefaultValue(80)
                    .setDecimals(0)
                    .setStep(1)
                    .setCommitTypedValueOnBlur()
                    .setLabel('voxelise.components.size')
                    .addValueChangedListener(() => {
                        this._appContext?.updateEstimatedVoxelDimensions(false);
                    }),
                'dimensionsReadout': new DimensionsReadoutComponent()
                    .setLabel('voxelise.components.dimensions'),
                'voxeliser': new ComboboxComponent<TVoxelisers>()
                    .addItem({ payload: 'ray-based', displayLocKey: 'voxelise.components.ray_based' })
                    .addItem({ payload: 'bvh-ray', displayLocKey: 'voxelise.components.bvh_ray' })
                    .addItem({ payload: 'bvh-ray-plus-thickness', displayLocKey: 'voxelise.components.bvh_ray_plus_thickness' })
                    .addItem({ payload: 'conservative-surface', displayLocKey: 'voxelise.components.conservative_surface' })
                    .addItem({ payload: 'solid-fill', displayLocKey: 'voxelise.components.solid_fill' })
                    .addItem({ payload: 'hybrid-sat-ray', displayLocKey: 'voxelise.components.hybrid_sat_ray' })
                    .addItem({ payload: 'sdf-shell', displayLocKey: 'voxelise.components.sdf_shell' })
                    .addItem({ payload: 'supersample-grid', displayLocKey: 'voxelise.components.supersample_grid' })
                    .addItem({ payload: 'flood-solid', displayLocKey: 'voxelise.components.flood_solid' })
                    .addItem({ payload: 'heightmap-relief', displayLocKey: 'voxelise.components.heightmap_relief' })
                    .addItem({ payload: 'ncrb', displayLocKey: 'voxelise.components.ncrb' })
                    .setLabel('voxelise.components.algorithm')
                    .addValueChangedListener(() => {
                        this._appContext?.updateEstimatedVoxelDimensions(false);
                        this._updateVoxeliseControls(this._ui.voxelise.components.voxeliser.getEnabled());
                    })
                    .addEnabledChangedListener((isEnabled) => {
                        this._updateVoxeliseControls(isEnabled);
                    }),
                'surfaceRadius': new SliderComponent()
                    .setMin(0.5)
                    .setMax(2.0)
                    .setDefaultValue(0.75)
                    .setDecimals(2)
                    .setStep(0.05)
                    .setLabel('voxelise.components.surface_radius')
                    .setShouldObeyGroupEnables(false),
                'coverageThreshold': new SliderComponent()
                    .setMin(0.125)
                    .setMax(0.875)
                    .setDefaultValue(0.25)
                    .setDecimals(3)
                    .setStep(0.125)
                    .setLabel('voxelise.components.coverage_threshold')
                    .setShouldObeyGroupEnables(false),
                'ambientOcclusion': new CheckboxComponent()
                    .setCheckedText('voxelise.components.on_recommended')
                    .setUncheckedText('voxelise.components.off_faster')
                    .setDefaultValue(true)
                    .setLabel('voxelise.components.ambient_occlusion'),
                'multisampleColouring': new CheckboxComponent()
                    .setCheckedText('voxelise.components.on_recommended')
                    .setUncheckedText('voxelise.components.off_faster')
                    .setDefaultValue(true)
                    .setLabel('voxelise.components.multisampling'),
                'voxelOverlapRule': new ComboboxComponent<TVoxelOverlapRule>()
                    .addItem({
                        displayLocKey: 'voxelise.components.average_recommended',
                        payload: 'average',
                    })
                    .addItem({
                        displayLocKey: 'voxelise.components.dominant',
                        payload: 'dominant',
                    })
                    .addItem({
                        displayLocKey: 'voxelise.components.first',
                        payload: 'first',
                    })
                    .setLabel('voxelise.components.voxel_overlap'),
                'morphMode': new ComboboxComponent<TMorphMode>()
                    .addItem({ payload: 'none', displayLocKey: 'voxelise.components.morph_none' })
                    .addItem({ payload: 'close', displayLocKey: 'voxelise.components.morph_close' })
                    .addItem({ payload: 'smooth', displayLocKey: 'voxelise.components.morph_smooth' })
                    .addItem({ payload: 'bevel', displayLocKey: 'voxelise.components.morph_bevel' })
                    .addItem({ payload: 'fill-cavities', displayLocKey: 'voxelise.components.morph_fill_cavities' })
                    .addItem({ payload: 'dilate', displayLocKey: 'voxelise.components.morph_dilate' })
                    .addItem({ payload: 'erode', displayLocKey: 'voxelise.components.morph_erode' })
                    .setLabel('voxelise.components.morph_mode')
                    .addValueChangedListener(() => {
                        this._updateVoxeliseControls(this._ui.voxelise.components.morphMode.getEnabled());
                    })
                    .addEnabledChangedListener((isEnabled) => {
                        this._updateVoxeliseControls(isEnabled);
                    }),
                'morphPasses': new SliderComponent()
                    .setMin(1)
                    .setMax(3)
                    .setDefaultValue(1)
                    .setDecimals(0)
                    .setStep(1)
                    .setLabel('voxelise.components.morph_passes')
                    .setShouldObeyGroupEnables(false),
                'voxelMirror': new ComboboxComponent<TVoxelMirrorAxis>()
                    .addItem({ payload: 'none', displayLocKey: 'voxelise.components.mirror_none' })
                    .addItem({ payload: 'x', displayLocKey: 'voxelise.components.mirror_x' })
                    .addItem({ payload: 'z', displayLocKey: 'voxelise.components.mirror_z' })
                    .addItem({ payload: 'xz', displayLocKey: 'voxelise.components.mirror_xz' })
                    .setLabel('voxelise.components.voxel_mirror'),
                'addBasePlinth': new CheckboxComponent()
                    .setCheckedText('voxelise.components.plinth_on')
                    .setUncheckedText('voxelise.components.plinth_off')
                    .setDefaultValue(false)
                    .setLabel('voxelise.components.add_base_plinth')
                    .addValueChangedListener(() => {
                        this._updateVoxeliseControls(this._ui.voxelise.components.addBasePlinth.getEnabled());
                    })
                    .addEnabledChangedListener((isEnabled) => {
                        this._updateVoxeliseControls(isEnabled);
                    }),
                'plinthThickness': new SliderComponent()
                    .setMin(1)
                    .setMax(4)
                    .setDefaultValue(1)
                    .setDecimals(0)
                    .setStep(1)
                    .setLabel('voxelise.components.plinth_thickness')
                    .setShouldObeyGroupEnables(false),
                'hollow': new CheckboxComponent()
                    .setCheckedText('voxelise.components.hollow_on')
                    .setUncheckedText('voxelise.components.hollow_off')
                    .setDefaultValue(false)
                    .setLabel('voxelise.components.hollow')
                    .addValueChangedListener(() => {
                        this._updateVoxeliseControls(this._ui.voxelise.components.hollow.getEnabled());
                    })
                    .addEnabledChangedListener((isEnabled) => {
                        this._updateVoxeliseControls(isEnabled);
                    }),
                'wallThickness': new SliderComponent()
                    .setMin(1)
                    .setMax(4)
                    .setDefaultValue(1)
                    .setDecimals(0)
                    .setStep(1)
                    .setLabel('voxelise.components.wall_thickness')
                    .setShouldObeyGroupEnables(false),
                'removeFloatingIslands': new CheckboxComponent()
                    .setCheckedText('voxelise.components.islands_on')
                    .setUncheckedText('voxelise.components.islands_off')
                    .setDefaultValue(false)
                    .setLabel('voxelise.components.remove_floating_islands')
                    .addValueChangedListener(() => {
                        this._updateVoxeliseControls(this._ui.voxelise.components.removeFloatingIslands.getEnabled());
                    })
                    .addEnabledChangedListener((isEnabled) => {
                        this._updateVoxeliseControls(isEnabled);
                    }),
                'minIslandSize': new SliderComponent()
                    .setMin(2)
                    .setMax(64)
                    .setDefaultValue(4)
                    .setDecimals(0)
                    .setStep(1)
                    .setLabel('voxelise.components.min_island_size')
                    .setShouldObeyGroupEnables(false),
                'placeholder': new PlaceholderComponent()
                    .setPlaceholderText('misc.advanced_settings'),
            },
            componentOrder: [
                'constraintAxis',
                'size',
                'dimensionsReadout',
                'hollow',
                'wallThickness',
                'removeFloatingIslands',
                'minIslandSize',
                'morphMode',
                'morphPasses',
                'voxelMirror',
                'addBasePlinth',
                'plinthThickness',
                'placeholder',
                'voxeliser',
                'surfaceRadius',
                'coverageThreshold',
                'ambientOcclusion',
                'multisampleColouring',
                'voxelOverlapRule',
            ],
            execButton: new ButtonComponent()
                .setOnClick(() => {
                    this._appContext?.do(EAction.Voxelise);
                })
                .setLabel(LOC('voxelise.button')),
        },
        'voxelPost': {
            id: 'voxelPost',
            label: LOC('voxel_post.heading'),
            components: {
                'rotation': new VectorComponent()
                    .setLabel('voxel_post.components.rotation')
                    .addValueChangedListener(() => {
                        if (!this._suppressAutoVoxelPost) {
                            this._scheduleAutoVoxelPostIfActive();
                        }
                    })
                    .setOnMouseEnterExit((state, component) => {
                        if (state === 'exit') {
                            Renderer.Get.clearAxisToHighlight();
                        } else {
                            Renderer.Get.setAxisToHighlight(component);
                        }
                    }),
            },
            componentOrder: ['rotation'],
            execButton: new ButtonComponent()
                .setOnClick(() => {
                    this._appContext?.do(EAction.VoxelPost);
                })
                .setLabel(LOC('voxel_post.button')),
        },
        'assign': {
            id: 'assign',
            label: LOC('assign.heading'),
            components: {
                'textureAtlas': new ComboboxComponent<string>()
                    .addItem({ displayLocKey: 'assign.components.vanilla', payload: 'vanilla' })
                    .setLabel('assign.components.texture_atlas')
                    .setShouldObeyGroupEnables(false),
                'blockPalette': new PaletteComponent()
                    .setLabel('assign.components.block_palette'),
                'dichromePalette': new DichromePaletteComponent()
                    .setLabel('assign.components.dichrome_palette')
                    .addValueChangedListener((newBlocks: string[]) => {
                        this._ui.assign.components.dichromeToneBias.setBlocks(newBlocks);
                    }),
                'dichromeToneBias': new RadialToneDistributionComponent()
                    .setLabel('assign.components.dichrome_tone_bias')
                    .setShouldObeyGroupEnables(false)
                    .addValueChangedListener(() => {
                        this._scheduleAutoAssignIfActive();
                    }),
                'blockSelectionAlgorithm': new ComboboxComponent<TBlockSelectionAlgorithm>()
                    .addItem({ payload: 'nearest-color', displayLocKey: 'assign.components.nearest_color' })
                    .addItem({ payload: 'color-chart-match', displayLocKey: 'assign.components.color_chart_match' })
                    .addItem({ payload: 'ciede2000', displayLocKey: 'assign.components.ciede2000' })
                    .addItem({ payload: 'hue-preserve', displayLocKey: 'assign.components.hue_preserve' })
                    .addItem({ payload: 'texture-smooth', displayLocKey: 'assign.components.texture_smooth' })
                    .addItem({ payload: 'edge-contour', displayLocKey: 'assign.components.edge_contour' })
                    .addItem({ payload: 'spatial-coherent', displayLocKey: 'assign.components.spatial_coherent' })
                    .addItem({ payload: 'palette-quantized', displayLocKey: 'assign.components.palette_quantized' })
                    .addItem({ payload: 'character-statue', displayLocKey: 'assign.components.character_statue' })
                    .addItem({ payload: 'dichrome', displayLocKey: 'assign.components.dichrome' })
                    .addItem({ payload: 'polychrome', displayLocKey: 'assign.components.polychrome' })
                    .setLabel('assign.components.block_selection_algorithm')
                    .addValueChangedListener((newValue: TBlockSelectionAlgorithm) => {
                        this._updateBlockSelectionControls(
                            newValue,
                            this._ui.assign.components.blockSelectionAlgorithm.getEnabled(),
                        );
                    })
                    .addEnabledChangedListener((isEnabled: boolean) => {
                        const styleActive = this._ui.assign.components.colourStyle.getValue() !== 'none';
                        this._ui.assign.components.colourStyleStrength.setEnabled(isEnabled && styleActive, false);
                    }),
                'colourStyle': new ComboboxComponent<TColourStyle>()
                    .addItem({ payload: 'none', displayLocKey: 'assign.components.style_none' })
                    .addItem({ payload: 'vibrant', displayLocKey: 'assign.components.style_vibrant' })
                    .addItem({ payload: 'pastel', displayLocKey: 'assign.components.style_pastel' })
                    .addItem({ payload: 'cel-shaded', displayLocKey: 'assign.components.style_cel_shaded' })
                    .addItem({ payload: 'warm-vintage', displayLocKey: 'assign.components.style_warm_vintage' })
                    .addItem({ payload: 'cool-noir', displayLocKey: 'assign.components.style_cool_noir' })
                    .addItem({ payload: 'sepia', displayLocKey: 'assign.components.style_sepia' })
                    .addItem({ payload: 'cyberpunk', displayLocKey: 'assign.components.style_cyberpunk' })
                    .setLabel('assign.components.colour_style')
                    .addValueChangedListener(() => {
                        const components = this._ui.assign.components;
                        this._updateBlockSelectionControls(
                            components.blockSelectionAlgorithm.getValue(),
                            components.blockSelectionAlgorithm.getEnabled(),
                        );
                    })
                    .addEnabledChangedListener((isEnabled: boolean) => {
                        const styleActive = this._ui.assign.components.colourStyle.getValue() !== 'none';
                        this._ui.assign.components.colourStyleStrength.setEnabled(isEnabled && styleActive, false);
                    }),
                'colourStyleStrength': new SliderComponent()
                    .setMin(0.25)
                    .setMax(1.0)
                    .setDefaultValue(0.8)
                    .setDecimals(2)
                    .setStep(0.05)
                    .setLabel('assign.components.colour_style_strength')
                    .setShouldObeyGroupEnables(false),
                'materialFilter': new ComboboxComponent<TMaterialFilter>()
                    .addItem({ payload: 'all', displayLocKey: 'assign.components.material_all' })
                    .addItem({ payload: 'smooth-only', displayLocKey: 'assign.components.material_smooth_only' })
                    .addItem({ payload: 'architectural', displayLocKey: 'assign.components.material_architectural' })
                    .addItem({ payload: 'no-translucent', displayLocKey: 'assign.components.material_no_translucent' })
                    .addItem({ payload: 'organic-nature', displayLocKey: 'assign.components.material_organic_nature' })
                    .setLabel('assign.components.material_filter')
                    .setShouldObeyGroupEnables(false),
                'dithering': new ComboboxComponent<TDithering>()
                    .addItems([{
                        displayLocKey: 'assign.components.ordered',
                        payload: 'ordered',
                    },
                    {
                        displayLocKey: 'assign.components.error_diffusion',
                        payload: 'error-diffusion',
                    },
                    {
                        displayLocKey: 'assign.components.atkinson',
                        payload: 'atkinson',
                    },
                    {
                        displayLocKey: 'assign.components.random',
                        payload: 'random',
                    },
                    {
                        displayLocKey: 'assign.components.off',
                        payload: 'off',
                    }])
                    .setLabel('assign.components.dithering')
                    .addEnabledChangedListener((isEnabled) => {
                        this._ui.assign.components.ditheringMagnitude.setEnabled(isEnabled && this._ui.assign.components.dithering.getValue() !== 'off', false);
                    })
                    .addValueChangedListener(() => {
                        const components = this._ui.assign.components;
                        this._updateBlockSelectionControls(
                            components.blockSelectionAlgorithm.getValue(),
                            components.blockSelectionAlgorithm.getEnabled(),
                        );
                    })
                    .setShouldObeyGroupEnables(false),
                'ditheringMagnitude': new SliderComponent()
                    .setMin(1)
                    .setMax(64)
                    .setDefaultValue(32)
                    .setDecimals(0)
                    .setStep(1)
                    .setLabel('assign.components.dithering_magnitude')
                    .setShouldObeyGroupEnables(false),
                'blockFilter': new CheckboxComponent()
                    .setCheckedText('misc.on')
                    .setUncheckedText('misc.off')
                    .setDefaultValue(false)
                    .setLabel('assign.components.block_filter')
                    .addValueChangedListener(() => {
                        const components = this._ui.assign.components;
                        this._updateBlockSelectionControls(
                            components.blockSelectionAlgorithm.getValue(),
                            components.blockSelectionAlgorithm.getEnabled(),
                        );
                    })
                    .addEnabledChangedListener((isEnabled) => {
                        const value = this._ui.assign.components.blockFilter.getValue();
                        this._ui.assign.components.blockFilterThreshold.setEnabled(value && isEnabled, false);
                    }),
                'blockFilterThreshold': new SliderComponent()
                    .setMin(1)
                    .setMax(120)
                    .setDefaultValue(15)
                    .setDecimals(0)
                    .setStep(1)
                    .setLabel('assign.components.block_filter_threshold')
                    .setShouldObeyGroupEnables(false),
                'fallable': new ComboboxComponent<FallableBehaviour>()
                    .addItems([{
                        displayLocKey: 'assign.components.replace_falling',
                        payload: 'replace-falling',
                    },
                    {
                        displayLocKey: 'assign.components.replace_fallable',
                        payload: 'replace-fallable',
                    },
                    {
                        displayLocKey: 'assign.components.do_nothing',
                        payload: 'do-nothing',
                    }])
                    .setLabel('assign.components.fallable_blocks'),
                'colourAccuracy': new SliderComponent()
                    .setMin(1)
                    .setMax(8)
                    .setDefaultValue(5)
                    .setDecimals(1)
                    .setStep(0.1)
                    .setLabel('assign.components.colour_accuracy')
                    .setShouldObeyGroupEnables(false),
                'contextualAveraging': new CheckboxComponent()
                    .setCheckedText('voxelise.components.on_recommended')
                    .setUncheckedText('voxelise.components.off_faster')
                    .setDefaultValue(true)
                    .setLabel('assign.components.smart_averaging')
                    .setShouldObeyGroupEnables(false),
                'errorWeight': new SliderComponent()
                    .setMin(0.0)
                    .setMax(2.0)
                    .setDefaultValue(0.2)
                    .setDecimals(2)
                    .setStep(0.01)
                    .setLabel('assign.components.smoothness')
                    .setShouldObeyGroupEnables(false),
                'brightnessOffset': new SliderComponent()
                    .setMin(-50)
                    .setMax(50)
                    .setDefaultValue(0)
                    .setDecimals(0)
                    .setStep(5)
                    .setLabel('assign.components.brightness_offset')
                    .setShouldObeyGroupEnables(false)
                    .addValueChangedListener((newValue: number) => {
                        (this._ui.assign.components.dichromeToneBias as RadialToneDistributionComponent).syncFloatingBrightness(newValue);
                        this._scheduleAutoAssignIfActive();
                    }),
                'saturationOffset': new SliderComponent()
                    .setMin(-50)
                    .setMax(50)
                    .setDefaultValue(0)
                    .setDecimals(0)
                    .setStep(5)
                    .setLabel('assign.components.saturation_offset')
                    .setShouldObeyGroupEnables(false),
                'contrastOffset': new SliderComponent()
                    .setMin(-40)
                    .setMax(40)
                    .setDefaultValue(0)
                    .setDecimals(0)
                    .setStep(5)
                    .setLabel('assign.components.contrast_offset')
                    .setShouldObeyGroupEnables(false)
                    .addValueChangedListener((newValue: number) => {
                        (this._ui.assign.components.dichromeToneBias as RadialToneDistributionComponent).syncFloatingContrast(newValue);
                        this._scheduleAutoAssignIfActive();
                    }),
                'temperatureOffset': new SliderComponent()
                    .setMin(-40)
                    .setMax(40)
                    .setDefaultValue(0)
                    .setDecimals(0)
                    .setStep(5)
                    .setLabel('assign.components.temperature_offset')
                    .setShouldObeyGroupEnables(false),
                'maxBlockTypes': new SliderComponent()
                    .setMin(0)
                    .setMax(32)
                    .setDefaultValue(0)
                    .setDecimals(0)
                    .setStep(1)
                    .setLabel('assign.components.max_block_types')
                    .setShouldObeyGroupEnables(false),
                'calculateLighting': new CheckboxComponent()
                    .setCheckedText('misc.on')
                    .setUncheckedText('misc.off')
                    .setDefaultValue(false)
                    .setLabel('assign.components.calculate_lighting')
                    .addValueChangedListener(() => {
                        const algorithm = this._ui.assign.components.blockSelectionAlgorithm.getValue();
                        const isEnabled = this._ui.assign.components.blockSelectionAlgorithm.getEnabled();
                        this._updateBlockSelectionControls(algorithm, isEnabled);
                    })
                    .addEnabledChangedListener(() => {
                        const algorithm = this._ui.assign.components.blockSelectionAlgorithm.getValue();
                        const isEnabled = this._ui.assign.components.blockSelectionAlgorithm.getEnabled();
                        this._updateBlockSelectionControls(algorithm, isEnabled);
                    }),
                'lightThreshold': new SliderComponent()
                    .setMin(0)
                    .setMax(14)
                    .setDefaultValue(1)
                    .setDecimals(0)
                    .setStep(1)
                    .setLabel('assign.components.light_threshold')
                    .setShouldObeyGroupEnables(false),
                'lightingPlacement': new ComboboxComponent<TLightingPlacement>()
                    .addItems([
                        {
                            displayLocKey: 'assign.components.lighting_placement_ordered',
                            payload: 'ordered',
                        },
                        {
                            displayLocKey: 'assign.components.lighting_placement_random',
                            payload: 'random',
                        },
                    ])
                    .setDefaultValue('ordered')
                    .setLabel('assign.components.lighting_placement')
                    .setShouldObeyGroupEnables(false),
                'lightingScope': new ComboboxComponent<TLightingScope>()
                    .addItems([
                        {
                            displayLocKey: 'assign.components.lighting_scope_darkness',
                            payload: 'darkness',
                        },
                        {
                            displayLocKey: 'assign.components.lighting_scope_all_surface',
                            payload: 'all_surface',
                        },
                    ])
                    .setDefaultValue('darkness')
                    .setLabel('assign.components.lighting_scope')
                    .setShouldObeyGroupEnables(false),
                'lightingLightBlock': new ComboboxComponent<string>()
                    .setMaxVisibleItems(10)
                    .addItems([
                        {
                            displayText: 'Auto (minecraft:glowstone)',
                            payload: 'auto',
                        },
                        {
                            displayText: 'minecraft:torch',
                            payload: 'minecraft:torch',
                        },
                        ...PALETTE_ALL_RELEASE.map((blockName) => ({
                            displayText: blockName,
                            payload: blockName,
                        })),
                    ])
                    .setDefaultValue('auto')
                    .setLabel('assign.components.lighting_light_block')
                    .setShouldObeyGroupEnables(false),
                'placeholder': new PlaceholderComponent()
                    .setPlaceholderText('misc.advanced_settings'),
            },
            componentOrder: [
                'blockSelectionAlgorithm',
                'blockPalette',
                'dichromePalette',
                'dichromeToneBias',
                'colourStyle',
                'colourStyleStrength',
                'materialFilter',
                'dithering',
                'blockFilter',
                'blockFilterThreshold',
                'placeholder',
                'textureAtlas',
                'ditheringMagnitude',
                'fallable',
                'colourAccuracy',
                'contextualAveraging',
                'errorWeight',
                'brightnessOffset',
                'saturationOffset',
                'contrastOffset',
                'temperatureOffset',
                'maxBlockTypes',
                'calculateLighting',
                'lightThreshold',
                'lightingPlacement',
                'lightingScope',
                'lightingLightBlock',
            ],
            execButton: new ButtonComponent()
                .setOnClick(() => {
                    this._appContext?.do(EAction.Assign);
                })
                .setLabel(LOC('assign.button')),
        },
        'preview': {
            id: 'preview',
            label: LOC('preview.heading'),
            components: {
                'blockList': new PreviewComponent(),
            },
            componentOrder: ['blockList'],
        },
        'export': {
            id: 'export',
            label: LOC('export.heading'),
            components: {
                'structureName': new TextInputComponent('', '', 64)
                    .setLabel('export.components.structure_name')
                    .setPlaceholder(LOC('export.components.structure_name_placeholder'))
                    .addValueChangedListener((val) => {
                        (this._ui.preview.components.blockList as PreviewComponent).setStructureName(val);
                    }),
                'export': new ComboboxComponent<TExporters>()
                    .addItems([
                        {
                            displayLocKey: 'export.components.litematic',
                            payload: 'litematic',
                        },
                        {
                            displayLocKey: 'export.components.schematic',
                            payload: 'schematic',
                        },
                        /*
                        {
                            displayText: 'Wavefront OBJ (.obj)',
                            payload: 'obj',
                        },
                        */
                        {
                            displayLocKey: 'export.components.sponge_schematic',
                            payload: 'schem',
                        },
                        {
                            displayLocKey: 'export.components.structure_blocks',
                            payload: 'nbt',
                        },
                        {
                            displayLocKey: 'export.components.indexed_json',
                            payload: 'indexed_json',
                        },
                        {
                            displayLocKey: 'export.components.uncompressed_json',
                            payload: 'uncompressed_json',
                        },
                    ])
                    .setLabel('export.components.exporter'),
            },
            componentOrder: ['structureName', 'export'],
            execButton: new ButtonComponent()
                .setLabel(LOC('export.button'))
                .setOnClick(() => {
                    this._appContext?.do(EAction.Export);
                }),
        },
    };

    private _toolbarLeft = {
        groups: {
            'viewmode': {
                components: {
                    'mesh': new ToolbarItemComponent({ id: 'mesh', iconSVG: AppIcons.MESH })
                        .onClick(() => {
                            this.clearPreviewSelection();
                            Renderer.Get.setModelToUse(MeshType.TriangleMesh);
                        })
                        .isActive(() => {
                            return Renderer.Get.getActiveMeshType() === MeshType.TriangleMesh;
                        })
                        .isEnabled(() => {
                            return Boolean(this._appContext?.hasImportedMesh()) &&
                                Renderer.Get.getModelsAvailable() >= MeshType.TriangleMesh;
                        })
                        .setTooltip('toolbar.view_mesh', 'right'),
                    'voxelMesh': new ToolbarItemComponent({ id: 'voxelMesh', iconSVG: AppIcons.VOXEL })
                        .onClick(() => {
                            this.clearPreviewSelection();
                            Renderer.Get.setModelToUse(MeshType.VoxelMesh);
                        })
                        .isActive(() => {
                            return Renderer.Get.getActiveMeshType() === MeshType.VoxelMesh;
                        })
                        .isEnabled(() => {
                            return Renderer.Get.getModelsAvailable() >= MeshType.VoxelMesh;
                        })
                        .setTooltip('toolbar.view_voxel_mesh', 'right'),
                    'blockMesh': new ToolbarItemComponent({ id: 'blockMesh', iconSVG: AppIcons.BLOCK })
                        .onClick(() => {
                            Renderer.Get.setModelToUse(MeshType.BlockMesh);
                        })
                        .isActive(() => {
                            return Renderer.Get.getActiveMeshType() === MeshType.BlockMesh;
                        })
                        .isEnabled(() => {
                            return Renderer.Get.getModelsAvailable() >= MeshType.BlockMesh;
                        })
                        .setTooltip('toolbar.view_block_mesh', 'right'),
                    'colorChart': new ToolbarItemComponent({ id: 'colorChart', iconSVG: AppIcons.COLOUR_SWATCH })
                        .onClick(() => {
                            Renderer.Get.toggleColorChart();
                        })
                        .isActive(() => {
                            return Renderer.Get.isColorChartEnabled();
                        })
                        .isEnabled(() => {
                            return Renderer.Get.getModelsAvailable() >= MeshType.BlockMesh;
                        })
                        .setTooltip('toolbar.color_chart', 'right'),
                },
                componentOrder: ['mesh', 'voxelMesh', 'blockMesh', 'colorChart'],
            },
            'debug': {
                components: {
                    'grid': new ToolbarItemComponent({ id: 'grid', iconSVG: AppIcons.GRID })
                        .onClick(() => {
                            Renderer.Get.toggleIsGridEnabled();
                        })
                        .isActive(() => {
                            return Renderer.Get.isGridEnabled();
                        })
                        .isEnabled(() => {
                            return Renderer.Get.getActiveMeshType() !== MeshType.None;
                        })
                        .setTooltip('toolbar.toggle_grid', 'bottom'),
                    'axes': new ToolbarItemComponent({ id: 'axes', iconSVG: AppIcons.AXES })
                        .onClick(() => {
                            Renderer.Get.toggleIsAxesEnabled();
                        })
                        .isActive(() => {
                            return Renderer.Get.isAxesEnabled();
                        })
                        .setTooltip('toolbar.toggle_axes', 'bottom'),
                    'night-vision': new ToolbarItemComponent({ id: 'night', iconSVG: AppIcons.BULB })
                        .onClick(() => {
                            Renderer.Get.toggleIsNightVisionEnabled();
                        })
                        .isActive(() => {
                            return Renderer.Get.isNightVisionEnabled();
                        })
                        .isEnabled(() => {
                            return Renderer.Get.canToggleNightVision();
                        })
                        .setTooltip('toolbar.toggle_night_vision', 'bottom'),
                },
                componentOrder: ['grid', 'axes', 'night-vision'],
            },
            'sliceHeight': {
                components: {
                    'slice': new ToolbarItemComponent({ id: 'slice', iconSVG: AppIcons.SLICE })
                        .onClick(() => {
                            Renderer.Get.toggleSliceViewerEnabled();
                            this._syncSliceReadout(true);
                        })
                        .isEnabled(() => {
                            return Renderer.Get.getActiveMeshType() === MeshType.BlockMesh;
                        })
                        .isActive(() => {
                            return Renderer.Get.isSliceViewerEnabled();
                        })
                        .setTooltip('toolbar.toggle_slice_viewer', 'bottom'),
                    'plus': new ToolbarItemComponent({ id: 'plus', iconSVG: AppIcons.PLUS })
                        .onClick(() => {
                            Renderer.Get.incrementSliceHeight();
                            this._syncSliceReadout(true);
                        })
                        .isEnabled(() => {
                            return Renderer.Get.isSliceViewerEnabled() &&
                                Renderer.Get.canIncrementSliceHeight();
                        })
                        .setTooltip('toolbar.increment_slice', 'bottom'),
                    'minus': new ToolbarItemComponent({ id: 'minus', iconSVG: AppIcons.MINUS })
                        .onClick(() => {
                            Renderer.Get.decrementSliceHeight();
                            this._syncSliceReadout(true);
                        })
                        .isEnabled(() => {
                            return Renderer.Get.isSliceViewerEnabled() &&
                                Renderer.Get.canDecrementSliceHeight();
                        })
                        .setTooltip('toolbar.decrement_slice', 'bottom'),
                },
                componentOrder: ['slice', 'plus', 'minus'],
            },
        },
        groupsOrder: ['viewmode', 'debug', 'sliceHeight'],
    };

    private _toolbarRight = {
        groups: {
            'zoom': {
                components: {
                    'zoomOut': new ToolbarItemComponent({ id: 'zout', iconSVG: AppIcons.MINUS })
                        .onClick(() => {
                            ArcballCamera.Get.onZoomOut();
                        })
                        .setTooltip('toolbar.zoom_out', 'bottom'),
                    'zoomIn': new ToolbarItemComponent({ id: 'zin', iconSVG: AppIcons.PLUS })
                        .onClick(() => {
                            ArcballCamera.Get.onZoomIn();
                        })
                        .setTooltip('toolbar.zoom_in', 'bottom'),
                    'reset': new ToolbarItemComponent({ id: 'reset', iconSVG: AppIcons.CENTRE })
                        .onClick(() => {
                            ArcballCamera.Get.reset();
                        })
                        .setTooltip('toolbar.reset_camera', 'bottom'),
                    'cameraSettings': new ToolbarItemComponent({ id: 'camera-settings-btn', iconSVG: AppIcons.CAMERA_SETTINGS })
                        .onClick(() => {
                            this._toggleCameraSettings();
                        })
                        .isActive(() => {
                            return this._isCameraSettingsOpen;
                        })
                        .setTooltip('toolbar.camera_settings', 'left'),
                },
                componentOrder: ['zoomOut', 'zoomIn', 'reset', 'cameraSettings'],
            },
            'camera': {
                components: {
                    'perspective': new ToolbarItemComponent({ id: 'pers', iconSVG: AppIcons.PERSPECTIVE })
                        .onClick(() => {
                            ArcballCamera.Get.setCameraMode('perspective');
                        })
                        .isActive(() => {
                            return ArcballCamera.Get.isPerspective();
                        })
                        .setTooltip('toolbar.perspective_camera', 'bottom'),
                    'orthographic': new ToolbarItemComponent({ id: 'orth', iconSVG: AppIcons.ORTHOGRAPHIC })
                        .onClick(() => {
                            ArcballCamera.Get.setCameraMode('orthographic');
                        })
                        .isActive(() => {
                            return ArcballCamera.Get.isOrthographic();
                        })
                        .setTooltip('toolbar.orthographic_camera', 'bottom'),
                },
                componentOrder: ['perspective', 'orthographic'],
            },
            'preview': {
                components: {
                    'previewPanel': new ToolbarItemComponent({ id: 'preview-panel-btn', iconSVG: AppIcons.IMAGE })
                        .onClick(() => {
                            this._togglePreviewPanel();
                        })
                        .isActive(() => {
                            return this._isPreviewPanelOpen;
                        })
                        .isEnabled(() => {
                            return this._isPreviewAvailable;
                        })
                        .setTooltip('toolbar.toggle_preview_panel', 'bottom'),
                    'blockInteraction': new ToolbarItemComponent({ id: 'block-interaction-btn', iconSVG: AppIcons.INTERACTION })
                        .onClick(() => {
                            InteractionManager.Get.toggleEnabled();
                        })
                        .isActive(() => {
                            return InteractionManager.Get.isEnabled();
                        })
                        .isEnabled(() => {
                            return Renderer.Get.getActiveMeshType() !== MeshType.None;
                        })
                        .setTooltip('toolbar.toggle_block_interaction', 'left'),
                },
                componentOrder: ['previewPanel', 'blockInteraction'],
            },
        },
        groupsOrder: ['camera', 'preview', 'zoom'],
    };

    private _uiDull: { [key: string]: Group } = this._ui;
    private _toolbarLeftDull: { [key: string]: ToolbarGroup } = this._toolbarLeft.groups;
    private _toolbarRightDull: { [key: string]: ToolbarGroup } = this._toolbarRight.groups;

    private _isCameraSettingsOpen = false;
    private _cameraSettingsPos: { x: number, y: number } | null = null;
    private _previewPanelPos: { x: number, y: number } | null = null;
    private _isPreviewAvailable = false;
    private _isPreviewPanelOpen = false;
    private _unscaledScrollTop = 0;
    private _isScalingSidebar = false;
    private _autoAssignEnabled = false;
    private _autoAssignRunning = false;
    private _autoVoxelPostEnabled = false;
    private _autoVoxelPostRunning = false;
    private _suppressAutoVoxelPost = false;
    private _isUpdatingBlockSelectionControls = false;
    private _autoAssignScheduler!: IAutoAssignScheduler;
    private _autoVoxelPostScheduler!: IAutoAssignScheduler;
    private _activeSidebarSections = new Set<TSidebarSectionId>();

    private _toggleCameraSettings() {
        const opening = !this._isCameraSettingsOpen;
        if (opening) {
            this._setPreviewPanelOpen(false);
        }
        this._isCameraSettingsOpen = opening;
        const panel = document.getElementById('camera-settings-popover');
        if (panel) {
            panel.classList.toggle('hide', !this._isCameraSettingsOpen);
            if (this._isCameraSettingsOpen) {
                if (this._cameraSettingsPos) {
                    panel.style.left = `${this._cameraSettingsPos.x}px`;
                    panel.style.top = `${this._cameraSettingsPos.y}px`;
                    panel.style.right = 'auto';
                } else {
                    this._positionCameraSettingsDefault(panel);
                }
            }
        }
        const toolbarItem = this._toolbarRight.groups.zoom.components.cameraSettings;
        if (toolbarItem) {
            toolbarItem.setActive(this._isCameraSettingsOpen);
        }
    }

    private _togglePreviewPanel() {
        if (!this._isPreviewAvailable) {
            return;
        }

        const shouldOpen = !this._isPreviewPanelOpen;
        if (shouldOpen) {
            if (this._isCameraSettingsOpen) {
                this._toggleCameraSettings();
            }
        }
        this._setPreviewPanelOpen(shouldOpen);
    }

    private _setPreviewPanelOpen(isOpen: boolean) {
        this._isPreviewPanelOpen = isOpen && this._isPreviewAvailable;

        const panel = document.getElementById('preview-panel-popover');
        if (panel) {
            panel.classList.toggle('hide', !this._isPreviewPanelOpen);
            if (this._isPreviewPanelOpen) {
                if (this._previewPanelPos) {
                    panel.style.left = `${this._previewPanelPos.x}px`;
                    panel.style.top = `${this._previewPanelPos.y}px`;
                    panel.style.right = 'auto';
                } else {
                    this._positionPreviewPanelDefault(panel);
                }
            }
        }

        const toolbarItem = this._toolbarRight.groups.preview.components.previewPanel;
        toolbarItem?.setActive(this._isPreviewPanelOpen);
    }

    private _positionCameraSettingsDefault(panel: HTMLElement) {
        if (typeof window === 'undefined') return;
        const cameraBtn = this._toolbarRight.groups.zoom.components.cameraSettings.getElement();
        const panelWidth = panel.offsetWidth || 250;
        const panelHeight = panel.offsetHeight || 180;

        let left = window.innerWidth - panelWidth - 20;
        let top = 68;

        if (cameraBtn) {
            const btnRect = cameraBtn.getBoundingClientRect();
            top = Math.round(btnRect.bottom + 8);
            left = Math.round(btnRect.right - panelWidth);
        }

        const clampedX = Math.max(10, Math.min(window.innerWidth - panelWidth - 10, left));
        const clampedY = Math.max(10, Math.min(window.innerHeight - panelHeight - 10, top));

        panel.style.left = `${clampedX}px`;
        panel.style.top = `${clampedY}px`;
        panel.style.right = 'auto';
        panel.style.bottom = 'auto';
    }

    private _positionPreviewPanelDefault(panel: HTMLElement) {
        if (typeof window === 'undefined') return;
        const previewBtn = this._toolbarRight.groups.preview.components.previewPanel.getElement();
        const interactionBtn = this._toolbarRight.groups.preview.components.blockInteraction.getElement();
        const zoomBtn = this._toolbarRight.groups.zoom.components.zoomOut.getElement();
        const cameraSettingsBtn = this._toolbarRight.groups.zoom.components.cameraSettings.getElement();
        const panelWidth = panel.offsetWidth || 420;
        const panelHeight = panel.offsetHeight || 240;

        let left = window.innerWidth - panelWidth - 20;
        let top = 68;

        const refBtn = previewBtn || interactionBtn;
        if (refBtn) {
            const refRect = refBtn.getBoundingClientRect();
            // Located slightly to the left of the preview and toggle interaction buttons
            left = Math.round(refRect.left - panelWidth - 12);

            // Under the camera settings / zoom buttons with a small gap
            const topRefBtn = zoomBtn || cameraSettingsBtn;
            if (topRefBtn) {
                const topRect = topRefBtn.getBoundingClientRect();
                top = Math.round(topRect.bottom + 8);
            } else {
                top = Math.round(refRect.top);
            }
        }

        const clampedX = Math.max(10, Math.min(window.innerWidth - panelWidth - 10, left));
        const clampedY = Math.max(10, Math.min(window.innerHeight - panelHeight - 10, top));

        panel.style.left = `${clampedX}px`;
        panel.style.top = `${clampedY}px`;
        panel.style.right = 'auto';
        panel.style.bottom = 'auto';
    }

    private _repositionPopoversOnResize() {
        if (typeof document === 'undefined') return;
        if (this._isCameraSettingsOpen) {
            const panel = document.getElementById('camera-settings-popover');
            if (panel) {
                if (this._cameraSettingsPos) {
                    const panelWidth = panel.offsetWidth || 250;
                    const panelHeight = panel.offsetHeight || 180;
                    const clampedX = Math.max(10, Math.min(window.innerWidth - panelWidth - 10, this._cameraSettingsPos.x));
                    const clampedY = Math.max(10, Math.min(window.innerHeight - panelHeight - 10, this._cameraSettingsPos.y));
                    panel.style.left = `${clampedX}px`;
                    panel.style.top = `${clampedY}px`;
                } else {
                    this._positionCameraSettingsDefault(panel);
                }
            }
        }
        if (this._isPreviewPanelOpen) {
            const panel = document.getElementById('preview-panel-popover');
            if (panel) {
                if (this._previewPanelPos) {
                    const panelWidth = panel.offsetWidth || 420;
                    const panelHeight = panel.offsetHeight || 240;
                    const clampedX = Math.max(10, Math.min(window.innerWidth - panelWidth - 10, this._previewPanelPos.x));
                    const clampedY = Math.max(10, Math.min(window.innerHeight - panelHeight - 10, this._previewPanelPos.y));
                    panel.style.left = `${clampedX}px`;
                    panel.style.top = `${clampedY}px`;
                } else {
                    this._positionPreviewPanelDefault(panel);
                }
            }
        }
    }

    public setPreviewAvailable(isAvailable: boolean) {
        this._isPreviewAvailable = isAvailable;
        if (!isAvailable) {
            this._setPreviewPanelOpen(false);
        }

        const toolbarItem = this._toolbarRight.groups.preview.components.previewPanel;
        toolbarItem?.setEnabled(isAvailable);
    }

    private _appContext?: AppContext;

    public bindToContext(context: AppContext) {
        this._appContext = context;
    }

    public tick(isBusy: boolean) {
        if (isBusy) {
            document.body.style.cursor = 'progress';
        } else {
            document.body.style.cursor = 'default';
        }

        const canvasColumn = UIUtil.getElementById('col-canvas');
        if (ArcballCamera.Get.isUserRotating || ArcballCamera.Get.isUserTranslating) {
            canvasColumn.style.cursor = 'grabbing';
        } else {
            canvasColumn.style.cursor = 'grab';
        }

        for (const groupName in this._toolbarLeftDull) {
            const toolbarGroup = this._toolbarLeftDull[groupName];
            for (const toolbarItem of toolbarGroup.componentOrder) {
                toolbarGroup.components[toolbarItem].tick();
            }
        }

        for (const groupName in this._toolbarRightDull) {
            const toolbarGroup = this._toolbarRightDull[groupName];
            for (const toolbarItem of toolbarGroup.componentOrder) {
                toolbarGroup.components[toolbarItem].tick();
            }
        }

        this._syncSliceReadout();
    }

    private _lastSliceKey = '';
    private _syncSliceReadout(force = false) {
        if (typeof document === 'undefined') {
            return;
        }
        const el = document.getElementById('toolbar-slice-readout');
        const active = Renderer.Get.isSliceViewerEnabled();
        const stats = active ? Renderer.Get.getSliceLayerStats() : null;
        const nextKey = active && stats && stats.totalLayers > 0 ?
            `${stats.layerNumber}/${stats.totalLayers}@${stats.sliceY}` :
            'off';

        if (!force && nextKey === this._lastSliceKey) {
            return;
        }
        this._lastSliceKey = nextKey;

        if (el) {
            if (active && stats && stats.totalLayers > 0) {
                el.textContent = `${stats.layerNumber}/${stats.totalLayers}`;
                el.classList.remove('hide');
            } else {
                el.textContent = '';
                el.classList.add('hide');
            }
        }

        (this._ui.preview.components.blockList as PreviewComponent).updateSliceStatus();
    }

    public build() {
        // Build properties
        {
            const sidebarHTML = new HTMLBuilder();

            sidebarHTML.add(`<div class="container-properties">`);
            {
                sidebarHTML.add(HeaderComponent.Get.generateHTML());
                sidebarHTML.add(this._getSidebarFilterPanelHTML());

                for (const groupName of this.uiOrder) {
                    if (groupName === 'preview') {
                        continue;
                    }
                    const group = this._uiDull[groupName];
                    sidebarHTML.add(`<div class="sidebar-section-block" id="sidebar_section_${group.id}" data-section="${group.id}">`);
                    sidebarHTML.add(this._getGroupHTML(group));
                    sidebarHTML.add(`</div>`);
                }
            }
            sidebarHTML.add(`</div>`);

            sidebarHTML.placeInto('properties');
        }

        // Build toolbar
        {
            const toolbarHTML = new HTMLBuilder();

            // Left
            toolbarHTML.add('<div class="toolbar-column">');
            for (const toolbarGroupName of this._toolbarLeft.groupsOrder) {
                const toolbarGroup = this._toolbarLeftDull[toolbarGroupName];
                if (toolbarGroupName === 'viewmode') {
                    toolbarHTML.add('<div class="toolbar-viewmode-stack">');
                    toolbarHTML.add('<div class="toolbar-group">');
                    for (const groupElementName of ['mesh', 'voxelMesh', 'blockMesh']) {
                        toolbarHTML.add(toolbarGroup.components[groupElementName].generateHTML());
                    }
                    toolbarHTML.add('</div><div class="toolbar-group toolbar-color-chart-group">');
                    toolbarHTML.add(toolbarGroup.components.colorChart.generateHTML());
                    toolbarHTML.add('</div></div>');
                } else {
                    toolbarHTML.add('<div class="toolbar-group">');
                    for (const groupElementName of toolbarGroup.componentOrder) {
                        const groupElement = toolbarGroup.components[groupElementName];
                        toolbarHTML.add(groupElement.generateHTML());
                    }
                    if (toolbarGroupName === 'sliceHeight') {
                        toolbarHTML.add(`<div class="toolbar-slice-readout hide" id="toolbar-slice-readout" title="${LOC('toolbar.slice_layer_tooltip')}"></div>`);
                    }
                    toolbarHTML.add('</div>');
                }
            }
            toolbarHTML.add('</div>');

            // Right
            toolbarHTML.add('<div class="toolbar-column">');
            for (const toolbarGroupName of this._toolbarRight.groupsOrder) {
                if (toolbarGroupName === 'preview') {
                    continue;
                }

                if (toolbarGroupName === 'camera') {
                    const cameraGroup = this._toolbarRightDull.camera;
                    const previewGroup = this._toolbarRightDull.preview;
                    toolbarHTML.add('<div class="toolbar-preview-stack">');
                    toolbarHTML.add('<div class="toolbar-group">');
                    for (const groupElementName of cameraGroup.componentOrder) {
                        toolbarHTML.add(cameraGroup.components[groupElementName].generateHTML());
                    }
                    toolbarHTML.add('</div><div class="toolbar-group toolbar-preview-button-group">');
                    toolbarHTML.add(previewGroup.components.previewPanel.generateHTML());
                    toolbarHTML.add('</div><div class="toolbar-group toolbar-interaction-button-group">');
                    toolbarHTML.add(previewGroup.components.blockInteraction.generateHTML());
                    toolbarHTML.add('</div></div>');
                } else {
                    toolbarHTML.add('<div class="toolbar-group">');
                    const toolbarGroup = this._toolbarRightDull[toolbarGroupName];
                    for (const groupElementName of toolbarGroup.componentOrder) {
                        const groupElement = toolbarGroup.components[groupElementName];
                        toolbarHTML.add(groupElement.generateHTML());
                    }
                    toolbarHTML.add('</div>');
                }
            }
            toolbarHTML.add('</div>');

            toolbarHTML.placeInto('toolbar');

            if (typeof document !== 'undefined') {
                document.getElementById('camera-settings-popover')?.remove();
                document.getElementById('preview-panel-popover')?.remove();
                document.body.insertAdjacentHTML('beforeend', this._getCameraSettingsHTML());
                document.body.insertAdjacentHTML('beforeend', this._getPreviewPanelHTML());
                this.setPreviewAvailable(this._isPreviewAvailable);
            }
        }

        // Build console
        AppConsole.Get.build();

        const savedSplitSizes = (() => {
            try {
                if (typeof localStorage !== 'undefined') {
                    const saved = localStorage.getItem('sidebar_split_sizes');
                    if (saved) {
                        const parsed = JSON.parse(saved);
                        if (Array.isArray(parsed) && parsed.length === 2 && typeof parsed[0] === 'number') {
                            return parsed;
                        }
                    }
                }
            } catch (_) {}
            return [22, 78];
        })();

        Split(['.column-sidebar', '.column-canvas'], {
            sizes: savedSplitSizes,
            minSize: [0, 0],
            gutterSize: 5,
            snapOffset: 0,
            onDrag: () => {
                this._updateSidebarScale();
            },
            onDragEnd: (sizes: number[]) => {
                this._updateSidebarScale();
                try {
                    if (typeof localStorage !== 'undefined') {
                        localStorage.setItem('sidebar_split_sizes', JSON.stringify(sizes));
                    }
                } catch (_) {}
            },
        });

        Split(['.column-properties', '.column-console'], {
            sizes: [85, 15],
            minSize: [0, 0],
            direction: 'vertical',
            gutterSize: 5,
        });

        this._setupSidebarScaleObserver();
    }

    private _setupSidebarScaleObserver() {
        if (typeof document === 'undefined') return;

        const propertiesCol = document.querySelector('.column-properties') as HTMLElement | null;
        const container = document.querySelector('.container-properties') as HTMLElement | null;

        if (propertiesCol) {
            propertiesCol.addEventListener('scroll', () => {
                if (!this._isScalingSidebar && container) {
                    const currentZoom = parseFloat(container.style.zoom) || 1;
                    this._unscaledScrollTop = propertiesCol.scrollTop / currentZoom;
                }
            }, { passive: true });
        }

        this._updateSidebarScale();

        const sidebar = document.querySelector('.column-sidebar') as HTMLElement | null;
        if (sidebar && typeof ResizeObserver !== 'undefined') {
            const ro = new ResizeObserver(() => {
                this._updateSidebarScale();
            });
            ro.observe(sidebar);
        }

        if (typeof window !== 'undefined') {
            window.addEventListener('resize', () => {
                this._updateSidebarScale();
                this._repositionPopoversOnResize();
            });
        }
    }

    private _updateSidebarScale() {
        if (typeof document === 'undefined') return;
        const propertiesCol = document.querySelector('.column-properties') as HTMLElement | null;
        const container = document.querySelector('.container-properties') as HTMLElement | null;
        if (!propertiesCol || !container) return;

        const sidebar = document.querySelector('.column-sidebar') as HTMLElement | null;
        // Sidebar column width with subpixel precision, completely immune to scrollbar toggles in children
        const availWidth = sidebar ? sidebar.getBoundingClientRect().width : propertiesCol.offsetWidth;
        if (availWidth <= 0) return;

        // Base nominal width where controls reach standard 1.0 proportions
        const nominalWidth = 460;

        let targetZoom: string;
        let targetWidth: string;
        let scale: number;

        if (availWidth >= nominalWidth) {
            // When stretching wider, stretch across the entire width without empty gaps
            scale = 1;
            targetZoom = '1';
            targetWidth = '100%';
        } else {
            // Unrestricted downscaling: shrink smoothly without any lower limit or jumps
            scale = Math.max(0.001, availWidth / nominalWidth);
            targetZoom = scale.toString();
            targetWidth = `${nominalWidth}px`;
        }

        this._isScalingSidebar = true;

        if (container.style.zoom !== targetZoom) {
            container.style.zoom = targetZoom;
        }
        if (container.style.width !== targetWidth) {
            container.style.width = targetWidth;
        }
        if (container.style.maxWidth !== 'none') {
            container.style.maxWidth = 'none';
        }

        // Scale console synchronously with the properties panel
        const innerConsole = document.getElementById('inner-console') as HTMLElement | null;
        if (innerConsole) {
            if (innerConsole.style.zoom !== targetZoom) {
                innerConsole.style.zoom = targetZoom;
            }
            if (innerConsole.style.width !== targetWidth) {
                innerConsole.style.width = targetWidth;
            }
        }

        // Notify open comboboxes to update position and scale in real-time
        document.dispatchEvent(new CustomEvent('sidebar-resize'));

        // Restore scroll position smoothly proportional to content scale
        if (this._unscaledScrollTop > 0) {
            const maxScroll = propertiesCol.scrollHeight - propertiesCol.clientHeight;
            if (maxScroll > 0) {
                propertiesCol.scrollTop = Math.min(maxScroll, Math.round(this._unscaledScrollTop * scale));
            }
        }

        this._isScalingSidebar = false;
    }

    private _forEachComponent(action: EAction, functor: (component: ConfigComponent<unknown, unknown>) => void) {
        const group = this._getGroup(action);

        for (const elementName of group.componentOrder) {
            const element = group.components[elementName];
            functor(element);
        }
    }

    private _getGroupHeadingLabel(action: EAction): TLocalisedString {
        switch (action) {
            case EAction.Settings:
                return LOC('settings.heading');
            case EAction.Import:
                return LOC('import.heading');
            case EAction.Materials:
                return LOC('materials.heading');
            case EAction.Voxelise:
                return LOC('voxelise.heading');
            case EAction.VoxelPost:
                return LOC('voxel_post.heading');
            case EAction.Assign:
                return LOC('assign.heading');
            case EAction.Preview:
                return LOC('preview.heading');
            case EAction.Export:
                return LOC('export.heading');
        }
        ASSERT(false);
    }

    private _getGroupButtonLabel(action: EAction): TLocalisedString {
        switch (action) {
            case EAction.Import:
                return LOC('import.button');
            case EAction.Materials:
                return LOC('materials.button');
            case EAction.Voxelise:
                return LOC('voxelise.button');
            case EAction.VoxelPost:
                return LOC('voxel_post.button');
            case EAction.Assign:
                return LOC('assign.button');
            case EAction.Preview:
                return LOC('preview.button');
            case EAction.Export:
                return LOC('export.button');
        }
        ASSERT(false, `Cannot get label of '${action}'`);
    }

    private _handleLanguageChange() {
        HeaderComponent.Get.refresh();


        Object.values(this._toolbarLeft.groups).forEach((group) => {
            Object.values(group.components).forEach((comp) => {
                comp.updateTranslation();
            });
        });

        Object.values(this._toolbarRight.groups).forEach((group) => {
            Object.values(group.components).forEach((comp) => {
                comp.updateTranslation();
            });
        });


        for (let i = 0; i < EAction.MAX; ++i) {
            const group = this._getGroup(i);
            const header = document.getElementById(`component_header_${group.id}`);

            group.label = this._getGroupHeadingLabel(i);
            if (header) {
                header.innerHTML = MiscComponents.createGroupHeader(group.label);
            }

            if (group.execButton !== undefined) {
                const newButtonLabel = this._getGroupButtonLabel(i);
                group.execButton.setLabel(newButtonLabel).updateLabel();
            }

            if (i === EAction.Assign) {
                const autoBtn = document.getElementById('assign-auto-update-btn');
                if (autoBtn) {
                    autoBtn.textContent = LOC('assign.auto_update_button');
                    autoBtn.setAttribute('title', LOC('assign.auto_update_tooltip'));
                    autoBtn.setAttribute('aria-label', LOC('assign.auto_update_button'));
                }
            }

            if (i === EAction.Export) {
                this._ui.export.components.structureName.setPlaceholder(LOC('export.components.structure_name_placeholder'));
            }

            this._forEachComponent(i, (component) => {
                component.refresh();
            });
        }

        const filterTitle = document.querySelector('#sidebar-section-filter-panel .sidebar-filter-title');
        if (filterTitle) {
            filterTitle.textContent = LOC('sidebar_filter.title');
        }
        const filterHint = document.querySelector('#sidebar-section-filter-panel .sidebar-filter-hint');
        if (filterHint) {
            filterHint.textContent = LOC('sidebar_filter.hint');
        }
        SIDEBAR_FILTER_SECTIONS.forEach((sec) => {
            const btn = document.querySelector(`.sidebar-filter-toggle[data-section="${sec}"]`);
            if (btn) {
                btn.textContent = this._getSidebarFilterToggleLabel(sec);
            }
        });

        const saveVoxelBtn = document.getElementById('voxelise-save-btn');
        if (saveVoxelBtn) {
            saveVoxelBtn.textContent = LOC('voxelise.save_button');
            saveVoxelBtn.setAttribute('title', LOC('voxelise.save_tooltip'));
        }
        const loadVoxelBtn = document.getElementById('voxelise-load-btn');
        if (loadVoxelBtn) {
            loadVoxelBtn.textContent = LOC('voxelise.load_button');
            loadVoxelBtn.setAttribute('title', LOC('voxelise.load_tooltip'));
        }
        const voxelPostAutoBtn = document.getElementById('voxel-post-auto-btn');
        if (voxelPostAutoBtn) {
            voxelPostAutoBtn.textContent = LOC('voxel_post.auto_button');
            voxelPostAutoBtn.setAttribute('title', LOC('voxel_post.auto_tooltip'));
            voxelPostAutoBtn.setAttribute('aria-label', LOC('voxel_post.auto_button'));
        }
        const voxelPostResetBtn = document.getElementById('voxel-post-reset-btn');
        if (voxelPostResetBtn) {
            voxelPostResetBtn.textContent = LOC('voxel_post.reset_button');
            voxelPostResetBtn.setAttribute('title', LOC('voxel_post.reset_tooltip'));
        }

        const previewTitle = document.querySelector('#preview-panel-header .camera-settings-title');
        if (previewTitle) {
            previewTitle.textContent = LOC('toolbar.toggle_preview_panel');
        }
        const cameraTitle = document.querySelector('#camera-settings-header .camera-settings-title');
        if (cameraTitle) {
            cameraTitle.textContent = LOC('toolbar.camera_settings');
        }
        const sliceReadout = document.getElementById('toolbar-slice-readout');
        if (sliceReadout) {
            sliceReadout.title = LOC('toolbar.slice_layer_tooltip');
        }
        this._syncSliceReadout(true);

        AppConsole.success(LOC('settings.changed_language'));
    }

    /**
     * Rebuilds the HTML for all components in an action group.
     */
    public refreshComponents(action: EAction) {
        const group = this._getGroup(action);

        const element = document.getElementById(`subcomponents_${group.id}`);
        ASSERT(element !== null);

        element.innerHTML = this._getComponentsHTML(group);

        this._forEachComponent(action, (component) => {
            component.registerEvents();
            component.finalise();
        });
    }

    private _getComponentsHTML(group: Group) {
        let groupHTML = '';
        for (const elementName of group.componentOrder) {
            const element = group.components[elementName];
            ASSERT(element !== undefined, `No element for: ${elementName}`);
            groupHTML += element.generateHTML();
        }
        return groupHTML;
    }

    private _getSidebarFilterToggleLabel(section: TSidebarSectionId): TLocalisedString {
        switch (section) {
            case 'settings':
                return LOC('sidebar_filter.settings');
            case 'import':
                return LOC('sidebar_filter.import');
            case 'materials':
                return LOC('sidebar_filter.materials');
            case 'voxelise':
                return LOC('sidebar_filter.voxelise');
            case 'voxelPost':
                return LOC('sidebar_filter.voxelPost');
            case 'assign':
                return LOC('sidebar_filter.assign');
            case 'export':
                return LOC('sidebar_filter.export');
        }
    }

    private _getSidebarFilterPanelHTML(): string {
        const togglesHTML = SIDEBAR_FILTER_SECTIONS.map((sec) => `
            <button
                type="button"
                class="sidebar-filter-toggle"
                data-section="${sec}"
                aria-pressed="false"
            >${this._getSidebarFilterToggleLabel(sec)}</button>
        `).join('');

        return `
            <div class="sidebar-section-filter-panel" id="sidebar-section-filter-panel">
                <div class="sidebar-filter-header">
                    <span class="sidebar-filter-title">${LOC('sidebar_filter.title')}</span>
                    <span class="sidebar-filter-hint">${LOC('sidebar_filter.hint')}</span>
                </div>
                <div class="sidebar-filter-grid">
                    ${togglesHTML}
                </div>
            </div>
        `;
    }

    private _syncSidebarSectionFilterUI(): void {
        if (typeof document === 'undefined') {
            return;
        }
        const visibleMap = computeVisibleSidebarSections(this._activeSidebarSections);

        SIDEBAR_FILTER_SECTIONS.forEach((sec) => {
            const btn = document.querySelector(`.sidebar-filter-toggle[data-section="${sec}"]`) as HTMLButtonElement | null;
            const isSelected = this._activeSidebarSections.has(sec);
            if (btn) {
                btn.classList.toggle('active', isSelected);
                btn.setAttribute('aria-pressed', String(isSelected));
            }
            const sectionEl = document.getElementById(`sidebar_section_${sec}`);
            if (sectionEl) {
                sectionEl.classList.toggle('is-section-hidden', !visibleMap[sec]);
            }
        });

        document.dispatchEvent(new CustomEvent('sidebar-resize'));
    }

    public syncVoxelIOButtons(): void {
        if (typeof document === 'undefined') {
            return;
        }
        const busy = this._appContext?.isActionBusy() ?? false;
        const workerReady = this._appContext?.isWorkerReady() ?? false;
        const hasVoxels = this._appContext?.hasVoxelMesh() ?? false;

        const saveBtn = document.getElementById('voxelise-save-btn') as HTMLButtonElement | null;
        if (saveBtn) {
            saveBtn.disabled = busy || !hasVoxels;
        }
        const loadBtn = document.getElementById('voxelise-load-btn') as HTMLButtonElement | null;
        if (loadBtn) {
            loadBtn.disabled = busy || !workerReady;
        }
    }

    private _getGroupHTML(group: Group) {
        let execHTML = group.execButton?.generateHTML() ?? '';
        if (group.id === 'assign') {
            execHTML = `<div class="assign-action-row">
                ${group.execButton?.generateHTML() ?? ''}
                <button
                    type="button"
                    id="assign-auto-update-btn"
                    class="assign-auto-update-btn is-hidden"
                    title="${LOC('assign.auto_update_tooltip')}"
                    aria-label="${LOC('assign.auto_update_button')}"
                    aria-pressed="false"
                >${LOC('assign.auto_update_button')}</button>
            </div>`;
        } else if (group.id === 'voxelise') {
            execHTML = `${group.execButton?.generateHTML() ?? ''}
            <div class="voxel-io-action-row">
                <button
                    type="button"
                    id="voxelise-save-btn"
                    class="voxel-io-btn"
                    title="${LOC('voxelise.save_tooltip')}"
                    disabled
                >${LOC('voxelise.save_button')}</button>
                <button
                    type="button"
                    id="voxelise-load-btn"
                    class="voxel-io-btn"
                    title="${LOC('voxelise.load_tooltip')}"
                    disabled
                >${LOC('voxelise.load_button')}</button>
                <input
                    type="file"
                    id="voxelise-load-file-input"
                    accept=".json,.voxels.json"
                    class="hide"
                />
            </div>`;
        } else if (group.id === 'voxelPost') {
            execHTML = `<div class="voxel-post-action-row">
                ${group.execButton?.generateHTML() ?? ''}
                <button
                    type="button"
                    id="voxel-post-auto-btn"
                    class="voxel-post-auto-btn"
                    title="${LOC('voxel_post.auto_tooltip')}"
                    aria-label="${LOC('voxel_post.auto_button')}"
                    aria-pressed="false"
                    disabled
                >${LOC('voxel_post.auto_button')}</button>
                <button
                    type="button"
                    id="voxel-post-reset-btn"
                    class="voxel-post-reset-btn"
                    title="${LOC('voxel_post.reset_tooltip')}"
                    disabled
                >${LOC('voxel_post.reset_button')}</button>
            </div>`;
        }
        return `
            <div id="component_header_${group.id}">
                ${MiscComponents.createGroupHeader(group.label)}
            </div>
            <div class="component-group" id="subcomponents_${group.id}">
                ${this._getComponentsHTML(group)}
            </div>
            ${execHTML}
        `;
    }

    public getActionButton(action: EAction) {
        const group = this._getGroup(action);
        return group.execButton;
    }

    public getExportGlbButton(): ButtonComponent | undefined {
        return undefined;
    }

    public setStructureName(name: string) {
        this._ui.export.components.structureName.setValue(name);
        (this._ui.preview.components.blockList as PreviewComponent).setStructureName(name);
    }

    public registerEvents() {
        HeaderComponent.Get.registerEvents();
        HeaderComponent.Get.finalise();

        for (let action = 0; action < EAction.MAX; ++action) {
            this._forEachComponent(action, (component) => {
                component.registerEvents();
                component.finalise();
            });

            const group = this._getGroup(action);
            group.execButton?.registerEvents();
            group.execButton?.finalise();
        }

        // Register toolbar left
        for (const toolbarGroupName of this._toolbarLeft.groupsOrder) {
            const toolbarGroup = this._toolbarLeftDull[toolbarGroupName];
            for (const groupElementName of toolbarGroup.componentOrder) {
                const element = toolbarGroup.components[groupElementName];
                element.registerEvents();
                element.finalise();
            }
        }
        // Register toolbar right
        for (const toolbarGroupName of this._toolbarRight.groupsOrder) {
            const toolbarGroup = this._toolbarRightDull[toolbarGroupName];
            for (const groupElementName of toolbarGroup.componentOrder) {
                const element = toolbarGroup.components[groupElementName];
                element.registerEvents();
                element.finalise();
            }
        }

        this._updateVoxeliseControls(this._ui.voxelise.components.hollow.getEnabled());

        const assignComponents = this._ui.assign.components;
        const radialTone = assignComponents.dichromeToneBias as RadialToneDistributionComponent;
        radialTone.syncFloatingBrightness(assignComponents.brightnessOffset.getValue());
        radialTone.syncFloatingContrast(assignComponents.contrastOffset.getValue());
        radialTone.setFloatingAssignDelegates({
            onBrightnessChange: (value: number) => {
                if (assignComponents.brightnessOffset.getEnabled() && assignComponents.brightnessOffset.getValue() !== value) {
                    assignComponents.brightnessOffset.setValue(value);
                }
            },
            onContrastChange: (value: number) => {
                if (assignComponents.contrastOffset.getEnabled() && assignComponents.contrastOffset.getValue() !== value) {
                    assignComponents.contrastOffset.setValue(value);
                }
            },
            onAssignClick: () => {
                if (this._ui.assign.execButton?.enabled) {
                    this._appContext?.do(EAction.Assign);
                }
            },
            onAutoAssignToggle: () => {
                this.toggleAutoAssign();
            },
        });

        if (typeof document !== 'undefined') {
            document.getElementById('assign-auto-update-btn')?.addEventListener('click', () => {
                this.toggleAutoAssign();
            });

            document.querySelectorAll('.sidebar-filter-toggle').forEach((btn) => {
                btn.addEventListener('click', () => {
                    const sectionId = (btn as HTMLElement).dataset.section as TSidebarSectionId | undefined;
                    if (!sectionId) {
                        return;
                    }
                    this._activeSidebarSections = toggleSidebarSection(this._activeSidebarSections, sectionId);
                    this._syncSidebarSectionFilterUI();
                });
            });

            document.getElementById('voxelise-save-btn')?.addEventListener('click', () => {
                this._appContext?.saveVoxelModel();
            });

            const voxelLoadInput = document.getElementById('voxelise-load-file-input') as HTMLInputElement | null;
            document.getElementById('voxelise-load-btn')?.addEventListener('click', () => {
                if (voxelLoadInput) {
                    voxelLoadInput.value = '';
                    voxelLoadInput.click();
                }
            });

            voxelLoadInput?.addEventListener('change', async () => {
                const file = voxelLoadInput.files?.[0];
                voxelLoadInput.value = '';
                if (!file) {
                    return;
                }
                const text = await file.text();
                await this._appContext?.loadVoxelModel(text, file.name);
            });

            document.getElementById('voxel-post-auto-btn')?.addEventListener('click', () => {
                this.toggleAutoVoxelPost();
            });

            document.getElementById('voxel-post-reset-btn')?.addEventListener('click', () => {
                this._appContext?.resetVoxelPost();
            });

            this._syncSidebarSectionFilterUI();
            this.syncVoxelIOButtons();
            this._syncVoxelPostActionButtons();
        }

        this._updateBlockSelectionControls(
            assignComponents.blockSelectionAlgorithm.getValue(),
            assignComponents.blockSelectionAlgorithm.getEnabled(),
        );

        this._registerCameraSettingsEvents();
        this._registerPreviewPanelEvents();

        if (typeof window !== 'undefined') {
            window.addEventListener('keydown', (e: KeyboardEvent) => {
                if (!Renderer.Get.isSliceViewerEnabled()) {
                    return;
                }
                const activeEl = document.activeElement as HTMLElement | null;
                if (activeEl) {
                    const tag = activeEl.tagName;
                    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || activeEl.isContentEditable) {
                        return;
                    }
                }
                if (e.key === '[' || e.code === 'BracketLeft') {
                    e.preventDefault();
                    Renderer.Get.decrementSliceHeight();
                    this._syncSliceReadout(true);
                } else if (e.key === ']' || e.code === 'BracketRight') {
                    e.preventDefault();
                    Renderer.Get.incrementSliceHeight();
                    this._syncSliceReadout(true);
                }
            });
        }
    }

    public get layout() {
        return this._ui;
    }

    public get layoutDull() {
        return this._uiDull;
    }

    /**
     * Enable a specific action.
     */
    public enable(action: EAction) {
        if (action < EAction.MAX) {
            this._forEachComponent(action, (component) => {
                component.setEnabled(true);
            });
            const canEnableExec = (action !== EAction.Import) || (this._ui.import.components.input.hasValue());
            const group = this._getGroup(action);
            group.execButton?.setEnabled(canEnableExec);
            if (action === EAction.VoxelPost) {
                this._syncVoxelPostActionButtons();
            }
            if (action === EAction.Assign) {
                const assignComponents = this._ui.assign.components;
                this._updateBlockSelectionControls(
                    assignComponents.blockSelectionAlgorithm.getValue(),
                    assignComponents.blockSelectionAlgorithm.getEnabled(),
                );
            }
        }
    }

    /**
     * Enable all actions up to and including a specific action.
     */
    public enableTo(action: EAction) {
        const hasMesh = this._appContext?.hasImportedMesh() ?? false;
        for (let i = 0; i <= action; ++i) {
            if (!hasMesh && (i === EAction.Materials || i === EAction.Voxelise)) {
                continue;
            }
            this.enable(i);
        }
        this.syncVoxelIOButtons();
        this._syncVoxelPostActionButtons();
    }

    /**
     * Disable a specific action and its dependent actions.
     */
    public disable(action: EAction) {
        if (action <= EAction.VoxelPost) {
            this.cancelAutoVoxelPost();
        }
        if (action <= EAction.Assign) {
            this.cancelAutoAssign();
        }
        for (let i = action; i < EAction.MAX; ++i) {
            this._forEachComponent(i, (component) => {
                component.setEnabled(false);
            });

            const group = this._getGroup(i);
            group.execButton?.setEnabled(false);
        }
        if (action <= EAction.Assign) {
            const assignComponents = this._ui.assign.components;
            this._updateBlockSelectionControls(
                assignComponents.blockSelectionAlgorithm.getValue(),
                false,
            );
        }
        this.syncVoxelIOButtons();
        this._syncVoxelPostActionButtons();
    }

    public resetVoxelPostControls(): void {
        this.cancelAutoVoxelPost();
        this._suppressAutoVoxelPost = true;
        try {
            this._ui.voxelPost.components.rotation.setValue(new Vector3(0, 0, 0));
        } finally {
            this._suppressAutoVoxelPost = false;
        }
    }

    public canRunAutoVoxelPost(): boolean {
        return computeVoxelPostControlState({
            groupEnabled: Boolean(this._ui.voxelPost.execButton?.enabled),
            hasVoxelMesh: this._appContext?.hasVoxelMesh() ?? false,
            autoApplyEnabled: this._autoVoxelPostEnabled,
            autoApplyRunning: this._autoVoxelPostRunning,
        }).canRunAutoApply;
    }

    public toggleAutoVoxelPost(): void {
        if (!(this._ui.voxelPost.execButton?.enabled ?? false)) {
            return;
        }
        this._autoVoxelPostEnabled = !this._autoVoxelPostEnabled;
        this._syncVoxelPostActionButtons();

        if (this._autoVoxelPostEnabled) {
            this._scheduleAutoVoxelPostIfActive();
        } else {
            this.cancelAutoVoxelPost();
        }
    }

    public cancelAutoVoxelPost(): void {
        this._autoVoxelPostScheduler.cancel();
    }

    public setAutoVoxelPostRunning(isRunning: boolean): void {
        this._autoVoxelPostRunning = isRunning;
        const postBtn = this._ui.voxelPost.execButton;
        if (postBtn) {
            if (isRunning) {
                postBtn.startLoading().setProgress(0.25);
            } else {
                postBtn.resetLoading();
            }
        }
        this._syncVoxelPostActionButtons();
    }

    public enableAssignAfterAutoVoxelPost(): void {
        this.disable(EAction.Preview);
        this.enable(EAction.Assign);
        this.syncVoxelIOButtons();
        this._syncVoxelPostActionButtons();
    }

    private _scheduleAutoVoxelPostIfActive(): void {
        if (this.canRunAutoVoxelPost()) {
            this._autoVoxelPostScheduler.schedule();
        }
    }

    private _syncVoxelPostActionButtons(): void {
        if (typeof document === 'undefined') {
            return;
        }
        const state = computeVoxelPostControlState({
            groupEnabled: Boolean(this._ui.voxelPost.execButton?.enabled),
            hasVoxelMesh: this._appContext?.hasVoxelMesh() ?? false,
            autoApplyEnabled: this._autoVoxelPostEnabled,
            autoApplyRunning: this._autoVoxelPostRunning,
        });

        const autoBtn = document.getElementById('voxel-post-auto-btn') as HTMLButtonElement | null;
        if (autoBtn) {
            autoBtn.disabled = !state.autoButtonEnabled;
            autoBtn.classList.toggle('is-active', state.autoButtonActive);
            autoBtn.setAttribute('aria-pressed', String(state.autoButtonActive));
        }
        const resetBtn = document.getElementById('voxel-post-reset-btn') as HTMLButtonElement | null;
        if (resetBtn) {
            resetBtn.disabled = !state.resetButtonEnabled;
        }
    }

    /**
     * Disables all the actions.
     */
    public disableAll() {
        this.disable(EAction.Settings);
    }

    public canRunAutoAssign(): boolean {
        const components = this._ui.assign.components;
        const algo = components.blockSelectionAlgorithm.getValue();
        if (!this._autoAssignEnabled || !isMultiBlockWeightedAlgorithm(algo)) {
            return false;
        }
        if (!components.blockSelectionAlgorithm.getEnabled()) {
            return false;
        }
        const selectedBlocks = components.dichromePalette.getValue();
        return selectedBlocks.length >= 2 && new Set(selectedBlocks).size >= 2;
    }

    public toggleAutoAssign(): void {
        const components = this._ui.assign.components;
        const algo = components.blockSelectionAlgorithm.getValue();
        const groupEnabled = components.blockSelectionAlgorithm.getEnabled();
        if (!isMultiBlockWeightedAlgorithm(algo) || !groupEnabled) {
            return;
        }

        this._autoAssignEnabled = !this._autoAssignEnabled;
        this._updateBlockSelectionControls(algo, groupEnabled);

        if (this._autoAssignEnabled) {
            this._scheduleAutoAssignIfActive();
        } else {
            this.cancelAutoAssign();
        }
    }

    public cancelAutoAssign(): void {
        this._autoAssignScheduler.cancel();
    }

    public setAutoAssignRunning(isRunning: boolean): void {
        this._autoAssignRunning = isRunning;
        const assignBtn = this._ui.assign.execButton;
        if (assignBtn) {
            if (isRunning) {
                assignBtn.startLoading().setProgress(0.25);
            } else {
                assignBtn.resetLoading();
            }
        }
        this._syncAssignFooterUI();
    }

    public enableExportAfterAutoAssign(): void {
        this.enable(EAction.Preview);
        this.enable(EAction.Export);
    }

    private _scheduleAutoAssignIfActive(): void {
        if (this.canRunAutoAssign()) {
            this._autoAssignScheduler.schedule();
        }
    }

    private _syncAssignFooterUI(controlState?: IAssignControlState): void {
        const components = this._ui.assign.components;
        const groupEnabled = components.blockSelectionAlgorithm.getEnabled();
        const state = controlState ?? computeAssignControlState({
            algorithm: components.blockSelectionAlgorithm.getValue(),
            groupEnabled,
            autoAssignEnabled: this._autoAssignEnabled,
            requestedCalculateLighting: components.calculateLighting.getValue(),
        });

        if (typeof document !== 'undefined') {
            const autoBtn = document.getElementById('assign-auto-update-btn') as HTMLButtonElement | null;
            if (autoBtn) {
                autoBtn.classList.toggle('is-hidden', !state.autoAssignButtonVisible);
                autoBtn.classList.toggle('is-active', state.autoAssignActive);
                autoBtn.disabled = !state.autoAssignButtonEnabled;
                autoBtn.setAttribute('aria-pressed', String(state.autoAssignActive));
            }
        }

        const assignBtn = this._ui.assign.execButton;
        const radialTone = components.dichromeToneBias as RadialToneDistributionComponent;
        radialTone.syncFloatingAssignState({
            assignEnabled: Boolean(assignBtn?.enabled) && !this._autoAssignRunning,
            assignLoading: this._autoAssignRunning,
            autoAssignEnabled: state.autoAssignButtonEnabled,
            autoAssignActive: state.autoAssignActive,
            slidersEnabled: components.brightnessOffset.getEnabled() && components.contrastOffset.getEnabled(),
        });
    }

    private _updateVoxeliseControls(groupEnabled: boolean) {
        const components = this._ui.voxelise.components;
        const algo = components.voxeliser.getValue();
        const isSdf = algo === 'sdf-shell';
        components.surfaceRadius.setEnabled(groupEnabled && isSdf, false);
        components.surfaceRadius.setVisible(isSdf);

        const isSupersample = algo === 'supersample-grid';
        components.coverageThreshold.setEnabled(groupEnabled && isSupersample, false);
        components.coverageThreshold.setVisible(isSupersample);

        const hollowOn = components.hollow.getValue();
        components.wallThickness.setEnabled(groupEnabled && hollowOn, false);
        components.wallThickness.setVisible(hollowOn);

        const islandsOn = components.removeFloatingIslands.getValue();
        components.minIslandSize.setEnabled(groupEnabled && islandsOn, false);
        components.minIslandSize.setVisible(islandsOn);

        const morphOn = components.morphMode.getValue() !== 'none';
        components.morphPasses.setEnabled(groupEnabled && morphOn, false);
        components.morphPasses.setVisible(morphOn);

        const plinthOn = components.addBasePlinth.getValue();
        components.plinthThickness.setEnabled(groupEnabled && plinthOn, false);
        components.plinthThickness.setVisible(plinthOn);
    }

    /**
     * Enable assignment tuning controls for every block selection algorithm.
     * Both algorithms share colour preprocessing and contextual scoring settings.
     */
    private _updateBlockSelectionControls(blockSelectionAlgorithm: TBlockSelectionAlgorithm, groupEnabled: boolean) {
        if (this._isUpdatingBlockSelectionControls) {
            return;
        }
        this._isUpdatingBlockSelectionControls = true;
        try {
            const components = this._ui.assign.components;
            const controlState = computeAssignControlState({
                algorithm: blockSelectionAlgorithm,
                groupEnabled,
                autoAssignEnabled: this._autoAssignEnabled,
                requestedCalculateLighting: components.calculateLighting.getValue(),
            });

            if (controlState.autoAssignActive && components.calculateLighting.getValue()) {
                components.calculateLighting.uncheck();
                Renderer.Get.setLightingAvailable(false);
            }

            if (!controlState.isWeightedAlgo) {
                this.cancelAutoAssign();
            }

            const isDichrome = controlState.isWeightedAlgo;
            const hasColourAssignment = !isDichrome;
            const ditheringEnabled = hasColourAssignment && components.dithering.getValue() !== 'off';
            const blockFilterEnabled = hasColourAssignment && components.blockFilter.getValue();
            const styleActive = components.colourStyle.getValue() !== 'none';
            const lightingEnabled = controlState.effectiveCalculateLighting;

            components.blockPalette.setEnabled(groupEnabled && !isDichrome, false);
            components.blockPalette.setVisible(!isDichrome);
            components.dichromePalette.setEnabled(groupEnabled && isDichrome, false);
            components.dichromePalette.setVisible(isDichrome);

            components.dichromeToneBias.setEnabled(groupEnabled && isDichrome, false);
            components.dichromeToneBias.setVisible(isDichrome);

            components.colourStyleStrength.setEnabled(groupEnabled && styleActive, false);
            components.colourStyleStrength.setVisible(styleActive);

            components.materialFilter.setEnabled(groupEnabled && hasColourAssignment, false);
            components.materialFilter.setVisible(hasColourAssignment);

            components.dithering.setEnabled(groupEnabled && hasColourAssignment, false);
            components.dithering.setVisible(hasColourAssignment);
            components.ditheringMagnitude.setEnabled(groupEnabled && ditheringEnabled, false);
            components.ditheringMagnitude.setVisible(ditheringEnabled);

            components.blockFilter.setEnabled(groupEnabled && hasColourAssignment, false);
            components.blockFilter.setVisible(hasColourAssignment);
            components.blockFilterThreshold.setEnabled(groupEnabled && blockFilterEnabled, false);
            components.blockFilterThreshold.setVisible(blockFilterEnabled);

            components.colourAccuracy.setEnabled(groupEnabled && hasColourAssignment, false);
            components.colourAccuracy.setVisible(hasColourAssignment);
            components.contextualAveraging.setEnabled(groupEnabled && hasColourAssignment, false);
            components.contextualAveraging.setVisible(hasColourAssignment);
            components.errorWeight.setEnabled(groupEnabled && hasColourAssignment, false);
            components.errorWeight.setVisible(hasColourAssignment);

            components.brightnessOffset.setEnabled(groupEnabled, false);
            components.brightnessOffset.setVisible(true);
            components.saturationOffset.setEnabled(groupEnabled && hasColourAssignment, false);
            components.saturationOffset.setVisible(hasColourAssignment);
            components.contrastOffset.setEnabled(groupEnabled, false);
            components.contrastOffset.setVisible(true);
            components.temperatureOffset.setEnabled(groupEnabled && hasColourAssignment, false);
            components.temperatureOffset.setVisible(hasColourAssignment);
            components.maxBlockTypes.setEnabled(groupEnabled && hasColourAssignment, false);
            components.maxBlockTypes.setVisible(hasColourAssignment);

            components.textureAtlas.setEnabled(groupEnabled && !isDichrome, false);
            components.textureAtlas.setVisible(!isDichrome);
            components.fallable.setEnabled(groupEnabled && !isDichrome, false);
            components.fallable.setVisible(!isDichrome);

            components.calculateLighting.setEnabled(controlState.calculateLightingEnabled, false);

            components.lightThreshold.setEnabled(groupEnabled && lightingEnabled, false);
            components.lightThreshold.setVisible(lightingEnabled);
            components.lightingPlacement.setEnabled(groupEnabled && lightingEnabled, false);
            components.lightingPlacement.setVisible(lightingEnabled);
            components.lightingScope.setEnabled(groupEnabled && lightingEnabled, false);
            components.lightingScope.setVisible(lightingEnabled);
            components.lightingLightBlock.setEnabled(groupEnabled && lightingEnabled, false);
            components.lightingLightBlock.setVisible(lightingEnabled);

            this._syncAssignFooterUI(controlState);
        } finally {
            this._isUpdatingBlockSelectionControls = false;
        }
    }

    /**
     * Util function to get the `Group` associated with an `EAction`.
     */
    private _getGroup(action: EAction): Group {
        const key = this.uiOrder[action];
        return this._uiDull[key];
    }

    public updateMaterialsAction(materialManager: MaterialMapManager) {
        this.layout.materials.components = {};
        this.layout.materials.componentOrder = [];

        if (materialManager.materials.size == 0) {
            this.layoutDull['materials'].components[`placeholder_element`] = new PlaceholderComponent()
                .setPlaceholderText('materials.components.no_materials_loaded');
            this.layoutDull['materials'].componentOrder.push(`placeholder_element`);
        } else {
            materialManager.materials.forEach((material, materialName) => {
                if (material.type === MaterialType.solid) {
                    this.layoutDull['materials'].components[`mat_${materialName}`] = new SolidMaterialComponent(materialName, material)
                        .setUnlocalisedLabel(materialName)
                        .onChangeTypeDelegate(() => {
                            materialManager.changeMaterialType(materialName, MaterialType.textured);
                            this.updateMaterialsAction(materialManager);
                        });
                } else {
                    this.layoutDull['materials'].components[`mat_${materialName}`] = new TexturedMaterialComponent(materialName, material)
                        .setUnlocalisedLabel(materialName)
                        .onChangeTypeDelegate(() => {
                            materialManager.changeMaterialType(materialName, MaterialType.solid);
                            this.updateMaterialsAction(materialManager);
                        })
                        .onChangeTransparencyTypeDelegate((newTransparency) => {
                            materialManager.changeTransparencyType(materialName, newTransparency);
                            this.updateMaterialsAction(materialManager);
                        });
                }

                this.layoutDull['materials'].componentOrder.push(`mat_${materialName}`);
            });
        }

        this.refreshComponents(EAction.Materials);
    }

    public updateVoxelDimensions(dims: EstimatedDimensions | null, isExact: boolean) {
        (this._ui.voxelise.components.dimensionsReadout as DimensionsReadoutComponent).setDimensions(dims, isExact);
    }

    public updatePreview(summary: PreviewParams.Output) {
        (this._ui.preview.components.blockList as PreviewComponent).updateSummary(summary);
        this.setPreviewAvailable(true);
        this._syncSliceReadout(true);
    }

    public getActivePaletteBlocks(): string[] {
        const algo = this._ui.assign.components.blockSelectionAlgorithm.getValue();
        if (algo === 'dichrome' || algo === 'polychrome') {
            return this._ui.assign.components.dichromePalette.getValue();
        }
        return (this._ui.assign.components.blockPalette as PaletteComponent).getValue().getBlocks();
    }

    public setReplaceCanUndo(canUndo: boolean) {
        (this._ui.preview.components.blockList as PreviewComponent).setCanUndoReplace(canUndo);
    }

    public async replaceBlockInModel(
        sourceBlock: string,
        targetBlock: string,
        options?: {
            scope?: TReplaceScope;
            mode?: TReplaceMode;
            sourceBlocks?: string[];
        },
    ): Promise<boolean> {
        if (!this._appContext) {
            return false;
        }
        return await this._appContext.replaceBlockInMesh(sourceBlock, targetBlock, options);
    }

    public clearPreview() {
        this.setPreviewAvailable(false);
        (this._ui.preview.components.blockList as PreviewComponent).clear();
    }

    public clearPreviewSelection() {
        (this._ui.preview.components.blockList as PreviewComponent).clearSelection();
    }

    public optimizePalette(blockNames: string[], disableUnused = false, modelBlocks: string[] = []): number {
        return (this._ui.assign.components.blockPalette as PaletteComponent).disableBlocks(blockNames, disableUnused, modelBlocks);
    }

    public rollbackToAssign() {
        this.cancelAutoAssign();
        Renderer.Get.clearBlockMesh();
        Renderer.Get.setModelToUse(MeshType.VoxelMesh);
        this.clearPreview();
        this.disable(EAction.Preview);
        this.enable(EAction.Assign);
    }

    private _getCameraSettingsHTML() {
        return `
            <div id="camera-settings-popover" class="camera-settings-popover hide">
                <div class="camera-settings-header" id="camera-settings-header">
                    <span class="camera-settings-title">${LOC('toolbar.camera_settings')}</span>
                    <button type="button" class="camera-settings-close-btn" id="camera-settings-close" title="Close">×</button>
                </div>
                <div class="camera-settings-body">
                    <div class="camera-setting-item">
                        <label for="camera-rot-speed">${LOC('toolbar.camera_rotation_speed')}</label>
                        <div class="camera-setting-input-wrapper">
                            <input id="camera-rot-speed" type="number" min="0" step="0.0005" value="${AppConfig.Get.CAMERA_SENSITIVITY_ROTATION.toFixed(4)}" />
                            <button type="button" class="camera-setting-wheel-btn" data-target="camera-rot-speed" title="${LOC('toolbar.camera_rotation_speed')} (↕ Scroll / Drag)">↕</button>
                        </div>
                    </div>
                    <div class="camera-setting-item">
                        <label for="camera-pan-speed">${LOC('toolbar.camera_pan_speed')}</label>
                        <div class="camera-setting-input-wrapper">
                            <input id="camera-pan-speed" type="number" min="0" step="0.0002" value="${AppConfig.Get.CAMERA_SENSITIVITY_PAN.toFixed(4)}" />
                            <button type="button" class="camera-setting-wheel-btn" data-target="camera-pan-speed" title="${LOC('toolbar.camera_pan_speed')} (↕ Scroll / Drag)">↕</button>
                        </div>
                    </div>
                    <div class="camera-setting-item">
                        <label for="camera-zoom-speed">${LOC('toolbar.camera_zoom_speed')}</label>
                        <div class="camera-setting-input-wrapper">
                            <input id="camera-zoom-speed" type="number" min="0" step="0.00002" value="${AppConfig.Get.CAMERA_SENSITIVITY_ZOOM.toFixed(5)}" />
                            <button type="button" class="camera-setting-wheel-btn" data-target="camera-zoom-speed" title="${LOC('toolbar.camera_zoom_speed')} (↕ Scroll / Drag)">↕</button>
                        </div>
                    </div>
                </div>
            </div>
        `;
    }

    private _getPreviewPanelHTML() {
        const group = this._getGroup(EAction.Preview);
        return `
            <div id="preview-panel-popover" class="camera-settings-popover preview-panel-popover hide">
                <div class="camera-settings-header" id="preview-panel-header">
                    <span class="camera-settings-title">${LOC('toolbar.toggle_preview_panel')}</span>
                    <button type="button" class="camera-settings-close-btn" id="preview-panel-close" title="Close">×</button>
                </div>
                <div class="camera-settings-body preview-panel-body" id="subcomponents_${group.id}">
                    ${this._getComponentsHTML(group)}
                </div>
            </div>
        `;
    }

    private _registerPreviewPanelEvents() {
        const panel = document.getElementById('preview-panel-popover');
        const header = document.getElementById('preview-panel-header');
        const closeBtn = document.getElementById('preview-panel-close');

        if (closeBtn) {
            closeBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this._setPreviewPanelOpen(false);
            });
        }

        // Keep the preview panel position between visits, like camera settings.
        if (panel && header) {
            try {
                const saved = localStorage.getItem('preview_panel_pos');
                if (saved) {
                    const parsed = JSON.parse(saved);
                    if (typeof parsed.x === 'number' && typeof parsed.y === 'number') {
                        const panelWidth = panel.offsetWidth || 420;
                        const panelHeight = panel.offsetHeight || 240;
                        const clampedX = Math.max(10, Math.min(window.innerWidth - panelWidth - 10, parsed.x));
                        const clampedY = Math.max(10, Math.min(window.innerHeight - panelHeight - 10, parsed.y));
                        this._previewPanelPos = { x: clampedX, y: clampedY };
                        panel.style.left = `${clampedX}px`;
                        panel.style.top = `${clampedY}px`;
                        panel.style.right = 'auto';
                    }
                }
            } catch (_) {}

            header.addEventListener('mousedown', (e: MouseEvent) => {
                if ((e.target as HTMLElement).closest('.camera-settings-close-btn')) return;
                if (e.button !== 0) return;
                e.preventDefault();

                const rect = panel.getBoundingClientRect();
                const offsetX = e.clientX - rect.left;
                const offsetY = e.clientY - rect.top;

                header.classList.add('grabbing');
                document.body.style.userSelect = 'none';

                const onMouseMove = (moveEvent: MouseEvent) => {
                    const panelWidth = panel.offsetWidth || 420;
                    const panelHeight = panel.offsetHeight || 240;
                    const rawX = moveEvent.clientX - offsetX;
                    const rawY = moveEvent.clientY - offsetY;

                    const clampedX = Math.max(10, Math.min(window.innerWidth - panelWidth - 10, rawX));
                    const clampedY = Math.max(10, Math.min(window.innerHeight - panelHeight - 10, rawY));

                    panel.style.left = `${clampedX}px`;
                    panel.style.top = `${clampedY}px`;
                    panel.style.right = 'auto';

                    this._previewPanelPos = { x: clampedX, y: clampedY };
                    try {
                        localStorage.setItem('preview_panel_pos', JSON.stringify(this._previewPanelPos));
                    } catch (_) {}
                };

                const onMouseUp = () => {
                    header.classList.remove('grabbing');
                    document.body.style.userSelect = '';
                    window.removeEventListener('mousemove', onMouseMove);
                    window.removeEventListener('mouseup', onMouseUp);
                };

                window.addEventListener('mousemove', onMouseMove);
                window.addEventListener('mouseup', onMouseUp);
            });
        }
    }

    private _registerCameraSettingsEvents() {
        const panel = document.getElementById('camera-settings-popover');
        const header = document.getElementById('camera-settings-header');
        const closeBtn = document.getElementById('camera-settings-close');

        if (closeBtn) {
            closeBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this._toggleCameraSettings();
            });
        }

        // Draggable window with persistent position
        if (panel && header) {
            try {
                const saved = localStorage.getItem('camera_settings_pos');
                if (saved) {
                    const parsed = JSON.parse(saved);
                    if (typeof parsed.x === 'number' && typeof parsed.y === 'number') {
                        const panelWidth = panel.offsetWidth || 250;
                        const panelHeight = panel.offsetHeight || 180;
                        const clampedX = Math.max(10, Math.min(window.innerWidth - panelWidth - 10, parsed.x));
                        const clampedY = Math.max(10, Math.min(window.innerHeight - panelHeight - 10, parsed.y));
                        this._cameraSettingsPos = { x: clampedX, y: clampedY };
                        panel.style.left = `${clampedX}px`;
                        panel.style.top = `${clampedY}px`;
                        panel.style.right = 'auto';
                    }
                }
            } catch (_) {}

            header.addEventListener('mousedown', (e: MouseEvent) => {
                if ((e.target as HTMLElement).closest('.camera-settings-close-btn')) return;
                if (e.button !== 0) return;
                e.preventDefault();

                const rect = panel.getBoundingClientRect();
                const offsetX = e.clientX - rect.left;
                const offsetY = e.clientY - rect.top;

                header.classList.add('grabbing');
                document.body.style.userSelect = 'none';

                const onMouseMove = (moveEvent: MouseEvent) => {
                    const panelWidth = panel.offsetWidth || 250;
                    const panelHeight = panel.offsetHeight || 180;
                    const rawX = moveEvent.clientX - offsetX;
                    const rawY = moveEvent.clientY - offsetY;

                    const clampedX = Math.max(10, Math.min(window.innerWidth - panelWidth - 10, rawX));
                    const clampedY = Math.max(10, Math.min(window.innerHeight - panelHeight - 10, rawY));

                    panel.style.left = `${clampedX}px`;
                    panel.style.top = `${clampedY}px`;
                    panel.style.right = 'auto';

                    this._cameraSettingsPos = { x: clampedX, y: clampedY };
                    try {
                        localStorage.setItem('camera_settings_pos', JSON.stringify(this._cameraSettingsPos));
                    } catch (_) {}
                };

                const onMouseUp = () => {
                    header.classList.remove('grabbing');
                    document.body.style.userSelect = '';
                    window.removeEventListener('mousemove', onMouseMove);
                    window.removeEventListener('mouseup', onMouseUp);
                };

                window.addEventListener('mousemove', onMouseMove);
                window.addEventListener('mouseup', onMouseUp);
            });
        }

        const setupControl = (
            inputId: string,
            step: number,
            decimals: number,
            getter: () => number,
            setter: (v: number) => void,
        ) => {
            const input = document.getElementById(inputId) as HTMLInputElement | null;
            if (!input) return;

            const applyVal = (val: number) => {
                const clamped = Math.max(0, val);
                setter(clamped);
                input.value = clamped.toFixed(decimals);
            };

            input.addEventListener('input', () => {
                const parsed = parseFloat(input.value);
                if (!isNaN(parsed) && parsed >= 0) {
                    setter(parsed);
                }
            });

            input.addEventListener('change', () => {
                const parsed = parseFloat(input.value);
                if (!isNaN(parsed)) {
                    applyVal(parsed);
                } else {
                    input.value = getter().toFixed(decimals);
                }
            });

            input.addEventListener('wheel', (e: WheelEvent) => {
                e.preventDefault();
                e.stopPropagation();
                const dir = e.deltaY < 0 ? 1 : -1;
                applyVal(getter() + dir * step);
            }, { passive: false });

            const wheelBtn = document.querySelector(`.camera-setting-wheel-btn[data-target="${inputId}"]`) as HTMLButtonElement | null;
            if (wheelBtn) {
                wheelBtn.addEventListener('wheel', (e: WheelEvent) => {
                    e.preventDefault();
                    e.stopPropagation();
                    const dir = e.deltaY < 0 ? 1 : -1;
                    applyVal(getter() + dir * step);
                }, { passive: false });

                wheelBtn.addEventListener('mousedown', (e: MouseEvent) => {
                    e.preventDefault();
                    const startY = e.clientY;
                    const startVal = getter();
                    const onMouseMove = (moveEvent: MouseEvent) => {
                        const dy = startY - moveEvent.clientY;
                        applyVal(startVal + dy * step);
                    };
                    const onMouseUp = () => {
                        window.removeEventListener('mousemove', onMouseMove);
                        window.removeEventListener('mouseup', onMouseUp);
                    };
                    window.addEventListener('mousemove', onMouseMove);
                    window.addEventListener('mouseup', onMouseUp);
                });
            }
        };

        setupControl('camera-rot-speed', 0.0005, 4,
            () => AppConfig.Get.CAMERA_SENSITIVITY_ROTATION,
            (v) => { AppConfig.Get.CAMERA_SENSITIVITY_ROTATION = v; },
        );
        setupControl('camera-pan-speed', 0.0002, 4,
            () => AppConfig.Get.CAMERA_SENSITIVITY_PAN,
            (v) => { AppConfig.Get.CAMERA_SENSITIVITY_PAN = v; },
        );
        setupControl('camera-zoom-speed', 0.00002, 5,
            () => AppConfig.Get.CAMERA_SENSITIVITY_ZOOM,
            (v) => { AppConfig.Get.CAMERA_SENSITIVITY_ZOOM = v; },
        );
    }
}
