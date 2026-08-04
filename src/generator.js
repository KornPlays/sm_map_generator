import { intNoise2d, simplexNoise2d } from "./noise.js";
import { LuaJitRandom } from "./luajit-random.js";

const { lauxlib, lua, lualib, to_jsstring, to_luastring } = globalThis.fengari;

const RUNTIME_SOURCES = [
  "data/excavation_world.lua",
  "lua/util.lua",
  "lua/terrain/terrain_util.lua",
  "lua/terrain/terrain_util2.lua",
  "lua/overworld/biome_roads.lua",
  "lua/overworld/celldata.lua",
  "lua/overworld/excavation_island.lua",
  "lua/overworld/generate_cells.lua",
  "lua/overworld/generate_roads.lua",
  "lua/overworld/overworld_util.lua",
  "lua/overworld/poi.lua",
  "lua/overworld/poi_types.lua",
  "lua/overworld/processing.lua",
  "lua/overworld/roads_and_cliffs.lua",
  "lua/overworld/start_area.lua",
  "lua/overworld/tile_database.lua",
  "lua/overworld/type_autumnForest.lua",
  "lua/overworld/type_burntForest.lua",
  "lua/overworld/type_desert.lua",
  "lua/overworld/type_field.lua",
  "lua/overworld/type_forest.lua",
  "lua/overworld/type_lake.lua",
  "lua/overworld/type_meadow.lua",
];

const NIL_UUID = "00000000-0000-0000-0000-000000000000";
let runtimePromise;

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
      const [metadataResponse, sourceEntries] = await Promise.all([
        fetch(publicUrl("runtime/data/tile_metadata.json")),
        Promise.all(RUNTIME_SOURCES.map(async (path) => [path, await fetchText(path)])),
      ]);
      if (!metadataResponse.ok) {
        throw new Error(`Could not load tile metadata (HTTP ${metadataResponse.status})`);
      }
      return {
        metadata: await metadataResponse.json(),
        sources: new Map(sourceEntries),
      };
    })();
  }
  return runtimePromise;
}

