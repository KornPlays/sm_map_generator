// Shared helpers the placement passes use. Ported from util.lua,
// overworld_util.lua and terrain/terrain_util2.lua.

import { MASK_TERRAINTYPE, SHIFT_TERRAINTYPE, TYPE_AUTUMNFOREST, TYPE_BURNTFOREST, TYPE_DESERT, TYPE_FIELD, TYPE_FOREST, TYPE_LAKE, TYPE_MEADOW } from "./cell-data.js";

export function clamp(value, lower, upper) {
  if (value < lower) return lower;
  if (value > upper) return upper;
  return value;
}

export function round(value) {
  return Math.floor(value + 0.5);
}

// removeFromArray compacts in place and keeps the surviving order, which the
// callers depend on.
export function removeFromArray(values, shouldRemove) {
  let writeIndex = 0;
  for (let readIndex = 0; readIndex < values.length; readIndex += 1) {
    const value = values[readIndex];
    if (!shouldRemove(value)) {
      values[writeIndex] = value;
      writeIndex += 1;
    }
  }
  values.length = writeIndex;
  return values;
}

// Fisher-Yates walking downwards, drawing from the same PRNG in the same order
// as the Lua so the shuffles agree.
export function shuffle(random, values, first, last) {
  const lower = first ?? 1;
  const upper = last ?? values.length;
  for (let index = upper; index >= lower + 1; index -= 1) {
    const other = random.integer(lower, index);
    const a = index - 1;
    const b = other - 1;
    const swap = values[a];
    values[a] = values[b];
    values[b] = swap;
  }
  return values;
}

// closestPoi's weighting. The forest weight is the only one that changes, and it
// changes with position, so both tables are built once and picked between.
// Indexed directly by terrain type (small consecutive integers up to
// TYPE_LAKE) rather than looked up by key — this runs once per grid corner
// per POI, so it is worth keeping as an array access rather than a property
// lookup on a plain object.
const NEAR_WEIGHTS = new Float64Array(TYPE_LAKE + 1);
NEAR_WEIGHTS[TYPE_MEADOW] = 1;
NEAR_WEIGHTS[TYPE_FOREST] = 1.6;
NEAR_WEIGHTS[TYPE_FIELD] = 1.2;
NEAR_WEIGHTS[TYPE_BURNTFOREST] = 1.6;
NEAR_WEIGHTS[TYPE_AUTUMNFOREST] = 1.8;
NEAR_WEIGHTS[TYPE_LAKE] = 2;
NEAR_WEIGHTS[TYPE_DESERT] = 1;
const FAR_WEIGHTS = Float64Array.from(NEAR_WEIGHTS);
FAR_WEIGHTS[TYPE_FOREST] = 1;

// Called once per grid corner (tens of thousands of times per generation),
// so it returns the winner directly rather than a [winner, best] pair — every
// caller only ever wanted the winner, and allocating a short-lived array on
// each call was pure GC pressure.
export function closestPoi(pois, x, y) {
  const weight = x < -8 && y < -8 ? NEAR_WEIGHTS : FAR_WEIGHTS;
  let winner = null;
  let best = Infinity;
  for (let index = 0; index < pois.length; index += 1) {
    const candidate = pois[index];
    const dx = candidate.x - x;
    const dy = candidate.y - y;
    const score = Math.sqrt(dx * dx + dy * dy) * weight[candidate.terrainType] - candidate.size;
    if (score < best) {
      winner = candidate;
      best = score;
    }
  }
  return winner;
}

// A footprint spans center - size // 2 to center + (size + 1) // 2. The callers
// sweep the grid row by row, so the list is narrowed once per row to the POIs
// that can reach it; a POI the filter drops cannot overlap the row at all, so
// the first match found is still the first match in pois.
//
// Unlike the Lua this needs no explicit invalidation: the filter is rebuilt
// whenever the array identity, its length, the row or the size changes, and the
// port keeps POI mutation and collision queries in separate passes.
export class CollisionIndex {
  constructor() {
    this.rows = new Map();
  }

