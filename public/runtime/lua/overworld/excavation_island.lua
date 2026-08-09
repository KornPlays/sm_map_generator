-- Inserts the fixed excavation sub-world into the generated cell grid.

local function excavationExtent(world)
    local minX, maxX, minY, maxY = 1000, -1000, 1000, -1000
    for _, cell in ipairs(world.cellData) do
        minX, maxX = min(minX, cell.x), max(maxX, cell.x)
        minY, maxY = min(minY, cell.y), max(maxY, cell.y)
    end
    return maxX - minX, maxY - minY
end

local function rotatedCells(cells, rotation)
    if rotation == 0 then return cells end
    local output = {}
    for _, cell in ipairs(cells) do
        local x, y = RotateLocal2(rotation, cell.x, cell.y, -1, -1)
        output[#output + 1] = {
            x = x, y = y, path = cell.path,
            rotation = (cell.rotation + rotation) % 4,
            offsetX = cell.offsetX, offsetY = cell.offsetY
        }
    end
    table.sort(output, function(left, right)
        return left.y < right.y or (left.y == right.y and left.x < right.x)
    end)
    return output
end

function injectExcavation(specification)
    local world = sm.json.open(specification.worldFile)
    local width, height = excavationExtent(world)
    local originX = specification.x + math.ceil(width / 2)
    local originY = specification.y + math.ceil(height / 2)
    world.cellData = rotatedCells(world.cellData, specification.rotation)

    for _, cell in ipairs(world.cellData) do
        local x, y = originX + cell.x, originY + cell.y
        local uid = sm.terrainTile.getTileUuid(cell.path)
        local group = FindGroupIdFromNeighbor(uid, cell, originX, originY)
        if not group then
            g_groupIdCount = g_groupIdCount + 1
            group = g_groupIdCount
        end
        g_cellData.uid[y][x] = uid
        g_cellData.xOffset[y][x], g_cellData.yOffset[y][x] = cell.offsetX, cell.offsetY
        g_cellData.rotation[y][x], g_cellData.groupId[y][x] = cell.rotation, group
    end

    for _, corner in ipairs(world.cornerData) do
        local x, y = originX + corner.x, originY + corner.y
        g_cornerTemp.terrainType[y][x] = corner.type
        g_cellData.elevation[y][x], g_cellData.cliffLevel[y][x] = 0, 0
    end
end
