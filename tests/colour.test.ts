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

test('Perceptual colour distance for realistic green blocks yields low error, while severe mismatch yields high error', () => {
    const greenVoxel: RGBA = { r: 0.1, g: 0.8, b: 0.2, a: 1 };
    const emeraldBlock: RGBA = { r: 0.166, g: 0.798, b: 0.344, a: 1 };
    const limeConcrete: RGBA = { r: 0.369, g: 0.662, b: 0.096, a: 1 };
    const blackstone: RGBA = { r: 0.18, g: 0.16, b: 0.17, a: 1 };

    const emeraldDeltaE = RGBAUtil.perceptualDistance(greenVoxel, emeraldBlock);
    const limeDeltaE = RGBAUtil.perceptualDistance(greenVoxel, limeConcrete);
    const blackstoneDeltaE = RGBAUtil.perceptualDistance(greenVoxel, blackstone);

    // Realistic matches should be under Delta E 30 and normalized under 0.45 (green to lime-yellow range)
    expect(emeraldDeltaE).toBeLessThan(20);
    expect(limeDeltaE).toBeLessThan(30);
    expect(emeraldDeltaE / 65.0).toBeLessThan(0.35); // in healthy green ramp
    expect(limeDeltaE / 65.0).toBeLessThan(0.45); // in green/lime ramp, NOT bright red

    // Severe mismatch must be well above Delta E 60, saturating to red
    expect(blackstoneDeltaE).toBeGreaterThan(60);
    expect(blackstoneDeltaE / 65.0).toBeGreaterThan(0.9);
});