  invalidate() {
    this.rows.clear();
  }

  collides(x, y, size, pois) {
    let row = this.rows.get(size);
    if (row === undefined) {
      row = { candidates: [], pois: null, y: null, length: -1 };
      this.rows.set(size, row);
    }
    const length = pois.length;
    if (row.pois !== pois || row.y !== y || row.length !== length) {
      const bottom = y - (size >> 1);
      const top = y + ((size + 1) >> 1);
      const candidates = row.candidates;
      candidates.length = 0;
      for (let index = 0; index < length; index += 1) {
        const candidate = pois[index];
        const otherSize = candidate.size;
        const otherY = candidate.y;
        if (top > otherY - (otherSize >> 1) && bottom < otherY + ((otherSize + 1) >> 1)) {
          candidates.push(candidate);
        }
      }
      row.pois = pois;
      row.y = y;
      row.length = length;
    }
    const left = x - (size >> 1);
    const right = x + ((size + 1) >> 1);
    const candidates = row.candidates;
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      const otherSize = candidate.size;
      const otherX = candidate.x;
      if (right > otherX - (otherSize >> 1) && left < otherX + ((otherSize + 1) >> 1)) {
        return candidate;
      }
    }
    return null;
  }
}

function rotatedOffset(rotation, x, y, last) {
  if (rotation === 1) return [y, last - x];
  if (rotation === 2) return [last - x, last - y];
  if (rotation === 3) return [last - y, x];
  return [x, y];
}

export function writeTile(cellData, uidIndex, originX, originY, size, rotation, terrainType) {
  cellData.groupIdCount += 1;
  const groupId = cellData.groupIdCount;
  for (let localY = 0; localY < size; localY += 1) {
    for (let localX = 0; localX < size; localX += 1) {
      const x = originX + localX;
      const y = originY + localY;
      const [offsetX, offsetY] = rotatedOffset(rotation, localX, localY, size - 1);
      const index = cellData.cellIndex(x, y);
      cellData.uid[index] = uidIndex;
      cellData.xOffset[index] = offsetX;
      cellData.yOffset[index] = offsetY;
      cellData.rotation[index] = rotation;
      cellData.groupId[index] = groupId;
      if (terrainType) {
        cellData.flags[index] = (cellData.flags[index] & ~MASK_TERRAINTYPE)
          | ((terrainType << SHIFT_TERRAINTYPE) & MASK_TERRAINTYPE);
      }
    }
  }
}

// RotateLocal2 / InverseRotateLocal2 from terrain_util2.lua.
export function rotateLocal2(turns, x, y, width, height) {
  if (turns === 1) return [height - y, x];
  if (turns === 2) return [width - x, height - y];
  if (turns === 3) return [y, width - x];
  return [x, y];
}

export function inverseRotateLocal2(turns, x, y, width, height) {
  if (turns === 1) return [y, width - x];
  if (turns === 2) return [width - x, height - y];
  if (turns === 3) return [height - y, x];
  return [x, y];
}

export function findGroupIdFromNeighbor(cellData, uidIndex, cell, offsetX = 0, offsetY = 0) {
  for (let deltaY = 0; deltaY >= -1; deltaY -= 1) {
    for (let deltaX = -3; deltaX <= 3; deltaX += 1) {
      if (deltaX === 0 && deltaY === 0) continue;
      const x = cell.x + offsetX + deltaX;
      const y = cell.y + offsetY + deltaY;
      if (!cellData.insideCellBounds(x, y)) continue;
      const index = cellData.cellIndex(x, y);
      if (cellData.uid[index] !== uidIndex || cellData.rotation[index] !== cell.rotation) continue;
      const [localX, localY] = inverseRotateLocal2(cell.rotation, deltaX, deltaY, 0, 0);
      if (cellData.xOffset[index] === cell.offsetX + localX
        && cellData.yOffset[index] === cell.offsetY + localY) {
        return cellData.groupId[index];
      }
    }
  }
  return null;
}
