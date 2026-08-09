import { simplexNoise2d } from "./noise.js";
import { FAST_PATH_PRELUDE } from "./lua-fastpath.js";
import { LuaFactory, LuaLibraries } from "wasmoon";
import { installPoiTypes, POI_TYPES } from "./world-generation/poi-types.js";

const RUNTIME_SOURCES = [
  "lua/util.lua",
  "lua/terrain/terrain_util.lua",
  "lua/terrain/terrain_util2.lua",
  "lua/overworld/biome_roads.lua",
  "lua/overworld/celldata.lua",
  "lua/overworld/excavation_island.lua",
  "lua/overworld/generate_cells.lua",
  "lua/overworld/generate_roads.lua",
  "lua/overworld/overworld_util.lua",
  "lua/overworld/processing.lua",
  "lua/overworld/tile_database.lua",
];

const NIL_UUID = "00000000-0000-0000-0000-000000000000";
let runtimePromise;
let luaFactory;

function publicUrl(path) {
  const baseUrl =
    globalThis.__SM_MAP_BASE_URL ??
    (typeof document !== "undefined" ? document.baseURI : globalThis.location?.href);
  if (!baseUrl) throw new Error("Could not resolve the bundled map data.");
  return new URL(path, baseUrl);
}

async function fetchText(path) {
  const response = await fetch(publicUrl(`runtime/${path}`));
  if (!response.ok) throw new Error(`Could not load ${path} (HTTP ${response.status})`);
  return response.text();
}

async function loadRuntime() {
  if (!runtimePromise) {
    runtimePromise = (async () => {
      const [metadataResponse, terrainRulesResponse, roadCliffRulesResponse, poiCatalogResponse, startAreaResponse, excavationWorldResponse, sourceEntries] = await Promise.all([
        fetch(publicUrl("runtime/data/tile_metadata.json")),
        fetch(publicUrl("runtime/data/terrain-rules.json")),
        fetch(publicUrl("runtime/data/road-cliff-rules.json")),
        fetch(publicUrl("runtime/data/poi-catalog.json")),
        fetch(publicUrl("runtime/data/start-area.json")),
        fetch(publicUrl("runtime/data/excavation-world.json")),
        Promise.all(RUNTIME_SOURCES.map(async (path) => [path, await fetchText(path)])),
      ]);
      if (!metadataResponse.ok) {
        throw new Error(`Could not load tile metadata (HTTP ${metadataResponse.status})`);
      }
      if (!terrainRulesResponse.ok) {
        throw new Error(`Could not load terrain rules (HTTP ${terrainRulesResponse.status})`);
      }
      if (!roadCliffRulesResponse.ok) {
        throw new Error(`Could not load road/cliff rules (HTTP ${roadCliffRulesResponse.status})`);
      }
      if (!poiCatalogResponse.ok) {
        throw new Error(`Could not load POI catalog (HTTP ${poiCatalogResponse.status})`);
      }
      if (!startAreaResponse.ok) {
        throw new Error(`Could not load start-area data (HTTP ${startAreaResponse.status})`);
      }
      if (!excavationWorldResponse.ok) {
        throw new Error(`Could not load excavation data (HTTP ${excavationWorldResponse.status})`);
      }
      return {
        metadata: await metadataResponse.json(),
        terrainRules: await terrainRulesResponse.json(),
        roadCliffRules: await roadCliffRulesResponse.json(),
        poiCatalog: await poiCatalogResponse.json(),
        startArea: await startAreaResponse.json(),
        excavationWorld: await excavationWorldResponse.json(),
        sources: new Map(sourceEntries),
      };
    })();
  }
  return runtimePromise;
}

function resolveSource(path) {
  const normalized = path.replaceAll("\\", "/");
  const prefix = "$SURVIVAL_DATA/Scripts/";
  if (normalized.startsWith(prefix)) {
    const relative = normalized.slice(prefix.length);
    if (relative === "util.lua") return "lua/util.lua";
    if (relative.startsWith("terrain/overworld/")) return `lua/overworld/${relative.slice(18)}`;
    if (relative === "terrain/terrain_util.lua" || relative === "terrain/terrain_util2.lua") {
      return `lua/${relative}`;
    }
    return null;
  }
  if (!normalized.includes("/")) return `lua/overworld/${normalized}`;
  return normalized;
}

