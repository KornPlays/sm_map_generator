// Top-level Chapter 2 overworld orchestration. Ported from generate_cells.lua.
//
// Tile selection (which UID a set of corner flags or POI type resolves to) is
// deliberately kept out of this file and passed in as a `selectors` object
// instead of hardcoded — the real generator builds those selectors from
// terrain-rules.json/road-cliff-rules.json/poi-catalog.json, and this module
// should not need to change shape depending on how that JSON is compiled.
// selectors must provide:
//   tileForType(terrainType, bits, noiseA, noiseB) -> (tileIndex << 2) | rotation, or -1 for "no tile"
//   cliffRoadTile(flags, noise) -> (tileIndex << 2) | rotation, or -1 for "no tile"
//   poiTile(poiType, variationIndex) -> tileIndex
// The first two run once per grid cell, so they return a packed integer
// instead of a [tileIndex, rotation] tuple — see packTile in selectors.js.
//   biomeRoads: BiomeRoads instance (see biome-roads.js)
//   writeStartArea(cellData, pois, roadNodes, writeTileFn) -> void

import {
  MASK_CLIFF, MASK_FLAT, MASK_ROADCLIFF, MASK_ROADS, MASK_ROADS_SN, MASK_ROADS_WE,
  MASK_TERRAINTYPE, SHIFT_TERRAINTYPE, TYPE_AUTUMNFOREST, TYPE_BURNTFOREST, TYPE_DESERT,
  TYPE_FIELD, TYPE_FOREST, TYPE_LAKE, TYPE_MEADOW,
} from "./cell-data.js";
import { clamp, CollisionIndex, closestPoi, shuffle, writeTile } from "./placement.js";
import { luaMod } from "./lua-compat.js";
import { luaSort } from "./lua-sort.js";
import { POI_TYPES } from "./poi-types.js";
import { EXCAVATION_ISLAND, FIXED_POIS, LARGE_TEMPLATES_SOURCE, MUST_TEMPLATES_SOURCE } from "./poi-catalog-data.js";
import { injectExcavation } from "./excavation-island.js";
import {
  DrawRoads, findRoadPath, hasRoad, preparePoiRoadGraph, writeDistancesInNodes,
} from "./road-network.js";
import { RoadNodeGrid } from "./road-graph.js";
import {
  addBorderingMeadows, addExtraPois, convertPlaceholderPois, enforceCliffRoadLimitations,
  evaluateRoadsAndCliffs, evaluateType, flattenPoiCliff, flattenPoiElevation, PoiSelector,
  setForcedAndLakeAdjacentPoiHillynessToZero, smoothPoiElevation,
} from "./processing.js";

const P = POI_TYPES;

function boxFalloff(x, y, cx, cy, innerW, innerH, outerW, outerH) {
  const horizontal = Math.max(Math.abs(x - cx) - innerW, 0) / (outerW - innerW);
  const vertical = Math.max(Math.abs(y - cy) - innerH, 0) / (outerH - innerH);
  return 1 - Math.min(Math.max(horizontal, vertical), 1);
}

