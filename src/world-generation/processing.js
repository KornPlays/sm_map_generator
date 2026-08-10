// Terrain post-processing: POI type selection, cliff/road slope limiting, and
// the four evaluateType/evaluateRoadsAndCliffs passes that turn corner terrain
// types into placed tiles. Ported from processing.lua.
//
// choosePoi/rewindPoi share mutable cursor state across the whole generation run
// (nextPoi in the Lua), so they live on a PoiSelector instance rather than as
// free functions — a fresh CellData per generateCells call needs a fresh
// selector too, matching the Lua module being re-evaluated per Lua VM instance.

import { POI_TYPES } from "./poi-types.js";
import { MASK_FLAT, MASK_ROADS, MASK_TERRAINTYPE, SHIFT_TERRAINTYPE, TYPE_AUTUMNFOREST, TYPE_BURNTFOREST, TYPE_DESERT, TYPE_FIELD, TYPE_FOREST, TYPE_LAKE, TYPE_MEADOW } from "./cell-data.js";
import { closestPoi, removeFromArray, round, shuffle } from "./placement.js";
import { luaMod } from "./lua-compat.js";

const P = POI_TYPES;

// [requestedSize 1, requestedSize 2] choice lists, exactly as poiRotation in the
// Lua — including its asymmetry (forest has 5 size-1 choices, 4 size-2 ones;
// desert/field/burnt/autumn forest reuse the same list for both sizes).
const POI_ROTATION = {
  [TYPE_MEADOW]: [
    [P.CAMP, P.RUIN, P.RANDOM, P.RUIN, P.RANDOM, P.RUIN],
    [P.CAMP, P.RUIN, P.RANDOM, P.RUIN_MEDIUM, P.RANDOM_MEDIUM, P.RUIN_MEDIUM],
  ],
  [TYPE_FOREST]: [
    [P.FOREST_CAMP, P.FOREST_RUIN, P.FOREST_RANDOM, P.FOREST_CAMP, P.FOREST_RANDOM],
    [P.FOREST_CAMP, P.FOREST_RUIN, P.FOREST_RANDOM, P.FOREST_RUIN_MEDIUM, P.FOREST_RANDOM_MEDIUM],
  ],
  [TYPE_DESERT]: [
    [P.DESERT_RANDOM, P.DESERT_OILPOOL],
    [P.DESERT_RANDOM, P.DESERT_OILPOOL],
  ],
  [TYPE_FIELD]: [
    [P.FARMINGPATCH, P.FIELD_RUIN, P.FIELD_RANDOM],
    [P.FARMINGPATCH, P.FIELD_RUIN, P.FIELD_RANDOM],
  ],
  [TYPE_BURNTFOREST]: [
    [P.BURNTFOREST_CAMP, P.BURNTFOREST_RUIN, P.BURNTFOREST_RUIN],
    [P.BURNTFOREST_CAMP, P.BURNTFOREST_RUIN, P.BURNTFOREST_RUIN],
  ],
  [TYPE_AUTUMNFOREST]: [
    [P.AUTUMNFOREST_CAMP, P.AUTUMNFOREST_RUIN],
    [P.AUTUMNFOREST_CAMP, P.AUTUMNFOREST_RUIN],
  ],
  [TYPE_LAKE]: [
    [P.LAKE_RANDOM],
    [P.LAKE_RANDOM, P.LAKE_RUIN_MEDIUM, P.LAKE_RANDOM_MEDIUM, P.LAKE_RANDOM_MEDIUM],
  ],
};

const TWO_CELL_POI = new Set([
  P.RUIN_MEDIUM, P.RANDOM_MEDIUM,
  P.FOREST_RUIN_MEDIUM, P.FOREST_RANDOM_MEDIUM,
  P.LAKE_RUIN_MEDIUM, P.LAKE_RANDOM_MEDIUM,
]);

export class PoiSelector {
  constructor() {
    // nextPoi[terrainType][requestedSize - 1] — one cursor per (terrain, size)
    // pair, 0-based into the choice list, starting where the Lua's 1-based
    // cursor of 1 does.
    this.cursors = new Map();
    for (const terrainType of Object.keys(POI_ROTATION)) {
      this.cursors.set(Number(terrainType), [0, 0]);
    }
  }

