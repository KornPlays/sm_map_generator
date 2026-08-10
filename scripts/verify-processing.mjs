// Cross-checks src/world-generation/processing.js against the real
// processing.lua (plus the celldata/terrain_util modules it depends on),
// running both over identical randomized grid state.
//
// Usage: node scripts/verify-processing.mjs

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { LuaFactory, LuaLibraries } from "wasmoon";

import { FAST_PATH_PRELUDE } from "../src/lua-fastpath.js";
import { CellData } from "../src/world-generation/cell-data.js";
import { CollisionIndex } from "../src/world-generation/placement.js";
import { LuaJitRandom } from "../src/world-generation/lua-compat.js";
import { RoadNodeGrid } from "../src/world-generation/road-graph.js";
import {
  PoiSelector, convertPlaceholderPois, flattenPoiCliff, addBorderingMeadows,
  enforceCliffRoadLimitations, evaluateRoadsAndCliffs, setForcedAndLakeAdjacentPoiHillynessToZero,
  smoothPoiElevation, flattenPoiElevation, uniformSquare, placeTerrainCompatible,
  addExtraPois, evaluateType,
} from "../src/world-generation/processing.js";
import { intNoise2d } from "../src/world-generation/lua-compat.js";
import { writeTile } from "../src/world-generation/placement.js";
import { POI_TYPES } from "../src/world-generation/poi-types.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const luaDir = resolve(root, "public/runtime/lua");

// A small bounded grid keeps every test fast while still exercising the loop
// shapes (padding, negative coordinates, corner-vs-cell offsets) the real
// generator uses.
const X_MIN = -20, X_MAX = 19, Y_MIN = -15, Y_MAX = 14, PADDING = 3, SEED = 760487397;

let streamState = 0x9e3779b9 >>> 0;
function nextInput() {
  streamState = (Math.imul(streamState, 1664525) + 1013904223) >>> 0;
  return streamState;
}
function nextRange(n) { return nextInput() % n; }

const factory = new LuaFactory(pathToFileURL(resolve(root, "public/vendor/wasmoon.wasm")).href);
const engine = await factory.createEngine({ enableProxy: false, openStandardLibs: false });
engine.global.loadLibrary(LuaLibraries.Base);
engine.global.loadLibrary(LuaLibraries.Table);
engine.global.loadLibrary(LuaLibraries.String);
engine.global.loadLibrary(LuaLibraries.Math);

