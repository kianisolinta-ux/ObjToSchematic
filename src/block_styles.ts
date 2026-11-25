export type TMaterialFilter =
    | 'all'
    | 'smooth-only'
    | 'architectural'
    | 'no-translucent'
    | 'organic-nature';

const NOISY_OR_PATTERNED_PATTERN = /(?:_ore$|^minecraft:ancient_debris$|cobblestone|bricks?$|glazed_terracotta|leaves$|sponge$|coral|amethyst|prismarine|netherrack|crafting_table|furnace|smoker|blast_furnace|bookshelf|tnt$|melon|pumpkin|magma|obsidian|bedrock|gravel|_log$|_wood$|_stem$|hyphae$|moss|sculk|spawner|shulker_box|dispenser|dropper|observer|piston|repeater|comparator|rail|dripstone|basalt|diamond_block|emerald_block|gold_block|iron_block|lapis_block|redstone_block|coal_block|netherite_block|copper|exposed_|weathered_|oxidized_|waxed_|raw_.*_block|smithing_table|cartography_table|fletching_table|stonecutter|loom|lodestone|chiseled_|cracked_|pillar|polished_|barrel|target|note_block|jukebox|purpur|end_stone|glowstone|sea_lantern|redstone_lamp|command_block|beacon|respawn_anchor|gilded_blackstone|reinforced_deepslate|bamboo_mosaic|froglight|shroomlight)/i;

const TRANSLUCENT_OR_FRAGILE_PATTERN = /(?:_glass$|^minecraft:glass$|^minecraft:tinted_glass$|^minecraft:ice$|slime_block|honey_block|leaves$|vine$|cobweb|barrier)/i;

const ARCHITECTURAL_PATTERN = /(?:stone|brick|terracotta|concrete|quartz|wood|planks|_log$|copper|deepslate|sandstone|mud|basalt|blackstone|tuff|calcite|slate|pillar|smooth_|granite|andesite|diorite|prismarine|purpur|end_stone|glass$)/i;

const ORGANIC_NATURE_PATTERN = /(?:_log$|_wood$|planks|leaves$|moss|grass|dirt|podzol|mycelium|mud|clay|sand|terracotta|stone|granite|andesite|diorite|tuff|calcite|coral|mushroom|pumpkin|melon|hay_block|honeycomb|bamboo|packed_ice|snow|dripstone)/i;

const NEON_OR_SYNTHETIC_PATTERN = /(?:concrete|glazed_terracotta|wool$|iron_block|gold_block|diamond_block|emerald_block|netherite_block|redstone_block|lapis_block|quartz|purpur|prismarine|copper)/i;

/**
 * Filters a list of namespaced Minecraft block names by material finish style.
 * Always falls back safely to the original `blockNames` if filtering removes every block.
 */
export function filterBlockNamesByMaterialStyle(
    blockNames: readonly string[],
    filter: TMaterialFilter,
): string[] {
    if (filter === 'all' || blockNames.length === 0) {
        return blockNames.slice();
    }

    let filtered: string[];
    switch (filter) {
        case 'smooth-only':
            filtered = blockNames.filter((name) => !NOISY_OR_PATTERNED_PATTERN.test(name));
            break;
        case 'architectural':
            filtered = blockNames.filter(
                (name) => ARCHITECTURAL_PATTERN.test(name) && !/_ore$|shulker_box|tnt$/i.test(name),
            );
            break;
        case 'no-translucent':
            filtered = blockNames.filter((name) => !TRANSLUCENT_OR_FRAGILE_PATTERN.test(name));
            break;
        case 'organic-nature':
            filtered = blockNames.filter(
                (name) => ORGANIC_NATURE_PATTERN.test(name) && !NEON_OR_SYNTHETIC_PATTERN.test(name),
            );
            break;
        default:
            filtered = blockNames.slice();
            break;
    }

    return filtered.length > 0 ? filtered : blockNames.slice();
}