  // Always succeeds in practice — every (terrainType, requestedSize) pair the
  // generator queries has a non-empty choice list — but the boolean is kept so
  // callers read the same as the Lua's `if choosePoi(...) then`.
  choosePoi(poi, requestedSize, terrainType) {
    const choices = POI_ROTATION[terrainType][requestedSize - 1];
    if (!choices.length) throw new Error(`No POI choices for terrain ${terrainType} and size ${requestedSize}`);
    const cursors = this.cursors.get(terrainType);
    const cursor = cursors[requestedSize - 1];
    poi.type = choices[cursor];
    poi.size = TWO_CELL_POI.has(poi.type) ? 2 : 1;
    poi.flat = terrainType === TYPE_LAKE;
    cursors[requestedSize - 1] = (cursor + 1) % choices.length;
    return poi.type != null;
  }

  rewindPoi(requestedSize, terrainType) {
    const choices = POI_ROTATION[terrainType][requestedSize - 1];
    const cursors = this.cursors.get(terrainType);
    let cursor = cursors[requestedSize - 1] - 1;
    if (cursor < 0) cursor = choices.length - 1;
    cursors[requestedSize - 1] = cursor;
  }
}

export function convertPlaceholderPois(cellData, selector, pois, intNoise2d) {
  for (const poi of pois) {
    if (poi.type !== P.RANDOM_PLACEHOLDER) continue;
    if (selector.choosePoi(poi, 2, poi.terrainType)) {
      if (poi.size === 1) {
        poi.x -= luaMod(intNoise2d(poi.x, poi.y, cellData.seed + 852), 2);
        poi.y -= luaMod(intNoise2d(poi.x, poi.y, cellData.seed + 299), 2);
      }
    } else {
      poi.type = null;
    }
  }
  removeFromArray(pois, (poi) => poi.type == null);
}

export function flattenPoiCliff(cellData, poi) {
  let terrainType = Math.floor(poi.type / 100);
  if (terrainType === 0) terrainType = TYPE_MEADOW;
  const margin = terrainType === TYPE_MEADOW ? 0 : 1;
  const half = Math.floor(poi.size / 2);
  for (let dy = -margin; dy <= poi.size + margin; dy += 1) {
    for (let dx = -margin; dx <= poi.size + margin; dx += 1) {
      const x = poi.x + dx - half;
      const y = poi.y + dy - half;
      if (!cellData.insideCornerBounds(x, y)) continue;
      const index = cellData.cornerIndex(x, y);
      cellData.cornerTerrainType[index] = terrainType;
      cellData.cliffLevel[index] = poi.cliffLevel ?? 0;
      cellData.cornerForceFlat[index] = 1;
    }
  }
}

export function addBorderingMeadows(cellData) {
  cellData.forEveryCell((x, y) => {
    const terrain = cellData.cornerTerrainType;
    const iC = cellData.cornerIndex(x, y);
    const iE = cellData.cornerIndex(x + 1, y);
    const iN = cellData.cornerIndex(x, y + 1);
    const iNE = cellData.cornerIndex(x + 1, y + 1);
    if (terrain[iC] !== TYPE_MEADOW && terrain[iE] !== TYPE_MEADOW && terrain[iC] !== terrain[iE]) {
      terrain[iE] = TYPE_MEADOW;
    }
    if (terrain[iC] !== TYPE_MEADOW && terrain[iN] !== TYPE_MEADOW && terrain[iC] !== terrain[iN]) {
      terrain[iN] = TYPE_MEADOW;
    }
    if (terrain[iC] !== TYPE_MEADOW && terrain[iNE] !== TYPE_MEADOW && terrain[iC] !== terrain[iNE]) {
      terrain[iNE] = TYPE_MEADOW;
    }
    if (terrain[iN] !== TYPE_MEADOW && terrain[iE] !== TYPE_MEADOW && terrain[iN] !== terrain[iE]) {
      if (terrain[iN] === TYPE_LAKE) terrain[iN] = TYPE_MEADOW;
      else terrain[iE] = TYPE_MEADOW;
    }
  });
}

const NEIGHBOR_RING = [[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0]];

// clampCornerSlope/clampRoadCell run once per grid corner per sweep — up to a
// few hundred thousand times across enforceCliffRoadLimitations's passes — so
// they report [corrections, violations] packed into one integer (corrections
// * PACK_SCALE + violations) instead of a tuple array. Neither count can reach
// PACK_SCALE in one call (clampRoadCell touches at most 4 corners), so this is
// lossless; sweep() unpacks it back into the same two counters it always kept.
const PACK_SCALE = 65536;