const metadata = {};
engine.global.set("_sm_tile_uuid", (path) => metadata[path]?.uid ?? "00000000-0000-0000-0000-000000000000");
engine.global.set("_sm_tile_size", () => 1);
await engine.doString(FAST_PATH_PRELUDE);
await engine.doString(`
local realType = type
local nilUuidString = "00000000-0000-0000-0000-000000000000"
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
function type(value) if realType(value) == "table" and value.__uuid then return "Uuid" end return realType(value) end
math.random = _sm_random
math.randomseed = _sm_randomseed
bit = { band = _sm_band, bor = _sm_bor, bnot = _sm_bnot, lshift = _sm_lshift, rshift = _sm_rshift, tobit = _sm_tobit }
sm = {
  noise = { simplexNoise2d = function() return 0 end, intNoise2d = _sm_int_noise, perlinNoise2d = function() return 0 end },
  uuid = { new = makeUuid, getNil = function() return makeUuid(nilUuidString) end, isNil = function(v) return v == nil or v:isNil() end },
  terrainTile = { getTileUuid = function(p) return makeUuid(_sm_tile_uuid(p)) end, getSize = _sm_tile_size },
  log = { info = function() end, warning = function() end, error = function() end },
  debugDraw = { clear = function() end },
  json = { open = function() return nil end },
  util = { clamp = function(v, lo, hi) return math.min(math.max(v, lo), hi) end },
}
print = function() end
ERROR_TILE_UUID = sm.uuid.new("723268d4-8d59-4500-a433-7d900b61c29c")
${Object.entries(POI_TYPES).map(([name, value]) => `POI_${name} = ${value}`).join("\n")}
function ddSphere() end
function ddBox() end
function ddArrow() end
function ddDownArrow() end
-- Normally injected by the JS host's roadCliffRulePrelude at bootstrap time;
-- reproduced here exactly since evaluateRoadsAndCliffs calls them directly.
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
`);
// The real files dofile each other by name (celldata.lua -> tile_database.lua,
// processing.lua -> $SURVIVAL_DATA/.../celldata.lua etc). Everything it can ask
// for is loaded standalone below in dependency order first, so dofile becomes a
// once-only no-op for paths already satisfied and a direct load for the rest.
const luaSources = {
  "tile_database.lua": await readFile(resolve(luaDir, "overworld/tile_database.lua"), "utf8"),
  "$SURVIVAL_DATA/Scripts/util.lua": await readFile(resolve(luaDir, "util.lua"), "utf8"),
  "$SURVIVAL_DATA/Scripts/terrain/terrain_util.lua": await readFile(resolve(luaDir, "terrain/terrain_util.lua"), "utf8"),
  "$SURVIVAL_DATA/Scripts/terrain/terrain_util2.lua": await readFile(resolve(luaDir, "terrain/terrain_util2.lua"), "utf8"),
  "$SURVIVAL_DATA/Scripts/terrain/overworld/celldata.lua": await readFile(resolve(luaDir, "overworld/celldata.lua"), "utf8"),
  "$SURVIVAL_DATA/Scripts/terrain/overworld/excavation_island.lua": await readFile(resolve(luaDir, "overworld/excavation_island.lua"), "utf8"),
};
const alreadyLoaded = new Set();
engine.global.set("_sm_source_for_dofile", (path) => luaSources[path] ?? null);
await engine.doString(`
function dofile(path)
  local source = _sm_source_for_dofile(path)
  if source == nil then return nil end
  local chunk, message = load(source, "@" .. path)
  if not chunk then error(message) end
  return chunk()
end
`);
for (const [path, source] of Object.entries(luaSources)) {
  if (path === "tile_database.lua") continue; // loaded lazily by celldata.lua's own dofile
  // eslint-disable-next-line no-await-in-loop
  await engine.doString(source);
  alreadyLoaded.add(path);
}
await engine.doString(await readFile(resolve(luaDir, "overworld/overworld_util.lua"), "utf8"));
// A handful of processing.lua's helpers are declared `local function` and are
// only reachable through the public functions that close over them. Promoting
// them to globals here does not change their behavior — Lua resolves the
// in-file calls the same way either way — it just makes them independently
// testable from outside the chunk.
const processingSource = (await readFile(resolve(luaDir, "overworld/processing.lua"), "utf8"))
  .replace("local function choosePoi(", "function choosePoi(")
  .replace("local function rewindPoi(", "function rewindPoi(")
  .replace("local function uniformSquare(", "function uniformSquare(")
  .replace("local function placeTerrainCompatible(", "function placeTerrainCompatible(")
  .replace(
    "local nextPoi = {}\nfor terrainType, _ in pairs(poiRotation) do nextPoi[terrainType] = {1,1} end",
    "nextPoi = {}\nfunction resetNextPoi() for terrainType, _ in pairs(poiRotation) do nextPoi[terrainType] = {1,1} end end\nresetNextPoi()",
  );
await engine.doString(processingSource);

const failures = [];
const note = (text) => { if (failures.length < 15) failures.push(text); };
let checkCount = 0;
function checkEqual(label, lua, js) {
  checkCount += 1;
  if (lua !== js) note(`${label} -> lua ${lua}, js ${js}`);
}

