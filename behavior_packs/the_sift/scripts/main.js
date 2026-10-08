import { BlockPermutation, BlockVolume, system, world } from "@minecraft/server";
const SIFT_DIMENSION_ID = "thesift:sift";
const ACTIVATION_ITEM = "minecraft:echo_shard";
const PORTAL_CORE = "minecraft:reinforced_deepslate";
const PORTAL_SURFACE = "thesift:rift_mist";
const PORTAL_CENTER = { x: 0, y: 64, z: 0 };
const RETURN_PORTAL_CENTER = { x: 0, y: 68, z: 5 };
const TERRAIN_GENERATED_PROPERTY = "thesift:terrain_v1_generated";
const SLATE_PATCH_GENERATED_PROPERTY = "thesift:slate_patch_v1_generated";
const SLATE_GRASS_PATCH_GENERATED_PROPERTY = "thesift:slate_grass_patch_v1_generated";
const SLATE_GREEN_GRASS_PATCH_GENERATED_PROPERTY = "thesift:slate_green_grass_patch_v1_generated";
const SINGERS_MEADOW_GENERATED_PROPERTY = "thesift:singers_meadow_v1_generated";
const SINGERS_MEADOW_RADIUS = 128;
const SCULK_WILDS_GENERATED_PROPERTY = "thesift:sculk_wilds_v1_generated";
const HILLY_MEADOWS_GENERATED_PROPERTY = "thesift:hilly_meadows_v4_generated";
// Scrub flag: one-time replacement of old bedrock / bare-slate bands left by
// v1-v3 Hilly terrain in existing worlds. Runs even when v4 terrain exists.
const HILLY_SCRUB_GENERATED_PROPERTY = "thesift:hilly_scrub_v1_done";
// Huge standalone biome WEST of Singer's Meadow. Singer's circle is x in [-128,128],
// Sculk Wilds rect is x in [0,384] z in [-128,160]. West center -520 keeps the
// ellipse x in [-840,-200] fully clear of both. No bedrock, no vanilla stone:
// only sift dirt/grass, sift slate + red/green slate grass, rose soil/grass.
const HILLY_MEADOWS_CENTER_X = -520;
const HILLY_MEADOWS_CENTER_Z = -40;
const HILLY_MEADOWS_RADIUS_X = 320;
const HILLY_MEADOWS_RADIUS_Z = 260;
const SINGERS_MEADOW_GROUND_FLORA = [
    "thesift:sift_mint_sprig",
    "thesift:sift_fan_grass",
    "thesift:sift_upright_grass",
    "thesift:sift_tall_grass",
    "thesift:sift_low_shrub",
    "thesift:sift_broad_shrub",
    "thesift:sift_stem_plant",
    "thesift:sift_bloom_stalk",
    "thesift:sift_ground_rosette",
    "thesift:sift_spreading_rosette",
    "thesift:sift_leaf_sprout",
    "thesift:sift_leaf_bush",
    "thesift:sift_leaf_cluster",
    "thesift:sift_cyan_flower",
    "thesift:sift_bloom",
    "thesift:sift_crimson_flower",
    "thesift:sift_small_flower",
    "thesift:sift_red_grass",
    "thesift:coral_grass",
    "thesift:rift_weed",
];
const HILLY_FLOWERS = [
    "thesift:sift_cyan_flower",
    "thesift:sift_bloom",
    "thesift:sift_crimson_flower",
    "thesift:sift_small_flower",
];
const returnLocations = new Map();
const activeEntrances = new Set();
let siftHomePromise;
system.beforeEvents.startup.subscribe((event) => {
    event.dimensionRegistry.registerCustomDimension(SIFT_DIMENSION_ID);
    event.blockComponentRegistry.registerCustomComponent("sift:rotatable_axis", {
        beforeOnPlayerPlace(placeEvent) {
            // Use the face actually clicked: facing_direction describes the player's
            // look direction, which made horizontal logs choose the wrong axis.
            const axis = placeEvent.face === "East" || placeEvent.face === "West"
                ? "x"
                : placeEvent.face === "North" || placeEvent.face === "South"
                    ? "z"
                    : "y";
            placeEvent.permutationToPlace = BlockPermutation.resolve(placeEvent.permutationToPlace.type.id, {
                ...placeEvent.permutationToPlace.getAllStates(),
                "sift:axis": axis,
            });
        },
    });
    event.blockComponentRegistry.registerCustomComponent("sift:willow_slab", {
        onPlace({ block }) {
            const half = block.permutation.getState("minecraft:vertical_half");
            if (half !== "top" && half !== "bottom") {
                return;
            }
            block.setPermutation(BlockPermutation.resolve(block.typeId, {
                ...block.permutation.getAllStates(),
                "sift:slab_type": half,
            }));
        },
        beforeOnPlayerPlace(placeEvent) {
            if (placeEvent.block.typeId !== "thesift:willow_slab"
                || placeEvent.permutationToPlace.type.id !== "thesift:willow_slab") {
                return;
            }
            const existingHalf = placeEvent.block.permutation.getAllStates()["sift:slab_type"];
            const incomingHalf = placeEvent.permutationToPlace.getState("minecraft:vertical_half");
            if ((existingHalf === "top" || existingHalf === "bottom")
                && (incomingHalf === "top" || incomingHalf === "bottom")
                && existingHalf !== incomingHalf) {
                placeEvent.permutationToPlace = BlockPermutation.resolve("thesift:willow_slab", {
                    ...placeEvent.block.permutation.getAllStates(),
                    "sift:slab_type": "double",
                });
            }
        },
    });
});
world.afterEvents.worldLoad.subscribe(() => {
    void ensureSiftHome().catch((error) => {
        console.warn(`Could not prepare the Sift arrival platform: ${String(error)}`);
    });
});
world.beforeEvents.playerInteractWithBlock.subscribe((event) => {
    if (!event.isFirstEvent || event.itemStack?.typeId !== ACTIVATION_ITEM) {
        return;
    }
    const { player, block } = event;
    if (block.typeId !== PORTAL_CORE && block.typeId !== PORTAL_SURFACE) {
        const clickedType = block.typeId;
        system.run(() => {
            player.sendMessage(`§eSift: Echo Shard interaction detected on ${clickedType}; target reinforced deepslate.`);
        });
        return;
    }
    event.cancel = true;
    const location = { ...block.location };
    const face = event.blockFace;
    const blockTypeId = block.typeId;
    system.run(() => {
        player.sendMessage(`§bSift: Echo Shard detected on ${blockTypeId} in ${player.dimension.id}; checking gateway conditions.`);
        try {
            handleGatewayInteraction(player, location, face, blockTypeId);
        }
        catch (error) {
            player.sendMessage(`§cSift: gateway activation failed: ${String(error)}`);
        }
    });
});
function handleGatewayInteraction(player, location, face, blockTypeId) {
    if (player.dimension.id === SIFT_DIMENSION_ID) {
        if (blockTypeId !== PORTAL_SURFACE) {
            return;
        }
        returnToOverworld(player);
        return;
    }
    if (player.dimension.id !== "minecraft:overworld" || blockTypeId !== PORTAL_CORE) {
        player.sendMessage(`§eSift: entrance activation requires the Overworld reinforced-deepslate core (current dimension: ${player.dimension.id}).`);
        return;
    }
    const nearbySculk = countDeepDarkSculk(location);
    if (nearbySculk < 8) {
        player.sendMessage(`§7The gateway is dormant: found ${nearbySculk}/8 nearby sculk blocks or devices.`);
        return;
    }
    player.sendMessage(`§bSift: found ${nearbySculk}+ sculk blocks/devices; filling the portal frame.`);
    const entranceKey = `${location.x},${location.y},${location.z}`;
    if (!activeEntrances.has(entranceKey)) {
        openAncientCityGateway(location, face);
        activeEntrances.add(entranceKey);
    }
    returnLocations.set(player.id, { ...player.location });
    player.playSound("portal.travel");
    player.sendMessage("§bThe gateway is active. Preparing the Sift and teleporting you.");
    void enterSift(player);
}
function countDeepDarkSculk(center) {
    const overworld = world.getDimension("overworld");
    const offsets = [0, 1, -1, 2, -2, 3, -3, 4, -4];
    let sculkCount = 0;
    for (const xOffset of offsets) {
        for (let yOffset = -2; yOffset <= 2; yOffset += 1) {
            for (const zOffset of offsets) {
                const block = overworld.getBlock({
                    x: center.x + xOffset,
                    y: center.y + yOffset,
                    z: center.z + zOffset,
                });
                if (block &&
                    (block.typeId === "minecraft:sculk" ||
                        block.typeId === "minecraft:sculk_sensor" ||
                        block.typeId === "minecraft:sculk_catalyst" ||
                        block.typeId === "minecraft:sculk_shrieker")) {
                    sculkCount += 1;
                    if (sculkCount >= 8) {
                        return sculkCount;
                    }
                }
            }
        }
    }
    return sculkCount;
}
function openAncientCityGateway(core, face) {
    const overworld = world.getDimension("overworld");
    const alongX = face === "North" || face === "South";
    const frameBounds = findPortalFrameBounds(overworld, core, alongX);
    if (frameBounds) {
        for (let y = frameBounds.minY + 1; y < frameBounds.maxY; y += 1) {
            for (let width = frameBounds.minWidth + 1; width < frameBounds.maxWidth; width += 1) {
                const location = alongX
                    ? { x: width, y, z: core.z }
                    : { x: core.x, y, z: width };
                overworld.getBlock(location)?.setType(PORTAL_SURFACE);
            }
        }
        return;
    }
    const normal = face === "North" ? 1 : face === "South" ? -1 : face === "West" ? -1 : 1;
    const plane = alongX
        ? { x: core.x, z: core.z + normal }
        : { x: core.x + normal, z: core.z };
    // Use a broad fallback gate when activating a single reinforced deepslate core.
    for (let y = -3; y <= 3; y += 1) {
        for (let width = -7; width <= 7; width += 1) {
            const location = alongX
                ? { x: plane.x + width, y: core.y + y, z: plane.z }
                : { x: plane.x, y: core.y + y, z: plane.z + width };
            const block = overworld.getBlock(location);
            if (!block) {
                continue;
            }
            const border = Math.abs(width) === 7 || Math.abs(y) === 3;
            if (border) {
                if (block.typeId === "minecraft:air") {
                    block.setType("minecraft:polished_deepslate");
                }
            }
            else if (block.typeId !== PORTAL_CORE) {
                block.setType(PORTAL_SURFACE);
            }
        }
    }
    // Cyan-lit uprights echo the broad, framed portal in the reference image.
    for (const side of [-8, 8]) {
        for (let y = -2; y <= 2; y += 1) {
            const location = alongX
                ? { x: plane.x + side, y: core.y + y, z: plane.z }
                : { x: plane.x, y: core.y + y, z: plane.z + side };
            const block = overworld.getBlock(location);
            if (block?.typeId === "minecraft:air") {
                block.setType(y === 0 ? "minecraft:sea_lantern" : "minecraft:deepslate_bricks");
            }
        }
    }
}
function findPortalFrameBounds(dimension, clicked, alongX) {
    const widthOf = (location) => (alongX ? location.x : location.z);
    const at = (width, y) => alongX ? { x: width, y, z: clicked.z } : { x: clicked.x, y, z: width };
    const keyOf = (width, y) => `${width},${y}`;
    const pending = [{ width: widthOf(clicked), y: clicked.y }];
    const visited = new Set();
    let minWidth = Number.POSITIVE_INFINITY;
    let maxWidth = Number.NEGATIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    while (pending.length > 0) {
        const current = pending.pop();
        if (!current) {
            continue;
        }
        const key = keyOf(current.width, current.y);
        if (visited.has(key)) {
            continue;
        }
        visited.add(key);
        if (Math.abs(current.width - widthOf(clicked)) > 20 ||
            Math.abs(current.y - clicked.y) > 12 ||
            dimension.getBlock(at(current.width, current.y))?.typeId !== PORTAL_CORE) {
            continue;
        }
        minWidth = Math.min(minWidth, current.width);
        maxWidth = Math.max(maxWidth, current.width);
        minY = Math.min(minY, current.y);
        maxY = Math.max(maxY, current.y);
        pending.push({ width: current.width - 1, y: current.y }, { width: current.width + 1, y: current.y }, { width: current.width, y: current.y - 1 }, { width: current.width, y: current.y + 1 });
    }
    const frameWidth = maxWidth - minWidth + 1;
    const frameHeight = maxY - minY + 1;
    if (frameWidth < 5 || frameHeight < 4 || frameWidth > 41 || frameHeight > 25) {
        return undefined;
    }
    for (let width = minWidth; width <= maxWidth; width += 1) {
        if (dimension.getBlock(at(width, minY))?.typeId !== PORTAL_CORE ||
            dimension.getBlock(at(width, maxY))?.typeId !== PORTAL_CORE) {
            return undefined;
        }
    }
    for (let y = minY + 1; y < maxY; y += 1) {
        if (dimension.getBlock(at(minWidth, y))?.typeId !== PORTAL_CORE ||
            dimension.getBlock(at(maxWidth, y))?.typeId !== PORTAL_CORE) {
            return undefined;
        }
    }
    return { minWidth, maxWidth, minY, maxY };
}
function ensureSiftHome() {
    if (!siftHomePromise) {
        siftHomePromise = prepareSiftHome().catch((error) => {
            siftHomePromise = undefined;
            throw error;
        });
    }
    return siftHomePromise;
}
async function prepareSiftHome() {
    const dimension = world.getDimension(SIFT_DIMENSION_ID);
    const areaId = "thesift:terrain_generation";
    try {
        await world.tickingAreaManager.createTickingArea(areaId, {
            dimension,
            from: { x: -50, y: 52, z: -50 },
            to: { x: 50, y: 105, z: 50 },
        });
        // Retain the simple spawn platform and return gate on subsequent world loads.
        for (let x = -8; x <= 8; x += 1) {
            for (let z = -3; z <= 12; z += 1) {
                dimension.getBlock({ x, y: 63, z })?.setType("minecraft:deepslate_bricks");
            }
        }
        buildSiftGateway(dimension);
        if (world.getDynamicProperty(TERRAIN_GENERATED_PROPERTY) !== true) {
            await generateSiftTerrain(dimension);
            world.setDynamicProperty(TERRAIN_GENERATED_PROPERTY, true);
        }
        if (world.getDynamicProperty(SLATE_PATCH_GENERATED_PROPERTY) !== true) {
            await generateSiftSlatePatch(dimension);
            world.setDynamicProperty(SLATE_PATCH_GENERATED_PROPERTY, true);
        }
        if (world.getDynamicProperty(SLATE_GRASS_PATCH_GENERATED_PROPERTY) !== true) {
            await generateSiftSlateGrassPatch(dimension);
            world.setDynamicProperty(SLATE_GRASS_PATCH_GENERATED_PROPERTY, true);
        }
        if (world.getDynamicProperty(SLATE_GREEN_GRASS_PATCH_GENERATED_PROPERTY) !== true) {
            await generateSiftSlateGreenGrassPatch(dimension);
            world.setDynamicProperty(SLATE_GREEN_GRASS_PATCH_GENERATED_PROPERTY, true);
        }
        if (world.getDynamicProperty(SINGERS_MEADOW_GENERATED_PROPERTY) !== true) {
            await generateSingersMeadow(dimension);
            world.setDynamicProperty(SINGERS_MEADOW_GENERATED_PROPERTY, true);
        }
        if (world.getDynamicProperty(SCULK_WILDS_GENERATED_PROPERTY) !== true) {
            await generateSculkWilds(dimension);
            world.setDynamicProperty(SCULK_WILDS_GENERATED_PROPERTY, true);
        }
        // Repair: v1 Hilly (center 420) overlapped Sculk and stamped red hills +
        // bedrock onto sculk in existing worlds. Rebuild those columns as sculk.
        await repairOldHillyOverlap(dimension);
        if (world.getDynamicProperty(HILLY_SCRUB_GENERATED_PROPERTY) !== true) {
            await scrubHillyBedrockBands(dimension);
            world.setDynamicProperty(HILLY_SCRUB_GENERATED_PROPERTY, true);
        }
        if (world.getDynamicProperty(HILLY_MEADOWS_GENERATED_PROPERTY) !== true) {
            await generateHillyMeadows(dimension);
            world.setDynamicProperty(HILLY_MEADOWS_GENERATED_PROPERTY, true);
        }
    }
    finally {
        try {
            world.tickingAreaManager.removeTickingArea(areaId);
        }
        catch {
            // The area may not have been created if the custom dimension failed to load.
        }
    }
}
/** Adds a compact red-slate grassland to the existing island without replacing its other terrain. */
function generateSiftSlatePatch(dimension) {
    return new Promise((resolve, reject) => {
        system.runJob((function* () {
            try {
                const centerX = 25;
                const centerZ = 28;
                const radius = 7;
                let completed = 0;
                for (let xOffset = -radius; xOffset <= radius; xOffset += 1) {
                    for (let zOffset = -radius; zOffset <= radius; zOffset += 1) {
                        if (xOffset * xOffset + zOffset * zOffset > radius * radius) {
                            continue;
                        }
                        const x = centerX + xOffset;
                        const z = centerZ + zOffset;
                        const surfaceY = getSiftSurfaceHeight(x, z);
                        dimension.fillBlocks(new BlockVolume({ x, y: surfaceY - 2, z }, { x, y: surfaceY, z }), "thesift:sift_slate");
                        if (stableHash(x + 91, z - 53) % 6 === 0) {
                            dimension.getBlock({ x, y: surfaceY + 1, z })?.setType("thesift:sift_red_grass");
                        }
                        completed += 1;
                        if (completed % 8 === 0) {
                            yield;
                        }
                    }
                }
                resolve();
            }
            catch (error) {
                reject(error);
            }
        })());
    });
}
/** Adds a small cap-grass patch over the center of the generated Sift Slate field. */
function generateSiftSlateGrassPatch(dimension) {
    return new Promise((resolve, reject) => {
        system.runJob((function* () {
            try {
                const centerX = 25;
                const centerZ = 28;
                let completed = 0;
                for (let xOffset = -4; xOffset <= 4; xOffset += 1) {
                    for (let zOffset = -4; zOffset <= 4; zOffset += 1) {
                        if (xOffset * xOffset + zOffset * zOffset > 16) {
                            continue;
                        }
                        const x = centerX + xOffset;
                        const z = centerZ + zOffset;
                        const surfaceY = getSiftSurfaceHeight(x, z);
                        dimension.getBlock({ x, y: surfaceY, z })?.setType("thesift:sift_slate_grass_block");
                        completed += 1;
                        if (completed % 8 === 0) {
                            yield;
                        }
                    }
                }
                resolve();
            }
            catch (error) {
                reject(error);
            }
        })());
    });
}
/** Adds a small green-grass variant patch beside the existing red Sift Slate grass patch. */
function generateSiftSlateGreenGrassPatch(dimension) {
    return new Promise((resolve, reject) => {
        system.runJob((function* () {
            try {
                const centerX = 30;
                const centerZ = 28;
                const radius = 2;
                let completed = 0;
                for (let xOffset = -radius; xOffset <= radius; xOffset += 1) {
                    for (let zOffset = -radius; zOffset <= radius; zOffset += 1) {
                        if (xOffset * xOffset + zOffset * zOffset > radius * radius) {
                            continue;
                        }
                        const x = centerX + xOffset;
                        const z = centerZ + zOffset;
                        const surfaceY = getSiftSurfaceHeight(x, z);
                        dimension.getBlock({ x, y: surfaceY, z })?.setType("thesift:sift_slate_green_grass_block");
                        completed += 1;
                        if (completed % 8 === 0) {
                            yield;
                        }
                    }
                }
                resolve();
            }
            catch (error) {
                reject(error);
            }
        })());
    });
}
/** Expands the Sift into a broad, rolling Singer's Meadow with four dense willow-grove pockets. */
async function generateSingersMeadow(dimension) {
    const tileStarts = [-128, -32, 64];
    let tileNumber = 0;
    // A sequence of overlapping-safe ticking areas keeps outer chunks loaded while the
    // script builds this 257-block-wide biome; only one additional area is active at a time.
    for (const xStart of tileStarts) {
        for (const zStart of tileStarts) {
            const areaId = `thesift:singers_meadow_tile_${tileNumber}`;
            tileNumber += 1;
            await world.tickingAreaManager.createTickingArea(areaId, {
                dimension,
                from: { x: xStart, y: 52, z: zStart },
                to: { x: xStart + 95, y: 108, z: zStart + 95 },
            });
            try {
                await generateSingersMeadowTile(dimension, xStart, xStart + 95, zStart, zStart + 95);
            }
            finally {
                world.tickingAreaManager.removeTickingArea(areaId);
            }
        }
    }
    // These existing Sift landmarks are rebuilt above the new meadow surface.
    await runSiftLandmarkJob(dimension);
    const groves = [
        { x: -78, z: -38, radius: 23, seed: 13 },
        { x: 75, z: -43, radius: 24, seed: 29 },
        { x: -77, z: 61, radius: 22, seed: 47 },
        { x: 43, z: 88, radius: 23, seed: 71 },
    ];
    for (let groveIndex = 0; groveIndex < groves.length; groveIndex += 1) {
        const grove = groves[groveIndex];
        if (!grove) {
            continue;
        }
        const areaId = `thesift:singers_willow_grove_${groveIndex}`;
        await world.tickingAreaManager.createTickingArea(areaId, {
            dimension,
            from: { x: grove.x - 32, y: 52, z: grove.z - 32 },
            to: { x: grove.x + 32, y: 108, z: grove.z + 32 },
        });
        try {
            await generateWillowGrove(dimension, grove.x, grove.z, grove.radius, grove.seed);
        }
        finally {
            world.tickingAreaManager.removeTickingArea(areaId);
        }
    }
}
function generateSingersMeadowTile(dimension, minX, maxX, minZ, maxZ) {
    return new Promise((resolve, reject) => {
        system.runJob((function* () {
            try {
                let completed = 0;
                const baseY = 54;
                for (let x = minX; x <= maxX; x += 1) {
                    for (let z = minZ; z <= maxZ; z += 1) {
                        if (x * x + z * z > SINGERS_MEADOW_RADIUS * SINGERS_MEADOW_RADIUS) {
                            continue;
                        }
                        // Leave the spawn court and return portal clear.
                        if (Math.abs(x) <= 9 && z >= -4 && z <= 13) {
                            continue;
                        }
                        const surfaceY = getSingersMeadowSurfaceHeight(x, z);
                        const biomeNoise = valueNoise(x + 947, z - 613, 31);
                        const substrate = biomeNoise < -0.24
                            ? "thesift:sift_slate"
                            : biomeNoise > 0.25
                                ? "thesift:rose_soil"
                                : "thesift:sift_dirt";
                        dimension.fillBlocks(new BlockVolume({ x, y: baseY, z }, { x, y: surfaceY - 1, z }), substrate);
                        const grassPatch = valueNoise(x - 257, z + 419, 12) > -0.45;
                        let surfaceBlock = substrate;
                        if (grassPatch) {
                            if (substrate === "thesift:sift_slate") {
                                surfaceBlock = valueNoise(x + 739, z - 353, 17) > 0.42
                                    ? "thesift:sift_slate_green_grass_block"
                                    : "thesift:sift_slate_grass_block";
                            }
                            else if (substrate === "thesift:rose_soil") {
                                surfaceBlock = "thesift:rose_grass_block";
                            }
                            else {
                                surfaceBlock = "thesift:sift_grass";
                            }
                        }
                        dimension.getBlock({ x, y: surfaceY, z })?.setType(surfaceBlock);
                        const lushness = (valueNoise(x + 121, z - 287, 10) + 1) / 2;
                        const plantChance = 30 + Math.floor(lushness * 43);
                        if (grassPatch && stableHash(x + 317, z - 821) % 100 < plantChance) {
                            const floraIndex = stableHash(x - 109, z + 557) % SINGERS_MEADOW_GROUND_FLORA.length;
                            const plantType = SINGERS_MEADOW_GROUND_FLORA[floraIndex];
                            if (plantType) {
                                dimension.getBlock({ x, y: surfaceY + 1, z })?.setType(plantType);
                            }
                        }
                        completed += 1;
                        if (completed % 24 === 0) {
                            yield;
                        }
                    }
                }
                resolve();
            }
            catch (error) {
                reject(error);
            }
        })());
    });
}
/** True when a column falls inside the OLD (broken v1) Hilly ellipse that overlapped Sculk. */
function isOldHillyMeadowsPosition(x, z) {
    const dx = (x - 420) / 260;
    const dz = (z - -40) / 220;
    return dx * dx + dz * dz <= 1;
}
/** True when a column falls inside the huge Hilly Meadows ellipse west of Singer's Meadow. */
function isHillyMeadowsPosition(x, z) {
    const dx = (x - HILLY_MEADOWS_CENTER_X) / HILLY_MEADOWS_RADIUS_X;
    const dz = (z - HILLY_MEADOWS_CENTER_Z) / HILLY_MEADOWS_RADIUS_Z;
    return dx * dx + dz * dz <= 1;
}
/** Rebuilds the v1-Hilly x Sculk overlap strip back to pure sculk. */
function repairOldHillyOverlap(dimension) {
    return new Promise((resolve, reject) => {
        system.runJob((function* () {
            try {
                for (let x = 160; x <= 384; x += 1) {
                    for (let z = -128; z <= 160; z += 1) {
                        if (!isOldHillyMeadowsPosition(x, z))
                            continue;
                        dimension.fillBlocks(new BlockVolume({ x, y: 40, z }, { x, y: 130, z }), "minecraft:air");
                        const wd = x + 1;
                        if (wd < 1 || wd > 384)
                            continue;
                        const surfaceY = getSculkWildsSurfaceHeight(x, z, wd, 384);
                        const colorNoise = valueNoise(x + 1207, z - 349, 39) + valueNoise(x - 331, z + 881, 19) * 0.26;
                        const green = colorNoise > 0.03;
                        const sculk = green ? "thesift:healthy_sculk_green" : "thesift:healthy_sculk_pink";
                        dimension.fillBlocks(new BlockVolume({ x, y: 54, z }, { x, y: surfaceY - 1, z }), sculk);
                        const grassPatch = valueNoise(x + 617, z + 271, 17) > -0.22;
                        const topBlock = green ? (grassPatch ? "thesift:sift_sculk_grass_green_block" : "thesift:healthy_sculk_green") : (grassPatch ? "thesift:sift_sculk_grass_pink_block" : "thesift:healthy_sculk_pink");
                        dimension.getBlock({ x, y: surfaceY, z })?.setType(topBlock);
                        if (grassPatch && surfaceY < 96 && isSiftWeedPosition(x, z)) {
                            dimension.getBlock({ x, y: surfaceY + 1, z })?.setType(green ? "thesift:sift_short_sculk_grass_green" : "thesift:sift_short_sculk_grass_pink");
                        }
                        if (x % 32 === 0 && z === -128)
                            yield;
                    }
                }
                resolve();
            }
            catch (error) {
                reject(error);
            }
        })());
    });
}
/** Very hilly surface: rolling mega-hills stacked on broad swells, eased at the rim. */
function getHillyMeadowsSurfaceHeight(x, z) {
    const broad = valueNoise(x, z, 31);
    const hills = valueNoise(x + 911, z - 537, 11);
    const ridge = valueNoise(x - 271, z + 613, 23);
    const detail = valueNoise(x + 173, z + 419, 47);
    // 56..~128: broad swells (+/-16) plus very huge hills (+0..44) with detail. Very hilly.
    let height = 76 + broad * 16 + hills * hills * 44 + (ridge - 0.5) * 10 + (detail - 0.5) * 10;
    const dx = (x - HILLY_MEADOWS_CENTER_X) / HILLY_MEADOWS_RADIUS_X;
    const dz = (z - HILLY_MEADOWS_CENTER_Z) / HILLY_MEADOWS_RADIUS_Z;
    const edge = Math.max(0, Math.min(1, 1 - Math.sqrt(dx * dx + dz * dz)));
    // Blend rim back toward meadow level so the biome edge never cliffs into void.
    const rimBlend = smoothStep(Math.max(0, Math.min(1, edge / 0.12)));
    height = 66 + (height - 66) * rimBlend;
    return Math.max(58, Math.min(118, Math.round(height)));
}
function getSingersMeadowSurfaceHeight(x, z) {
    const distance = Math.sqrt(x * x + z * z);
    if (distance <= 48) {
        return getSiftSurfaceHeight(x, z);
    }
    const broad = valueNoise(x + 167, z - 233, 27);
    const detail = valueNoise(x - 419, z + 631, 11);
    const fine = valueNoise(x + 877, z + 59, 5);
    const hillHeight = 69 + broad * 11 + detail * 4 + fine * 1.5;
    const rise = smoothStep(Math.max(0, Math.min(1, (distance - 48) / 27)));
    const outerSlope = Math.max(0, Math.min(1, (SINGERS_MEADOW_RADIUS - distance) / 19));
    const risingTerrain = lerp(56, hillHeight, rise);
    return Math.round(56 + (risingTerrain - 56) * outerSlope);
}
/** Builds a rolling, connected second biome east of the circular Singer's Meadow. */
async function generateSculkWilds(dimension) {
    const xStarts = [0, 96, 192, 288];
    const zStarts = [-128, -32, 64];
    let tileNumber = 0;
    for (const xStart of xStarts) {
        for (const zStart of zStarts) {
            const areaId = `thesift:sculk_wilds_tile_${tileNumber}`;
            tileNumber += 1;
            await world.tickingAreaManager.createTickingArea(areaId, {
                dimension,
                from: { x: xStart, y: 52, z: zStart },
                to: { x: xStart + 95, y: 112, z: zStart + 95 },
            });
            try {
                await generateSculkWildsTile(dimension, xStart, xStart + 95, zStart, zStart + 95);
            }
            finally {
                world.tickingAreaManager.removeTickingArea(areaId);
            }
        }
    }
}
function generateSculkWildsTile(dimension, minX, maxX, minZ, maxZ) {
    return new Promise((resolve, reject) => {
        system.runJob((function* () {
            try {
                let completed = 0;
                const baseY = 54;
                for (let x = minX; x <= maxX; x += 1) {
                    for (let z = minZ; z <= maxZ; z += 1) {
                        if (Math.abs(z) > SINGERS_MEADOW_RADIUS)
                            continue;
                        const meadowEdgeX = Math.floor(Math.sqrt(SINGERS_MEADOW_RADIUS * SINGERS_MEADOW_RADIUS - z * z));
                        const westDistance = x - meadowEdgeX;
                        const biomeWidth = Math.max(156, Math.round(214 - Math.abs(z) * 0.32
                            + valueNoise(x + 911, z - 443, 43) * 12));
                        if (westDistance < 1 || westDistance > biomeWidth)
                            continue;
                        const surfaceY = getSculkWildsSurfaceHeight(x, z, westDistance, biomeWidth);
                        const colorNoise = valueNoise(x + 1207, z - 349, 39)
                            + valueNoise(x - 331, z + 881, 19) * 0.26;
                        const green = colorNoise > 0.03;
                        const sculk = green ? "thesift:healthy_sculk_green" : "thesift:healthy_sculk_pink";
                        dimension.fillBlocks(new BlockVolume({ x, y: baseY, z }, { x, y: surfaceY - 1, z }), sculk);
                        const grassPatch = valueNoise(x + 617, z + 271, 17) > -0.22;
                        const topBlock = green
                            ? "thesift:sift_sculk_grass_green_block"
                            : "thesift:sift_sculk_grass_pink_block";
                        dimension.getBlock({ x, y: surfaceY, z })?.setType(grassPatch ? topBlock : sculk);
                        if (grassPatch) {
                            const vegetationChance = 36 + Math.floor((valueNoise(x - 83, z + 1201, 9) + 1) * 22);
                            if (stableHash(x + 401, z - 101) % 100 < vegetationChance) {
                                const tall = stableHash(x - 709, z + 523) % 100 < 42;
                                const plantId = `thesift:sift_${tall ? "tall" : "short"}_sculk_grass_${green ? "green" : "pink"}`;
                                dimension.getBlock({ x, y: surfaceY + 1, z })?.setType(plantId);
                            }
                        }
                        completed += 1;
                        if (completed % 24 === 0)
                            yield;
                    }
                }
                resolve();
            }
            catch (error) {
                reject(error);
            }
        })());
    });
}
function getSculkWildsSurfaceHeight(x, z, westDistance, width) {
    const broad = valueNoise(x + 547, z - 269, 41);
    const medium = valueNoise(x - 1031, z + 719, 19);
    const detail = valueNoise(x + 73, z + 401, 8);
    const hillHeight = 69 + broad * 12 + medium * 5 + detail * 2;
    const westBlend = smoothStep(Math.min(1, westDistance / 32));
    const eastBlend = smoothStep(Math.min(1, (width - westDistance + 1) / 22));
    const edgeBlend = Math.min(westBlend, eastBlend);
    return Math.round(56 + (hillHeight - 56) * edgeBlend);
}
/**

 * Hilly Meadows: a VERY huge, VERY hilly sibling of Singer's Meadow.

 * Same substrate palette, same flora, towering rolling hills + dense forest.

 */