function clampCornerSlope(cellData, x, y, lower) {
  let extreme = lower ? Infinity : -Infinity;
  for (const [dx, dy] of NEIGHBOR_RING) {
    const value = cellData.getCornerCliffLevel(x + dx, y + dy);
    extreme = lower ? Math.min(extreme, value) : Math.max(extreme, value);
  }
  const index = cellData.cornerIndex(x, y);
  const current = cellData.cliffLevel[index];
  const invalid = lower ? extreme < current - 3 : extreme > current + 3;
  if (!invalid) return 0;
  if (cellData.cornerForceFlat[index]) return 1;
  cellData.cliffLevel[index] = lower ? extreme + 3 : extreme - 3;
  return PACK_SCALE;
}

function edgeIsRoad(edge) {
  return edge.road === true;
}

function clampRoadCell(cellData, x, y, lower, roadNodes) {
  const node = roadNodes.get(x, y);
  let roadCount = 0;
  if (node) for (const edge of node.edges) if (edgeIsRoad(edge)) roadCount += 1;
  if (roadCount === 0) return 0;

  const i0 = cellData.cornerIndex(x, y);
  const i1 = cellData.cornerIndex(x + 1, y);
  const i2 = cellData.cornerIndex(x + 1, y + 1);
  const i3 = cellData.cornerIndex(x, y + 1);
  const v0 = cellData.cliffLevel[i0];
  const v1 = cellData.cliffLevel[i1];
  const v2 = cellData.cliffLevel[i2];
  const v3 = cellData.cliffLevel[i3];
  const low = Math.min(v0, v1, v2, v3);
  const high = Math.max(v0, v1, v2, v3);
  const allowed = roadCount === 2 ? 1 : 0;
  if (high - low <= allowed) return 0;

  const limit = lower ? low + allowed : high - allowed;
  let corrections = 0;
  let violations = 0;
  if (lower ? v0 > limit : v0 < limit) {
    if (cellData.cornerForceFlat[i0]) violations += 1;
    else { cellData.cliffLevel[i0] = limit; corrections += 1; }
  }
  if (lower ? v1 > limit : v1 < limit) {
    if (cellData.cornerForceFlat[i1]) violations += 1;
    else { cellData.cliffLevel[i1] = limit; corrections += 1; }
  }
  if (lower ? v2 > limit : v2 < limit) {
    if (cellData.cornerForceFlat[i2]) violations += 1;
    else { cellData.cliffLevel[i2] = limit; corrections += 1; }
  }
  if (lower ? v3 > limit : v3 < limit) {
    if (cellData.cornerForceFlat[i3]) violations += 1;
    else { cellData.cliffLevel[i3] = limit; corrections += 1; }
  }
  return corrections * PACK_SCALE + violations;
}

function sweep(cellData, clampFn, roadNodes, lower, reverse) {
  const { xMin, xMax, yMin, yMax } = cellData.bounds;
  const padding = cellData.padding;
  const minX = xMin + padding;
  const maxX = xMax - padding;
  const minY = yMin + padding;
  const maxY = yMax - padding;
  let corrections = 0;
  let violations = 0;
  const [yStart, yEnd, yStep] = reverse ? [maxY, minY, -1] : [minY, maxY, 1];
  const [xStart, xEnd, xStep] = reverse ? [maxX, minX, -1] : [minX, maxX, 1];
  for (let y = yStart; reverse ? y >= yEnd : y <= yEnd; y += yStep) {
    for (let x = xStart; reverse ? x >= xEnd : x <= xEnd; x += xStep) {
      const packed = clampFn(cellData, x, y, lower, roadNodes);
      corrections += Math.floor(packed / PACK_SCALE);
      violations += packed % PACK_SCALE;
    }
  }
  return [corrections, violations];
}