// --- shared randomized grid setup -------------------------------------------
async function freshGrids(bounds = { xMin: X_MIN, xMax: X_MAX, yMin: Y_MIN, yMax: Y_MAX }) {
  const { xMin: gXMin, xMax: gXMax, yMin: gYMin, yMax: gYMax } = bounds;
  const cellData = new CellData();
  cellData.initialize(gXMin, gXMax, gYMin, gYMax, SEED, PADDING);

  const cornerTerrain = [];
  const cliffLevel = [];
  const elevation = [];
  const hillyness = [];
  const lakeAdjacent = [];
  const forceFlat = [];
  for (let y = gYMin; y <= gYMax + 1; y += 1) {
    for (let x = gXMin; x <= gXMax + 1; x += 1) {
      const terrain = 1 + nextRange(6); // TYPE_MEADOW..TYPE_AUTUMNFOREST, plus occasional 8 below
      const finalTerrain = nextRange(10) === 0 ? 8 : terrain;
      const index = cellData.cornerIndex(x, y);
      cellData.cornerTerrainType[index] = finalTerrain;
      cellData.cliffLevel[index] = nextRange(9) - 4;
      cellData.elevation[index] = nextRange(2000) / 100 - 10;
      cellData.cornerHillyness[index] = nextRange(100) / 100;
      cellData.cornerLakeAdjacent[index] = nextRange(5) === 0 ? 1 : 0;
      cellData.cornerForceFlat[index] = nextRange(8) === 0 ? 1 : 0;
      cornerTerrain.push([x, y, finalTerrain]);
      cliffLevel.push([x, y, cellData.cliffLevel[index]]);
      elevation.push([x, y, cellData.elevation[index]]);
      hillyness.push([x, y, cellData.cornerHillyness[index]]);
      lakeAdjacent.push([x, y, cellData.cornerLakeAdjacent[index]]);
      forceFlat.push([x, y, cellData.cornerForceFlat[index]]);
    }
  }
  const flags = [];
  for (let y = gYMin; y <= gYMax; y += 1) {
    for (let x = gXMin; x <= gXMax; x += 1) {
      const index = cellData.cellIndex(x, y);
      if (nextRange(6) === 0) cellData.flags[index] = 0x0f00 & (nextInput() | 0);
      flags.push([x, y, cellData.flags[index]]);
    }
  }

  // A handful of road nodes with edges, so clampRoadCell/evaluateRoadsAndCliffs
  // exercise their road-aware branches.
  const roadNodes = new RoadNodeGrid(cellData);
  const roadCells = [];
  for (let index = 0; index < 40; index += 1) {
    const x = gXMin + nextRange(cellData.cellWidth);
    const y = gYMin + nextRange(cellData.cellHeight);
    roadNodes.ensure(x, y);
    roadCells.push([x, y]);
  }
  for (const [x, y] of roadCells) {
    const node = roadNodes.get(x, y);
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (const [dx, dy] of dirs) {
      if (nextRange(2) !== 0) continue;
      const other = roadNodes.get(x + dx, y + dy);
      if (!other) continue;
      const road = nextRange(4) !== 0;
      if (!node.edges.some((e) => e.n === other)) node.edges.push({ n: other, cost: 1, road });
      if (!other.edges.some((e) => e.n === node)) other.edges.push({ n: node, cost: 1, road });
    }
  }

  return { cellData, roadNodes, roadCells, dumps: { cornerTerrain, cliffLevel, elevation, hillyness, lakeAdjacent, forceFlat, flags } };
}

