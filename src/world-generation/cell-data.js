// The grid the whole world layout is written into, plus the accessors the
// generation passes read it through. Ported from celldata.lua and
// terrain/terrain_util.lua.
//
// The Lua stores every layer as a table of tables indexed [y][x] over a range
// that includes negative coordinates. Here each layer is one flat typed array
// with an origin offset, which removes a table lookup per access and makes the
// whole grid a handful of contiguous allocations instead of ~160,000 Lua table
// slots. Cell flags never exceed 0x1FFFF and levels stay small, so the widths
// below are chosen to hold every value the passes can produce.

export const TYPE_MEADOW = 1;
export const TYPE_FOREST = 2;
export const TYPE_DESERT = 3;
export const TYPE_FIELD = 4;
export const TYPE_BURNTFOREST = 5;
export const TYPE_AUTUMNFOREST = 6;
export const TYPE_LAKE = 8;

export const MASK_CLIFF = 0x00ff;
export const MASK_ROADS = 0x0f00;
export const MASK_ROADCLIFF = 0x0fff;
export const MASK_TERRAINTYPE = 0xf000;
export const MASK_FLAT = 0x10000;
export const FLAG_ROAD_E = 0x0100;
export const FLAG_ROAD_N = 0x0200;
export const FLAG_ROAD_W = 0x0400;
export const FLAG_ROAD_S = 0x0800;
export const MASK_ROADS_SN = FLAG_ROAD_S | FLAG_ROAD_N;
export const MASK_ROADS_WE = FLAG_ROAD_W | FLAG_ROAD_E;
export const SHIFT_TERRAINTYPE = 12;

export const NIL_UUID = "00000000-0000-0000-0000-000000000000";

// Tile identities are interned to small integers inside the grid; index 0 is the
// nil uuid, so a freshly cleared grid reads as empty.
export class TileTable {
  constructor() {
    this.uuids = [NIL_UUID];
    this.indices = new Map([[NIL_UUID, 0]]);
  }

  intern(uuid) {
    const existing = this.indices.get(uuid);
    if (existing !== undefined) return existing;
    const index = this.uuids.length;
    this.uuids.push(uuid);
    this.indices.set(uuid, index);
    return index;
  }

  uuid(index) {
    return this.uuids[index] ?? NIL_UUID;
  }
}

export class CellData {
  constructor() {
    this.bounds = { xMin: 0, xMax: 0, yMin: 0, yMax: 0 };
    this.padding = 0;
    this.seed = 0;
    this.groupIdCount = 0;
    this.tiles = new TileTable();
  }

  // Mirrors initializeCellData: cell layers span the bounds, corner layers span
  // one further in each direction.
  initialize(xMin, xMax, yMin, yMax, seed, padding) {
    this.bounds = { xMin, xMax, yMin, yMax };
    this.seed = seed;
    this.padding = padding ?? 0;
    this.groupIdCount = 0;

    this.cellWidth = xMax - xMin + 1;
    this.cellHeight = yMax - yMin + 1;
    this.cornerWidth = this.cellWidth + 1;
    this.cornerHeight = this.cellHeight + 1;
    this.xMin = xMin;
    this.yMin = yMin;

    const cells = this.cellWidth * this.cellHeight;
    const corners = this.cornerWidth * this.cornerHeight;
    this.uid = new Int32Array(cells);
    this.xOffset = new Int8Array(cells);
    this.yOffset = new Int8Array(cells);
    this.rotation = new Uint8Array(cells);
    this.groupId = new Int32Array(cells);
    this.flags = new Int32Array(cells);
    this.elevation = new Float64Array(corners);
    this.cliffLevel = new Int32Array(corners);
    // g_cornerTemp in the Lua: working state the generation passes read and
    // write before it collapses into flags/uid/elevation.
    this.cornerTerrainType = new Int32Array(corners);
    this.cornerHillyness = new Float64Array(corners);
    this.cornerForceFlat = new Uint8Array(corners);
    this.cornerLakeAdjacent = new Uint8Array(corners);
  }

  cellIndex(x, y) {
    return (y - this.yMin) * this.cellWidth + (x - this.xMin);
  }

  cornerIndex(x, y) {
    return (y - this.yMin) * this.cornerWidth + (x - this.xMin);
  }

  insideCellBounds(x, y, padding = 0) {
    const { xMin, xMax, yMin, yMax } = this.bounds;
    return x >= xMin + padding && x <= xMax - padding
      && y >= yMin + padding && y <= yMax - padding;
  }

  insideCornerBounds(x, y, padding = 0) {
    const { xMin, xMax, yMin, yMax } = this.bounds;
    return x >= xMin + padding && x <= xMax - padding + 1
      && y >= yMin + padding && y <= yMax - padding + 1;
  }

  getCornerElevationLevel(x, y) {
    return this.insideCornerBounds(x, y) ? this.elevation[this.cornerIndex(x, y)] : 0;
  }

  getCornerCliffLevel(x, y) {
    return this.insideCornerBounds(x, y) ? this.cliffLevel[this.cornerIndex(x, y)] : 0;
  }

  getCellTileUid(x, y) {
    return this.insideCellBounds(x, y) ? this.uid[this.cellIndex(x, y)] : 0;
  }

  // Cell flags are only ever built from unsigned masks, so they stay inside the
  // non-negative range where these plain operators match LuaJIT's bit library.
  getRoadCliffFlags(x, y) {
    if (!this.insideCellBounds(x, y)) return 0;
    return this.flags[this.cellIndex(x, y)] & MASK_ROADCLIFF;
  }

  isFlat(x, y) {
    if (!this.insideCellBounds(x, y)) return false;
    return (this.flags[this.cellIndex(x, y)] & MASK_FLAT) !== 0;
  }

  getCellType(x, y) {
    if (!this.insideCellBounds(x, y)) return 0;
    return (this.flags[this.cellIndex(x, y)] & MASK_TERRAINTYPE) >> SHIFT_TERRAINTYPE;
  }

  isLake(x, y) {
    return this.insideCellBounds(x, y) && this.getCellType(x, y) === TYPE_LAKE;
  }

  isRoad(x, y) {
    if (!this.insideCellBounds(x, y)) return false;
    return (this.flags[this.cellIndex(x, y)] & MASK_ROADS) !== 0;
  }

  // forEveryCell / forEveryCorner from terrain_util.lua.
  forEveryCell(callback, inset = 0) {
    const { xMin, xMax, yMin, yMax } = this.bounds;
    for (let y = yMin + inset; y <= yMax - inset; y += 1) {
      for (let x = xMin + inset; x <= xMax - inset; x += 1) callback(x, y);
    }
  }

  forEveryCorner(callback, inset = 0) {
    const { xMin, xMax, yMin, yMax } = this.bounds;
    for (let y = yMin + inset; y <= yMax - inset + 1; y += 1) {
      for (let x = xMin + inset; x <= xMax - inset + 1; x += 1) callback(x, y);
    }
  }
}

export function dist2(x0, y0, x1, y1) {
  const dx = x0 - x1;
  const dy = y0 - y1;
  return dx * dx + dy * dy;
}

export function distance(x0, y0, x1, y1) {
  return Math.sqrt(dist2(x0, y0, x1, y1));
}
