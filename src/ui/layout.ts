import Split from 'split.js';

import { locales } from '../../loc/base';
import { PALETTE_ALL_RELEASE } from '../../res/palettes/all';
import { AppContext } from '../app_context';
import { FallableBehaviour } from '../block_mesh';
import { ArcballCamera } from '../camera';
import { AppConfig } from '../config';
import { EAppEvent, EventManager } from '../event';
import { TExporters } from '../exporters/exporters';
import { LOC, Localiser, TLocalisedString } from '../localiser';
import { MaterialMapManager } from '../material-map';
import { MaterialType } from '../mesh';
import { InteractionManager } from '../interaction';
import { MeshType, Renderer } from '../renderer';
import { EAction } from '../util';
import { ASSERT } from '../util/error_util';
import { LOG } from '../util/log_util';
import { TAxis } from '../util/type_util';
import { TDithering, TBlockSelectionAlgorithm, TLightingPlacement, TLightingScope } from '../util/type_util';
import { UIUtil } from '../util/ui_util';
import { TVoxelOverlapRule } from '../voxel_mesh';
import { TVoxelisers } from '../voxelisers/voxelisers';
import { PreviewParams } from '../worker_types';
import { ButtonComponent } from './components/button';
import { CheckboxComponent } from './components/checkbox';
import { ComboboxComponent } from './components/combobox';
import { ConfigComponent } from './components/config';
import { FileComponent } from './components/file_input';
import { HeaderComponent } from './components/header';
import { PaletteComponent } from './components/palette';
import { PlaceholderComponent } from './components/placeholder';
import { PreviewComponent } from './components/preview';
import { SliderComponent } from './components/slider';
import { SolidMaterialComponent } from './components/solid_material';
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
    }

    public uiOrder = ['settings', 'import', 'materials', 'voxelise', 'assign', 'preview', 'export'];
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
                    }),
                'size': new SliderComponent()
                    .setMin(3)
                    .setMax(380)
                    .setDefaultValue(80)
                    .setDecimals(0)
                    .setStep(1)
                    .setLabel('voxelise.components.size'),
                'voxeliser': new ComboboxComponent<TVoxelisers>()
                    .addItem({ payload: 'ray-based', displayLocKey: 'voxelise.components.ray_based' })
                    .addItem({ payload: 'bvh-ray', displayLocKey: 'voxelise.components.bvh_ray' })
                    .addItem({ payload: 'ncrb', displayLocKey: 'voxelise.components.ncrb' })
                    .setLabel('voxelise.components.algorithm'),
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
                        displayLocKey: 'voxelise.components.first',
                        payload: 'first',
                    })
                    .setLabel('voxelise.components.voxel_overlap'),
                'placeholder': new PlaceholderComponent()
                    .setPlaceholderText('misc.advanced_settings'),
            },
            componentOrder: [
                'constraintAxis',
                'size',
                'placeholder',
                'voxeliser',
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
                'dichromeToneBias': new SliderComponent()
                    .setMin(-100)
                    .setMax(100)
                    .setDefaultValue(0)
                    .setDecimals(0)
                    .setStep(1)
                    .setThumbStyle()
                    .setLabel('assign.components.dichrome_tone_bias')
                    .setShouldObeyGroupEnables(false),
                'blockSelectionAlgorithm': new ComboboxComponent<TBlockSelectionAlgorithm>()
                    .addItem({ payload: 'nearest-color', displayLocKey: 'assign.components.nearest_color' })
                    .addItem({ payload: 'color-chart-match', displayLocKey: 'assign.components.color_chart_match' })
                    .addItem({ payload: 'character-statue', displayLocKey: 'assign.components.character_statue' })
                    .addItem({ payload: 'dichrome', displayLocKey: 'assign.components.dichrome' })
                    .setLabel('assign.components.block_selection_algorithm')
                    .addValueChangedListener((newValue: TBlockSelectionAlgorithm) => {
                        this._updateBlockSelectionControls(
                            newValue,
                            this._ui.assign.components.blockSelectionAlgorithm.getEnabled(),
                        );
                    })
                    .addEnabledChangedListener((isEnabled: boolean) => {
                        this._updateBlockSelectionControls(
                            this._ui.assign.components.blockSelectionAlgorithm.getValue(),
                            isEnabled,
                        );
                    }),
                'dithering': new ComboboxComponent<TDithering>()
                    .addItems([{
                        displayLocKey: 'assign.components.ordered',
                        payload: 'ordered',
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
                    .addEnabledChangedListener(() => {
                        const components = this._ui.assign.components;
                        this._updateBlockSelectionControls(
                            components.blockSelectionAlgorithm.getValue(),
                            components.blockSelectionAlgorithm.getEnabled(),
                        );
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
                'dichromeToneBias',
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
            componentOrder: ['export'],
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
                            return Renderer.Get.getModelsAvailable() >= MeshType.TriangleMesh;
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
                        })
                        .isEnabled(() => {
                            return Renderer.Get.isSliceViewerEnabled() &&
                                Renderer.Get.canIncrementSliceHeight();
                        })
                        .setTooltip('toolbar.decrement_slice', 'bottom'),
                    'minus': new ToolbarItemComponent({ id: 'minus', iconSVG: AppIcons.MINUS })
                        .onClick(() => {
                            Renderer.Get.decrementSliceHeight();
                        })
                        .isEnabled(() => {
                            return Renderer.Get.isSliceViewerEnabled() &&
                                Renderer.Get.canDecrementSliceHeight();
                        })
                        .setTooltip('toolbar.increment_slice', 'bottom'),
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
        if (shouldOpen && this._isCameraSettingsOpen) {
            this._toggleCameraSettings();
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
    }

    public build() {
        // Build properties
        {
            const sidebarHTML = new HTMLBuilder();

            sidebarHTML.add(`<div class="container-properties">`);
            {
                sidebarHTML.add(HeaderComponent.Get.generateHTML());

                for (const groupName of this.uiOrder) {
                    if (groupName === 'preview') {
                        continue;
                    }
                    const group = this._uiDull[groupName];
                    sidebarHTML.add(this._getGroupHTML(group));
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
            const header = UIUtil.getElementById(`component_header_${group.id}`);

            group.label = this._getGroupHeadingLabel(i);
            header.innerHTML = MiscComponents.createGroupHeader(group.label);

            if (group.execButton !== undefined) {
                const newButtonLabel = this._getGroupButtonLabel(i);
                group.execButton.setLabel(newButtonLabel).updateLabel();
            }

            this._forEachComponent(i, (component) => {
                component.refresh();
            });
        }

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

    private _getGroupHTML(group: Group) {
        return `
            <div id="component_header_${group.id}">
                ${MiscComponents.createGroupHeader(group.label)}
            </div>
            <div class="component-group" id="subcomponents_${group.id}">
                ${this._getComponentsHTML(group)}
            </div>
            ${group.execButton?.generateHTML() ?? ''}
        `;
    }

    public getActionButton(action: EAction) {
        const group = this._getGroup(action);
        return group.execButton;
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

        const assignComponents = this._ui.assign.components;
        this._updateBlockSelectionControls(
            assignComponents.blockSelectionAlgorithm.getValue(),
            assignComponents.blockSelectionAlgorithm.getEnabled(),
        );

        this._registerCameraSettingsEvents();
        this._registerPreviewPanelEvents();
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
            this._getGroup(action).execButton?.setEnabled(canEnableExec);
        }
    }

    /**
     * Enable all actions up to and including a specific action.
     */
    public enableTo(action: EAction) {
        for (let i = 0; i <= action; ++i) {
            this.enable(i);
        }
    }

    /**
     * Disable a specific action and its dependent actions.
     */
    public disable(action: EAction) {
        for (let i = action; i < EAction.MAX; ++i) {
            this._forEachComponent(i, (component) => {
                component.setEnabled(false);
            });

            this._getGroup(i).execButton?.setEnabled(false);
        }
    }

    /**
     * Disables all the actions.
     */
    public disableAll() {
        this.disable(EAction.Settings);
    }

    /**
     * Enable assignment tuning controls for every block selection algorithm.
     * Both algorithms share colour preprocessing and contextual scoring settings.
     */
    private _updateBlockSelectionControls(blockSelectionAlgorithm: TBlockSelectionAlgorithm, groupEnabled: boolean) {
        const components = this._ui.assign.components;
        const isDichrome = blockSelectionAlgorithm === 'dichrome';
        const hasColourAssignment = !isDichrome;
        const ditheringEnabled = hasColourAssignment && components.dithering.getValue() !== 'off';
        const blockFilterEnabled = hasColourAssignment && components.blockFilter.getValue();
        const lightingEnabled = components.calculateLighting.getValue();

        // Dichrome consumes exactly the two blocks currently checked in the shared palette.
        components.blockPalette.setEnabled(groupEnabled, false);
        components.blockPalette.setVisible(true);
        components.blockPalette.setLabel(isDichrome ?
            'assign.components.dichrome_palette' :
            'assign.components.block_palette');
        components.blockPalette.refresh();

        components.dichromeToneBias.setEnabled(groupEnabled && isDichrome, false);
        components.dichromeToneBias.setVisible(isDichrome);

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

        components.lightThreshold.setEnabled(groupEnabled && lightingEnabled, false);
        components.lightThreshold.setVisible(lightingEnabled);
        components.lightingPlacement.setEnabled(groupEnabled && lightingEnabled, false);
        components.lightingPlacement.setVisible(lightingEnabled);
        components.lightingScope.setEnabled(groupEnabled && lightingEnabled, false);
        components.lightingScope.setVisible(lightingEnabled);
        components.lightingLightBlock.setEnabled(groupEnabled && lightingEnabled, false);
        components.lightingLightBlock.setVisible(lightingEnabled);
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

    public updatePreview(summary: PreviewParams.Output) {
        (this._ui.preview.components.blockList as PreviewComponent).updateSummary(summary);
        this.setPreviewAvailable(true);
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
            (v) => { AppConfig.Get.CAMERA_SENSITIVITY_ROTATION = v; }
        );
        setupControl('camera-pan-speed', 0.0002, 4,
            () => AppConfig.Get.CAMERA_SENSITIVITY_PAN,
            (v) => { AppConfig.Get.CAMERA_SENSITIVITY_PAN = v; }
        );
        setupControl('camera-zoom-speed', 0.00002, 5,
            () => AppConfig.Get.CAMERA_SENSITIVITY_ZOOM,
            (v) => { AppConfig.Get.CAMERA_SENSITIVITY_ZOOM = v; }
        );
    }
}
