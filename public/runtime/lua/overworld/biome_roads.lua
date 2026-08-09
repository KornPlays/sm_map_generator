-- Browser-owned selector for road tiles that cross biome boundaries.

local terrainByName = {
    Forest = TYPE_FOREST, Desert = TYPE_DESERT, Field = TYPE_FIELD,
    BurntForest = TYPE_BURNTFOREST, AutumnForest = TYPE_AUTUMNFOREST, Lake = TYPE_LAKE
}

local sourcePaths = {
    "$SURVIVAL_DATA/Terrain/Tiles/roads_biomes/Road(0101)_Forest(1001)_01.tile",
    "$SURVIVAL_DATA/Terrain/Tiles/roads_biomes/Road(0001)_Forest(1111)_01.tile",
    "$SURVIVAL_DATA/Terrain/Tiles/roads_biomes/Road(0011)_Forest(1111)_01.tile",
    "$SURVIVAL_DATA/Terrain/Tiles/roads_biomes/Road(0101)_Forest(1111)_01.tile",
    "$SURVIVAL_DATA/Terrain/Tiles/roads_biomes/Road(0111)_Forest(1111)_01.tile",
    "$SURVIVAL_DATA/Terrain/Tiles/roads_biomes/Road(1111)_Forest(1111)_01.tile",
    "$SURVIVAL_DATA/Terrain/Tiles/roads_biomes/Road(0101)_Forest(0010)_01.tile",
    "$SURVIVAL_DATA/Terrain/Tiles/roads_biomes/Road(0101)_Forest(0001)_01.tile",
    "$SURVIVAL_DATA/Terrain/Tiles/roads_biomes/Road(0101)_Forest(1011)_01.tile",
    "$SURVIVAL_DATA/Terrain/Tiles/roads_biomes/Road(0101)_Forest(0111)_01.tile",
    "$SURVIVAL_DATA/Terrain/Tiles/roads_biomes/Road(0101)_Forest(0011)_01.tile",
    "$SURVIVAL_DATA/Terrain/Tiles/roads_biomes/Road(0011)_Forest(0001)_01.tile",
    "$SURVIVAL_DATA/Terrain/Tiles/roads_biomes/Road(0011)_Forest(1110)_01.tile",
    "$SURVIVAL_DATA/Terrain/Tiles/roads_biomes/Road(0011)_Forest(1100)_01.tile",
    "$SURVIVAL_DATA/Terrain/Tiles/roads_biomes/Road(0011)_Forest(0110)_01.tile",
    "$SURVIVAL_DATA/Terrain/Tiles/roads_biomes/Road(0101)_Desert(1001)_01.tile",
    "$SURVIVAL_DATA/Terrain/Tiles/roads_biomes/Road(0101)_Desert(1001)_02.tile",
    "$SURVIVAL_DATA/Terrain/Tiles/roads_biomes/Road(0011)_Desert(1111)_01.tile",
    "$SURVIVAL_DATA/Terrain/Tiles/roads_biomes/Road(0011)_Desert(1111)_02.tile",
    "$SURVIVAL_DATA/Terrain/Tiles/roads_biomes/Road(0101)_Desert(1111)_01.tile",
    "$SURVIVAL_DATA/Terrain/Tiles/roads_biomes/Road(0101)_Desert(1111)_02.tile",
    "$SURVIVAL_DATA/Terrain/Tiles/roads_biomes/Road(0101)_Desert(1111)_03.tile",
    "$SURVIVAL_DATA/Terrain/Tiles/roads_biomes/Road(0101)_Desert(0010)_01.tile",
    "$SURVIVAL_DATA/Terrain/Tiles/roads_biomes/Road(0101)_Desert(0001)_01.tile",
    "$SURVIVAL_DATA/Terrain/Tiles/roads_biomes/Road(0101)_Field(1001)_01.tile",
    "$SURVIVAL_DATA/Terrain/Tiles/roads_biomes/Road(0011)_Field(1111)_01.tile",
    "$SURVIVAL_DATA/Terrain/Tiles/roads_biomes/Road(0101)_Field(1111)_01.tile",
    "$SURVIVAL_DATA/Terrain/Tiles/roads_biomes/Road(0101)_BurntForest(1001)_01.tile",
    "$SURVIVAL_DATA/Terrain/Tiles/roads_biomes/Road(0011)_BurntForest(1111)_01.tile",
    "$SURVIVAL_DATA/Terrain/Tiles/roads_biomes/Road(0101)_BurntForest(1111)_01.tile",
    "$SURVIVAL_DATA/Terrain/Tiles/roads_biomes/Road(0101)_AutumnForest(1001)_01.tile",
    "$SURVIVAL_DATA/Terrain/Tiles/roads_biomes/Road(0011)_AutumnForest(1111)_01.tile",
    "$SURVIVAL_DATA/Terrain/Tiles/roads_biomes/Road(0101)_AutumnForest(1111)_01.tile",
    "$SURVIVAL_DATA/Terrain/Tiles/roads_biomes/Road(0101)_Lake(1001)_01.tile",
    "$SURVIVAL_DATA/Terrain/Tiles/roads_biomes/Road(0101)_Lake(1001)_02.tile",
    "$SURVIVAL_DATA/Terrain/Tiles/roads_biomes/Road(0101)_Lake(1001)_03.tile",
    "$SURVIVAL_DATA/Terrain/Tiles/roads_biomes/Road(0101)_Lake(1111)_01.tile",
    "$SURVIVAL_DATA/Terrain/Tiles/roads_biomes/Road(0101)_Lake(1111)_02.tile",
    "$SURVIVAL_DATA/Terrain/Tiles/roads_biomes/Road(0011)_Lake(0001)_01.tile",
    "$SURVIVAL_DATA/Terrain/Tiles/roads_biomes/Road(0011)_Lake(0110)_01.tile",
    "$SURVIVAL_DATA/Terrain/Tiles/roads_biomes/Road(0011)_Lake(1100)_01.tile",
    "$SURVIVAL_DATA/Terrain/Tiles/roads_biomes/Road(0011)_Lake(1110)_01.tile",
    "$SURVIVAL_DATA/Terrain/Tiles/roads_biomes/Road(0101)_Lake(0001)_01.tile",
    "$SURVIVAL_DATA/Terrain/Tiles/roads_biomes/Road(0101)_Lake(0010)_01.tile",
    "$SURVIVAL_DATA/Terrain/Tiles/roads_biomes/Road(0101)_Lake(0011)_01.tile",
    "$SURVIVAL_DATA/Terrain/Tiles/roads_biomes/Road(0101)_Lake(0011)_02.tile"
}

