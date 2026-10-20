import Split from 'split.js';

import { locales } from '../../loc/base';
import { AppContext } from '../app_context';
import { FallableBehaviour } from '../block_mesh';
import { ArcballCamera } from '../camera';
import { AppConfig } from '../config';
import { EAppEvent, EventManager } from '../event';
import { TExporters } from '../exporters/exporters';
import { LOC, Localiser, TLocalisedString } from '../localiser';
import { MaterialMapManager } from '../material-map';
import { MaterialType } from '../mesh';
import { MeshType, Renderer } from '../renderer';
import { EAction } from '../util';
import { ASSERT } from '../util/error_util';
import { TAxis } from '../util/type_util';
import { TDithering } from '../util/type_util';
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
                                console.log('min', this._appContext.minConstraint, 'max', this._appContext.maxConstraint);
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
                                console.log('min', this._appContext.minConstraint, 'max', this._appContext.maxConstraint);
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
                    .addValueChangedListener((newValue: TDithering) => {
                        this._ui.assign.components.ditheringMagnitude.setEnabled(newValue !== 'off', false);
                    }),
                'ditheringMagnitude': new SliderComponent()
                    .setMin(1)
                    .setMax(64)
                    .setDefaultValue(32)
                    .setDecimals(0)
                    .setStep(1)
                    .setLabel('assign.components.dithering_magnitude')
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
                    .setLabel('assign.components.colour_accuracy'),
                'contextualAveraging': new CheckboxComponent()
                    .setCheckedText('voxelise.components.on_recommended')
                    .setUncheckedText('voxelise.components.off_faster')
                    .setDefaultValue(true)
                    .setLabel('assign.components.smart_averaging'),
                'errorWeight': new SliderComponent()
                    .setMin(0.0)
                    .setMax(2.0)
                    .setDefaultValue(0.2)
                    .setDecimals(2)
                    .setStep(0.01)
                    .setLabel('assign.components.smoothness'),
                'calculateLighting': new CheckboxComponent()
                    .setCheckedText('misc.on')
                    .setUncheckedText('misc.off')
                    .setDefaultValue(false)
                    .setLabel('assign.components.calculate_lighting')
                    .addValueChangedListener((newValue: boolean) => {
                        const isEnabled = this._ui.assign.components.calculateLighting.getEnabled();
                        this._ui.assign.components.lightThreshold.setEnabled(newValue && isEnabled, false);
                    })
                    .addEnabledChangedListener((isEnabled: boolean) => {
                        const value = this._ui.assign.components.calculateLighting.getValue();
                        this._ui.assign.components.lightThreshold.setEnabled(value && isEnabled, false);
                    }),
                'lightThreshold': new SliderComponent()
                    .setMin(0)
                    .setMax(14)
                    .setDefaultValue(1)
                    .setDecimals(0)
                    .setStep(1)
                    .setLabel('assign.components.light_threshold')
                    .setShouldObeyGroupEnables(false),
                'placeholder': new PlaceholderComponent()
                    .setPlaceholderText('misc.advanced_settings'),
            },
            componentOrder: [
                'blockPalette',
                'dithering',
                'placeholder',
                'textureAtlas',
                'ditheringMagnitude',
                'fallable',
                'colourAccuracy',
                'contextualAveraging',
                'errorWeight',
                'calculateLighting',
                'lightThreshold',
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
                            Renderer.Get.setModelToUse(MeshType.TriangleMesh);
                        })
                        .isActive(() => {
                            return Renderer.Get.getActiveMeshType() === MeshType.TriangleMesh;
                        })
                        .isEnabled(() => {
                            return Renderer.Get.getModelsAvailable() >= MeshType.TriangleMesh;
                        })
                        .setTooltip('toolbar.view_mesh'),
                    'voxelMesh': new ToolbarItemComponent({ id: 'voxelMesh', iconSVG: AppIcons.VOXEL })
                        .onClick(() => {
                            Renderer.Get.setModelToUse(MeshType.VoxelMesh);
                        })
                        .isActive(() => {
                            return Renderer.Get.getActiveMeshType() === MeshType.VoxelMesh;
                        })
                        .isEnabled(() => {
                            return Renderer.Get.getModelsAvailable() >= MeshType.VoxelMesh;
                        })
                        .setTooltip('toolbar.view_voxel_mesh'),
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
                        .setTooltip('toolbar.view_block_mesh'),
                },
                componentOrder: ['mesh', 'voxelMesh', 'blockMesh'],
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
                        .setTooltip('toolbar.toggle_grid'),
                    'axes': new ToolbarItemComponent({ id: 'axes', iconSVG: AppIcons.AXES })
                        .onClick(() => {
                            Renderer.Get.toggleIsAxesEnabled();
                        })
                        .isActive(() => {
                            return Renderer.Get.isAxesEnabled();
                        })
                        .setTooltip('toolbar.toggle_axes'),
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
                        .setTooltip('toolbar.toggle_night_vision'),
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
                        .setTooltip('toolbar.toggle_slice_viewer'),
                    'plus': new ToolbarItemComponent({ id: 'plus', iconSVG: AppIcons.PLUS })
                        .onClick(() => {
                            Renderer.Get.incrementSliceHeight();
                        })
                        .isEnabled(() => {
                            return Renderer.Get.isSliceViewerEnabled() &&
                                Renderer.Get.canIncrementSliceHeight();
                        })
                        .setTooltip('toolbar.decrement_slice'),
                    'minus': new ToolbarItemComponent({ id: 'minus', iconSVG: AppIcons.MINUS })
                        .onClick(() => {
                            Renderer.Get.decrementSliceHeight();
                        })
                        .isEnabled(() => {
                            return Renderer.Get.isSliceViewerEnabled() &&
                                Renderer.Get.canDecrementSliceHeight();
                        })
                        .setTooltip('toolbar.increment_slice'),
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
                        .setTooltip('toolbar.zoom_out'),
                    'zoomIn': new ToolbarItemComponent({ id: 'zin', iconSVG: AppIcons.PLUS })
                        .onClick(() => {
                            ArcballCamera.Get.onZoomIn();
                        })
                        .setTooltip('toolbar.zoom_in'),
                    'reset': new ToolbarItemComponent({ id: 'reset', iconSVG: AppIcons.CENTRE })
                        .onClick(() => {
                            ArcballCamera.Get.reset();
                        })
                        .setTooltip('toolbar.reset_camera'),
                    'cameraSettings': new ToolbarItemComponent({ id: 'camera-settings-btn', iconSVG: AppIcons.CAMERA_SETTINGS })
                        .onClick(() => {
                            this._toggleCameraSettings();
                        })
                        .isActive(() => {
                            return this._isCameraSettingsOpen;
                        })
                        .setTooltip('toolbar.camera_settings'),
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
                        .setTooltip('toolbar.perspective_camera'),
                    'orthographic': new ToolbarItemComponent({ id: 'orth', iconSVG: AppIcons.ORTHOGRAPHIC })
                        .onClick(() => {
                            ArcballCamera.Get.setCameraMode('orthographic');
                        })
                        .isActive(() => {
                            return ArcballCamera.Get.isOrthographic();
                        })
                        .setTooltip('toolbar.orthographic_camera'),
                },
                componentOrder: ['perspective', 'orthographic'],
            },
        },
        groupsOrder: ['camera', 'zoom'],
    };

    private _uiDull: { [key: string]: Group } = this._ui;
    private _toolbarLeftDull: { [key: string]: ToolbarGroup } = this._toolbarLeft.groups;
    private _toolbarRightDull: { [key: string]: ToolbarGroup } = this._toolbarRight.groups;

    private _isCameraSettingsOpen = false;
    private _cameraSettingsPos: { x: number, y: number } | null = null;

    private _toggleCameraSettings() {
        this._isCameraSettingsOpen = !this._isCameraSettingsOpen;
        const panel = document.getElementById('camera-settings-popover');
        if (panel) {
            panel.classList.toggle('hide', !this._isCameraSettingsOpen);
            if (this._isCameraSettingsOpen && this._cameraSettingsPos) {
                panel.style.left = `${this._cameraSettingsPos.x}px`;
                panel.style.top = `${this._cameraSettingsPos.y}px`;
                panel.style.right = 'auto';
            }
        }
        const toolbarItem = this._toolbarRight.groups.zoom.components.cameraSettings;
        if (toolbarItem) {
            toolbarItem.setActive(this._isCameraSettingsOpen);
        }
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
                toolbarHTML.add('<div class="toolbar-group">');
                const toolbarGroup = this._toolbarLeftDull[toolbarGroupName];
                for (const groupElementName of toolbarGroup.componentOrder) {
                    const groupElement = toolbarGroup.components[groupElementName];
                    toolbarHTML.add(groupElement.generateHTML());
                }
                toolbarHTML.add('</div>');
            }
            toolbarHTML.add('</div>');

            // Right
            toolbarHTML.add('<div class="toolbar-column">');
            for (const toolbarGroupName of this._toolbarRight.groupsOrder) {
                toolbarHTML.add('<div class="toolbar-group">');
                const toolbarGroup = this._toolbarRightDull[toolbarGroupName];
                for (const groupElementName of toolbarGroup.componentOrder) {
                    const groupElement = toolbarGroup.components[groupElementName];
                    toolbarHTML.add(groupElement.generateHTML());
                }
                toolbarHTML.add('</div>');
            }
            toolbarHTML.add('</div>');

            toolbarHTML.placeInto('toolbar');

            const canvasCol = document.getElementById('col-canvas');
            if (canvasCol) {
                canvasCol.insertAdjacentHTML('beforeend', this._getCameraSettingsHTML());
            }
        }

        // Build console
        AppConsole.Get.build();

        Split(['.column-sidebar', '.column-canvas'], {
            sizes: [20, 80],
            minSize: [600, 500],
            gutterSize: 5,
        });

        Split(['.column-properties', '.column-console'], {
            sizes: [85, 15],
            minSize: [0, 0],
            direction: 'vertical',
            gutterSize: 5,
        });
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

        this._registerCameraSettingsEvents();
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
    }

    public clearPreview() {
        (this._ui.preview.components.blockList as PreviewComponent).clear();
    }

    public optimizePalette(blockNames: string[]): number {
        return (this._ui.assign.components.blockPalette as PaletteComponent).disableBlocks(blockNames);
    }

    public rollbackToAssign() {
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
                        this._cameraSettingsPos = parsed;
                        panel.style.left = `${parsed.x}px`;
                        panel.style.top = `${parsed.y}px`;
                        panel.style.right = 'auto';
                    }
                }
            } catch (_) {}

            header.addEventListener('mousedown', (e: MouseEvent) => {
                if ((e.target as HTMLElement).closest('.camera-settings-close-btn')) return;
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