export function enforceCliffRoadLimitations(cellData, roadNodes, log = () => {}) {
  let pass = 1;
  let hasViolations = true;
  while (pass <= 5 && hasViolations) {
    hasViolations = false;
    const lower = pass % 2 === 1;
    const [, v1] = sweep(cellData, clampCornerSlope, roadNodes, lower, false);
    hasViolations = hasViolations || v1 > 0;
    const [, v2] = sweep(cellData, clampCornerSlope, roadNodes, lower, true);
    hasViolations = hasViolations || v2 > 0;
    const [c3, v3] = sweep(cellData, clampRoadCell, roadNodes, lower, false);
    hasViolations = hasViolations || v3 > 0;
    log("Road SW to NE:", c3, "corrections,", v3, "violations");
    const [c4, v4] = sweep(cellData, clampRoadCell, roadNodes, lower, true);
    hasViolations = hasViolations || v4 > 0;
    log("Road NE to SW:", c4, "corrections,", v4, "violations");
    pass += 1;
  }
}

function calculateCliffBits(se, sw, nw, ne) {
  const lowest = Math.min(se, sw, nw, ne);
  const relative = (value) => Math.min(Math.max(value - lowest, 0), 3);
  return (relative(se) << 6) | (relative(sw) << 4) | (relative(nw) << 2) | relative(ne);
}

function calculateRoadBits(south, west, north, east) {
  const { FLAG_ROAD_E, FLAG_ROAD_N, FLAG_ROAD_W, FLAG_ROAD_S } = cellDataFlags;
  return (east ? FLAG_ROAD_E : 0) + (north ? FLAG_ROAD_N : 0) + (west ? FLAG_ROAD_W : 0) + (south ? FLAG_ROAD_S : 0);
}
const cellDataFlags = { FLAG_ROAD_E: 0x0100, FLAG_ROAD_N: 0x0200, FLAG_ROAD_W: 0x0400, FLAG_ROAD_S: 0x0800 };

export function evaluateRoadsAndCliffs(cellData, roadNodes, getCliffRoadTileIdAndRotation, intNoise2d) {
  const { xMin, xMax, yMin, yMax } = cellData.bounds;
  const padding = cellData.padding;
  const minX = xMin + padding;
  const maxX = xMax - padding;
  const minY = yMin + padding;
  const maxY = yMax - padding;
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const cliffBits = calculateCliffBits(
        cellData.getCornerCliffLevel(x + 1, y),
        cellData.getCornerCliffLevel(x, y),
        cellData.getCornerCliffLevel(x, y + 1),
        cellData.getCornerCliffLevel(x + 1, y + 1),
      );
      let east = false;
      let north = false;
      let west = false;
      let south = false;
      const node = roadNodes.get(x, y);
      if (node) {
        for (const edge of node.edges) {
          if (!edgeIsRoad(edge)) continue;
          if (edge.n.y === node.y) {
            east = east || edge.n.x > node.x;
            west = west || edge.n.x < node.x;
          } else if (edge.n.x === node.x) {
            north = north || edge.n.y > node.y;
            south = south || edge.n.y < node.y;
          }
        }
      }
      const index = cellData.cellIndex(x, y);
      cellData.flags[index] |= calculateRoadBits(south, west, north, east) | cliffBits;
    }
  }
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const flags = cellData.getRoadCliffFlags(x, y);
      // Packed (tileId << 2) | rotation, or -1 for "no tile" — see packTile in
      // selectors.js. Unpacked inline to avoid a tuple-array allocation here.
      const packed = getCliffRoadTileIdAndRotation(flags, intNoise2d(x, y, cellData.seed + 2854));
      const index = cellData.cellIndex(x, y);
      if (packed >= 0 && cellData.uid[index] === 0) {
        cellData.uid[index] = packed >> 2;
        cellData.xOffset[index] = 0;
        cellData.yOffset[index] = 0;
        cellData.rotation[index] = packed & 3;
        cellData.groupId[index] = 0;
      }
    }
  }
}

function aroundPoi(cellData, poi, callback) {
  const half = Math.floor(poi.size / 2);
  for (let dy = -1; dy <= poi.size + 1; dy += 1) {
    const edgeRow = dy === -1 || dy === poi.size + 1;
    const dxStart = edgeRow ? 0 : -1;
    const dxEnd = edgeRow ? poi.size : poi.size + 1;
    for (let dx = dxStart; dx <= dxEnd; dx += 1) {
      const x = poi.x + dx - half;
      const y = poi.y + dy - half;
      if (cellData.insideCornerBounds(x, y)) callback(x, y);
    }
  }
}