// Builds the five noise functions the rest of generation reads from, closing
// over the per-world simplex seed offset the way the Lua's buildNoise does.
function buildNoise(seed, simplexNoise2d, perlinNoise2d, cornerGradient) {
  const simplexSeed = ((seed % 32768) + 32768) % 32768;

  function islandShape(x, y) {
    let value = boxFalloff(x, y, 0, 0, 40, 24, 64, 48);
    value = Math.max(value - boxFalloff(x, y, -36, -38, 8, 4, 16, 16), 0);
    value = Math.max(value - boxFalloff(x, y, 48, 32, 16, 16, 24, 24), 0);
    value = Math.min(value + boxFalloff(x, y, -29, -26, 3, 3, 5, 5), 1);
    value = Math.min(value + boxFalloff(x, y, 27, 37, 4, 4, 12, 12), 1);
    return value * 2 - 1;
  }
  function islandNoise(x, y) {
    const noise = simplexNoise2d((x + 256 * (simplexSeed + 10)) / 8, (y + 256 * (simplexSeed + 21)) / 8);
    return clamp(islandShape(x, y) + noise, -1, 1);
  }
  function cliffNoise(x, y) {
    const first = boxFalloff(x, y, 0, -15, 0, 0, 15, 30);
    const firstNoise = Math.abs(simplexNoise2d((x + 256 * (simplexSeed + 123)) / 10, (y + 256 * (simplexSeed + 404)) / 10));
    const second = boxFalloff(x, y, 0, 30, 0, 0, 20, 10);
    const secondNoise = Math.abs(simplexNoise2d((x + 256 * (simplexSeed + 123)) / 10, (y + 256 * (simplexSeed + 404)) / 10));
    return Math.floor(first * 4 + firstNoise) + Math.floor(second * 4 + secondNoise);
  }
  function extraCliffNoise(x, y) {
    const gate = simplexNoise2d((x + 256 * (simplexSeed + 73)) / 7, (y + 256 * (simplexSeed + 75)) / 7);
    const a = simplexNoise2d((x + 256 * (simplexSeed + 66)) / 11, (y + 256 * (simplexSeed + 274)) / 11);
    const b = simplexNoise2d((x + 256 * (simplexSeed + 127)) / 22, (y + 256 * (simplexSeed + 421)) / 22);
    return gate > 0.5 ? clamp(Math.floor(Math.abs(a * 4 + b * 2)), 0, 3) : 0;
  }
  function elevationNoise(x, y) {
    const center = cornerGradient(x, y);
    let value = 0.1 + clamp((center * 3 - 1) * 0.1, 0, 1);
    value += perlinNoise2d(x / 16, y / 16, seed + 7907) * clamp(center * 3 - 1, 0, 1);
    value += perlinNoise2d(x / 8, y / 8, seed + 5527) * 0.5;
    value += perlinNoise2d(x / 4, y / 4, seed + 8733) * 0.25;
    value += perlinNoise2d(x / 2, y / 2, seed + 5442) * 0.125;
    return value * 250;
  }
  return { islandShape, islandNoise, cliffNoise, extraCliffNoise, elevationNoise };
}

function initializeCorners(cellData, xMin, xMax, yMin, yMax, padding) {
  const width = xMax + 1 - xMin;
  const height = yMax + 1 - yMin;
  const centerX = xMin + width / 2;
  const centerY = yMin + height / 2;
  const edgePadding = padding + 4;
  cellData.cornerGradient = new Float64Array(cellData.cornerTerrainType.length);
  for (let y = yMin; y <= yMax + 1; y += 1) {
    for (let x = xMin; x <= xMax + 1; x += 1) {
      const index = cellData.cornerIndex(x, y);
      cellData.cornerTerrainType[index] = TYPE_LAKE;
      cellData.cornerForceFlat[index] = 0;
      cellData.cornerLakeAdjacent[index] = 0;
      cellData.cornerHillyness[index] = 1;
      const gradient = 1 - Math.min(Math.max(
        Math.abs(x - centerX) / (width / 2 - edgePadding),
        Math.abs(y - centerY) / (height / 2 - edgePadding),
      ), 1);
      cellData.cornerGradient[index] = gradient;
    }
  }
}

function createPoiCatalog() {
  const pois = [];
  const refs = {};
  for (const [refName, x, y, type, size, road, flat, rotation, terrainType, cliffLevel, index, forceFlat, elevationSmoothing] of FIXED_POIS) {
    const poi = { x, y, type, size, road, flat, rotation, terrainType, cliffLevel, index, forceFlat, elevationSmoothing };
    pois.push(poi);
    if (refName) refs[refName] = poi;
  }
  const largeTemplates = LARGE_TEMPLATES_SOURCE.map(([type, index, road]) => ({
    type, index, size: 4, road: road !== false, flat: true, elevationSmoothing: 4,
  }));
  const chemicals = [1, 2, 3];
  return { pois, refs, largeTemplates, must: MUST_TEMPLATES_SOURCE, chemicalsSlot: chemicals };
}

// The must-template chemical indices are resolved by a shuffle at catalog-build
// time in the Lua (`local chemicals={1,2,3}; shuffle(chemicals)`), which the
// Lua runs before math.randomseed... no — Lua's generateOverworldCelldata calls
// math.randomseed(seed) first, then createPoiCatalog() reads from the now-seeded
// stream. This is threaded through explicitly here rather than at module load.
function buildMustTemplates(random) {
  const chemicals = [1, 2, 3];
  shuffle(random, chemicals);
  return MUST_TEMPLATES_SOURCE.map(([type, size, rotation, road, flat, chemicalSlot]) => ({
    type, size, rotation, road, flat,
    index: chemicalSlot ? chemicals[chemicalSlot - 1] : null,
  }));
}

