-- Browser generator grid storage.
-- This small compatibility module owns the arrays shared by the generation
-- passes. Numeric flags are intentionally documented here as the public data
-- contract between those passes.

dofile "tile_database.lua"

TYPE_MEADOW, TYPE_FOREST, TYPE_DESERT, TYPE_FIELD = 1, 2, 3, 4
TYPE_BURNTFOREST, TYPE_AUTUMNFOREST, TYPE_LAKE = 5, 6, 8

DEBUG_R, DEBUG_G, DEBUG_B, DEBUG_C = 243, 244, 245, 246
DEBUG_M, DEBUG_Y, DEBUG_BLACK, DEBUG_ORANGE = 247, 248, 249, 250
DEBUG_PINK, DEBUG_LIME, DEBUG_SPRING, DEBUG_PURPLE, DEBUG_LAKE = 251, 252, 253, 254, 255

MASK_CLIFF, MASK_ROADS, MASK_ROADCLIFF = 0x00ff, 0x0f00, 0x0fff
MASK_TERRAINTYPE, MASK_FLAT = 0xf000, 0x10000
FLAG_ROAD_E, FLAG_ROAD_N, FLAG_ROAD_W, FLAG_ROAD_S = 0x0100, 0x0200, 0x0400, 0x0800
MASK_ROADS_SN = bit.bor(FLAG_ROAD_S, FLAG_ROAD_N)
MASK_ROADS_WE = bit.bor(FLAG_ROAD_W, FLAG_ROAD_E)
SHIFT_TERRAINTYPE = 12
ERROR_TILE_UUID = sm.uuid.new("723268d4-8d59-4500-a433-7d900b61c29c")

g_cellData = g_cellData or {
    version = 2,
    bounds = { xMin = 0, xMax = 0, yMin = 0, yMax = 0 },
    padding = 0,
    seed = 0,
    elevation = {}, cliffLevel = {},
    uid = {}, xOffset = {}, yOffset = {}, rotation = {}, groupId = {}, flags = {}
}

-- The bounds test and the flag accessors below run millions of times per world,
-- so the grid table and its bounds are held as upvalues instead of being walked
-- out of the globals on every call. initializeCellData is the only writer of
-- g_cellData.bounds, so refreshing them there keeps the copies authoritative.
local cellData = g_cellData
local boundsXMin, boundsXMax, boundsYMin, boundsYMax = 0, 0, 0, 0
local maskRoadCliff, maskFlat, maskRoads = MASK_ROADCLIFF, MASK_FLAT, MASK_ROADS
local maskTerrainType, shiftTerrainType = MASK_TERRAINTYPE, SHIFT_TERRAINTYPE

function initializeCellData(xMin, xMax, yMin, yMax, seed, padding)
    local data = g_cellData
    cellData = data
    boundsXMin, boundsXMax, boundsYMin, boundsYMax = xMin, xMax, yMin, yMax
    data.bounds = { xMin = xMin, xMax = xMax, yMin = yMin, yMax = yMax }
    data.seed, data.padding = seed, padding
    data.elevation, data.cliffLevel = {}, {}
    data.uid, data.xOffset, data.yOffset = {}, {}, {}
    data.rotation, data.groupId, data.flags = {}, {}, {}

    for y = yMin, yMax + 1 do
        data.elevation[y], data.cliffLevel[y] = {}, {}
        for x = xMin, xMax + 1 do
            data.elevation[y][x], data.cliffLevel[y][x] = 0, 0
        end
    end
    for y = yMin, yMax do
        data.uid[y], data.xOffset[y], data.yOffset[y] = {}, {}, {}
        data.rotation[y], data.groupId[y], data.flags[y] = {}, {}, {}
        for x = xMin, xMax do
            data.uid[y][x] = sm.uuid.getNil()
            data.xOffset[y][x], data.yOffset[y][x] = 0, 0
            data.rotation[y][x], data.groupId[y][x], data.flags[y][x] = 0, 0, 0
        end
    end
    g_groupIdCount = 0
end

function insideCornerBounds(x, y, padding)
    if padding == nil then
        return x >= boundsXMin and x <= boundsXMax + 1
           and y >= boundsYMin and y <= boundsYMax + 1
    end
    return x >= boundsXMin + padding and x <= boundsXMax - padding + 1
       and y >= boundsYMin + padding and y <= boundsYMax - padding + 1
end

function insideCellBounds(x, y, padding)
    if padding == nil then
        return x >= boundsXMin and x <= boundsXMax and y >= boundsYMin and y <= boundsYMax
    end
    return x >= boundsXMin + padding and x <= boundsXMax - padding
       and y >= boundsYMin + padding and y <= boundsYMax - padding
end

function getCornerElevationLevel(x, y)
    if x < boundsXMin or x > boundsXMax + 1 or y < boundsYMin or y > boundsYMax + 1 then return 0 end
    return cellData.elevation[y][x]
end

function getCornerCliffLevel(x, y)
    if x < boundsXMin or x > boundsXMax + 1 or y < boundsYMin or y > boundsYMax + 1 then return 0 end
    return cellData.cliffLevel[y][x]
end

function GetCellTileUid(x, y)
    return insideCellBounds(x, y) and cellData.uid[y][x] or sm.uuid.getNil()
end

-- Cell flags are only ever built from unsigned masks, so they stay inside the
-- non-negative 32-bit range where Lua's native operators match bit's exactly.
function getRoadCliffFlags(x, y)
    if x < boundsXMin or x > boundsXMax or y < boundsYMin or y > boundsYMax then return 0 end
    return cellData.flags[y][x] & maskRoadCliff
end

function isFlat(x, y)
    if x < boundsXMin or x > boundsXMax or y < boundsYMin or y > boundsYMax then return false end
    return (cellData.flags[y][x] & maskFlat) ~= 0
end

function getCellType(x, y)
    if x < boundsXMin or x > boundsXMax or y < boundsYMin or y > boundsYMax then return 0 end
    return (cellData.flags[y][x] & maskTerrainType) >> shiftTerrainType
end

function isLake(x, y)
    return insideCellBounds(x, y) and getCellType(x, y) == TYPE_LAKE
end

function isRoad(x, y)
    if x < boundsXMin or x > boundsXMax or y < boundsYMin or y > boundsYMax then return false end
    return (cellData.flags[y][x] & maskRoads) ~= 0
end
