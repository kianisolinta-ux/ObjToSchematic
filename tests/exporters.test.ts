import { BlockMesh } from '../src/block_mesh';
import { Bounds } from '../src/bounds';
import { IndexedJSONExporter } from '../src/exporters/indexed_json_exporter';
import { Litematic } from '../src/exporters/litematic_exporter';
import { NBTExporter } from '../src/exporters/nbt_exporter';
import { SchemExporter } from '../src/exporters/schem_exporter';
import { Vector3 } from '../src/vector';
import { TEST_PREAMBLE } from './preamble';

TEST_PREAMBLE();

test('Litematic and Schem export cleanly even with emissive or dynamically added blocks', () => {
    const blockMesh = Object.create(BlockMesh.prototype) as any;
    blockMesh._blocks = new Map();
    blockMesh._blocksUsed = new Set();
    blockMesh._voxelMesh = {
        getBounds: () => new Bounds(new Vector3(0, 0, 0), new Vector3(2, 2, 2)),
    };

    const stone = {
        name: 'minecraft:stone',
        colour: { r: 0.5, g: 0.5, b: 0.5, a: 1 },
        faces: {} as any,
    };
    const glowstone = {
        name: 'minecraft:glowstone',
        colour: { r: 0.9, g: 0.8, b: 0.4, a: 1 },
        faces: {} as any,
    };

    // Add blocks
    blockMesh._blocks.set(new Vector3(0, 0, 0).hash(), {
        voxel: { position: new Vector3(0, 0, 0), colour: stone.colour },
        blockInfo: stone,
    });
    // Glowstone was added via lighting (simulating unmapped emissive block)
    blockMesh._blocks.set(new Vector3(1, 1, 1).hash(), {
        voxel: { position: new Vector3(1, 1, 1), colour: glowstone.colour },
        blockInfo: glowstone,
    });

    const litematicExporter = new Litematic();
    const litematicResult = litematicExporter.export(blockMesh);
    expect(litematicResult.type).toBe('single');
    if (litematicResult.type === 'single') {
        expect(litematicResult.content).toBeDefined();
    }

    const schemExporter = new SchemExporter();
    const schemResult = schemExporter.export(blockMesh);
    expect(schemResult.type).toBe('single');
    if (schemResult.type === 'single') {
        expect(schemResult.content).toBeDefined();
    }

    const nbtExporter = new NBTExporter();
    const nbtResult = nbtExporter.export(blockMesh);
    expect(nbtResult.type).toBe('multiple');
    if (nbtResult.type === 'multiple') {
        expect(nbtResult.regions.length).toBeGreaterThan(0);
    }

    const indexedJSONExporter = new IndexedJSONExporter();
    const jsonResult = indexedJSONExporter.export(blockMesh);
    expect(jsonResult.type).toBe('single');
    if (jsonResult.type === 'single') {
        const parsed = JSON.parse(jsonResult.content.toString());
        expect(parsed.xyzi.length).toBe(2);
        expect(parsed.blocks['0']).toBeDefined();
        expect(parsed.blocks['1']).toBeDefined();
    }
});