async function pushGridToLua(dumps, roadCells, bounds = { xMin: X_MIN, xMax: X_MAX, yMin: Y_MIN, yMax: Y_MAX }) {
  const { xMin: gXMin, xMax: gXMax, yMin: gYMin, yMax: gYMax } = bounds;
  const lit = (rows) => rows.map(([x, y, v]) => `[${x}]=[${y}]=${v}`).join(","); // placeholder, unused
  // initializeCellData is the real celldata.lua entry point: it is what
  // refreshes that module's cached bounds/table upvalues, which a hand-built
  // g_cellData table would leave stale.
  await engine.doString(`
    initializeCellData(${gXMin}, ${gXMax}, ${gYMin}, ${gYMax}, ${SEED}, ${PADDING})
    g_cornerTemp = { terrainType = {}, hillyness = {}, lakeAdjacent = {}, forceFlat = {} }
    for y = ${gYMin}, ${gYMax} + 1 do
      g_cornerTemp.terrainType[y], g_cornerTemp.hillyness[y], g_cornerTemp.lakeAdjacent[y], g_cornerTemp.forceFlat[y] = {}, {}, {}, {}
    end
  `);
  const setRows = (target, rows, cast = (v) => v) => rows.map(([x, y, v]) => `${target}[${y}][${x}]=${cast(v)}`).join("\n");
  await engine.doString(setRows("g_cornerTemp.terrainType", dumps.cornerTerrain));
  await engine.doString(setRows("g_cellData.cliffLevel", dumps.cliffLevel));
  await engine.doString(setRows("g_cellData.elevation", dumps.elevation));
  await engine.doString(setRows("g_cornerTemp.hillyness", dumps.hillyness));
  await engine.doString(setRows("g_cornerTemp.lakeAdjacent", dumps.lakeAdjacent, (v) => (v ? "true" : "false")));
  await engine.doString(setRows("g_cornerTemp.forceFlat", dumps.forceFlat, (v) => (v ? "true" : "false")));
  if (dumps.flags) await engine.doString(setRows("g_cellData.flags", dumps.flags));
  // Rebuild the flags for cells the JS side randomized (only "flags" set differs
  // from the zero default above).
  await engine.doString(`roadNodes = {} for y = ${gYMin}, ${gYMax} do roadNodes[y] = {} end`);
  for (const [x, y] of roadCells) {
    // eslint-disable-next-line no-await-in-loop
    await engine.doString(`roadNodes[${y}][${x}] = roadNodes[${y}][${x}] or { x = ${x}, y = ${y}, edges = {} }`);
  }
}

function dumpJsGrid(cellData, layer, cast = (v) => v) {
  const rows = [];
  for (let y = Y_MIN; y <= Y_MAX + 1; y += 1) {
    for (let x = X_MIN; x <= X_MAX + 1; x += 1) {
      rows.push(cast(layer[cellData.cornerIndex(x, y)]));
    }
  }
  return rows.join(",");
}

async function dumpLuaGrid(luaTable) {
  return engine.doString(`
    local out = {}
    for y = ${Y_MIN}, ${Y_MAX} + 1 do for x = ${X_MIN}, ${X_MAX} + 1 do
      local v = ${luaTable}[y][x]
      if type(v) == "boolean" then v = v and 1 or 0 end
      out[#out+1] = tostring(v)
    end end
    return table.concat(out, ",")
  `);
}

// --- flattenPoiCliff ---------------------------------------------------------
{
  const { cellData, roadCells, dumps } = await freshGrids();
  await pushGridToLua(dumps, roadCells);
  const poi = { x: 3, y: -2, size: 3, type: 116, cliffLevel: 2 }; // POI_CAMP-ish, meadow terrain
  flattenPoiCliff(cellData, poi);
  await engine.doString(`flattenPoiCliff({ x = 3, y = -2, size = 3, type = 116, cliffLevel = 2 })`);
  checkEqual("flattenPoiCliff terrainType", await dumpLuaGrid("g_cornerTemp.terrainType"), dumpJsGrid(cellData, cellData.cornerTerrainType));
  checkEqual("flattenPoiCliff cliffLevel", await dumpLuaGrid("g_cellData.cliffLevel"), dumpJsGrid(cellData, cellData.cliffLevel));
  checkEqual("flattenPoiCliff forceFlat", await dumpLuaGrid("g_cornerTemp.forceFlat"), dumpJsGrid(cellData, cellData.cornerForceFlat));
}

// --- addBorderingMeadows -----------------------------------------------------
{
  const { cellData, roadCells, dumps } = await freshGrids();
  await pushGridToLua(dumps, roadCells);
  addBorderingMeadows(cellData);
  await engine.doString("addBorderingMeadows()");
  checkEqual("addBorderingMeadows", await dumpLuaGrid("g_cornerTemp.terrainType"), dumpJsGrid(cellData, cellData.cornerTerrainType));
}