function checkBounds(pois, xMin, xMax, yMin, yMax) {
  for (const poi of pois) {
    const half = Math.floor(poi.size / 2);
    if (!(poi.x + half > xMin && poi.x - half < xMax && poi.y + half > yMin && poi.y - half < yMax)) {
      throw new Error(`POI outside generation bounds: ${poi.type}`);
    }
  }
}

const TERRAIN_TYPES = [TYPE_MEADOW, TYPE_FOREST, TYPE_DESERT, TYPE_FIELD, TYPE_BURNTFOREST, TYPE_AUTUMNFOREST, TYPE_LAKE];

function createTerrainBalancer() {
  const weights = {
    [TYPE_MEADOW]: 0.2, [TYPE_FOREST]: 0.2, [TYPE_DESERT]: 0.1, [TYPE_FIELD]: 0.1,
    [TYPE_BURNTFOREST]: 0.1, [TYPE_AUTUMNFOREST]: 0.1, [TYPE_LAKE]: 0.2,
  };
  const counts = Object.fromEntries(TERRAIN_TYPES.map((t) => [t, 0]));
  let total = 0;
  return function choose(forced) {
    let selected = forced ?? null;
    if (selected == null) {
      if (total === 0) {
        selected = TYPE_FOREST;
      } else {
        let minimum = 1;
        for (const terrainType of TERRAIN_TYPES) {
          const ratio = counts[terrainType] / total / weights[terrainType];
          if (ratio < minimum) { selected = terrainType; minimum = ratio; }
        }
      }
    }
    counts[selected] += 1;
    total += 1;
    return selected;
  };
}

function copyTemplate(template, x, y, terrainType) {
  return {
    x, y, type: template.type, index: template.index, rotation: template.rotation,
    size: template.size, road: template.road, flat: template.flat,
    forceFlat: template.forceFlat, elevationSmoothing: template.elevationSmoothing,
    terrainType,
  };
}