function instrumentSource(resolved, source) {
  if (resolved === "lua/overworld/generate_roads.lua") {
    return source
      .replace("\t\tlocal roadCells = {}\n", "")
      .replaceAll("\t\troadCells[#roadCells + 1] = { x = n.x, y = n.y }\n", "")
      .replace("\t\troadCells[#roadCells + 1] = { x = b.x, y = b.y }\n", "");
  }
  if (resolved !== "lua/overworld/generate_cells.lua") return source;
  return source
    .replace(
      "local roadNodes = drawRoads( roadEdges, pois )",
      `collectgarbage("collect")
	local roadNodes = drawRoads( roadEdges, pois )
	for _, roadPoi in ipairs( roadPois ) do
		roadPoi.edges = nil
		roadPoi.dist = nil
	end
	roadPois = nil
	roadEdges = nil
	roadDestinations = nil
	collectgarbage("collect")`,
    )
    .replace(
      'print( "Random road pois:", randomRoadPoiCount )\n\n\t------------------------------------------------------------------------------------------------\n\n\t-- Elevation (hills)',
      `print( "Random road pois:", randomRoadPoiCount )
	roadNodes = nil
	collectgarbage("collect")

	------------------------------------------------------------------------------------------------

	-- Elevation (hills)`,
    )
    .replace(
      "preparePoiRoadGraph( pois, roadPois )",
      '_sm_progress("Connecting the main roads…", 20)\n\tcollectgarbage("collect")\n\tpreparePoiRoadGraph( pois, roadPois )',
    )
    .replace(
      "writeStartArea( pois, roadNodes )",
      '_sm_progress("Placing landmarks and the starting area…", 22)\n\twriteStartArea( pois, roadNodes )',
    )
    .replace(
      "evaluateRoadsAndCliffs( roadNodes )",
      '_sm_progress("Choosing road and cliff tiles…", 24)\n\tevaluateRoadsAndCliffs( roadNodes )',
    )
    .replace(
      "addBorderingMeadows()",
      '_sm_progress("Connecting biome roads…", 26)\n\taddBorderingMeadows()',
    )
    .replace(
      "addExtraPois( pois, padding )",
      '_sm_progress("Placing remaining points of interest…", 29)\n\taddExtraPois( pois, padding )',
    )
    .replace(
      "evaluateType( TYPE_MEADOW, getMeadowTileIdAndRotation )",
      '_sm_progress("Choosing terrain tiles…", 30)\n\tevaluateType( TYPE_MEADOW, getMeadowTileIdAndRotation )',
    );
}

function installCallbacks(engine, runtime, onProgress) {
  installPoiTypes((name, value) => engine.global.set(name, value));
  engine.global.set("_sm_simplex", (x, y) => simplexNoise2d(x, y));
  engine.global.set("_sm_tile_uuid", (path) => runtime.metadata[path]?.uid ?? NIL_UUID);
  engine.global.set("_sm_tile_size", (path) => runtime.metadata[path]?.size ?? 1);
  engine.global.set("_sm_source", (path) => {
    const resolved = resolveSource(path);
    let source = resolved ? runtime.sources.get(resolved) : null;
    if (resolved === "lua/overworld/excavation_island.lua" && source) {
      // The excavation reconstruction depends on the source array order.
      source = source
        .replaceAll("pairs( worldFile.cellData )", "ipairs( worldFile.cellData )")
        .replaceAll("pairs( worldFile.cornerData )", "ipairs( worldFile.cornerData )");
    }
    return source == null ? undefined : instrumentSource(resolved, source);
  });
  engine.global.set("_sm_progress", (message, percent) => onProgress(message, percent));
}

