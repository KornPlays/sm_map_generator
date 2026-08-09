-- Browser terrain catalog. Paths are resolved through tile_metadata.json by
-- the JavaScript host; only layout-relevant fields are retained here.

local tilesById = {}
local legacyIds = {}

local function tileRecord(uid)
    return tilesById[tostring(uid)]
end

function GetPath(uid)
    local tile = tileRecord(uid)
    return tile and tile.path or nil
end

function GetSize(uid)
    local tile = tileRecord(uid)
    return tile and tile.size or nil
end

function GetTerrainType(uid)
    local tile = tileRecord(uid)
    return tile and tile.terrainType or nil
end

function GetPoiType(uid)
    local tile = tileRecord(uid)
    return tile and tile.poiType or nil
end

function GetTileDatabase()
    return tilesById
end

function AddTile(legacyId, path, terrainType, poiType)
    local uid = sm.terrainTile.getTileUuid(path)
    local key = tostring(uid)
    if tilesById[key] == nil then
        tilesById[key] = {
            path = path,
            size = sm.terrainTile.getSize(path),
            terrainType = terrainType or 1,
            poiType = poiType
        }
    end
    if legacyId ~= nil then legacyIds[legacyId] = uid end
    return uid
end

function AddLegacyUpgrade(legacyId, uid)
    legacyIds[legacyId] = uid
end

function GetLegacyUpgrade(legacyId)
    return legacyIds[legacyId]
end