function placeCatalog(cellData, collisionIndex, random, intNoise2d, pois, refs, largeTemplates, mustTemplates, chooseTerrain, islandShape, islandNoise, seed) {
  for (const poi of pois) {
    if (poi.terrainType == null) poi.terrainType = Math.max(Math.floor(poi.type / 100), 1);
    chooseTerrain(poi.terrainType);
  }

  const largeSpots = [];
  for (let row = 1; row <= 5; row += 1) {
    const columnCount = 5 + ((row - 1) % 2);
    for (let column = 1; column <= columnCount; column += 1) {
      const spot = { x: column * 20 - 70 + (row % 2) * 10, y: row * 16 - 48 };
      if ((row > 2 || column > 3) && !collisionIndex.collides(spot.x, spot.y, 8, pois)) largeSpots.push(spot);
    }
  }
  luaSort(largeSpots, (a, b) => (a.x + a.y + luaMod(intNoise2d(a.x, a.y, seed + 345), 75)) - (b.x + b.y + luaMod(intNoise2d(b.x, b.y, seed + 345), 75)));
  if (largeSpots.length < largeTemplates.length) throw new Error("Not enough large spots for large templates");
  while (largeSpots.length > largeTemplates.length) {
    const removeIndex = random.integer(1, largeSpots.length) - 1;
    largeSpots.splice(removeIndex, 1);
  }
  largeTemplates.forEach((template, index) => {
    const spot = largeSpots[index];
    pois.push(copyTemplate(template, spot.x, spot.y, chooseTerrain(Math.floor(template.type / 100))));
  });

  const excluded = new Set([refs.crashExit, refs.mechanic, refs.wocHouse, refs.resourceCar, refs.packing1, refs.packing2, refs.warehouseQuest, refs.excavationBridge]);
  const destinations = [];
  for (const poi of pois) if (poi.road && !excluded.has(poi)) destinations.push(poi);

  const mustSpots = [];
  const randomSpots = [];
  for (let row = 1; row <= 15; row += 1) {
    for (let column = 1; column <= 21; column += 1) {
      const noise = intNoise2d(column, row, seed + 557);
      const x = column * 6 - 66 + luaMod(noise, 3) - 1;
      const y = row * 6 - 50 + (column % 2) * 3;
      if (collisionIndex.collides(x, y, 8, pois)) continue;
      const eligible = islandShape(x, y) > 0.25 && !(x < -8 && y < -8);
      (eligible ? mustSpots : randomSpots).push({ x, y });
    }
  }
  luaSort(mustSpots, (a, b) => (a.x + a.y + luaMod(intNoise2d(a.x, a.y, seed + 653), 24)) - (b.x + b.y + luaMod(intNoise2d(b.x, b.y, seed + 653), 24)));

  const used = [];
  const step = mustSpots.length / mustTemplates.length;
  const first = random.integer(1, Math.ceil(step));
  for (let index = 1; index <= mustTemplates.length; index += 1) used.push(Math.floor((index - 1) * step) + first);
  mustTemplates.forEach((template, templateIndex) => {
    const spot = mustSpots[used[templateIndex] - 1];
    const dx = template.size === 1 ? -luaMod(intNoise2d(spot.x, spot.y, cellData.seed + 852), 2) : 0;
    const dy = template.size === 1 ? -luaMod(intNoise2d(spot.x, spot.y, cellData.seed + 299), 2) : 0;
    pois.push(copyTemplate(template, spot.x + dx, spot.y + dy, chooseTerrain(Math.floor(template.type / 100))));
  });
  let usedIndex = 0;
  mustSpots.forEach((spot, index) => {
    const oneBased = index + 1;
    if (usedIndex < used.length && oneBased === used[usedIndex]) usedIndex += 1;
    else randomSpots.push(spot);
  });

  luaSort(randomSpots, (a, b) => (a.x + a.y + luaMod(intNoise2d(a.x, a.y, seed + 603), 24)) - (b.x + b.y + luaMod(intNoise2d(b.x, b.y, seed + 603), 24)));
  let beginningCounter = 0;
  for (const spot of randomSpots) {
    let terrainType;
    if (islandNoise(spot.x, spot.y) >= 0) {
      let forced;
      if (spot.x < -8 && spot.y < -8) {
        const sequence = [TYPE_MEADOW, TYPE_FOREST, TYPE_MEADOW, TYPE_FIELD];
        forced = sequence[beginningCounter % sequence.length];
        beginningCounter += 1;
      }
      terrainType = chooseTerrain(forced);
    } else {
      terrainType = TYPE_LAKE;
    }
    pois.push({ x: spot.x, y: spot.y, type: P.RANDOM_PLACEHOLDER, size: 2, road: true, flat: false, terrainType });
  }
  return destinations;
}

function createRoadNetwork(cellData, collisionIndex, random, intNoise2d, simplexNoise2d, pois, refs, destinations, log) {
  const roadPois = [];
  preparePoiRoadGraph(pois, roadPois);
  const edges = [];
  const pairsToConnect = [
    [refs.crashExit, refs.mechanic], [refs.mechanic, refs.wocHouse], [refs.wocHouse, refs.packing1],
    [refs.wocHouse, refs.resourceCar], [refs.resourceCar, refs.campLarge], [refs.packing1, refs.warehouseQuest],
    [refs.warehouseQuest, refs.ruinCity], [refs.ruinCity, refs.packing2], [refs.packing2, refs.excavationBridge],
  ];
  for (const [a, b] of pairsToConnect) findRoadPath(roadPois, edges, a, b, log);
  shuffle(random, destinations);
  let previous = refs.packing2;
  for (const destination of destinations) {
    findRoadPath(roadPois, edges, previous, destination, log);
    previous = destination;
  }
  for (const poi of roadPois) poi.dist = Infinity;
  writeDistancesInNodes(null, refs.crashExit);
  luaSort(edges, (a, b) => Math.min(a.a.dist, a.b.dist) - Math.min(b.a.dist, b.b.dist));

  const drawRoads = new DrawRoads(cellData, intNoise2d, simplexNoise2d, log);
  return drawRoads.run(edges, pois, collisionIndex, () => new RoadNodeGrid(cellData));
}