function terrainRulePrelude(manifest) {
  const definitions = [];
  const functions = [];
  for (const [name, rule] of Object.entries(manifest.types)) {
    const entries = Object.entries(rule.entries).map(([flags, entry]) => {
      const tiles = entry.tiles.map((tile) =>
        `{ ${tile.id}, ${JSON.stringify(tile.path)}, ${tile.terrainType} }`
      ).join(",");
      const rotation = entry.rotation == null ? "false" : entry.rotation;
      return `[${flags}] = { rotation = ${rotation}, tiles = { ${tiles} } }`;
    }).join(",\n");
    definitions.push(`${name} = { ${entries} }`);
    functions.push(`
function init${rule.functionSuffix}Tiles()
    browserTerrainInit(${JSON.stringify(name)})
end
function get${rule.functionSuffix}TileIdAndRotation(flags, variationNoise, rotationNoise)
    return browserTerrainSelect(${JSON.stringify(name)}, flags, variationNoise, rotationNoise)
end`);
  }
  return `
local browserTerrainRules = { ${definitions.join(",\n")} }
local browserTerrainTiles = {}

local function browserTerrainInit(name)
    local output = {}
    for flags, entry in pairs(browserTerrainRules[name]) do
        local candidates = {}
        for _, tile in ipairs(entry.tiles) do
            candidates[#candidates + 1] = AddTile(tile[1], tile[2], tile[3])
        end
        output[flags] = { rotation = entry.rotation, tiles = candidates }
    end
    browserTerrainTiles[name] = output
end

local function browserTerrainSelect(name, flags, variationNoise, rotationNoise)
    local entry = browserTerrainTiles[name] and browserTerrainTiles[name][flags]
    if flags == 0 or entry == nil then return sm.uuid.getNil(), 0 end
    local count = #entry.tiles
    if count == 0 then return ERROR_TILE_UUID, 0 end
    local rotation = flags == 15 and (rotationNoise % 4) or entry.rotation
    return entry.tiles[variationNoise % count + 1], rotation
end
${functions.join("\n")}
`;
}

function roadCliffRulePrelude(manifest) {
  const entries = Object.entries(manifest.entries).map(([flags, entry]) => {
    const tiles = entry.tiles.map((tile) => `{ ${tile.id}, ${JSON.stringify(tile.path)} }`).join(",");
    return `[${flags}] = { rotation = ${entry.rotation}, tiles = { ${tiles} } }`;
  }).join(",\n");
  return `
local browserRoadCliffRules = { ${entries} }
local browserRoadCliffTiles = {}

function calculateCliffBits(se, sw, nw, ne)
    local lowest = math.min(math.min(se, sw), math.min(nw, ne))
    local function relative(value) return sm.util.clamp(value - lowest, 0, 3) end
    return bit.bor(bit.lshift(relative(se), 6), bit.lshift(relative(sw), 4),
        bit.lshift(relative(nw), 2), relative(ne))
end

function calculateRoadBits(south, west, north, east)
    return (east and FLAG_ROAD_E or 0) + (north and FLAG_ROAD_N or 0)
        + (west and FLAG_ROAD_W or 0) + (south and FLAG_ROAD_S or 0)
end

function initRoadAndCliffTiles()
    browserRoadCliffTiles = {}
    for flags, rule in pairs(browserRoadCliffRules) do
        local candidates = {}
        for _, tile in ipairs(rule.tiles) do
            candidates[#candidates + 1] = AddTile(tile[1], tile[2])
        end
        browserRoadCliffTiles[flags] = { rotation = rule.rotation, tiles = candidates }
    end
end

function getCliffRoadTileIdAndRotation(flags, variationNoise)
    if flags <= 0 then return sm.uuid.getNil(), 0 end
    local item = browserRoadCliffTiles[flags]
    if item == nil or #item.tiles == 0 then item = browserRoadCliffTiles[bit.band(flags, MASK_CLIFF)] end
    if item == nil or #item.tiles == 0 then return ERROR_TILE_UUID, 0 end
    return item.tiles[variationNoise % #item.tiles + 1], item.rotation
end
`;
}

function poiCatalogPrelude(manifest) {
  const entries = manifest.entries.map((entry) => {
    const type = POI_TYPES[entry.type];
    if (!Number.isInteger(type)) throw new Error(`Unknown POI type in catalog: ${entry.type}`);
    const legacyId = entry.legacyIndex == null ? "false" : type * 100 + entry.legacyIndex;
    const terrainType = entry.terrainType == null ? "false" : Number(entry.terrainType);
    return `{ ${type}, ${legacyId}, ${JSON.stringify(entry.path)}, ${terrainType} }`;
  }).join(",\n");
  return `
local browserPoiCatalog = { ${entries} }
local browserPoiTiles = {}

function initPoiTiles()
    browserPoiTiles = {}
    for _, definition in ipairs(browserPoiCatalog) do
        local poiType, legacyId, path, terrainType = definition[1], definition[2], definition[3], definition[4]
        browserPoiTiles[poiType] = browserPoiTiles[poiType] or {}
        local uid = AddTile(legacyId or nil, path, terrainType or nil, poiType)
        browserPoiTiles[poiType][#browserPoiTiles[poiType] + 1] = uid
    end
end

function getPoiTileId(poiType, index)
    return browserPoiTiles[poiType][index]
end

function getRandomPoiTileId(poiType, noise)
    local candidates = browserPoiTiles[poiType]
    if candidates == nil or #candidates == 0 then return ERROR_TILE_UUID, 0 end
    return candidates[noise % #candidates + 1]
end
`;
}

