import { RGBA, RGBAUtil } from '../src/colour';

test('Perceptual colour distance is zero for identical colours', () => {
    const colour: RGBA = { r: 0.1, g: 0.8, b: 0.2, a: 1 };
    expect(RGBAUtil.perceptualDistance(colour, colour)).toBeCloseTo(0);
});

test('Perceptual colour distance detects strong colour mismatch', () => {
    const green: RGBA = { r: 0.1, g: 0.8, b: 0.2, a: 1 };
    const blackstoneLike: RGBA = { r: 0.18, g: 0.16, b: 0.17, a: 1 };
    const distance = RGBAUtil.perceptualDistance(green, blackstoneLike);

    expect(distance).toBeGreaterThan(30);
    expect(distance).toBeCloseTo(RGBAUtil.perceptualDistance(blackstoneLike, green));
});