export function setForcedAndLakeAdjacentPoiHillynessToZero(cellData, poi) {
  if (!poi.flat) return;
  let touchesLake = false;
  if (!poi.forceFlat) {
    aroundPoi(cellData, poi, (x, y) => {
      if (cellData.cornerLakeAdjacent[cellData.cornerIndex(x, y)]) touchesLake = true;
    });
  }
  if (touchesLake || poi.forceFlat) {
    aroundPoi(cellData, poi, (x, y) => { cellData.cornerHillyness[cellData.cornerIndex(x, y)] = 0; });
  }
}

export function smoothPoiElevation(cellData, poi) {
  if (!poi.elevationSmoothing) return;
  const half = Math.floor(poi.size / 2);
  let total = 0;
  let count = 0;
  for (let dy = 0; dy <= poi.size; dy += 1) {
    for (let dx = 0; dx <= poi.size; dx += 1) {
      const x = poi.x + dx - half;
      const y = poi.y + dy - half;
      if (cellData.insideCornerBounds(x, y)) {
        total += cellData.elevation[cellData.cornerIndex(x, y)];
        count += 1;
      }
    }
  }
  if (count === 0) return;
  const average = total / count;
  const rings = poi.elevationSmoothing;
  for (let dy = -rings; dy <= poi.size + rings; dy += 1) {
    for (let dx = -rings; dx <= poi.size + rings; dx += 1) {
      const ox = dx < 0 ? -dx : (dx > poi.size ? dx - poi.size : 0);
      const oy = dy < 0 ? -dy : (dy > poi.size ? dy - poi.size : 0);
      const ring = Math.max(ox, oy);
      if (ring <= 0 || ring > rings) continue;
      const x = poi.x + dx - half;
      const y = poi.y + dy - half;
      if (!cellData.insideCornerBounds(x, y)) continue;
      const index = cellData.cornerIndex(x, y);
      const blend = (rings - ring + 1) / (rings + 1);
      const value = cellData.elevation[index];
      cellData.elevation[index] = value + (average - value) * blend;
    }
  }
}

export function flattenPoiElevation(cellData, poi) {
  if (!poi.flat) return;
  let total = 0;
  let count = 0;
  let lake = false;
  aroundPoi(cellData, poi, (x, y) => {
    const index = cellData.cornerIndex(x, y);
    total += cellData.elevation[index];
    count += 1;
    lake = lake || Boolean(cellData.cornerLakeAdjacent[index]) || poi.type === P.TEST;
  });
  const average = lake ? 0 : round(4 * total / count) / 4;
  aroundPoi(cellData, poi, (x, y) => { cellData.elevation[cellData.cornerIndex(x, y)] = average; });
  const half = Math.floor(poi.size / 2);
  for (let dy = 0; dy <= poi.size; dy += 1) {
    for (let dx = 0; dx <= poi.size; dx += 1) {
      const x = poi.x + dx - half;
      const y = poi.y + dy - half;
      if (cellData.insideCellBounds(x, y)) cellData.flags[cellData.cellIndex(x, y)] |= MASK_FLAT;
    }
  }
}

export function uniformSquare(cellData, x, y, size, terrainType) {
  for (let dy = 0; dy <= size; dy += 1) {
    for (let dx = 0; dx <= size; dx += 1) {
      if (cellData.cornerTerrainType[cellData.cornerIndex(x + dx, y + dy)] !== terrainType) return false;
    }
  }
  return true;
}

export function placeTerrainCompatible(cellData, poi) {
  const x0 = poi.x - Math.floor(poi.size / 2);
  const y0 = poi.y - Math.floor(poi.size / 2);
  const terrainType = Math.floor(poi.type / 100);
  if (uniformSquare(cellData, x0, y0, poi.size, terrainType)) return true;
  for (let y = y0 - 1; y <= y0 + poi.size; y += 1) {
    for (let x = x0 - 1; x <= x0 + poi.size; x += 1) {
      if ((cellData.flags[cellData.cellIndex(x, y)] & MASK_ROADS) === 0) continue;
      const t = cellData.cornerTerrainType;
      if (
        t[cellData.cornerIndex(x, y)] !== terrainType
        || t[cellData.cornerIndex(x + 1, y)] !== terrainType
        || t[cellData.cornerIndex(x, y + 1)] !== terrainType
        || t[cellData.cornerIndex(x + 1, y + 1)] !== terrainType
      ) return false;
    }
  }
  for (let y = y0; y <= y0 + poi.size; y += 1) {
    for (let x = x0; x <= x0 + poi.size; x += 1) {
      cellData.cornerTerrainType[cellData.cornerIndex(x, y)] = terrainType;
    }
  }
  return true;
}