// --- enforceCliffRoadLimitations ---------------------------------------------
{
  const { cellData, roadNodes, roadCells, dumps } = await freshGrids();
  await pushGridToLua(dumps, roadCells);
  enforceCliffRoadLimitations(cellData, roadNodes);
  await engine.doString("enforceCliffRoadLimitations(roadNodes)");
  checkEqual("enforceCliffRoadLimitations cliffLevel", await dumpLuaGrid("g_cellData.cliffLevel"), dumpJsGrid(cellData, cellData.cliffLevel));
}

// --- evaluateRoadsAndCliffs ---------------------------------------------------
{
  const { cellData, roadNodes, roadCells, dumps } = await freshGrids();
  await pushGridToLua(dumps, roadCells);
  // A deterministic stand-in tile selector, identical on both sides. Packed as
  // (tileId << 2) | rotation / -1 for "no tile", matching the real selectors'
  // contract (see packTile in selectors.js).
  const jsSelector = (flags, noise) => (flags <= 0 ? -1 : ((1000 + (noise % 7)) << 2) | (noise % 4));
  evaluateRoadsAndCliffs(cellData, roadNodes, jsSelector, intNoise2d);
  await engine.doString(`
    function getCliffRoadTileIdAndRotation(flags, noise)
      if flags <= 0 then return sm.uuid.getNil(), 0 end
      return sm.uuid.new(tostring(1000 + noise % 7)), noise % 4
    end
    evaluateRoadsAndCliffs(roadNodes)
  `);
  const luaFlags = await engine.doString(`
    local out = {}
    for y = ${Y_MIN}, ${Y_MAX} do for x = ${X_MIN}, ${X_MAX} do out[#out+1] = g_cellData.flags[y][x] end end
    return table.concat(out, ",")
  `);
  const jsFlags = [];
  for (let y = Y_MIN; y <= Y_MAX; y += 1) for (let x = X_MIN; x <= X_MAX; x += 1) jsFlags.push(cellData.flags[cellData.cellIndex(x, y)]);
  checkEqual("evaluateRoadsAndCliffs flags", luaFlags, jsFlags.join(","));

  const luaUids = await engine.doString(`
    local out = {}
    for y = ${Y_MIN}, ${Y_MAX} do for x = ${X_MIN}, ${X_MAX} do
      local uid = g_cellData.uid[y][x]
      out[#out+1] = uid:isNil() and "-" or tostring(uid)
    end end
    return table.concat(out, ",")
  `);
  const jsUids = [];
  for (let y = Y_MIN; y <= Y_MAX; y += 1) {
    for (let x = X_MIN; x <= X_MAX; x += 1) {
      const uid = cellData.uid[cellData.cellIndex(x, y)];
      jsUids.push(uid === 0 ? "-" : String(uid));
    }
  }
  checkEqual("evaluateRoadsAndCliffs uid", luaUids, jsUids.join(","));
}

// --- setForcedAndLakeAdjacentPoiHillynessToZero / smoothPoiElevation / flattenPoiElevation ---
{
  const { cellData, roadCells, dumps } = await freshGrids();
  await pushGridToLua(dumps, roadCells);
  const jsPoi = { x: -4, y: 5, size: 2, type: 802, flat: true, forceFlat: false, elevationSmoothing: 2 };
  setForcedAndLakeAdjacentPoiHillynessToZero(cellData, jsPoi);
  smoothPoiElevation(cellData, jsPoi);
  flattenPoiElevation(cellData, jsPoi);
  await engine.doString(`
    local poi = { x = -4, y = 5, size = 2, type = 802, flat = true, forceFlat = false, elevationSmoothing = 2 }
    setForcedAndLakeAdjacentPoiHillynessToZero(poi)
    smoothPoiElevation(poi)
    flattenPoiElevation(poi)
  `);
  checkEqual("poi hillyness", await dumpLuaGrid("g_cornerTemp.hillyness"), dumpJsGrid(cellData, cellData.cornerHillyness));
  const luaElevation = await engine.doString(`
    local out = {}
    for y = ${Y_MIN}, ${Y_MAX} + 1 do for x = ${X_MIN}, ${X_MAX} + 1 do out[#out+1] = string.format("%.6f", g_cellData.elevation[y][x]) end end
    return table.concat(out, ",")
  `);
  const jsElevation = dumpJsGrid(cellData, cellData.elevation, (v) => v.toFixed(6));
  checkEqual("poi elevation", luaElevation, jsElevation);
  const luaPoiFlags = await engine.doString(`
    local out = {}
    for y = ${Y_MIN}, ${Y_MAX} do for x = ${X_MIN}, ${X_MAX} do out[#out+1] = g_cellData.flags[y][x] end end
    return table.concat(out, ",")
  `);
  const jsPoiFlags = [];
  for (let y = Y_MIN; y <= Y_MAX; y += 1) for (let x = X_MIN; x <= X_MAX; x += 1) jsPoiFlags.push(cellData.flags[cellData.cellIndex(x, y)]);
  checkEqual("poi flat flags", luaPoiFlags, jsPoiFlags.join(","));
}

