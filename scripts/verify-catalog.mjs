// Cross-checks tile-catalog.js, biome-roads.js and excavation-island.js against
// the Lua they replace. AddTile's interned index and getBiomeRoadTile's tile
// choice both feed directly into which artwork gets drawn, so a divergence here
// changes the map's appearance even though the layout coordinates stay right.
//
// Usage: node scripts/verify-catalog.mjs

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { LuaFactory, LuaLibraries } from "wasmoon";

import { FAST_PATH_PRELUDE } from "../src/lua-fastpath.js";
import { CellData, NIL_UUID } from "../src/world-generation/cell-data.js";
import { TileCatalog } from "../src/world-generation/tile-catalog.js";
import { BiomeRoads } from "../src/world-generation/biome-roads.js";
import { injectExcavation } from "../src/world-generation/excavation-island.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const luaDir = resolve(root, "public/runtime/lua");
const publicDir = resolve(root, "public");

const metadata = JSON.parse(await readFile(resolve(publicDir, "runtime/data/tile_metadata.json"), "utf8"));
const excavationWorld = JSON.parse(await readFile(resolve(publicDir, "runtime/data/excavation-world.json"), "utf8"));
const startArea = JSON.parse(await readFile(resolve(publicDir, "runtime/data/start-area.json"), "utf8"));

const factory = new LuaFactory(pathToFileURL(resolve(root, "public/vendor/wasmoon.wasm")).href);
const engine = await factory.createEngine({ enableProxy: false, openStandardLibs: false });
engine.global.loadLibrary(LuaLibraries.Base);
engine.global.loadLibrary(LuaLibraries.Table);
engine.global.loadLibrary(LuaLibraries.String);
engine.global.loadLibrary(LuaLibraries.Math);

engine.global.set("_sm_tile_uuid", (path) => metadata[path]?.uid ?? NIL_UUID);
engine.global.set("_sm_tile_size", (path) => metadata[path]?.size ?? 1);
await engine.doString(FAST_PATH_PRELUDE);
await engine.doString(`
math.random = _sm_random
math.randomseed = _sm_randomseed
bit = {
    band = _sm_band, bor = _sm_bor, bnot = _sm_bnot,
    lshift = _sm_lshift, rshift = _sm_rshift, tobit = _sm_tobit
}
TYPE_MEADOW, TYPE_FOREST, TYPE_DESERT, TYPE_FIELD = 1, 2, 3, 4
TYPE_BURNTFOREST, TYPE_AUTUMNFOREST, TYPE_LAKE = 5, 6, 8
MASK_ROADS = 0x0f00
FLAG_ROAD_E, FLAG_ROAD_N, FLAG_ROAD_W, FLAG_ROAD_S = 0x0100, 0x0200, 0x0400, 0x0800
function min(a, b) if a < b then return a end return b end
function max(a, b) if a > b then return a end return b end
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
local realType = type
function type(value)
    if realType(value) == "table" and value.__uuid then return "Uuid" end
    return realType(value)
end
sm = {
    terrainTile = { getTileUuid = function(path) return makeUuid(_sm_tile_uuid(path)) end, getSize = _sm_tile_size },
    uuid = { new = makeUuid, getNil = function() return makeUuid(nilUuidString) end, isNil = function(v) return v == nil or v:isNil() end },
    json = { open = function() return EXCAVATION_WORLD end },
}
g_cellData = { bounds = { xMin = -72, xMax = 71, yMin = -56, yMax = 55 }, flags = {} }
for y = -56, 56 do g_cellData.flags[y] = {} for x = -72, 72 do g_cellData.flags[y][x] = 0 end end
g_cornerTemp = { terrainType = {} }
for y = -56, 57 do g_cornerTemp.terrainType[y] = {} for x = -72, 73 do g_cornerTemp.terrainType[y][x] = 1 end end
`);
await engine.doString(await readFile(resolve(luaDir, "overworld/tile_database.lua"), "utf8"));
await engine.doString(await readFile(resolve(luaDir, "overworld/biome_roads.lua"), "utf8"));

const failures = [];
const note = (text) => { if (failures.length < 15) failures.push(text); };