export function addExtraPois(cellData, selector, collisionIndex, random, pois, padding, writePoiFn, log = () => {}) {
  const mediumSpots = [];
  const smallSpots = [];
  for (let gridY = 0; gridY <= 30; gridY += 1) {
    for (let gridX = 0; gridX <= 40; gridX += 1) {
      let y = gridY * 3 - 46;
      let x = gridX * 3 - 62 + (gridY % 3);
      let terrainType = cellData.cornerTerrainType[cellData.cornerIndex(x, y)];
      const fits = uniformSquare(cellData, x, y, 2, terrainType)
        && cellData.flags[cellData.cellIndex(x, y)] === 0
        && cellData.flags[cellData.cellIndex(x + 1, y)] === 0
        && cellData.flags[cellData.cellIndex(x, y + 1)] === 0
        && cellData.flags[cellData.cellIndex(x + 1, y + 1)] === 0;
      if (fits && !collisionIndex.collides(x + 1, y + 1, 4, pois)) {
        mediumSpots.push({ x: x + 1, y: y + 1, terrainType });
      } else {
        const offsets = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }];
        shuffle(random, offsets);
        for (const offset of offsets) {
          y = gridY * 3 - 46 + offset.y;
          x = gridX * 3 - 62 + (gridY % 3) + offset.x;
          terrainType = cellData.cornerTerrainType[cellData.cornerIndex(x, y)];
          const smallFits = uniformSquare(cellData, x, y, 1, terrainType)
            && cellData.flags[cellData.cellIndex(x, y)] === 0;
          if (smallFits && !collisionIndex.collides(x, y, 3, pois)) {
            smallSpots.push({ x, y, terrainType });
            break;
          }
        }
      }
    }
  }
  log("Medium extra poi spots:", mediumSpots.length);
  log("Small extra poi spots:", smallSpots.length);

  let mediumCount = 0;
  let smallCount = 0;
  const fill = (spots, requestedSize) => {
    shuffle(random, spots);
    for (const spot of spots) {
      const poi = { x: spot.x, y: spot.y, type: null, size: null, road: false, flat: false, terrainType: spot.terrainType, edges: [] };
      if (!selector.choosePoi(poi, requestedSize, spot.terrainType)) continue;
      if (placeTerrainCompatible(cellData, poi)) {
        writePoiFn(poi, padding);
        collisionIndex.invalidate();
        if (poi.size === 2) mediumCount += 1;
        else smallCount += 1;
      } else {
        selector.rewindPoi(requestedSize, spot.terrainType);
      }
    }
  };
  fill(mediumSpots, 2);
  fill(smallSpots, 1);
  log("Medium extra pois:", mediumCount);
  log("Small extra pois:", smallCount);
}

export function evaluateType(cellData, terrainType, selector, intNoise2d) {
  cellData.forEveryCell((x, y) => {
    const cellIndex = cellData.cellIndex(x, y);
    if (cellData.uid[cellIndex] !== 0) return;
    const corners = cellData.cornerTerrainType;
    const bits =
      (corners[cellData.cornerIndex(x + 1, y)] === terrainType ? 8 : 0)
      | (corners[cellData.cornerIndex(x, y)] === terrainType ? 4 : 0)
      | (corners[cellData.cornerIndex(x, y + 1)] === terrainType ? 2 : 0)
      | (corners[cellData.cornerIndex(x + 1, y + 1)] === terrainType ? 1 : 0);
    // selector returns (tileId << 2) | rotation packed into one integer, or -1
    // for "no tile" — see packTile in selectors.js. Unpacked inline rather than
    // through a shared helper so this hot loop never allocates a tuple array.
    const packed = selector(bits, intNoise2d(x, y, cellData.seed + 2854), intNoise2d(x, y, cellData.seed + 9439));
    if (packed < 0) return;
    cellData.uid[cellIndex] = packed >> 2;
    cellData.rotation[cellIndex] = packed & 3;
    cellData.xOffset[cellIndex] = 0;
    cellData.yOffset[cellIndex] = 0;
    cellData.flags[cellIndex] |= (terrainType << SHIFT_TERRAINTYPE) & MASK_TERRAINTYPE;
  });
}