/** Replaces legacy bedrock + bare-slate bands inside the Hilly rect with matching grass. */
function scrubHillyBedrockBands(dimension) {
    return new Promise((resolve, reject) => {
        system.runJob((function* () {
            try {
                const minX = HILLY_MEADOWS_CENTER_X - HILLY_MEADOWS_RADIUS_X;
                const maxX = HILLY_MEADOWS_CENTER_X + HILLY_MEADOWS_RADIUS_X;
                const minZ = HILLY_MEADOWS_CENTER_Z - HILLY_MEADOWS_RADIUS_Z;
                const maxZ = HILLY_MEADOWS_CENTER_Z + HILLY_MEADOWS_RADIUS_Z;
                for (let x = minX; x <= maxX; x += 1) {
                    for (let z = minZ; z <= maxZ; z += 1) {
                        if (!isHillyMeadowsPosition(x, z))
                            continue;
                        if (Math.abs(x) <= 32 && Math.abs(z - 5) <= 32)
                            continue;
                        const surfaceY = getHillyMeadowsSurfaceHeight(x, z);
                        const soilNoise = valueNoise(x + 389, z - 217, 19);
                        const slateNoise = valueNoise(x - 733, z + 511, 23);
                        let hillyTop = "thesift:sift_grass";
                        if (soilNoise > 0.55) {
                            hillyTop = "thesift:rose_grass_block";
                        }
                        else if (slateNoise > 0.18) {
                            hillyTop = valueNoise(x + 1207, z - 349, 13) > -0.08 ? "thesift:sift_slate_green_grass_block" : "thesift:sift_slate_grass_block";
                        }
                        else if (valueNoise(x + 617, z + 271, 17) > -0.55) {
                            hillyTop = "thesift:sift_grass";
                        }
                        else {
                            hillyTop = "thesift:rose_grass_block";
                        }
                        const lo = Math.max(40, surfaceY - 24);
                        for (let y = lo; y <= surfaceY; y += 1) {
                            const b = dimension.getBlock({ x, y, z });
                            if (!b)
                                continue;
                            const id = b.typeId;
                            if (id === "minecraft:bedrock" || id === "thesift:sift_slate") {
                                b.setType(hillyTop);
                            }
                        }
                        dimension.getBlock({ x, y: surfaceY, z })?.setType(hillyTop);
                        if (z % 32 === 0)
                            yield;
                    }
                    yield;
                }
                resolve();
            }
            catch (error) {
                reject(error);
            }
        })());
    });
}
async function generateHillyMeadows(dimension) {
    const tileSize = 96;
    const minTileX = Math.floor((HILLY_MEADOWS_CENTER_X - HILLY_MEADOWS_RADIUS_X) / tileSize);
    const maxTileX = Math.floor((HILLY_MEADOWS_CENTER_X + HILLY_MEADOWS_RADIUS_X) / tileSize);
    const minTileZ = Math.floor((HILLY_MEADOWS_CENTER_Z - HILLY_MEADOWS_RADIUS_Z) / tileSize);
    const maxTileZ = Math.floor((HILLY_MEADOWS_CENTER_Z + HILLY_MEADOWS_RADIUS_Z) / tileSize);
    let tileNumber = 0;
    for (let tileX = minTileX; tileX <= maxTileX; tileX += 1) {
        for (let tileZ = minTileZ; tileZ <= maxTileZ; tileZ += 1) {
            const minX = tileX * tileSize;
            const maxX = minX + tileSize - 1;
            const minZ = tileZ * tileSize;
            const maxZ = minZ + tileSize - 1;
            const corners = [
                [minX, minZ],
                [maxX, minZ],
                [minX, maxZ],
                [maxX, maxZ],
            ];
            const centerInside = isHillyMeadowsPosition(Math.floor((minX + maxX) / 2), Math.floor((minZ + maxZ) / 2));
            if (!centerInside && !corners.some(([cx, cz]) => isHillyMeadowsPosition(cx, cz)))
                continue;
            const areaId = `thesift:hilly_meadows_tile_${tileNumber}`;
            tileNumber += 1;
            await world.tickingAreaManager.createTickingArea(areaId, {
                dimension,
                from: { x: minX, y: 50, z: minZ },
                to: { x: maxX, y: 130, z: maxZ },
            });
            try {
                await fillHillyMeadowsTile(dimension, minX, maxX, minZ, maxZ);
            }
            finally {
                world.tickingAreaManager.removeTickingArea(areaId);
            }
        }
    }
    await plantHillyWillowForest(dimension);
}
function fillHillyMeadowsTile(dimension, minX, maxX, minZ, maxZ) {
    return new Promise((resolve, reject) => {
        system.runJob((function* () {
            try {
                let completed = 0;
                for (let x = minX; x <= maxX; x += 1) {
                    for (let z = minZ; z <= maxZ; z += 1) {
                        if (!isHillyMeadowsPosition(x, z))
                            continue;
                        if (Math.abs(x) <= 32 && Math.abs(z - 5) <= 32)
                            continue;
                        const surfaceY = getHillyMeadowsSurfaceHeight(x, z);
                        // Standalone meadow fill: no bedrock, no sculk. Deep dirt body so
                        // steep cliff sides never expose black bands.
                        dimension.fillBlocks(new BlockVolume({ x, y: surfaceY - 14, z }, { x, y: surfaceY - 3, z }), "thesift:sift_dirt");
                        dimension.fillBlocks(new BlockVolume({ x, y: surfaceY - 2, z }, { x, y: surfaceY - 1, z }), "thesift:sift_dirt");
                        const soilNoise = valueNoise(x + 389, z - 217, 19);
                        const slateNoise = valueNoise(x - 733, z + 511, 23);
                        // Hilly soils ONLY (no bedrock, no vanilla, no sculk):
                        // sift_dirt -> sift_grass | sift_slate -> red/green slate grass | rose_soil -> rose_grass_block.
                        // Deep matching body so cliff sides match the top, never black bands.
                        let substrate = "thesift:sift_dirt";
                        let hillyTop = "thesift:sift_grass";
                        let hillyBody = "thesift:sift_dirt";
                        if (soilNoise > 0.55) {
                            substrate = "thesift:rose_soil";
                            hillyTop = "thesift:rose_grass_block";
                            hillyBody = "thesift:rose_soil";
                        }
                        else if (slateNoise > 0.18) {
                            substrate = "thesift:sift_slate";
                            hillyBody = "thesift:sift_slate";
                            hillyTop = valueNoise(x + 1207, z - 349, 13) > -0.08 ? "thesift:sift_slate_green_grass_block" : "thesift:sift_slate_grass_block";
                        }
                        else if (valueNoise(x + 617, z + 271, 17) > -0.55) {
                            substrate = "thesift:sift_dirt";
                            hillyTop = "thesift:sift_grass";
                            hillyBody = "thesift:sift_dirt";
                        }
                        else {
                            substrate = "thesift:rose_soil";
                            hillyTop = "thesift:rose_grass_block";
                            hillyBody = "thesift:rose_grass_block";
                        }
                        // Bedrock-free solid hills: body uses the SAME grass block as the top
                        // so steep cliff sides never expose grey slate bands that read as bedrock.
                        // Full-column overwrite also buries any legacy v1-v3 bedrock / slate.
                        hillyBody = hillyTop;
                        dimension.fillBlocks(new BlockVolume({ x, y: 40, z }, { x, y: surfaceY, z }), hillyBody);
                        dimension.getBlock({ x, y: surfaceY - 2, z })?.setType(substrate);
                        dimension.getBlock({ x, y: surfaceY - 1, z })?.setType(substrate);
                        dimension.getBlock({ x, y: surfaceY, z })?.setType(hillyTop);
                        const hillBoost = Math.max(0, Math.min(1, (surfaceY - 66) / 30));
                        const lushness = valueNoise(x + 583, z - 927, 13);
                        if (lushness > -0.75) {
                            const plantChance = 62 + Math.floor(((lushness + 1) / 2) * 30) + Math.floor(hillBoost * 6);
                            if (stableHash(x + 317, z - 821) % 100 < plantChance) {
                                const floraIndex = stableHash(x - 109, z + 557) % SINGERS_MEADOW_GROUND_FLORA.length;
                                const plantType = SINGERS_MEADOW_GROUND_FLORA[floraIndex];
                                if (plantType) {
                                    dimension.getBlock({ x, y: surfaceY + 1, z })?.setType(plantType);
                                }
                            }
                        }
                        completed += 1;
                        if (completed % 24 === 0)
                            yield;
                    }
                }
                resolve();
            }
            catch (error) {
                reject(error);
            }
        })());
    });
}
/** Dense willow forest across the whole Hilly Meadows (not just pockets). */
async function plantHillyWillowForest(dimension) {
    const groves = [];
    let groveIndex = 0;
    for (let gx = HILLY_MEADOWS_CENTER_X - HILLY_MEADOWS_RADIUS_X + 30; gx <= HILLY_MEADOWS_CENTER_X + HILLY_MEADOWS_RADIUS_X - 30; gx += 46) {
        for (let gz = HILLY_MEADOWS_CENTER_Z - HILLY_MEADOWS_RADIUS_Z + 30; gz <= HILLY_MEADOWS_CENTER_Z + HILLY_MEADOWS_RADIUS_Z - 30; gz += 46) {
            const jx = gx + ((stableHash(gx, gz) % 25) - 12);
            const jz = gz + ((stableHash(gz, gx + 7) % 25) - 12);
            if (!isHillyMeadowsPosition(jx, jz))
                continue;
            groveIndex += 1;
            groves.push({ x: jx, z: jz, radius: 34, seed: 5000 + groveIndex * 131 });
        }
    }
    for (const [index, grove] of groves.entries()) {
        const areaId = `thesift:hilly_willow_grove_${index}`;
        await world.tickingAreaManager.createTickingArea(areaId, {
            dimension,
            from: { x: grove.x - 56, y: 50, z: grove.z - 56 },
            to: { x: grove.x + 56, y: 140, z: grove.z + 56 },
        });
        try {
            await generateHillyWillowGrove(dimension, grove.x, grove.z, grove.radius, grove.seed);
        }
        finally {
            world.tickingAreaManager.removeTickingArea(areaId);
        }
    }
}
function generateHillyWillowGrove(dimension, centerX, centerZ, radius, seed) {
    return new Promise((resolve, reject) => {
        system.runJob((function* () {
            try {
                let treeNumber = 0;
                for (let dx = -radius; dx <= radius; dx += 2) {
                    for (let dz = -radius; dz <= radius; dz += 2) {
                        if (dx * dx + dz * dz > radius * radius)
                            continue;
                        const treeX = centerX + dx;
                        const treeZ = centerZ + dz;
                        if (!isHillyMeadowsPosition(treeX, treeZ))
                            continue;
                        if (Math.abs(treeX) <= 32 && Math.abs(treeZ - 5) <= 32)
                            continue;
                        if (stableHash(treeX * 3 + seed, treeZ * 7 - seed) % 100 < 80) {
                            const baseY = getHillyMeadowsSurfaceHeight(treeX, treeZ);
                            dimension.getBlock({ x: treeX, y: baseY + 1, z: treeZ })?.setType("minecraft:air");
                            const height = 12 + (stableHash(treeX + seed * 3, treeZ - seed * 5) % 7);
                            yield* buildWillowTree(dimension, treeX, baseY, treeZ, height, seed + treeNumber);
                            treeNumber += 1;
                        }
                        if (treeNumber % 3 === 0)
                            yield;
                    }
                }
                resolve();
            }
            catch (error) {
                reject(error);
            }
        })());
    });
}
function runSiftLandmarkJob(dimension) {
    return new Promise((resolve, reject) => {
        system.runJob((function* () {
            try {
                yield* buildRoseSpire(dimension, -24, -22, 27);
                yield* buildRoseSpire(dimension, 21, -27, 24);
                yield* buildRoseSpire(dimension, 29, 15, 20);
                yield* buildRoseSpire(dimension, -29, 20, 23);
                yield* buildRoseSpire(dimension, 1, 35, 18);
                yield* buildCrystalOutcrop(dimension, -34, -4);
                yield* buildCrystalOutcrop(dimension, 13, 29);
                yield* buildCrystalOutcrop(dimension, 35, -11);
                resolve();
            }
            catch (error) {
                reject(error);
            }
        })());
    });
}
function generateWillowGrove(dimension, centerX, centerZ, radius, seed) {
    return new Promise((resolve, reject) => {
        system.runJob((function* () {
            try {
                let treeNumber = 0;
                for (let x = centerX - radius; x <= centerX + radius; x += 5) {
                    for (let z = centerZ - radius; z <= centerZ + radius; z += 5) {
                        const jitterX = stableHash(x + seed, z - seed) % 3 - 1;
                        const jitterZ = stableHash(z - seed, x + seed) % 3 - 1;
                        const treeX = x + jitterX;
                        const treeZ = z + jitterZ;
                        const dx = treeX - centerX;
                        const dz = treeZ - centerZ;
                        if (dx * dx + dz * dz > radius * radius || stableHash(treeX + 41, treeZ - 73) % 100 < 23) {
                            continue;
                        }
                        const baseY = getSingersMeadowSurfaceHeight(treeX, treeZ);
                        const height = 11 + stableHash(treeX + seed * 3, treeZ - seed * 5) % 7;
                        yield* buildWillowTree(dimension, treeX, baseY, treeZ, height, seed + treeNumber);
                        treeNumber += 1;
                    }
                }
                resolve();
            }
            catch (error) {
                reject(error);
            }
        })());
    });
}
function* buildWillowTree(dimension, x, baseY, z, height, seed) {
    const verticalLog = BlockPermutation.resolve("thesift:willow_log", { "sift:axis": "y" });
    let writes = 0;
    for (let y = baseY + 1; y <= baseY + height; y += 1) {
        dimension.getBlock({ x, y, z })?.setPermutation(verticalLog);
        writes += 1;
        if (writes % 24 === 0) {
            yield;
        }
    }
    const branchY = baseY + height - 4;
    const directions = [
        { x: 1, z: 0, axis: "x" },
        { x: -1, z: 0, axis: "x" },
        { x: 0, z: 1, axis: "z" },
        { x: 0, z: -1, axis: "z" },
    ];
    for (let index = 0; index < directions.length; index += 1) {
        const direction = directions[index];
        if (!direction || stableHash(x + seed + index, z - seed) % 100 < 28) {
            continue;
        }
        const length = 2 + stableHash(x - index, z + seed) % 3;
        const log = BlockPermutation.resolve("thesift:willow_log", { "sift:axis": direction.axis });
        for (let step = 1; step <= length; step += 1) {
            dimension.getBlock({ x: x + direction.x * step, y: branchY, z: z + direction.z * step })?.setPermutation(log);
            writes += 1;
            if (writes % 24 === 0) {
                yield;
            }
        }
    }
    const canopyY = baseY + height - 2;
    const canopyLayers = [
        { offset: 2, radius: 2 },
        { offset: 1, radius: 4 },
        { offset: 0, radius: 5 },
        { offset: -1, radius: 5 },
        { offset: -2, radius: 5 },
        { offset: -3, radius: 4 },
        { offset: -4, radius: 4 },
        { offset: -5, radius: 3 },
        { offset: -6, radius: 2 },
    ];
    const bottomLeaves = new Map();
    for (const layer of canopyLayers) {
        for (let dx = -layer.radius; dx <= layer.radius; dx += 1) {
            for (let dz = -layer.radius; dz <= layer.radius; dz += 1) {
                if (dx * dx + dz * dz > layer.radius * layer.radius + 1) {
                    continue;
                }
                const location = { x: x + dx, y: canopyY + layer.offset, z: z + dz };
                if ((Math.abs(dx) + Math.abs(dz) >= layer.radius * 2 - 1)
                    && stableHash(location.x + seed, location.z - seed) % 100 < 14) {
                    continue;
                }
                dimension.getBlock(location)?.setType("thesift:willow_leaves");
                const key = `${location.x},${location.z}`;
                const old = bottomLeaves.get(key);
                if (!old || location.y < old.y) {
                    bottomLeaves.set(key, { x: location.x, z: location.z, y: location.y });
                }
                writes += 1;
                if (writes % 24 === 0) {
                    yield;
                }
            }
        }
    }
    const vineTypes = [
        "thesift:willow_vine_canopy",
        "thesift:willow_vine_cluster",
        "thesift:willow_vine_sparse",
        "thesift:willow_vine_pair",
        "thesift:willow_vine_curtain",
        "thesift:willow_vine_long",
        "thesift:willow_vine_forked",
        "thesift:sift_hanging_canopy",
        "thesift:sift_trailing_vine",
    ];
    for (const leaf of bottomLeaves.values()) {
        const edgeDistance = Math.abs(leaf.x - x) + Math.abs(leaf.z - z);
        if (edgeDistance < 4 || stableHash(leaf.x + seed * 7, leaf.z - seed * 11) % 100 >= 13) {
            continue;
        }
        const vineIndex = stableHash(leaf.x - seed, leaf.z + seed) % vineTypes.length;
        const vineType = vineTypes[vineIndex];
        if (!vineType) {
            continue;
        }
        const maxLength = Math.min(5, leaf.y - baseY - 1);
        const length = Math.min(maxLength, 2 + stableHash(leaf.x + seed, leaf.z - seed) % 4);
        for (let segment = 1; segment <= length; segment += 1) {
            dimension.getBlock({ x: leaf.x, y: leaf.y - segment, z: leaf.z })?.setType(vineType);
            writes += 1;
            if (writes % 24 === 0) {
                yield;
            }
        }
    }
}
/** Generates a finite first-pass landscape around the portal using script-driven blocks. */
function generateSiftTerrain(dimension) {
    return new Promise((resolve, reject) => {
        system.runJob((function* () {
            try {
                const radius = 48;
                const baseY = 54;
                const total = (radius * 2 + 1) ** 2;
                let done = 0;
                for (let x = -radius; x <= radius; x += 1) {
                    for (let z = -radius; z <= radius; z += 1) {
                        const distance = Math.sqrt(x * x + z * z);
                        if (distance > radius) {
                            continue;
                        }
                        // Preserve a roomy arrival court and the return portal before the terrain begins.
                        if (Math.abs(x) <= 9 && z >= -4 && z <= 13) {
                            continue;
                        }
                        const surfaceY = getSiftSurfaceHeight(x, z);
                        dimension.fillBlocks(new BlockVolume({ x, y: baseY, z }, { x, y: surfaceY - 1, z }), "thesift:rose_soil");
                        const grass = isSiftGrassSurface(x, z);
                        dimension.getBlock({ x, y: surfaceY, z })?.setType(grass ? "thesift:rose_grass_block" : "thesift:rose_soil");
                        if (grass && surfaceY < 96 && isSiftWeedPosition(x, z)) {
                            dimension.getBlock({ x, y: surfaceY + 1, z })?.setType(stableHash(x + 401, z - 113) % 7 === 0 ? "thesift:coral_grass" : "thesift:rift_weed");
                        }
                        done += 1;
                        // Keep the job responsive while it fills the roughly 97x97 island.
                        if (done % 32 === 0) {
                            yield;
                        }
                    }
                }
                yield* buildRoseSpire(dimension, -24, -22, 27);
                yield* buildRoseSpire(dimension, 21, -27, 24);
                yield* buildRoseSpire(dimension, 29, 15, 20);
                yield* buildRoseSpire(dimension, -29, 20, 23);
                yield* buildRoseSpire(dimension, 1, 35, 18);
                yield* buildCrystalOutcrop(dimension, -34, -4);
                yield* buildCrystalOutcrop(dimension, 13, 29);
                yield* buildCrystalOutcrop(dimension, 35, -11);
                resolve();
            }
            catch (error) {
                reject(error);
            }
        })());
    });
}
function getSiftSurfaceHeight(x, z) {
    const distance = Math.sqrt(x * x + z * z);
    const broad = valueNoise(x, z, 23);
    const detail = valueNoise(x + 187, z - 93, 9);
    const fine = valueNoise(x - 311, z + 257, 4);
    const hillHeight = 69 + broad * 12 + detail * 4 + fine * 1.5;
    const arrivalBlend = Math.max(0, Math.min(1, (distance - 15) / 9));
    const edgeBlend = Math.max(0, Math.min(1, (48 - distance) / 10));
    const height = 64 * (1 - arrivalBlend) + hillHeight * arrivalBlend;
    const tapered = 56 * (1 - edgeBlend) + height * edgeBlend;
    // Quantized heights make broad blocky shelves like the reference landscape.
    return Math.round(tapered);
}
function valueNoise(x, z, scale) {
    const gridX = Math.floor(x / scale);
    const gridZ = Math.floor(z / scale);
    const tx = smoothStep((x / scale) - gridX);
    const tz = smoothStep((z / scale) - gridZ);
    const a = lerp(hashNoise(gridX, gridZ), hashNoise(gridX + 1, gridZ), tx);
    const b = lerp(hashNoise(gridX, gridZ + 1), hashNoise(gridX + 1, gridZ + 1), tx);
    return lerp(a, b, tz);
}
function hashNoise(x, z) {
    const value = Math.sin(x * 127.1 + z * 311.7 + 918.31) * 43758.5453;
    return (value - Math.floor(value)) * 2 - 1;
}
function stableHash(x, z) {
    const value = Math.sin(x * 12.9898 + z * 78.233 + 45.164) * 43758.5453;
    return Math.floor((value - Math.floor(value)) * 2147483647);
}
function smoothStep(value) {
    return value * value * (3 - 2 * value);
}
function lerp(start, end, amount) {
    return start + (end - start) * amount;
}
function isSiftGrassSurface(x, z) {
    const patch = valueNoise(x + 719, z + 233, 6);
    return patch > -0.62;
}
function isSiftWeedPosition(x, z) {
    return stableHash(x, z) % 23 === 0;
}
function* buildRoseSpire(dimension, centerX, centerZ, height) {
    const baseY = getSiftSurfaceHeight(centerX, centerZ);
    let driftX = 0;
    let driftZ = 0;
    for (let layer = 0; layer < height; layer += 1) {
        if (layer > 2 && layer % 4 === 0) {
            driftX += stableHash(centerX + layer, centerZ) % 3 - 1;
            driftZ += stableHash(centerX, centerZ - layer) % 3 - 1;
            driftX = Math.max(-2, Math.min(2, driftX));
            driftZ = Math.max(-2, Math.min(2, driftZ));
        }
        const taper = layer < 4 ? 2 : layer < height * 0.55 ? 1 : 0;
        const radius = taper + (stableHash(layer, centerX + centerZ) % 5 === 0 ? 1 : 0);
        for (let dx = -radius; dx <= radius; dx += 1) {
            for (let dz = -radius; dz <= radius; dz += 1) {
                if (Math.abs(dx) + Math.abs(dz) <= radius + 1) {
                    dimension.getBlock({ x: centerX + driftX + dx, y: baseY + layer, z: centerZ + driftZ + dz })?.setType("thesift:rose_soil");
                }
            }
        }
        // Uneven ledges break the silhouette into irregular, eroded-looking steps.
        if (layer % 5 === 2) {
            const ledgeX = stableHash(centerX, layer + centerZ) % 5 - 2;
            const ledgeZ = stableHash(centerZ, layer - centerX) % 5 - 2;
            dimension.getBlock({ x: centerX + driftX + ledgeX, y: baseY + layer, z: centerZ + driftZ + ledgeZ })?.setType("thesift:rose_soil");
        }
        yield;
    }
}
function* buildCrystalOutcrop(dimension, centerX, centerZ) {
    const baseY = getSiftSurfaceHeight(centerX, centerZ);
    for (let dx = -2; dx <= 2; dx += 1) {
        for (let dz = -2; dz <= 2; dz += 1) {
            const spread = Math.abs(dx) + Math.abs(dz);
            if (spread > 3 || stableHash(centerX + dx, centerZ + dz) % 3 === 0) {
                continue;
            }
            const blockType = spread === 0 ? "minecraft:sea_lantern" : "minecraft:prismarine";
            const topY = baseY + (spread <= 1 ? 2 : 1);
            dimension.getBlock({ x: centerX + dx, y: baseY + 1, z: centerZ + dz })?.setType(blockType);
            if (spread <= 1) {
                dimension.getBlock({ x: centerX + dx, y: topY, z: centerZ + dz })?.setType(blockType);
            }
            yield;
        }
    }
}
function buildSiftGateway(dimension) {
    const center = RETURN_PORTAL_CENTER;
    // Wide, stepped footing blends the gateway into the arrival plaza.
    for (let x = -7; x <= 7; x += 1) {
        for (let zOffset = -2; zOffset <= 3; zOffset += 1) {
            dimension.getBlock({ x: center.x + x, y: 63, z: center.z + zOffset })?.setType("thesift:sift_gate_stone");
        }
    }
    // Build thick side pillars and a layered crown around the portal plane.
    for (const side of [-1, 1]) {
        for (let zOffset = -1; zOffset <= 1; zOffset += 1) {
            for (let y = -3; y <= 4; y += 1) {
                const x = center.x + side * 5;
                const z = center.z + zOffset;
                const type = y === -2 || y === 1 ? "thesift:sift_gate_rune" : "thesift:sift_gate_stone";
                dimension.getBlock({ x, y: center.y + y, z })?.setType(type);
            }
            for (const xOffset of [-6, 6]) {
                for (let y = -2; y <= 1; y += 1) {
                    dimension.getBlock({
                        x: center.x + xOffset,
                        y: center.y + y,
                        z: center.z + zOffset,
                    })?.setType("thesift:sift_gate_stone");
                }
            }
        }
    }
    // Crown tiers make the silhouette read as an ancient shrine, not a bare rectangle.
    for (let zOffset = -1; zOffset <= 1; zOffset += 1) {
        for (let x = -6; x <= 6; x += 1) {
            dimension.getBlock({ x: center.x + x, y: center.y + 4, z: center.z + zOffset })?.setType("thesift:sift_gate_stone");
        }
        for (let x = -4; x <= 4; x += 1) {
            dimension.getBlock({ x: center.x + x, y: center.y + 5, z: center.z + zOffset })?.setType("thesift:sift_gate_stone");
        }
        for (let x = -2; x <= 2; x += 1) {
            dimension.getBlock({ x: center.x + x, y: center.y + 6, z: center.z + zOffset })?.setType("thesift:sift_gate_rune");
        }
    }
    // Custom frame blocks enclose the 7-by-5 translucent opening.
    for (let y = -3; y <= 3; y += 1) {
        for (let x = -4; x <= 4; x += 1) {
            const border = Math.abs(x) === 4 || Math.abs(y) === 3;
            const location = { x: center.x + x, y: center.y + y, z: center.z };
            dimension.getBlock(location)?.setType(border ? "thesift:sift_gate_frame" : PORTAL_SURFACE);
        }
    }
    // Recessed rune strips and bright crystals accent the outer pillars.
    for (const zOffset of [-1, 1]) {
        for (const side of [-5, 5]) {
            for (const yOffset of [-2, 1]) {
                dimension.getBlock({
                    x: center.x + side,
                    y: center.y + yOffset,
                    z: center.z + zOffset,
                })?.setType("thesift:sift_gate_rune");
            }
            for (const yOffset of [-3, 3]) {
                dimension.getBlock({
                    x: center.x + side,
                    y: center.y + yOffset,
                    z: center.z + zOffset,
                })?.setType("thesift:sift_gate_crystal");
            }
        }
    }
}
async function enterSift(player) {
    try {
        await ensureSiftHome();
        player.teleport(PORTAL_CENTER, {
            dimension: world.getDimension(SIFT_DIMENSION_ID),
            checkForBlocks: true,
            keepVelocity: false,
        });
    }
    catch (error) {
        player.sendMessage(`§cThe Sift gateway could not open: ${String(error)}`);
    }
}
function returnToOverworld(player) {
    const overworld = world.getDimension("overworld");
    const target = returnLocations.get(player.id) ?? world.getDefaultSpawnLocation();
    try {
        player.teleport(target, {
            dimension: overworld,
            checkForBlocks: true,
            keepVelocity: false,
        });
        player.playSound("portal.travel");
        player.sendMessage("§bYou return through the Ancient City gateway.");
    }
    catch (error) {
        player.sendMessage(`§cThe return gateway failed: ${String(error)}`);
    }
}
