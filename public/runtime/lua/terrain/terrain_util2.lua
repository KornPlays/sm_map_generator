-- Minimal grid helpers needed when the excavation island is inserted into the
-- generated overworld. Rendering, physics, storage, and game-object helpers are
-- deliberately outside the browser generator.

function InsideCellBounds(x, y)
    local bounds = g_cellData.bounds
    return x >= bounds.xMin and x <= bounds.xMax and y >= bounds.yMin and y <= bounds.yMax
end

function RotateLocal2(turns, x, y, width, height)
    if turns == 1 then return height - y, x end
    if turns == 2 then return width - x, height - y end
    if turns == 3 then return y, width - x end
    return x, y
end

function InverseRotateLocal2(turns, x, y, width, height)
    if turns == 1 then return y, width - x end
    if turns == 2 then return width - x, height - y end
    if turns == 3 then return height - y, x end
    return x, y
end

function FindGroupIdFromNeighbor(uid, cell, offsetX, offsetY)
    local originX = offsetX or 0
    local originY = offsetY or 0
    for deltaY = 0, -1, -1 do
        for deltaX = -3, 3 do
            if deltaX ~= 0 or deltaY ~= 0 then
                local x = cell.x + originX + deltaX
                local y = cell.y + originY + deltaY
                if InsideCellBounds(x, y)
                    and g_cellData.uid[y][x] == uid
                    and g_cellData.rotation[y][x] == cell.rotation then
                    local localX, localY = InverseRotateLocal2(cell.rotation, deltaX, deltaY, 0, 0)
                    if g_cellData.xOffset[y][x] == cell.offsetX + localX
                        and g_cellData.yOffset[y][x] == cell.offsetY + localY then
                        return g_cellData.groupId[y][x]
                    end
                end
            end
        end
    end
    return nil
end