function luaLiteral(value) {
  if (value == null) return "nil";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `{ ${value.map(luaLiteral).join(", ")} }`;
  return `{ ${Object.entries(value).map(([key, item]) => `${key} = ${luaLiteral(item)}`).join(", ")} }`;
}

function startAreaPrelude(manifest) {
  return `
local browserStartArea = ${luaLiteral(manifest)}

function writeStartArea(pois, roadNodes)
    local originX, originY = browserStartArea.origin[1], browserStartArea.origin[2]
    for _, placement in ipairs(browserStartArea.placements) do
        writeTile(getPoiTileId(POI_CRASHSITE_AREA, placement.tileIndex),
            originX + placement.x, originY + placement.y, placement.size, placement.rotation)
        if placement.poiIndex then
            pois[#pois + 1] = {
                x = originX + placement.x + math.floor(placement.size / 2),
                y = originY + placement.y + math.floor(placement.size / 2),
                type = POI_CRASHSITE_AREA, index = placement.poiIndex,
                size = placement.size, flat = true
            }
        end
    end

    for localY = 0, 16 do
        for localX = 0, 20 do
            local x, y = originX + localX, originY + localY
            g_cornerTemp.terrainType[y][x] = browserStartArea.terrain[17 - localY][localX + 1]
            g_cellData.cliffLevel[y][x] = browserStartArea.cliffs[17 - localY][localX + 1]
        end
    end

    for localY = 0, 15 do
        for localX = 0, 19 do
            local x, y = originX + localX, originY + localY
            if browserStartArea.roadCells[16 - localY][localX + 1] then
                roadNodes[y][x] = { x = x, y = y, edges = {} }
            end
            if browserStartArea.staticCells[16 - localY][localX + 1] then
                g_cornerTemp.hillyness[y][x], g_cornerTemp.hillyness[y][x + 1] = 0, 0
                g_cornerTemp.hillyness[y + 1][x], g_cornerTemp.hillyness[y + 1][x + 1] = 0, 0
            else
                g_cellData.uid[y][x] = sm.uuid.getNil()
                g_cellData.xOffset[y][x], g_cellData.yOffset[y][x] = 0, 0
                g_cellData.rotation[y][x], g_cellData.groupId[y][x] = 0, 0
            end
        end
    end

    for y = originY, originY + 15 do
        for x = originX, originX + 19 do
            local current, east, north = roadNodes[y][x], roadNodes[y][x + 1], roadNodes[y + 1][x]
            if current and east then
                current.edges[#current.edges + 1] = { n = east, cost = 1, road = true }
                east.edges[#east.edges + 1] = { n = current, cost = 1, road = true }
            end
            if current and north then
                current.edges[#current.edges + 1] = { n = north, cost = 1, road = true }
                north.edges[#north.edges + 1] = { n = current, cost = 1, road = true }
            end
        end
    end
end
`;
}