function resolveSource(path) {
  const normalized = path.replaceAll("\\", "/");
  if (normalized === "data/excavation_world.lua") return normalized;
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

function luaString(state, index) {
  const value = lua.lua_tostring(state, index);
  return value ? to_jsstring(value) : "";
}

function setFunction(state, name, callback) {
  lua.lua_pushcfunction(state, callback);
  lua.lua_setglobal(state, to_luastring(name));
}

function execute(state, source, name = "browser-bootstrap") {
  const encoded = to_luastring(source);
  const loadStatus = lauxlib.luaL_loadbuffer(
    state,
    encoded,
    encoded.length,
    to_luastring(`@${name}`),
  );
  if (loadStatus !== lua.LUA_OK) throw new Error(luaString(state, -1));
  const callStatus = lua.lua_pcall(state, 0, 0, 0);
  if (callStatus !== lua.LUA_OK) throw new Error(luaString(state, -1));
}

function pushSignedInteger(state, value) {
  lua.lua_pushinteger(state, value | 0);
  return 1;
}

function installCallbacks(state, runtime, random) {
  setFunction(state, "_sm_simplex", (inner) => {
    lua.lua_pushnumber(inner, simplexNoise2d(lua.lua_tonumber(inner, 1), lua.lua_tonumber(inner, 2)));
    return 1;
  });
  setFunction(state, "_sm_int_noise", (inner) => {
    lua.lua_pushnumber(
      inner,
      intNoise2d(
        lua.lua_tonumber(inner, 1),
        lua.lua_tonumber(inner, 2),
        lua.lua_tonumber(inner, 3),
      ),
    );
    return 1;
  });
  setFunction(state, "_sm_tile_uuid", (inner) => {
    const item = runtime.metadata[luaString(inner, 1)];
    lua.lua_pushstring(inner, to_luastring(item?.uid ?? NIL_UUID));
    return 1;
  });
  setFunction(state, "_sm_tile_size", (inner) => {
    const item = runtime.metadata[luaString(inner, 1)];
    lua.lua_pushnumber(inner, item?.size ?? 1);
    return 1;
  });
  setFunction(state, "_sm_source", (inner) => {
    const resolved = resolveSource(luaString(inner, 1));
    let source = resolved ? runtime.sources.get(resolved) : null;
    if (resolved === "lua/overworld/excavation_island.lua" && source) {
      // LuaJIT visits this dense numeric array in index order with pairs().
      // Fengari's table traversal order differs, and the island's neighbor-
      // based group reconstruction depends on the preceding cell. ipairs()
      // expresses the order the shipped data already has explicitly.
      source = source
        .replaceAll("pairs( worldFile.cellData )", "ipairs( worldFile.cellData )")
        .replaceAll("pairs( worldFile.cornerData )", "ipairs( worldFile.cornerData )");
    }
    if (source == null) lua.lua_pushnil(inner);
    else lua.lua_pushstring(inner, to_luastring(source));
    return 1;
  });
  setFunction(state, "_sm_randomseed", (inner) => {
    random.seed(lua.lua_tonumber(inner, 1));
    return 0;
  });
  setFunction(state, "_sm_random", (inner) => {
    const count = lua.lua_gettop(inner);
    let value;
    if (count === 0) value = random.random();
    else if (count === 1) value = random.integer(1, lua.lua_tonumber(inner, 1));
    else value = random.integer(lua.lua_tonumber(inner, 1), lua.lua_tonumber(inner, 2));
    lua.lua_pushnumber(inner, value);
    return 1;
  });

  setFunction(state, "_sm_band", (inner) => {
    let value = -1;
    for (let index = 1; index <= lua.lua_gettop(inner); index += 1) {
      value &= lua.lua_tonumber(inner, index) | 0;
    }
    return pushSignedInteger(inner, value);
  });
  setFunction(state, "_sm_bor", (inner) => {
    let value = 0;
    for (let index = 1; index <= lua.lua_gettop(inner); index += 1) {
      value |= lua.lua_tonumber(inner, index) | 0;
    }
    return pushSignedInteger(inner, value);
  });
  setFunction(state, "_sm_bnot", (inner) => pushSignedInteger(inner, ~lua.lua_tonumber(inner, 1)));
  setFunction(state, "_sm_lshift", (inner) =>
    pushSignedInteger(inner, (lua.lua_tonumber(inner, 1) | 0) << (lua.lua_tonumber(inner, 2) & 31)),
  );
  setFunction(state, "_sm_rshift", (inner) =>
    pushSignedInteger(inner, (lua.lua_tonumber(inner, 1) >>> (lua.lua_tonumber(inner, 2) & 31)) | 0),
  );
  setFunction(state, "_sm_tobit", (inner) => pushSignedInteger(inner, lua.lua_tonumber(inner, 1)));
}

function bootstrap(seed) {
  return `
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

dofile("data/excavation_world.lua")
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
            rows[#rows + 1] = table.concat({
                x, y, tostring(uid), GetSize(uid) or 1,
                g_cellData.rotation[y][x] or 0,
                g_cellData.groupId[y][x] or 0,
                terrainType
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

  const state = lauxlib.luaL_newstate();
  const random = new LuaJitRandom();
  try {
    lualib.luaL_openlibs(state);
    installCallbacks(state, runtime, random);
    execute(state, bootstrap(seed));
    lua.lua_getglobal(state, to_luastring("__RESULT"));
    const result = luaString(state, -1);
    lua.lua_pop(state, 1);
    const cells = result
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [x, y, uid, size, rotation, group, terrainType] = line.split("\t");
        return {
          x: Number(x),
          y: Number(y),
          uid,
          size: Number(size),
          rotation: Number(rotation),
          group: Number(group),
          terrainType: Number(terrainType),
        };
      });
    onProgress(`World layout complete · ${cells.length.toLocaleString()} populated cells`, 32);
    return cells;
  } finally {
    lua.lua_close(state);
  }
}
