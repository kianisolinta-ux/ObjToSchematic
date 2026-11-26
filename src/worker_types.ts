import { FallableBehaviour } from './block_mesh';
import { TMaterialFilter } from './block_styles';
import { Bounds } from './bounds';
import { TBlockMeshBufferDescription, TMeshBufferDescription, TVoxelMeshBufferDescription } from './buffer';
import { RGBAUtil } from './colour';
import { TColourStyle } from './colour_styles';
import { TStructureExport } from './exporters/base_exporter';
import { TExporters } from './exporters/exporters';
import { LitematicExportOptions } from './exporters/litematic_exporter';
import { MaterialMap } from './mesh';
import { MeshRepairStats } from './mesh_repair';
import { TMessage } from './ui/console';
import { ColourSpace } from './util';
import { AppError } from './util/error_util';
import { TAxis } from './util/type_util';
import { TBlockSelectionAlgorithm, TDithering, TLightingPlacement, TLightingScope } from './util/type_util';
import { Vector3 } from './vector';
import { TVoxelOverlapRule } from './voxel_mesh';
import { TVoxelModelMeta } from './voxel_model_io';
import { TMorphMode, TVoxelMirrorAxis } from './voxel_postprocess';
import { TVoxelisers } from './voxelisers/voxelisers';

export namespace InitParams {
    export type Input = {
    }

    export type Output = {
    }
}

export namespace SettingsParams {
    export type Input = {
        language: string,
    }

    export type Output = {
    }
}

export namespace ImportParams {
    export type Input = {
        file: File,
        rotation: Vector3,
    }

    export type Output = {
        triangleCount: number,
        dimensions: Vector3,
        materials: MaterialMap,
    }
}

export namespace RenderMeshParams {
    export type Input = {

    }

    export type Output = {
        buffers: TMeshBufferDescription[],
        dimensions: Vector3
    }
}

export namespace SetMaterialsParams {
    export type Input = {
        materials: MaterialMap
    }

    export type Output = {
        materials: MaterialMap,
        materialsChanged: string[],
    }
}

export namespace VoxeliseParams {
    export type Input = {
        constraintAxis: TAxis,
        voxeliser: TVoxelisers,
        size: number,
        useMultisampleColouring: boolean,
        enableAmbientOcclusion: boolean,
        voxelOverlapRule: TVoxelOverlapRule,
        surfaceRadius?: number,
        coverageThreshold?: number,
        morphMode?: TMorphMode,
        morphPasses?: number,
        voxelMirror?: TVoxelMirrorAxis,
        addBasePlinth?: boolean,
        plinthThickness?: number,
        hollow?: boolean,
        wallThickness?: number,
        removeFloatingIslands?: boolean,
        minIslandSize?: number,
    }

    export type Output = {

    }
}

/*
export namespace RenderVoxelMeshParams {
    export type Input = {
        desiredHeight: number,
        enableAmbientOcclusion: boolean,
    }

    export type Output = {
        buffer: TVoxelMeshBufferDescription,
        dimensions: Vector3,
        voxelSize: number,
    }
}
*/

export namespace RenderNextVoxelMeshChunkParams {
    export type Input = {
        desiredHeight: number,
        enableAmbientOcclusion: boolean,
    }

    export type Output = {
        buffer: TVoxelMeshBufferDescription,
        dimensions: Vector3,
        voxelSize: number,
        moreVoxelsToBuffer: boolean,
        isFirstChunk: boolean,
    }
}

export namespace SaveVoxelModelParams {
    export type Input = {
        modelName?: string,
        constraintAxis?: TAxis,
        size?: number,
        enableAmbientOcclusion?: boolean,
        voxelOverlapRule?: TVoxelOverlapRule,
    }

    export type Output = {
        content: string,
        voxelCount: number,
        dimensions: Vector3,
    }
}

export namespace LoadVoxelModelParams {
    export type Input = {
        jsonText: string,
        enableAmbientOcclusion?: boolean,
    }

    export type Output = {
        voxelCount: number,
        dimensions: Vector3,
        desiredHeight: number,
        meta: TVoxelModelMeta,
    }
}

export namespace VoxelPostParams {
    export type Input = {
        rotation: Vector3,
    }

    export type Output = {
        voxelCount: number,
        dimensions: Vector3,
    }
}

export type TAtlasId = string;
export type TPaletteId = string;

export interface TDichromeToneConfig {
    mode: 'weights' | 'percentages';
    values: number[];
    percentages: number[];
}

export namespace AssignParams {
    export type Input = {
        textureAtlas: TAtlasId,
        blockPalette: string[],
        blockSelectionAlgorithm: TBlockSelectionAlgorithm,
        dichromeToneBias?: number | { x: number, y: number } | TDichromeToneConfig,
        dithering: TDithering,
        ditheringMagnitude: number,
        blockFilter: boolean,
        blockFilterThreshold: number,
        colourSpace: ColourSpace,
        fallable: FallableBehaviour,
        resolution: RGBAUtil.TColourAccuracy,
        calculateLighting: boolean,
        lightThreshold: number,
        lightingPlacement: TLightingPlacement,
        lightingScope: TLightingScope,
        lightingLightBlock: string,
        contextualAveraging: boolean,
        errorWeight: number,
        brightnessOffset?: number,
        saturationOffset?: number,
        contrastOffset?: number,
        temperatureOffset?: number,
        colourStyle?: TColourStyle,
        colourStyleStrength?: number,
        materialFilter?: TMaterialFilter,
        maxBlockTypes?: number,
    }