// --- tile catalog + AddTile ordering ----------------------------------------
const cellData = new CellData();
cellData.initialize(-72, 71, -56, 55, 0, 8);
const catalog = new TileCatalog(cellData, metadata);
const luaAddTile = await engine.doString(`
  return function(legacyId, path, terrainType, poiType)
    return tostring(AddTile(legacyId ~= 0 and legacyId or nil, path, terrainType ~= 0 and terrainType or nil, poiType ~= 0 and poiType or nil))
  end
`);
const samplePaths = Object.keys(metadata).slice(0, 260);
const jsUuidByIndex = new Map();
for (let index = 0; index < samplePaths.length; index += 1) {
  const path = samplePaths[index];
  const legacyId = index % 5 === 0 ? 1000 + index : 0;
  const terrainType = index % 3 === 0 ? 2 : 0;
  const jsIndex = catalog.addTile(legacyId || null, path, terrainType || null, null);
  const luaUuid = luaAddTile(legacyId, path, terrainType, 0);
  const jsUuid = cellData.tiles.uuid(jsIndex);
  if (jsUuid !== luaUuid) note(`AddTile(${path}) -> lua ${luaUuid}, js ${jsUuid}`);
  jsUuidByIndex.set(jsIndex, luaUuid);
}
for (const [jsIndex, luaUuid] of jsUuidByIndex) {
  if (catalog.getPath(jsIndex) == null) note(`getPath missing for interned index of ${luaUuid}`);
}
console.log(`tile catalog: ${samplePaths.length} AddTile calls checked`);

// --- biome roads --------------------------------------------------------------
const biomeRoads = new BiomeRoads(catalog);
biomeRoads.init();
await engine.doString("initBiomeRoadTiles()");
const luaCalculateIndex = await engine.doString(`
  return function(x, y)
    return calculateIndex({ x = x, y = y })
  end
`);
const luaGetTile = await engine.doString(`
  return function(x, y)
    local tile = getBiomeRoadTile({ x = x, y = y })
    if tile == nil then return "none" end
    local out = {}
    for i, uid in ipairs(tile.tiles) do out[i] = tostring(uid) end
    return tile.rotation .. "|" .. tile.terrainType .. "|" .. table.concat(out, ",")
  end
`);

let indexChecks = 0;
let choiceChecks = 0;
for (let y = -56; y <= 55; y += 3) {
  for (let x = -72; x <= 71; x += 3) {
    // Vary the flags/corner terrain the Lua globals hold, mirrored on the JS side.
    const roadBits = ((x * 31 + y * 17) & 0xf) << 8;
    engine.global.set("__flags", roadBits);
    engine.global.get(""); // no-op keep-alive
    // Write into the Lua grid directly through doString for speed.
    // eslint-disable-next-line no-await-in-loop
    await engine.doString(`g_cellData.flags[${y}][${x}] = ${roadBits}`);
    const cornerValues = [1 + (x & 3), 1 + (y & 3), 1 + ((x + y) & 3), 1 + ((x - y) & 3)];
    // eslint-disable-next-line no-await-in-loop
    await engine.doString(`
      g_cornerTemp.terrainType[${y}][${x + 1}] = ${cornerValues[0]}
      g_cornerTemp.terrainType[${y}][${x}] = ${cornerValues[1]}
      g_cornerTemp.terrainType[${y + 1}][${x}] = ${cornerValues[2]}
      g_cornerTemp.terrainType[${y + 1}][${x + 1}] = ${cornerValues[3]}
    `);
    cellData.flags[cellData.cellIndex(x, y)] = roadBits;
    cellData.cornerTerrainType[cellData.cornerIndex(x + 1, y)] = cornerValues[0];
    cellData.cornerTerrainType[cellData.cornerIndex(x, y)] = cornerValues[1];
    cellData.cornerTerrainType[cellData.cornerIndex(x, y + 1)] = cornerValues[2];
    cellData.cornerTerrainType[cellData.cornerIndex(x + 1, y + 1)] = cornerValues[3];

    const jsIndex = biomeRoads.calculateIndex(cellData, cellData.cornerTerrainType, x, y);
    // eslint-disable-next-line no-await-in-loop
    const luaIndex = await luaCalculateIndex(x, y);
    indexChecks += 1;
    if (jsIndex !== luaIndex) note(`calculateIndex(${x},${y}) -> lua ${luaIndex}, js ${jsIndex}`);

    const jsTile = biomeRoads.getTile(cellData, cellData.cornerTerrainType, x, y);
    const jsSerialized = jsTile
      ? `${jsTile.rotation}|${jsTile.terrainType}|${jsTile.tiles.map((i) => cellData.tiles.uuid(i)).join(",")}`
      : "none";
    // eslint-disable-next-line no-await-in-loop
    const luaSerialized = await luaGetTile(x, y);
    choiceChecks += 1;
    if (jsSerialized !== luaSerialized) note(`getBiomeRoadTile(${x},${y}) -> lua ${luaSerialized}, js ${jsSerialized}`);
  }
}
console.log(`biome roads: ${indexChecks} index checks, ${choiceChecks} tile choices checked`);

