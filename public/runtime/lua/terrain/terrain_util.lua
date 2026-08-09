-- Small iteration and distance helpers for the browser-only world grid.

function forEveryCorner(callback, inset)
    local padding = inset or 0
    local bounds = g_cellData.bounds
    for y = bounds.yMin + padding, bounds.yMax - padding + 1 do
        for x = bounds.xMin + padding, bounds.xMax - padding + 1 do callback(x, y) end
    end
end

function forEveryCell(callback, inset)
    local padding = inset or 0
    local bounds = g_cellData.bounds
    for y = bounds.yMin + padding, bounds.yMax - padding do
        for x = bounds.xMin + padding, bounds.xMax - padding do callback(x, y) end
    end
end

function dist2(x0, y0, x1, y1)
    local dx = x0 - x1
    local dy = y0 - y1
    return dx * dx + dy * dy
end

function distance(x0, y0, x1, y1)
    return math.sqrt(dist2(x0, y0, x1, y1))
end
