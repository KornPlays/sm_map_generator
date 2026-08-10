// JS-native entry point for the Chapter 2 overworld generator. Mirrors
// generator.js's generateCells(seed, onProgress) interface and output shape
// exactly, but runs the ported algorithm directly instead of through wasmoon.
//
// Verified to produce byte-identical output to the Lua path across all five
// golden seeds — see scripts/verify-full-pipeline.mjs and USE_JS_GENERATOR in
// generator.js.

import { CellData } from "./cell-data.js";
import { TileCatalog } from "./tile-catalog.js";
import { BiomeRoads } from "./biome-roads.js";
import {
  buildTerrainSelectors, buildRoadCliffSelector, buildPoiSelector, buildStartAreaWriter,
} from "./selectors.js";
import { generateOverworldCelldata } from "./world-orchestration.js";
import { LuaJitRandom, intNoise2d } from "./lua-compat.js";
import { simplexNoise2d } from "../noise.js";

let dataPromise;

function publicUrl(path) {
  const baseUrl =
    globalThis.__SM_MAP_BASE_URL ??
    (typeof document !== "undefined" ? document.baseURI : globalThis.location?.href);
  if (!baseUrl) throw new Error("Could not resolve the bundled map data.");
  return new URL(path, baseUrl);
}

async function fetchJson(path) {
  const response = await fetch(publicUrl(`runtime/${path}`));
  if (!response.ok) throw new Error(`Could not load ${path} (HTTP ${response.status})`);
  return response.json();
}

async function loadData() {
  if (!dataPromise) {
    dataPromise = (async () => {
      const [metadata, terrainRules, roadCliffRules, poiCatalog, startArea, excavationWorld] = await Promise.all([
        fetchJson("data/tile_metadata.json"),
        fetchJson("data/terrain-rules.json"),
        fetchJson("data/road-cliff-rules.json"),
        fetchJson("data/poi-catalog.json"),
        fetchJson("data/start-area.json"),
        fetchJson("data/excavation-world.json"),
      ]);
      return { metadata, terrainRules, roadCliffRules, poiCatalog, startArea, excavationWorld };
    })();
  }
  return dataPromise;
}

export async function generateCells(seed, onProgress = () => {}) {
  onProgress("Loading the Chapter 2 world rules…", 8);
  const { metadata, terrainRules, roadCliffRules, poiCatalog, startArea, excavationWorld } = await loadData();
  onProgress("Generating roads, biomes, islands, and POIs…", 18);
  await new Promise((resolve) => setTimeout(resolve, 0));

  const cellData = new CellData();
  const catalog = new TileCatalog(cellData, metadata);
  const tileForType = buildTerrainSelectors(catalog, terrainRules);
  const cliffRoadTile = buildRoadCliffSelector(catalog, roadCliffRules);
  const poiSelector = buildPoiSelector(catalog, poiCatalog);
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
  generateOverworldCelldata(cellData, {
    xMin: -72, xMax: 71, yMin: -56, yMax: 55, seed, padding: 8,
    random, intNoise2d, simplexNoise2d, perlinNoise2d: () => 0,
    metadata,
    selectors: {
      tileForType, cliffRoadTile,
      poiTile: (poiType, variation) => poiSelector.byNoise(poiType, variation),
      biomeRoads, writeStartArea, excavationWorld,
    },
    log: () => {},
  });

  const cells = [];
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
      cells.push({
        x, y, uid: cellData.tiles.uuid(uidIndex), size, rotation,
        group: cellData.groupId[index], terrainType,
        originX: x - localX, originY: y - localY,
      });
    }
  }

  onProgress(`World layout complete · ${cells.length.toLocaleString()} populated cells`, 32);
  return cells;
}
