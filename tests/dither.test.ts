import { RGBA_255 } from '../src/colour';
import { Ditherer } from '../src/dither';
import { Vector3 } from '../src/vector';

afterEach(() => {
    jest.restoreAllMocks();
});

test('random dithering clamps RGB channels and preserves alpha', () => {
    jest.spyOn(Math, 'random').mockReturnValue(0);

    const colour = {
        r: 10,
        g: 100,
        b: 250,
        a: 255,
    } as RGBA_255;

    Ditherer.ditherRandom(colour, 64);

    expect(colour).toEqual({
        r: 0,
        g: 68,
        b: 218,
        a: 255,
    });
});

test('ordered dithering clamps RGB channels and preserves alpha', () => {
    const colour = {
        r: 10,
        g: 100,
        b: 250,
        a: 255,
    } as RGBA_255;

    Ditherer.ditherOrdered(colour, { x: 0, y: 0, z: 0 } as Vector3, 64);

    expect(colour).toEqual({
        r: 0,
        g: 68,
        b: 218,
        a: 255,
    });
});