    export type Output = {

    }
}

export namespace RenderNextBlockMeshChunkParams {
    export type Input = {
        textureAtlas: TAtlasId,
    }

    export type Output = {
        buffer: TBlockMeshBufferDescription,
        bounds: Bounds,
        atlasTexturePath: string,
        atlasSize: number,
        moreBlocksToBuffer: boolean,
        isFirstChunk: boolean,
    }
}

/*
export namespace RenderBlockMeshParams {
    export type Input = {
        textureAtlas: TAtlasId,
    }

    export type Output = {
        buffer: TBlockMeshBufferDescription,
        dimensions: Vector3,
        atlasTexturePath: string,
        atlasSize: number,
    }
}
*/

export type TBlockSummaryItem = {
    name: string;
    count: number;
    hexColour: string;
    percentage: number;
};

export namespace PreviewParams {
    export type Input = {
    }

    export type Output = {
        total: number;
        unique: number;
        blocks: TBlockSummaryItem[];
    }
}

export namespace ExportParams {
    export type Input = {
        exporter: TExporters,
        litematicOptions?: LitematicExportOptions,
    }

    export type Output = {
        files: TStructureExport
    }
}

export namespace ExportGlbParams {
    export type Input = {
        modelName?: string,
        groundAndCenter?: boolean,
        preserveCurrentGeometry?: boolean,
        forceRecomputeNormals?: boolean,
        removeSmallIslands?: boolean,
        minIslandTriangles?: number,
    }

    export type Output = {
        glbBytes: Uint8Array,
        stats: MeshRepairStats,
    }
}

export type TReplaceScope = 'all' | 'layer' | 'surface' | 'hidden';
export type TReplaceMode = 'swap' | 'auto-palette' | 'undo';

export namespace ReplaceBlockParams {
    export type Input = {
        sourceBlock: string,
        sourceBlocks?: string[],
        targetBlock: string,
        scope?: TReplaceScope,
        sliceY?: number,
        mode?: TReplaceMode,
        activePalette?: string[],
    }

    export type Output = {
        replacedCount: number,
        sourceName: string,
        targetName: string,
        canUndo?: boolean,
        undone?: boolean,
    }
}

export type TaskParams =
    | { type: 'Started', taskId: string }
    | { type: 'Progress', taskId: string, percentage: number }
    | { type: 'Finished', taskId: string }

export type TToWorkerMessage =
    | { action: 'Init', params: InitParams.Input }
    | { action: 'Settings', params: SettingsParams.Input }
    | { action: 'Import', params: ImportParams.Input }
    | { action: 'SetMaterials', params: SetMaterialsParams.Input }
    | { action: 'RenderMesh', params: RenderMeshParams.Input }
    | { action: 'ExportGlb', params: ExportGlbParams.Input }
    | { action: 'Voxelise', params: VoxeliseParams.Input }
    | { action: 'SaveVoxelModel', params: SaveVoxelModelParams.Input }
    | { action: 'LoadVoxelModel', params: LoadVoxelModelParams.Input }
    | { action: 'VoxelPost', params: VoxelPostParams.Input }
    //| { action: 'RenderVoxelMesh', params: RenderVoxelMeshParams.Input }
    | { action: 'RenderNextVoxelMeshChunk', params: RenderNextVoxelMeshChunkParams.Input }
    | { action: 'Assign', params: AssignParams.Input }
    //| { action: 'RenderBlockMesh', params: RenderBlockMeshParams.Input }
    | { action: 'RenderNextBlockMeshChunk', params: RenderNextBlockMeshChunkParams.Input }
    | { action: 'ReplaceBlock', params: ReplaceBlockParams.Input }
    | { action: 'Preview', params: PreviewParams.Input }
    | { action: 'Export', params: ExportParams.Input }

export type TFromWorkerMessage =
    | { action: 'KnownError', error: AppError }
    | { action: 'UnknownError', error: Error }
    | { action: 'Progress', payload: TaskParams }
    | ({ messages: TMessage[] } & (
        | { action: 'Init', result: InitParams.Output }
        | { action: 'Settings', result: SettingsParams.Output }
        | { action: 'Import', result: ImportParams.Output }
        | { action: 'SetMaterials', result: SetMaterialsParams.Output }
        | { action: 'RenderMesh', result: RenderMeshParams.Output }
        | { action: 'ExportGlb', result: ExportGlbParams.Output }
        | { action: 'Voxelise', result: VoxeliseParams.Output }
        | { action: 'SaveVoxelModel', result: SaveVoxelModelParams.Output }
        | { action: 'LoadVoxelModel', result: LoadVoxelModelParams.Output }
        | { action: 'VoxelPost', result: VoxelPostParams.Output }
        //| { action: 'RenderVoxelMesh', result: RenderVoxelMeshParams.Output }
        | { action: 'RenderNextVoxelMeshChunk', result: RenderNextVoxelMeshChunkParams.Output }
        | { action: 'Assign', result: AssignParams.Output }
        //| { action: 'RenderBlockMesh', result: RenderBlockMeshParams.Output }
        | { action: 'RenderNextBlockMeshChunk', result: RenderNextBlockMeshChunkParams.Output }
        | { action: 'ReplaceBlock', result: ReplaceBlockParams.Output }
        | { action: 'Preview', result: PreviewParams.Output }
        | { action: 'Export', result: ExportParams.Output }));