function addExtraCliffs(cellData, collisionIndex, pois, roadNodes, padding, noise) {
  const terrainIs = (x, y, terrainType) => cellData.insideCornerBounds(x, y) && cellData.cornerTerrainType[cellData.cornerIndex(x, y)] === terrainType;
  cellData.forEveryCorner((x, y) => {
    if (collisionIndex.collides(x, y, 2, pois)) return;
    let valid = true;
    let minimum = cellData.cliffLevel[cellData.cornerIndex(x, y)];
    outer: for (let cy = y - 1; cy <= y + 1; cy += 1) {
      for (let cx = x - 1; cx <= x + 1; cx += 1) {
        if (!terrainIs(cx, cy, TYPE_MEADOW)) { valid = false; break outer; }
        minimum = Math.min(minimum, cellData.cliffLevel[cellData.cornerIndex(cx, cy)]);
      }
    }
    if (valid) {
      outer2: for (let cy = y - 1; cy <= y; cy += 1) {
        for (let cx = x - 1; cx <= x; cx += 1) {
          if (hasRoad(roadNodes, cx, cy)) { valid = false; break outer2; }
        }
      }
    }
    if (valid) cellData.cliffLevel[cellData.cornerIndex(x, y)] = minimum + noise(x, y);
  }, padding);
}

function forceDistantRoadEdgeToMeadow(cellData, from, to) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const terrain = cellData.cornerTerrainType;
  const ci = cellData.cornerIndex.bind(cellData);
  if (dx === -1) { terrain[ci(to.x, to.y)] = TYPE_MEADOW; terrain[ci(to.x, to.y + 1)] = TYPE_MEADOW; }
  else if (dx === 1) { terrain[ci(to.x + 1, to.y)] = TYPE_MEADOW; terrain[ci(to.x + 1, to.y + 1)] = TYPE_MEADOW; }
  else if (dy === -1) { terrain[ci(to.x, to.y)] = TYPE_MEADOW; terrain[ci(to.x + 1, to.y)] = TYPE_MEADOW; }
  else if (dy === 1) { terrain[ci(to.x, to.y + 1)] = TYPE_MEADOW; terrain[ci(to.x + 1, to.y + 1)] = TYPE_MEADOW; }
}

function meadowCell(cellData, node) {
  const terrain = cellData.cornerTerrainType;
  const ci = cellData.cornerIndex.bind(cellData);
  terrain[ci(node.x, node.y)] = TYPE_MEADOW;
  terrain[ci(node.x + 1, node.y)] = TYPE_MEADOW;
  terrain[ci(node.x, node.y + 1)] = TYPE_MEADOW;
  terrain[ci(node.x + 1, node.y + 1)] = TYPE_MEADOW;
}

function straightRoadSpot(cellData, list, node) {
  const bits = cellData.flags[cellData.cellIndex(node.x, node.y)] & MASK_ROADCLIFF;
  if (bits === MASK_ROADS_SN || bits === MASK_ROADS_WE) list.push({ x: node.x, y: node.y });
}