function bootstrap(seed, terrainRules, roadCliffRules, poiCatalog, startArea, excavationWorld) {
  return `
${FAST_PATH_PRELUDE}

local realType = type
local nilUuidString = "${NIL_UUID}"
local uuidCache = {}
local uuidMeta = { __tostring = function(self) return self.value end }
local function makeUuid(value)
    value = value or nilUuidString
    if not uuidCache[value] then
        local item = { value = value, __uuid = true }
        item.isNil = function(self) return self.value == nilUuidString end
        uuidCache[value] = setmetatable(item, uuidMeta)
    end
    return uuidCache[value]
end
function type(value)
    if realType(value) == "table" and value.__uuid then return "Uuid" end
    return realType(value)
end

unpack = table.unpack
math.atan2 = math.atan
math.random = _sm_random
math.randomseed = _sm_randomseed
bit = {
    band = _sm_band,
    bor = _sm_bor,
    bnot = _sm_bnot,
    lshift = _sm_lshift,
    rshift = _sm_rshift,
    tobit = _sm_tobit
}

CELL_SIZE = 64
GRAPHICS_CELL_PADDING = 8
EXCAVATION_WORLD = ${luaLiteral(excavationWorld)}
sm = {
    noise = {
        simplexNoise2d = _sm_simplex,
        intNoise2d = _sm_int_noise,
        perlinNoise2d = function(...) return 0 end
    },
    uuid = {
        new = makeUuid,
        getNil = function() return makeUuid(nilUuidString) end,
        isNil = function(value) return value == nil or value:isNil() end
    },
    terrainTile = {
        getTileUuid = function(path) return makeUuid(_sm_tile_uuid(path)) end,
        getSize = _sm_tile_size
    },
    json = { open = function(path) return EXCAVATION_WORLD end },
    util = { clamp = function(value, lo, hi) return math.min(math.max(value, lo), hi) end },
    log = { info = function() end, warning = function() end, error = function() end },
    debugDraw = { clear = function() end }
}

function dofile(path)
    local source = _sm_source(path)
    if source == nil then return nil end
    local chunk, message = load(source, "@" .. path)
    if not chunk then error(message) end
    return chunk()
end

${terrainRulePrelude(terrainRules)}
${roadCliffRulePrelude(roadCliffRules)}
${poiCatalogPrelude(poiCatalog)}
${startAreaPrelude(startArea)}

print = function() end
dofile("$SURVIVAL_DATA/Scripts/terrain/overworld/generate_cells.lua")
initRoadAndCliffTiles()
initMeadowTiles()
initForestTiles()
initFieldTiles()
initBurntForestTiles()
initAutumnForestTiles()
initLakeTiles()
initDesertTiles()
initPoiTiles()
initBiomeRoadTiles()
for _, cell in pairs(EXCAVATION_WORLD.cellData) do
    if cell.path and cell.path ~= "" then AddTile(nil, cell.path, nil, nil) end
end
generateOverworldCelldata(-72, 71, -56, 55, ${seed}, nil, 8)

local rows = {}
for y = -48, 47 do
    for x = -64, 63 do
        local uid = g_cellData.uid[y][x]
        if uid and not uid:isNil() then
            local flags = g_cellData.flags[y][x] or 0
            local terrainType = bit.rshift(bit.band(flags, MASK_TERRAINTYPE), SHIFT_TERRAINTYPE)
            local size = GetSize(uid) or 1
            local rotation = g_cellData.rotation[y][x] or 0
            local offsetX = g_cellData.xOffset[y][x] or 0
            local offsetY = g_cellData.yOffset[y][x] or 0
            local last = size - 1
            local localX, localY = offsetX, offsetY
            if rotation == 1 then
                localX, localY = last - offsetY, offsetX
            elseif rotation == 2 then
                localX, localY = last - offsetX, last - offsetY
            elseif rotation == 3 then
                localX, localY = offsetY, last - offsetX
            end
            rows[#rows + 1] = table.concat({
                x, y, tostring(uid), size, rotation,
                g_cellData.groupId[y][x] or 0,
                terrainType, x - localX, y - localY
            }, "\\t")
        end
    end
end
__RESULT = table.concat(rows, "\\n")
`;
}

export async function generateCells(seed, onProgress = () => {}) {
  onProgress("Loading the Chapter 2 world rules…", 8);
  const runtime = await loadRuntime();
  onProgress("Generating roads, biomes, islands, and POIs…", 18);
  await new Promise((resolve) => setTimeout(resolve, 0));

  luaFactory ??= new LuaFactory(publicUrl("vendor/wasmoon.wasm").href);
  const engine = await luaFactory.createEngine({
    enableProxy: false,
    openStandardLibs: false,
  });
  engine.global.loadLibrary(LuaLibraries.Base);
  engine.global.loadLibrary(LuaLibraries.Table);
  engine.global.loadLibrary(LuaLibraries.String);
  engine.global.loadLibrary(LuaLibraries.Math);
  try {
    installCallbacks(engine, runtime, onProgress);
    await engine.doString(bootstrap(
      seed,
      runtime.terrainRules,
      runtime.roadCliffRules,
      runtime.poiCatalog,
      runtime.startArea,
      runtime.excavationWorld,
    ));
    const result = engine.global.get("__RESULT") || "";
    const cells = result
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [x, y, uid, size, rotation, group, terrainType, originX, originY] = line.split("\t");
        return {
          x: Number(x),
          y: Number(y),
          uid,
          size: Number(size),
          rotation: Number(rotation),
          group: Number(group),
          terrainType: Number(terrainType),
          originX: Number(originX),
          originY: Number(originY),
        };
      });
    onProgress(`World layout complete · ${cells.length.toLocaleString()} populated cells`, 32);
    return cells;
  } finally {
    engine.global.close();
  }
}
