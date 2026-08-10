-- Shared placement operations for the browser world generator.
--
-- closestPoi and collides are the hottest functions in the pipeline. Both scan
-- every placed POI, and the road and cliff passes call them once per grid cell,
-- so together they run tens of millions of inner iterations per world. They are
-- deliberately written flat: the footprint and distance helpers are inlined, the
-- weight table is built once instead of per call, and the halving uses integer
-- division so it stays a single VM instruction rather than a math.floor call.

local sqrt = math.sqrt

local nearWeights, farWeights

-- Built on first use because the TYPE_ constants come from celldata.lua, which
-- is loaded after this file.
local function poiWeights(earlyRegion)
    if nearWeights == nil then
        nearWeights = {
            [TYPE_MEADOW] = 1,
            [TYPE_FOREST] = 1.6,
            [TYPE_FIELD] = 1.2,
            [TYPE_BURNTFOREST] = 1.6,
            [TYPE_AUTUMNFOREST] = 1.8,
            [TYPE_LAKE] = 2,
            [TYPE_DESERT] = 1
        }
        farWeights = {
            [TYPE_MEADOW] = 1,
            [TYPE_FOREST] = 1,
            [TYPE_FIELD] = 1.2,
            [TYPE_BURNTFOREST] = 1.6,
            [TYPE_AUTUMNFOREST] = 1.8,
            [TYPE_LAKE] = 2,
            [TYPE_DESERT] = 1
        }
    end
    return earlyRegion and nearWeights or farWeights
end

function closestPoi(pois, x, y)
    local weight = poiWeights(x < -8 and y < -8)
    local winner, best = nil, math.huge
    for index = 1, #pois do
        local candidate = pois[index]
        local dx, dy = candidate.x - x, candidate.y - y
        local score = sqrt(dx * dx + dy * dy) * weight[candidate.terrainType] - candidate.size
        if score < best then winner, best = candidate, score end
    end
    return winner, best
end

-- A footprint spans center - size // 2 to center + (size + 1) // 2.
--
-- Every heavy caller sweeps the grid row by row, so collides is asked about one
-- y and one size for a whole row of x in turn. Narrowing the list down to the
-- POIs whose footprint reaches that row, once per row, turns each of those calls
-- from a scan of every placed POI into a handful of tests. The filtered list
-- keeps the original order, and a POI it leaves out cannot overlap the row at
-- all, so the first match found is still the first match in pois.
--
-- The filter is rebuilt whenever the list, the row, the size, or the number of
-- POIs changes. That covers every way pois grows or shrinks; the one place that
-- edits a POI's own x, y or size in place — convertPlaceholderPois — clears it
-- explicitly instead.
-- Kept per query size, because the road pass asks about size 1 and size 3 for
-- the same cell in turn; one shared row would be rebuilt on every call.
local rowCaches = {}

function invalidateCollisionRow()
    rowCaches = {}
end

local function buildCollisionRow(cache, pois, y, size, length)
    local bottom, top = y - size // 2, y + (size + 1) // 2
    local candidates = cache.candidates
    local found = 0
    for index = 1, length do
        local candidate = pois[index]
        local otherSize = candidate.size
        local otherY = candidate.y
        if top > otherY - otherSize // 2 and bottom < otherY + (otherSize + 1) // 2 then
            found = found + 1
            candidates[found] = candidate
        end
    end
    cache.count = found
    cache.pois, cache.y, cache.length = pois, y, length
end

function collides(x, y, size, pois)
    local cache = rowCaches[size]
    if cache == nil then
        cache = { candidates = {}, count = 0, pois = nil, y = nil, length = -1 }
        rowCaches[size] = cache
    end
    local length = #pois
    if cache.pois ~= pois or cache.y ~= y or cache.length ~= length then
        buildCollisionRow(cache, pois, y, size, length)
    end
    local left, right = x - size // 2, x + (size + 1) // 2
    local candidates = cache.candidates
    for index = 1, cache.count do
        local candidate = candidates[index]
        local otherSize = candidate.size
        local otherX = candidate.x
        if right > otherX - otherSize // 2 and left < otherX + (otherSize + 1) // 2 then
            return candidate
        end
    end
    return nil
end

local function rotatedOffset(rotation, x, y, last)
    if rotation == 1 then return y, last - x end
    if rotation == 2 then return last - x, last - y end
    if rotation == 3 then return last - y, x end
    return x, y
end

function writeTile(uid, originX, originY, size, rotation, terrainType)
    assert(type(uid) == "Uuid")
    g_groupIdCount = g_groupIdCount + 1
    for localY = 0, size - 1 do
        for localX = 0, size - 1 do
            local x, y = originX + localX, originY + localY
            local offsetX, offsetY = rotatedOffset(rotation, localX, localY, size - 1)
            g_cellData.uid[y][x] = uid
            g_cellData.xOffset[y][x], g_cellData.yOffset[y][x] = offsetX, offsetY
            g_cellData.rotation[y][x], g_cellData.groupId[y][x] = rotation, g_groupIdCount
            if terrainType then
                local preserved = bit.band(g_cellData.flags[y][x], bit.bnot(MASK_TERRAINTYPE))
                local encoded = bit.band(bit.lshift(terrainType, SHIFT_TERRAINTYPE), MASK_TERRAINTYPE)
                g_cellData.flags[y][x] = bit.bor(preserved, encoded)
            end
        end
    end
end

function writePoi(poi, padding)
    local variation = poi.index and poi.index - 1 or sm.noise.intNoise2d(poi.x, poi.y, g_cellData.seed + 2854)
    local uid = getRandomPoiTileId(poi.type, variation)
    local rotation = poi.rotation or (sm.noise.intNoise2d(poi.x, poi.y, g_cellData.seed + 9439) % 4)
    assert(uid ~= -1, "Unknown POI type")
    local x, y = poi.x - math.floor(poi.size / 2), poi.y - math.floor(poi.size / 2)
    if insideCellBounds(x, y, padding) and insideCellBounds(x + poi.size - 1, y + poi.size - 1, padding) then
        writeTile(uid, x, y, poi.size, rotation, math.floor(poi.type / 100))
    else
        sm.log.warning("POI outside generated bounds")
    end
end

function ddSphere() end
function ddBox() end
function ddArrow() end
function ddDownArrow() end