local choices = {}

local function shifted(sequence, turns)
    local output = {}
    for index = 1, 4 do output[index] = sequence[(index + turns - 1) % 4 + 1] end
    return output
end

local function packedKey(roads, corners)
    local key = bit.bor(bit.lshift(roads[1], 19), bit.lshift(roads[2], 18),
        bit.lshift(roads[3], 17), bit.lshift(roads[4], 16))
    return bit.bor(key, bit.lshift(corners[1] > 1 and corners[1] or 0, 12),
        bit.lshift(corners[2] > 1 and corners[2] or 0, 8),
        bit.lshift(corners[3] > 1 and corners[3] or 0, 4),
        corners[4] > 1 and corners[4] or 0)
end

local function decodePath(path)
    local s, w, n, e, biome, se, sw, nw, ne = path:match(
        "Road%((%d)(%d)(%d)(%d)%)_(%a+)%((%d)(%d)(%d)(%d)%)")
    local terrain = assert(terrainByName[biome])
    return { s, w, n, e }, { se * terrain, sw * terrain, nw * terrain, ne * terrain }, terrain
end

function initBiomeRoadTiles()
    choices = {}
    for _, path in ipairs(sourcePaths) do
        local roads, corners, terrain = decodePath(path)
        for rotation = 0, 3 do
            local key = packedKey(shifted(roads, rotation), shifted(corners, rotation))
            choices[key] = choices[key] or { tiles = {}, rotation = rotation, terrainType = terrain }
            choices[key].tiles[#choices[key].tiles + 1] = AddTile(nil, path, nil, nil)
        end
    end
end

function calculateIndex(cell)
    local roads = bit.lshift(bit.rshift(bit.band(g_cellData.flags[cell.y][cell.x], MASK_ROADS), 8), 16)
    local corners = {
        g_cornerTemp.terrainType[cell.y][cell.x + 1], g_cornerTemp.terrainType[cell.y][cell.x],
        g_cornerTemp.terrainType[cell.y + 1][cell.x], g_cornerTemp.terrainType[cell.y + 1][cell.x + 1]
    }
    return bit.bor(roads, packedKey({ 0, 0, 0, 0 }, corners))
end

function getBiomeRoadTile(cell)
    return choices[calculateIndex(cell)]
end