// --- uniformSquare / placeTerrainCompatible ----------------------------------
{
  const { cellData, roadCells, dumps } = await freshGrids();
  await pushGridToLua(dumps, roadCells);
  const luaUniform = await engine.doString(`
    return function(x, y, size, terrainType) return uniformSquare(x, y, size, terrainType) end
  `);
  let uniformChecks = 0;
  for (let index = 0; index < 60; index += 1) {
    const x = X_MIN + nextRange(cellData.cellWidth - 4);
    const y = Y_MIN + nextRange(cellData.cellHeight - 4);
    const size = 1 + nextRange(3);
    const terrainType = 1 + nextRange(8);
    const js = uniformSquare(cellData, x, y, size, terrainType);
    // eslint-disable-next-line no-await-in-loop
    const lua = await luaUniform(x, y, size, terrainType);
    uniformChecks += 1;
    checkEqual(`uniformSquare(${x},${y},${size},${terrainType})`, lua, js);
  }
  console.log(`uniformSquare: ${uniformChecks} checks`);

  const luaPlaceCompat = await engine.doString(`
    return function(x, y, size, poiType)
      local poi = { x = x, y = y, size = size, type = poiType }
      local result = placeTerrainCompatible(poi)
      local out = {}
      for cy = ${Y_MIN}, ${Y_MAX} + 1 do for cx = ${X_MIN}, ${X_MAX} + 1 do out[#out+1] = g_cornerTemp.terrainType[cy][cx] end end
      return tostring(result) .. "|" .. table.concat(out, ",")
    end
  `);
  let placeChecks = 0;
  for (let index = 0; index < 20; index += 1) {
    const { cellData: fresh, roadCells: rc, dumps: d } = await freshGrids();
    // eslint-disable-next-line no-await-in-loop
    await pushGridToLua(d, rc);
    const x = X_MIN + 3 + nextRange(fresh.cellWidth - 8);
    const y = Y_MIN + 3 + nextRange(fresh.cellHeight - 8);
    const size = 1 + nextRange(3);
    const poiType = [116, 201, 301, 401][nextRange(4)] * 1; // meadow/forest/desert/field camp-ish
    const jsPoi = { x, y, size, type: poiType };
    const jsResult = placeTerrainCompatible(fresh, jsPoi);
    // eslint-disable-next-line no-await-in-loop
    const luaResult = await luaPlaceCompat(x, y, size, poiType);
    const [luaFlag, luaGrid] = luaResult.split("|");
    const jsGrid = dumpJsGrid(fresh, fresh.cornerTerrainType);
    placeChecks += 1;
    checkEqual(`placeTerrainCompatible(${x},${y},${size},${poiType}) result`, luaFlag, String(jsResult));
    checkEqual(`placeTerrainCompatible(${x},${y},${size},${poiType}) grid`, luaGrid, jsGrid);
  }
  console.log(`placeTerrainCompatible: ${placeChecks} checks`);
}

