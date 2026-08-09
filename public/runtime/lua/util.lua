-- Minimal compatibility helpers for the standalone terrain generator.
-- This project-authored file intentionally contains only the small, generic
-- operations the world-layout pipeline calls.

function clamp(value, lower, upper)
    if value < lower then return lower end
    if value > upper then return upper end
    return value
end

function round(value)
    return math.floor(value + 0.5)
end

function min(a, b)
    if a < b then return a end
    return b
end

function max(a, b)
    if a > b then return a end
    return b
end

function isAnyOf(value, choices)
    for _, candidate in pairs(choices) do
        if value == candidate then return true end
    end
    return false
end

function removeFromArray(values, shouldRemove)
    local writeIndex = 1
    for readIndex = 1, #values do
        local value = values[readIndex]
        if not shouldRemove(value) then
            values[writeIndex] = value
            writeIndex = writeIndex + 1
        end
    end
    for index = #values, writeIndex, -1 do values[index] = nil end
    return values
end

function shuffle(values, first, last)
    local lower = first or 1
    local upper = last or #values
    for index = upper, lower + 1, -1 do
        local other = math.random(lower, index)
        values[index], values[other] = values[other], values[index]
    end
    return values
end

function ShouldShow(tags, enabledFlags)
    for _, tag in pairs(tags) do
        local action, flag = string.match(tag, "^ts:([^:]+):(.+)$")
        if action == "show" and enabledFlags[flag] == nil then return false end
        if action == "hide" and enabledFlags[flag] == true then return false end
    end
    return true
end
