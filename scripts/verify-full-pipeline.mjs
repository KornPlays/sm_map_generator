// End-to-end check of the JavaScript world generator against the real Lua one,
// for one seed at a time. This is the check that matters most: everything else
// in the port has been verified function-by-function, but generate_roads.lua
// and generate_cells.lua are stateful pipelines where a divergence three passes
// upstream can silently relocate something four passes downstream. Comparing
// the final cell list is the only thing that actually proves the whole pipeline
// agrees.
//
// Usage: node scripts/verify-full-pipeline.mjs [seed]

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const seed = Number(process.argv[2] ?? 760487397);

globalThis.document = { baseURI: pathToFileURL(`${resolve(root, "public")}/`).href };
globalThis.requestAnimationFrame = (cb) => setImmediate(cb);
globalThis.fetch = async (input) => {
  try { return new Response(await readFile(fileURLToPath(String(input))), { status: 200 }); }
  catch { return new Response(null, { status: 404 }); }
};

// --- the real (Lua) generator, unmodified -----------------------------------
const { generateCells: generateCellsLua } = await import(pathToFileURL(resolve(root, "src/generator.js")).href);
const luaCells = await generateCellsLua(seed);

// --- the JS port -------------------------------------------------------------
const { CellData } = await import(pathToFileURL(resolve(root, "src/world-generation/cell-data.js")).href);
const { TileCatalog } = await import(pathToFileURL(resolve(root, "src/world-generation/tile-catalog.js")).href);
const { BiomeRoads } = await import(pathToFileURL(resolve(root, "src/world-generation/biome-roads.js")).href);
const { buildTerrainSelectors, buildRoadCliffSelector, buildPoiSelector, buildStartAreaWriter } =
  await import(pathToFileURL(resolve(root, "src/world-generation/selectors.js")).href);
const { generateOverworldCelldata } = await import(pathToFileURL(resolve(root, "src/world-generation/world-orchestration.js")).href);
const { LuaJitRandom, intNoise2d } = await import(pathToFileURL(resolve(root, "src/world-generation/lua-compat.js")).href);
const { simplexNoise2d } = await import(pathToFileURL(resolve(root, "src/noise.js")).href);

const dataDir = resolve(root, "public/runtime/data");
const [metadata, terrainRules, roadCliffRules, poiCatalogManifest, startArea, excavationWorld] = await Promise.all([
  readFile(resolve(dataDir, "tile_metadata.json"), "utf8").then(JSON.parse),
  readFile(resolve(dataDir, "terrain-rules.json"), "utf8").then(JSON.parse),
  readFile(resolve(dataDir, "road-cliff-rules.json"), "utf8").then(JSON.parse),
  readFile(resolve(dataDir, "poi-catalog.json"), "utf8").then(JSON.parse),
  readFile(resolve(dataDir, "start-area.json"), "utf8").then(JSON.parse),
  readFile(resolve(dataDir, "excavation-world.json"), "utf8").then(JSON.parse),
]);

const cellData = new CellData();
const catalog = new TileCatalog(cellData, metadata);
const tileForType = buildTerrainSelectors(catalog, terrainRules);
const cliffRoadTile = buildRoadCliffSelector(catalog, roadCliffRules);
const poiSelector = buildPoiSelector(catalog, poiCatalogManifest);
const writeStartArea = buildStartAreaWriter(startArea, poiSelector);
const biomeRoads = new BiomeRoads(catalog);
biomeRoads.init();
// Pre-register excavation island cell tiles the way the Lua bootstrap's
// `for _, cell in pairs(EXCAVATION_WORLD.cellData) do AddTile(...) end` does,
// so their UIDs exist in the catalog before injectExcavation references them.
for (const cell of excavationWorld.cellData) {
  if (cell.path) catalog.addTile(null, cell.path, null, null);
}

const random = new LuaJitRandom();
const logLines = [];
const log = (...args) => logLines.push(args.join(" "));

generateOverworldCelldata(cellData, {
  xMin: -72, xMax: 71, yMin: -56, yMax: 55, seed, padding: 8,
  random, intNoise2d, simplexNoise2d, perlinNoise2d: () => 0,
  metadata,
  selectors: {
    tileForType, cliffRoadTile,
    poiTile: (poiType, variation) => poiSelector.byNoise(poiType, variation),
    biomeRoads, writeStartArea, excavationWorld,
  },
  log,
});

const jsCells = [];
for (let y = -48; y <= 47; y += 1) {
  for (let x = -64; x <= 63; x += 1) {
    const index = cellData.cellIndex(x, y);
    const uidIndex = cellData.uid[index];
    if (uidIndex === 0) continue;
    const flags = cellData.flags[index];
    const terrainType = (flags & 0xf000) >> 12;
    const size = catalog.getSize(uidIndex) ?? 1;
    const rotation = cellData.rotation[index];
    const offsetX = cellData.xOffset[index];
    const offsetY = cellData.yOffset[index];
    const last = size - 1;
    let localX = offsetX;
    let localY = offsetY;
    if (rotation === 1) { localX = last - offsetY; localY = offsetX; }
    else if (rotation === 2) { localX = last - offsetX; localY = last - offsetY; }
    else if (rotation === 3) { localX = offsetY; localY = last - offsetX; }
    jsCells.push({
      x, y, uid: cellData.tiles.uuid(uidIndex), size, rotation,
      group: cellData.groupId[index], terrainType,
      originX: x - localX, originY: y - localY,
    });
  }
}

// --- compare -------------------------------------------------------------
console.log(`seed ${seed}: lua ${luaCells.length} cells, js ${jsCells.length} cells`);

const key = (c) => `${c.x},${c.y}`;
const luaByKey = new Map(luaCells.map((c) => [key(c), c]));
const jsByKey = new Map(jsCells.map((c) => [key(c), c]));

const onlyInLua = [...luaByKey.keys()].filter((k) => !jsByKey.has(k));
const onlyInJs = [...jsByKey.keys()].filter((k) => !luaByKey.has(k));
let firstDivergence = null;
let mismatchCount = 0;
for (const [k, luaCell] of luaByKey) {
  const jsCell = jsByKey.get(k);
  if (!jsCell) continue;
  const fields = ["uid", "size", "rotation", "group", "terrainType", "originX", "originY"];
  const diffs = fields.filter((f) => luaCell[f] !== jsCell[f]);
  if (diffs.length) {
    mismatchCount += 1;
    if (!firstDivergence) firstDivergence = { key: k, luaCell, jsCell, diffs };
  }
}

console.log(`only in lua: ${onlyInLua.length}${onlyInLua.length ? " e.g. " + onlyInLua.slice(0, 5).join(" ") : ""}`);
console.log(`only in js: ${onlyInJs.length}${onlyInJs.length ? " e.g. " + onlyInJs.slice(0, 5).join(" ") : ""}`);
console.log(`field mismatches on shared cells: ${mismatchCount}`);
if (firstDivergence) {
  console.log("first divergence:", JSON.stringify(firstDivergence, null, 1));
}
if (logLines.length) {
  console.log("--- js generation log (tail) ---");
  console.log(logLines.slice(-15).join("\n"));
}

if (onlyInLua.length || onlyInJs.length || mismatchCount) {
  process.exitCode = 1;
} else {
  console.log("FULL PIPELINE MATCH");
}