// Walks the road-node graph from the crash site outward, assigning each node a
// biome-road tile (or, where none fits, flattening it to plain meadow) while
// keeping every branch connected back to the start. The Lua's `trace` table
// tracks a spanning structure over the visited nodes with a `reverse` operation
// that re-roots a subtree when two branches collide — ported field-for-field
// since the branch-id bookkeeping is exactly what keeps disconnected branches
// from being silently dropped.
function paintBiomeRoads(cellData, roadNodes, startPoi, biomeRoads, intNoise2d, log) {
  const potential = [];
  const start = roadNodes.get(startPoi.x, startPoi.y);
  const stack = [start];
  const visited = new Set([start]);
  const trace = new Map();
  const ends = [];
  let traceId = 0;

  const updateBranchIds = (node) => {
    const id = trace.get(node).id;
    for (const edge of node.edges) {
      const entry = trace.get(edge.n);
      if (entry && entry.parent === node && entry.id !== id) {
        entry.id = id;
        updateBranchIds(edge.n);
      }
    }
  };
  const reverse = (node, collision) => {
    const nodeEntry = trace.get(node);
    const oldParent = nodeEntry.parent;
    if (oldParent && trace.has(oldParent)) trace.get(oldParent).children -= 1;
    const collisionEntry = trace.get(collision);
    collisionEntry.children += 1;
    nodeEntry.parent = collision;
    nodeEntry.id = collisionEntry.id;
    updateBranchIds(node);
    if (oldParent) {
      reverse(oldParent, node);
    } else {
      nodeEntry.children += 1;
      ends.push(node);
    }
  };

  while (stack.length > 0) {
    const node = stack.pop();
    for (const edge of node.edges) {
      if (!(edge.road || edge.shortcut)) continue;
      if (!visited.has(edge.n)) {
        visited.add(edge.n);
        if (!biomeRoads.getTile(cellData, cellData.cornerTerrainType, edge.n.x, edge.n.y)) {
          forceDistantRoadEdgeToMeadow(cellData, node, edge.n);
        }
        if (biomeRoads.getTile(cellData, cellData.cornerTerrainType, edge.n.x, edge.n.y)) {
          const nodeEntry = trace.get(node);
          if (nodeEntry) {
            nodeEntry.children += 1;
            trace.set(edge.n, { parent: node, children: 0, origin: node, id: nodeEntry.id });
          } else {
            traceId += 1;
            trace.set(edge.n, { parent: null, children: 0, origin: node, id: traceId });
          }
        } else {
          meadowCell(cellData, edge.n);
          const nodeEntry = trace.get(node);
          if (nodeEntry) { nodeEntry.children += 1; ends.push(node); }
          straightRoadSpot(cellData, potential, edge.n);
        }
        stack.push(edge.n);
      } else if (trace.has(node)) {
        const nodeEntry = trace.get(node);
        const otherEntry = trace.get(edge.n);
        if (otherEntry && nodeEntry.id !== otherEntry.id) {
          reverse(node, edge.n);
          nodeEntry.children += 1;
          ends.push(node);
        } else if (edge.n !== nodeEntry.origin) {
          nodeEntry.children += 1;
          ends.push(node);
        }
      }
    }
  }

  for (const first of ends) {
    trace.get(first).children -= 1;
    let node = first;
    while (node) {
      const entry = trace.get(node);
      if (entry.children > 0) break;
      const tile = biomeRoads.getTile(cellData, cellData.cornerTerrainType, node.x, node.y);
      if (tile) {
        const noise = intNoise2d(node.x, node.y, cellData.seed + 499);
        const index = cellData.cellIndex(node.x, node.y);
        cellData.uid[index] = tile.tiles[luaMod(noise, tile.tiles.length)];
        cellData.rotation[index] = tile.rotation;
        cellData.xOffset[index] = 0;
        cellData.yOffset[index] = 0;
        if (tile.terrainType) {
          cellData.flags[index] = (cellData.flags[index] & ~MASK_TERRAINTYPE)
            | ((tile.terrainType << SHIFT_TERRAINTYPE) & MASK_TERRAINTYPE);
        }
      } else {
        meadowCell(cellData, node);
        straightRoadSpot(cellData, potential, node);
      }
      const parent = entry.parent;
      trace.delete(node);
      if (parent) trace.get(parent).children -= 1;
      else break;
      node = parent;
    }
  }
  return potential;
}

function placeRandomRoadPois(cellData, collisionIndex, random, intNoise2d, spots, pois, padding, writePoiFn) {
  shuffle(random, spots);
  let count = 0;
  for (const spot of spots) {
    if (!collisionIndex.collides(spot.x, spot.y, 3, pois)) {
      const bits = cellData.flags[cellData.cellIndex(spot.x, spot.y)] & MASK_ROADS;
      const poi = {
        x: spot.x, y: spot.y, type: P.ROAD_RANDOM, size: 1,
        rotation: (bits === MASK_ROADS_SN ? 1 : 0) + luaMod(intNoise2d(spot.x, spot.y, cellData.seed + 211), 2) * 2,
        road: true, flat: false, terrainType: TYPE_MEADOW, edges: [],
      };
      writePoiFn(poi, padding);
      pois.push(poi);
      count += 1;
    }
    if (count >= 20) break;
  }
}