// --- excavation island ---------------------------------------------------------
await engine.doString(await readFile(resolve(luaDir, "terrain/terrain_util2.lua"), "utf8"));
await engine.doString(await readFile(resolve(luaDir, "overworld/excavation_island.lua"), "utf8"));
engine.global.set("EXCAVATION_WORLD", excavationWorld);
await engine.doString(`
g_cellData.uid, g_cellData.xOffset, g_cellData.yOffset = {}, {}, {}
g_cellData.rotation, g_cellData.groupId = {}, {}
g_cellData.elevation, g_cellData.cliffLevel = {}, {}
for y = -56, 55 do
    g_cellData.uid[y], g_cellData.xOffset[y], g_cellData.yOffset[y] = {}, {}, {}
    g_cellData.rotation[y], g_cellData.groupId[y] = {}, {}
    for x = -72, 71 do g_cellData.uid[y][x] = sm.uuid.getNil() end
end
for y = -56, 56 do
    g_cellData.elevation[y], g_cellData.cliffLevel[y] = {}, {}
end
g_groupIdCount = 0
local spec = { worldFile = "excavation", x = 32, y = 16, rotation = 0 }
injectExcavation(spec)
`);
const luaExcavationSample = await engine.doString(`
  return function(x, y)
    local uid = g_cellData.uid[y][x]
    return tostring(uid) .. "|" .. g_cellData.xOffset[y][x] .. "|" .. g_cellData.yOffset[y][x]
      .. "|" .. g_cellData.rotation[y][x] .. "|" .. g_cellData.groupId[y][x]
  end
`);

const jsCellData = new CellData();
jsCellData.initialize(-72, 71, -56, 55, 0, 8);
const jsCatalog = new TileCatalog(jsCellData, metadata);
injectExcavation(jsCellData, metadata, excavationWorld, { worldFile: "excavation", x: 32, y: 16, rotation: 0 });

let excavationChecks = 0;
let excavationMismatches = 0;
for (let y = 16; y <= 47; y += 1) {
  for (let x = 32; x <= 63; x += 1) {
    const index = jsCellData.cellIndex(x, y);
    const jsUuid = jsCellData.tiles.uuid(jsCellData.uid[index]);
    const jsSerialized = `${jsUuid}|${jsCellData.xOffset[index]}|${jsCellData.yOffset[index]}|${jsCellData.rotation[index]}|${jsCellData.groupId[index]}`;
    // eslint-disable-next-line no-await-in-loop
    const luaSerialized = await luaExcavationSample(x, y);
    excavationChecks += 1;
    if (jsSerialized !== luaSerialized) {
      excavationMismatches += 1;
      note(`excavation cell (${x},${y}) -> lua ${luaSerialized}, js ${jsSerialized}`);
    }
  }
}
console.log(`excavation island: ${excavationChecks} cells checked, ${excavationMismatches} mismatches`);

engine.global.close();

if (failures.length) {
  console.error(`FAILED — ${failures.length}+ mismatch(es):`);
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}
console.log("catalog, biome roads, and excavation island all match Lua exactly");
