// Builds the tile-selection functions world-orchestration.js needs from the
// same JSON manifests the Lua path turns into generated Lua source (see
// terrainRulePrelude/roadCliffRulePrelude/poiCatalogPrelude/startAreaPrelude in
// generator.js). Kept separate from world-orchestration.js because that module
// is pure algorithm and should not need to change shape depending on how the
// manifests happen to be compiled.

import { TYPE_AUTUMNFOREST, TYPE_BURNTFOREST, TYPE_DESERT, TYPE_FIELD, TYPE_FOREST, TYPE_LAKE, TYPE_MEADOW } from "./cell-data.js";
import { luaMod } from "./lua-compat.js";
import { POI_TYPES } from "./poi-types.js";

// Placeholder artwork the Lua falls back to when a ruleset entry legitimately
// has zero tiles (should not happen for any manifest actually shipped, but the
// Lua defends against it and so does this). Lua builds this from a hardcoded
// UUID constant (celldata.lua's ERROR_TILE_UUID), not a tile path — there is no
// metadata entry for it, so interning it through catalog.addTile's path lookup
// would silently fall back to the nil UUID (index 0) and make the error tile
// indistinguishable from "no tile" to findGroupIdFromNeighbor's uid comparison.
const ERROR_TILE_UUID = "723268d4-8d59-4500-a433-7d900b61c29c";

const TERRAIN_TYPE_BY_NAME = {
  meadow: TYPE_MEADOW, forest: TYPE_FOREST, desert: TYPE_DESERT, field: TYPE_FIELD,
  burntForest: TYPE_BURNTFOREST, autumnForest: TYPE_AUTUMNFOREST, lake: TYPE_LAKE,
};

// Packs a (tileId, rotation) pair into one integer — tileForType and
// cliffRoadTile run once per grid cell (tens of thousands of times per
// generation), and returning a [tileId, rotation] tuple array on every call
// was pure GC pressure for a value every caller immediately unpacked. -1
// means "no tile"; callers unpack with `packed >> 2` / `packed & 3`.
function packTile(tileId, rotation) {
  return tileId == null ? -1 : (tileId << 2) | rotation;
}

// browserTerrainSelect, one instance per terrain type name (meadow/forest/...).
// flags==15 is the "uniform corners, no directional preference" case, where the
// rotation is drawn from noise instead of the manifest's fixed value.
function buildTerrainSelector(catalog, entries) {
  const byFlags = new Map();
  for (const [flagsKey, entry] of Object.entries(entries)) {
    const flags = Number(flagsKey);
    const tiles = entry.tiles.map((tile) => catalog.addTile(tile.id, tile.path, tile.terrainType, null));
    byFlags.set(flags, { rotation: entry.rotation, tiles });
  }
  const errorTile = catalog.internUuid(ERROR_TILE_UUID);
  return function select(flags, variationNoise, rotationNoise) {
    const entry = byFlags.get(flags);
    if (flags === 0 || !entry) return -1;
    if (entry.tiles.length === 0) return packTile(errorTile, 0);
    const rotation = flags === 15 ? luaMod(rotationNoise, 4) : entry.rotation;
    return packTile(entry.tiles[luaMod(variationNoise, entry.tiles.length)], rotation);
  };
}

export function buildTerrainSelectors(catalog, manifest) {
  const byTerrainType = new Map();
  for (const [name, rule] of Object.entries(manifest.types)) {
    const terrainType = TERRAIN_TYPE_BY_NAME[name];
    if (terrainType == null) throw new Error(`Unknown terrain rule name: ${name}`);
    byTerrainType.set(terrainType, buildTerrainSelector(catalog, rule.entries));
  }
  return function tileForType(terrainType, bits, variationNoise, rotationNoise) {
    const select = byTerrainType.get(terrainType);
    if (!select) throw new Error(`No terrain rules for terrain type ${terrainType}`);
    return select(bits, variationNoise, rotationNoise);
  };
}

const MASK_CLIFF = 0x00ff;

export function buildRoadCliffSelector(catalog, manifest) {
  const byFlags = new Map();
  for (const [flagsKey, entry] of Object.entries(manifest.entries)) {
    const flags = Number(flagsKey);
    const tiles = entry.tiles.map((tile) => catalog.addTile(tile.id, tile.path, null, null));
    byFlags.set(flags, { rotation: entry.rotation, tiles });
  }
  const errorTile = catalog.internUuid(ERROR_TILE_UUID);
  return function cliffRoadTile(flags, variationNoise) {
    if (flags <= 0) return -1;
    let item = byFlags.get(flags);
    if (!item || item.tiles.length === 0) item = byFlags.get(flags & MASK_CLIFF);
    if (!item || item.tiles.length === 0) return packTile(errorTile, 0);
    return packTile(item.tiles[luaMod(variationNoise, item.tiles.length)], item.rotation);
  };
}