function buildElevation(cellData, pois, xMin, xMax, yMin, yMax, padding, elevationNoise) {
  const terrainIs = (x, y, terrainType) => cellData.insideCornerBounds(x, y) && cellData.cornerTerrainType[cellData.cornerIndex(x, y)] === terrainType;
  cellData.forEveryCorner((x, y) => {
    let adjacent = false;
    for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) adjacent = adjacent || terrainIs(x + dx, y + dy, TYPE_LAKE);
    const index = cellData.cornerIndex(x, y);
    cellData.cornerLakeAdjacent[index] = adjacent ? 1 : 0;
    if (adjacent) cellData.cornerHillyness[index] = -0.2;
  }, padding);
  for (const poi of pois) if (poi.type !== P.CRASHSITE_AREA) setForcedAndLakeAdjacentPoiHillynessToZero(cellData, poi);

  const hillyness = cellData.cornerHillyness;
  const ci = cellData.cornerIndex.bind(cellData);
  for (let y = yMin; y <= yMax + 1; y += 1) {
    for (let x = xMin + 1; x <= xMax + 1; x += 1) {
      let h = hillyness[ci(x, y)];
      h = Math.min(h, hillyness[ci(x - 1, y)] + 0.2);
      if (y > yMin) h = Math.min(h, hillyness[ci(x - 1, y - 1)] + 0.2);
      if (y < yMax + 1) h = Math.min(h, hillyness[ci(x - 1, y + 1)] + 0.2);
      hillyness[ci(x, y)] = h;
    }
    for (let x = xMax; x >= xMin + 1; x -= 1) {
      let h = hillyness[ci(x, y)];
      h = Math.min(h, hillyness[ci(x + 1, y)] + 0.2);
      if (y > yMin) h = Math.min(h, hillyness[ci(x + 1, y - 1)] + 0.2);
      if (y < yMax + 1) h = Math.min(h, hillyness[ci(x + 1, y + 1)] + 0.2);
      hillyness[ci(x, y)] = h;
    }
  }
  for (let x = xMin; x <= xMax + 1; x += 1) {
    for (let y = yMin + 1; y <= yMax + 1; y += 1) {
      let h = hillyness[ci(x, y)];
      h = Math.min(h, hillyness[ci(x, y - 1)] + 0.2);
      if (x > xMin) h = Math.min(h, hillyness[ci(x - 1, y - 1)] + 0.2);
      if (x < xMax + 1) h = Math.min(h, hillyness[ci(x + 1, y - 1)] + 0.2);
      hillyness[ci(x, y)] = h;
    }
    for (let y = yMax; y >= yMin + 1; y -= 1) {
      let h = hillyness[ci(x, y)];
      h = Math.min(h, hillyness[ci(x, y + 1)] + 0.2);
      if (x > xMin) h = Math.min(h, hillyness[ci(x - 1, y + 1)] + 0.2);
      if (x < xMax + 1) h = Math.min(h, hillyness[ci(x + 1, y + 1)] + 0.2);
      hillyness[ci(x, y)] = h;
    }
  }
  cellData.forEveryCorner((x, y) => {
    const index = ci(x, y);
    const h = clamp(hillyness[index], 0, 1);
    cellData.elevation[index] = elevationNoise(x, y) * h;
  }, padding);
  for (const poi of pois) if (poi.type !== P.CRASHSITE_AREA) smoothPoiElevation(cellData, poi);
  cellData.forEveryCorner((x, y) => {
    const index = ci(x, y);
    const h = clamp(hillyness[index], 0, 1);
    cellData.elevation[index] = cellData.elevation[index] * h;
  }, padding);
  for (const poi of pois) if (poi.type !== P.CRASHSITE_AREA) flattenPoiElevation(cellData, poi);
}

