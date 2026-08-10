// Diagnostic only (not part of the port's permanent test suite): compares the
// exact sequence of math.random draws between the real Lua generator and the
// JS port, to localize where they first diverge. Requires the temporary
// _SM_LOG_RANDOM instrumentation in lua-fastpath.js / generator.js.
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
globalThis.__SM_LOG_RANDOM = true;

const { generateCells: generateCellsLua } = await import(pathToFileURL(resolve(root, "src/generator.js")).href);
await generateCellsLua(seed);
const luaLog = globalThis.__SM_RANDOM_LOG_OUT || [];
console.log(`lua draws: ${luaLog.length}`);

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
for (const cell of excavationWorld.cellData) if (cell.path) catalog.addTile(null, cell.path, null, null);

const realRandom = new LuaJitRandom();
const jsLog = [];
// Wraps the same draw primitives _sm_random dispatches on: no-arg (random()),
// one-arg (integer(1,n)), two-arg (integer(lo,hi)) — logged in the same format
// as the Lua side so the two logs line up entry-for-entry.
const loggedRandom = {
  seed: (s) => realRandom.seed(s),
  random: () => { const r = realRandom.random(); jsLog.push(`nil,nil=${r}`); return r; },
  integer: (lower, upper) => {
    const r = realRandom.integer(lower, upper);
    jsLog.push(`${lower},${upper}=${r}`);
    return r;
  },
};

generateOverworldCelldata(cellData, {
  xMin: -72, xMax: 71, yMin: -56, yMax: 55, seed, padding: 8,
  random: loggedRandom, intNoise2d, simplexNoise2d, perlinNoise2d: () => 0,
  metadata,
  selectors: { tileForType, cliffRoadTile, poiTile: (t, v) => poiSelector.byNoise(t, v), biomeRoads, writeStartArea, excavationWorld },
  log: () => {},
});
console.log(`js draws: ${jsLog.length}`);

// A 1-arg Lua math.random(n) call and a 2-arg random.integer(1,n) call are the
// same formula and consume the same single rngRandom() draw, but log with
// different (lower,upper) text — comparing only the drawn value avoids that
// cosmetic mismatch and shows where the actual numbers first disagree.
const resultOf = (entry) => entry.split("=")[1];
const length = Math.min(luaLog.length, jsLog.length);
let firstDivergenceIndex = -1;
for (let i = 0; i < length; i += 1) {
  if (resultOf(luaLog[i]) !== resultOf(jsLog[i])) { firstDivergenceIndex = i; break; }
}
if (firstDivergenceIndex === -1 && luaLog.length !== jsLog.length) firstDivergenceIndex = length;

if (firstDivergenceIndex === -1) {
  console.log("DRAW VALUES MATCH EXACTLY (arg-format differences aside)");
} else {
  console.log(`FIRST DIVERGENCE at draw #${firstDivergenceIndex}`);
  const start = Math.max(0, firstDivergenceIndex - 5);
  for (let i = start; i < Math.min(firstDivergenceIndex + 5, length + 1); i += 1) {
    console.log(`  [${i}] lua=${luaLog[i] ?? "(none)"}  js=${jsLog[i] ?? "(none)"}`);
  }
}