// getPoiTileId (1-based explicit index) and getRandomPoiTileId (noise-selected)
// from poiCatalogPrelude, over the same insertion-ordered per-type tile lists.
export function buildPoiSelector(catalog, manifest) {
  const byType = new Map();
  for (const entry of manifest.entries) {
    const poiType = POI_TYPES[entry.type];
    if (!Number.isInteger(poiType)) throw new Error(`Unknown POI type in catalog: ${entry.type}`);
    const legacyId = entry.legacyIndex == null ? null : poiType * 100 + entry.legacyIndex;
    const uid = catalog.addTile(legacyId, entry.path, entry.terrainType ?? null, poiType);
    if (!byType.has(poiType)) byType.set(poiType, []);
    byType.get(poiType).push(uid);
  }
  const errorTile = catalog.internUuid(ERROR_TILE_UUID);
  return {
    byIndex(poiType, oneBasedIndex) {
      const candidates = byType.get(poiType);
      if (!candidates) throw new Error(`No POI tiles for type ${poiType}`);
      return candidates[oneBasedIndex - 1];
    },
    // world-orchestration.js's writePoiFn passes a zero-based `variation` that
    // is either an explicit poi.index - 1 or raw (possibly negative) noise;
    // luaMod handles both uniformly, matching getRandomPoiTileId's `% #candidates`.
    byNoise(poiType, variation) {
      const candidates = byType.get(poiType);
      if (!candidates || candidates.length === 0) return errorTile;
      return candidates[luaMod(variation, candidates.length)];
    },
  };
}

// writeStartArea from startAreaPrelude. The manifest's grids are stored
// top-row-first the way the Lua literal was, so row index `17 - localY` (etc.)
// in the original is preserved here as `manifest.terrain[17 - localY]`.
export function buildStartAreaWriter(manifest, poiSelector) {
  const P = POI_TYPES;
  return function writeStartArea(cellData, pois, roadNodes, writeTileFn) {
    const [originX, originY] = manifest.origin;
    for (const placement of manifest.placements) {
      const uid = poiSelector.byIndex(P.CRASHSITE_AREA, placement.tileIndex);
      writeTileFn(cellData, uid, originX + placement.x, originY + placement.y, placement.size, placement.rotation, null);
      if (placement.poiIndex) {
        pois.push({
          x: originX + placement.x + Math.floor(placement.size / 2),
          y: originY + placement.y + Math.floor(placement.size / 2),
          type: P.CRASHSITE_AREA,
          index: placement.poiIndex,
          size: placement.size,
          flat: true,
        });
      }
    }

    for (let localY = 0; localY <= 16; localY += 1) {
      for (let localX = 0; localX <= 20; localX += 1) {
        const x = originX + localX;
        const y = originY + localY;
        const cornerIndex = cellData.cornerIndex(x, y);
        cellData.cornerTerrainType[cornerIndex] = manifest.terrain[17 - localY - 1][localX];
        cellData.cliffLevel[cornerIndex] = manifest.cliffs[17 - localY - 1][localX];
      }
    }

    for (let localY = 0; localY <= 15; localY += 1) {
      for (let localX = 0; localX <= 19; localX += 1) {
        const x = originX + localX;
        const y = originY + localY;
        if (manifest.roadCells[16 - localY - 1][localX]) {
          roadNodes.set(x, y, { x, y, edges: [] });
        }
        if (manifest.staticCells[16 - localY - 1][localX]) {
          const a = cellData.cornerIndex(x, y);
          const b = cellData.cornerIndex(x + 1, y);
          const c = cellData.cornerIndex(x, y + 1);
          const d = cellData.cornerIndex(x + 1, y + 1);
          cellData.cornerHillyness[a] = 0;
          cellData.cornerHillyness[b] = 0;
          cellData.cornerHillyness[c] = 0;
          cellData.cornerHillyness[d] = 0;
        } else {
          const index = cellData.cellIndex(x, y);
          cellData.uid[index] = 0;
          cellData.xOffset[index] = 0;
          cellData.yOffset[index] = 0;
          cellData.rotation[index] = 0;
          cellData.groupId[index] = 0;
        }
      }
    }

    for (let y = originY; y <= originY + 15; y += 1) {
      for (let x = originX; x <= originX + 19; x += 1) {
        const current = roadNodes.get(x, y);
        const east = roadNodes.get(x + 1, y);
        const north = roadNodes.get(x, y + 1);
        if (current && east) {
          current.edges.push({ n: east, cost: 1, road: true });
          east.edges.push({ n: current, cost: 1, road: true });
        }
        if (current && north) {
          current.edges.push({ n: north, cost: 1, road: true });
          north.edges.push({ n: current, cost: 1, road: true });
        }
      }
    }
  };
}