// --- evaluateType -------------------------------------------------------------
{
  const { cellData, roadCells, dumps } = await freshGrids();
  await pushGridToLua(dumps, roadCells);
  const jsSelector = (bits, a, b) => (bits === 0 ? -1 : ((2000 + bits) << 2) | ((a + b) % 4));
  evaluateType(cellData, 1, jsSelector, intNoise2d);
  await engine.doString(`
    local function selector(bits, a, b)
      if bits == 0 then return sm.uuid.getNil(), 0 end
      return sm.uuid.new(tostring(2000 + bits)), (a + b) % 4
    end
    evaluateType(1, selector)
  `);
  const luaUids = await engine.doString(`
    local out = {}
    for y = ${Y_MIN}, ${Y_MAX} do for x = ${X_MIN}, ${X_MAX} do
      local uid = g_cellData.uid[y][x]
      out[#out+1] = (uid:isNil() and "-" or tostring(uid)) .. ":" .. g_cellData.rotation[y][x] .. ":" .. g_cellData.flags[y][x]
    end end
    return table.concat(out, ",")
  `);
  const jsUids = [];
  for (let y = Y_MIN; y <= Y_MAX; y += 1) {
    for (let x = X_MIN; x <= X_MAX; x += 1) {
      const index = cellData.cellIndex(x, y);
      const uid = cellData.uid[index];
      jsUids.push(`${uid === 0 ? "-" : uid}:${cellData.rotation[index]}:${cellData.flags[index]}`);
    }
  }
  checkEqual("evaluateType", luaUids, jsUids.join(","));
}

// --- PoiSelector: choosePoi / rewindPoi / convertPlaceholderPois -------------
{
  const luaChoose = await engine.doString(`
    return function(terrainType, requestedSize)
      local poi = { terrainType = terrainType }
      local ok = choosePoi(poi, requestedSize, terrainType)
      return tostring(ok) .. "|" .. tostring(poi.type) .. "|" .. tostring(poi.size) .. "|" .. tostring(poi.flat)
    end
  `);
  const luaRewind = await engine.doString(`
    return function(terrainType, requestedSize) rewindPoi(requestedSize, terrainType) end
  `);
  const selector = new PoiSelector();
  const terrains = [1, 2, 3, 4, 5, 6, 8];
  let poiChecks = 0;
  for (let index = 0; index < 400; index += 1) {
    const terrainType = terrains[nextRange(terrains.length)];
    const requestedSize = 1 + nextRange(2);
    const poi = { terrainType };
    const ok = selector.choosePoi(poi, requestedSize, terrainType);
    const jsResult = `${ok}|${poi.type}|${poi.size}|${poi.flat}`;
    // eslint-disable-next-line no-await-in-loop
    const luaResult = await luaChoose(terrainType, requestedSize);
    poiChecks += 1;
    checkEqual(`choosePoi(${terrainType},${requestedSize})#${index}`, luaResult, jsResult);
    if (nextRange(5) === 0) {
      selector.rewindPoi(requestedSize, terrainType);
      // eslint-disable-next-line no-await-in-loop
      await luaRewind(terrainType, requestedSize);
    }
  }
  console.log(`choosePoi/rewindPoi: ${poiChecks} checks`);
}

{
  // convertPlaceholderPois: build an identical placeholder list on both sides
  // and compare the resulting POI arrays.
  const selector = new PoiSelector();
  const cellData = new CellData();
  cellData.initialize(X_MIN, X_MAX, Y_MIN, Y_MAX, SEED, PADDING);
  const terrains = [1, 2, 3, 4, 5, 6, 8];
  const pois = [];
  const luaPoiLiterals = [];
  for (let index = 0; index < 30; index += 1) {
    const terrainType = terrains[nextRange(terrains.length)];
    const x = X_MIN + nextRange(cellData.cellWidth);
    const y = Y_MIN + nextRange(cellData.cellHeight);
    const isPlaceholder = nextRange(3) !== 0;
    const poi = isPlaceholder
      ? { x, y, type: 1, size: 2, terrainType } // POI_RANDOM_PLACEHOLDER = 1
      : { x, y, type: 999, size: 1, terrainType };
    pois.push(poi);
    luaPoiLiterals.push(`{ x = ${x}, y = ${y}, type = ${poi.type}, size = ${poi.size}, terrainType = ${terrainType} }`);
  }
  convertPlaceholderPois(cellData, selector, pois, intNoise2d);
  const jsSerialized = pois.map((p) => `${p.x},${p.y},${p.type},${p.size}`).join("|");

  await engine.doString(`
    resetNextPoi()
    local pois = { ${luaPoiLiterals.join(",\n")} }
    g_cellData = g_cellData or {}
    g_cellData.seed = ${SEED}
    convertPlaceholderPois(pois)
    local out = {}
    for _, poi in ipairs(pois) do out[#out+1] = poi.x .. "," .. poi.y .. "," .. poi.type .. "," .. poi.size end
    __CONVERTED = table.concat(out, "|")
  `);
  const luaSerialized = await engine.doString("return __CONVERTED");
  checkEqual("convertPlaceholderPois", luaSerialized, jsSerialized);
}

