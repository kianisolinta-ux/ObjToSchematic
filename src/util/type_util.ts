export type TBrand<K, T> = K & { __brand: T };

export type Vector3Hash = TBrand<number, 'Vector3Hash'>;

export type TDithering = 'off' | 'random' | 'ordered' | 'error-diffusion' | 'atkinson';

export type TLightingPlacement = 'ordered' | 'random';

export type TLightingScope = 'darkness' | 'all_surface';

export type TBlockSelectionAlgorithm =
    | 'nearest-color'
    | 'color-chart-match'
    | 'character-statue'
    | 'dichrome'
    | 'polychrome'
    | 'ciede2000'
    | 'spatial-coherent'
    | 'palette-quantized'
    | 'hue-preserve'
    | 'texture-smooth'
    | 'edge-contour';

export type TAxis = 'x' | 'y' | 'z';

export type TTexelExtension = 'repeat' | 'clamp';

export type TTexelInterpolation = 'nearest' | 'linear';

export type DeepPartial<T> = T extends object ? {
    [P in keyof T]?: DeepPartial<T[P]>;
} : T;