// generateOverworldCelldata itself. `random` and the noise functions are
// created by the caller (matching where math.randomseed(seed) and the Lua
// noise closures come from) so a fresh CellData + a fresh PRNG always pair up.
export function generateOverworldCelldata(cellData, {
  xMin, xMax, yMin, yMax, seed, padding,
  random, intNoise2d, simplexNoise2d, perlinNoise2d,
  metadata, selectors, log = () => {},
}) {
  random.seed(seed);
  cellData.initialize(xMin, xMax, yMin, yMax, seed, padding);
  initializeCorners(cellData, xMin, xMax, yMin, yMax, padding);
  const noise = buildNoise(seed, simplexNoise2d, perlinNoise2d, (x, y) => cellData.cornerGradient[cellData.cornerIndex(x, y)]);

  const { pois, refs, largeTemplates } = createPoiCatalog();
  const mustTemplates = buildMustTemplates(random);
  checkBounds(pois, xMin, xMax, yMin, yMax);
  const chooseTerrain = createTerrainBalancer();
  const collisionIndex = new CollisionIndex();
  const destinations = placeCatalog(cellData, collisionIndex, random, intNoise2d, pois, refs, largeTemplates, mustTemplates, chooseTerrain, noise.islandShape, noise.islandNoise, seed);
  collisionIndex.invalidate();
  checkBounds(pois, xMin, xMax, yMin, yMax);
  for (const poi of pois) if (poi.cliffLevel == null) poi.cliffLevel = noise.cliffNoise(poi.x, poi.y);

  cellData.forEveryCorner((x, y) => {
    const index = cellData.cornerIndex(x, y);
    if (noise.islandNoise(x, y) >= 0) {
      const poi = closestPoi(pois, x, y);
      cellData.cornerTerrainType[index] = (poi.terrainType === TYPE_LAKE && noise.islandShape(x, y) < 1) ? TYPE_MEADOW : poi.terrainType;
      cellData.cliffLevel[index] = poi.cliffLevel ?? 0;
    } else {
      cellData.cornerTerrainType[index] = TYPE_LAKE;
      cellData.cliffLevel[index] = 0;
    }
  }, padding);

  const roadNodes = createRoadNetwork(cellData, collisionIndex, random, intNoise2d, simplexNoise2d, pois, refs, destinations, log);
  collisionIndex.invalidate();
  const poiSelector = new PoiSelector();
  convertPlaceholderPois(cellData, poiSelector, pois, intNoise2d);
  collisionIndex.invalidate();
  for (const poi of pois) {
    if (poi.type === P.RANDOM_PLACEHOLDER || poi.type == null) throw new Error("Unresolved placeholder POI survived conversion");
  }

  const writePoiFn = (poi, poiPadding) => {
    const variation = poi.index != null ? poi.index - 1 : intNoise2d(poi.x, poi.y, cellData.seed + 2854);
    const uid = selectors.poiTile(poi.type, variation);
    const rotation = poi.rotation ?? luaMod(intNoise2d(poi.x, poi.y, cellData.seed + 9439), 4);
    if (uid == null) throw new Error(`Unknown POI type ${poi.type}`);
    const x = poi.x - Math.floor(poi.size / 2);
    const y = poi.y - Math.floor(poi.size / 2);
    if (cellData.insideCellBounds(x, y, poiPadding) && cellData.insideCellBounds(x + poi.size - 1, y + poi.size - 1, poiPadding)) {
      writeTile(cellData, uid, x, y, poi.size, rotation, Math.floor(poi.type / 100));
    } else {
      log("POI outside generated bounds");
    }
  };

  for (const poi of pois) if (poi.type !== P.CRASHSITE_AREA) { flattenPoiCliff(cellData, poi); writePoiFn(poi, padding); }
  selectors.writeStartArea(cellData, pois, roadNodes, writeTile);
  injectExcavation(cellData, metadata, selectors.excavationWorld, EXCAVATION_ISLAND);

  enforceCliffRoadLimitations(cellData, roadNodes, log);
  addExtraCliffs(cellData, collisionIndex, pois, roadNodes, padding, noise.extraCliffNoise);
  collisionIndex.invalidate();
  evaluateRoadsAndCliffs(cellData, roadNodes, selectors.cliffRoadTile, intNoise2d);
  cellData.forEveryCell((x, y) => {
    if ((cellData.flags[cellData.cellIndex(x, y)] & MASK_CLIFF) !== 0) meadowCell(cellData, { x, y });
  });
  addBorderingMeadows(cellData);
  const spots = paintBiomeRoads(cellData, roadNodes, refs.crashExit, selectors.biomeRoads, intNoise2d, log);
  placeRandomRoadPois(cellData, collisionIndex, random, intNoise2d, spots, pois, padding, writePoiFn);
  collisionIndex.invalidate();
  buildElevation(cellData, pois, xMin, xMax, yMin, yMax, padding, noise.elevationNoise);
  addExtraPois(cellData, poiSelector, collisionIndex, random, pois, padding, writePoiFn, log);

  for (const terrainType of [TYPE_MEADOW, TYPE_FOREST, TYPE_DESERT, TYPE_FIELD, TYPE_BURNTFOREST, TYPE_AUTUMNFOREST, TYPE_LAKE]) {
    evaluateType(cellData, terrainType, (bits, a, b) => selectors.tileForType(terrainType, bits, a, b), intNoise2d);
  }

  for (let y = yMin; y <= yMax; y += 1) {
    for (let x = xMin; x <= xMax; x += 1) {
      if (cellData.uid[cellData.cellIndex(x, y)] === 0) log(`Nil cell at: ${x} ${y}`);
    }
  }
}