// --- addExtraPois integration test -------------------------------------------
// addExtraPois scans a fixed grid (gridY*3-46, gridX*3-62+...) baked in from the
// real generator's bounds, not g_cellData.bounds, so it can only be exercised
// against the true -72..71 x -56..55 extent.
{
  const fullBounds = { xMin: -72, xMax: 71, yMin: -56, yMax: 55 };
  const { cellData, dumps } = await freshGrids(fullBounds);
  // addExtraPois needs open, uniformly-terrained blocks to find any spot in —
  // the per-corner random terrain freshGrids() otherwise produces almost never
  // has one, so this overwrites it with 6x6 blocks of a single terrain type
  // (mirroring how contiguous the real generator's biomes are) and empties the
  // flags grid so nothing is already occupied.
  cellData.flags.fill(0);
  for (let y = fullBounds.yMin; y <= fullBounds.yMax + 1; y += 1) {
    for (let x = fullBounds.xMin; x <= fullBounds.xMax + 1; x += 1) {
      const blockType = 1 + (((Math.floor(x / 6) + Math.floor(y / 6)) % 6 + 6) % 6);
      const index = cellData.cornerIndex(x, y);
      cellData.cornerTerrainType[index] = blockType;
      const row = dumps.cornerTerrain.find(([rx, ry]) => rx === x && ry === y);
      if (row) row[2] = blockType;
    }
  }
  await pushGridToLua(dumps, [], fullBounds);
  await engine.doString(`for y = -56, 55 do for x = -72, 71 do g_cellData.flags[y][x] = 0 end end`);

  const jsRandom = new LuaJitRandom();
  jsRandom.seed(SEED);
  const jsSelector = new PoiSelector();
  const jsCollisionIndex = new CollisionIndex();
  const jsPois = [];
  const jsWritten = [];
  const jsWritePoi = (poi) => {
    jsWritten.push(`${poi.x},${poi.y},${poi.type},${poi.size},${poi.rotation ?? "n"}`);
    writeTile(cellData, 1, poi.x - Math.floor(poi.size / 2), poi.y - Math.floor(poi.size / 2), poi.size, 0, null);
  };
  addExtraPois(cellData, jsSelector, jsCollisionIndex, jsRandom, jsPois, PADDING, jsWritePoi);

  await engine.doString(`
    resetNextPoi()
    math.randomseed(${SEED})
    local pois = {}
    __WRITTEN = {}
    function writePoi(poi, padding)
      __WRITTEN[#__WRITTEN + 1] = poi.x .. "," .. poi.y .. "," .. poi.type .. "," .. poi.size .. "," .. (poi.rotation or "n")
    end
    addExtraPois(pois, ${PADDING})
    __WRITTEN_STR = table.concat(__WRITTEN, "|")
  `);
  const luaWritten = await engine.doString("return __WRITTEN_STR");
  checkEqual("addExtraPois written POIs", luaWritten, jsWritten.join("|"));
  console.log(`addExtraPois: ${jsWritten.length} POIs placed`);
}

engine.global.close();

if (failures.length) {
  console.error(`FAILED — ${failures.length}+ mismatch(es) out of ${checkCount} checks:`);
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}
console.log(`processing.js matches Lua exactly (${checkCount} checks across all functions)`);
