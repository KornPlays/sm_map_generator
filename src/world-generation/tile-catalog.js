// Tile registry. Ported from tile_database.lua.
//
// The Lua keys everything by tostring(uid) — a 36-character string — and stores
// legacy numeric ids in a side table. Here tiles are keyed by the same interned
// integer index cell-data.js already assigns each uuid, so lookups during the
// hot placement passes are array accesses instead of string-keyed map lookups.

import { NIL_UUID } from "./cell-data.js";

export class TileCatalog {
  constructor(cellData, metadata) {
    this.cellData = cellData;
    this.metadata = metadata;
    // Indexed by the same interned integer TileTable hands out, so index 0 (the
    // nil uuid) is always undefined here — matching GetPath(nilUuid) == nil.
    this.records = [undefined];
    this.legacyIds = new Map();
  }

  addTile(legacyId, path, terrainType, poiType) {
    const uid = this.metadata[path]?.uid ?? NIL_UUID;
    const index = this.cellData.tiles.intern(uid);
    if (this.records[index] === undefined) {
      this.records[index] = {
        path,
        size: this.metadata[path]?.size ?? 1,
        terrainType: terrainType ?? 1,
        poiType: poiType ?? null,
      };
    }
    if (legacyId != null) this.legacyIds.set(legacyId, index);
    return index;
  }

  // For tiles identified by a fixed UUID constant rather than a metadata path
  // (e.g. Lua's ERROR_TILE_UUID = sm.uuid.new("...")). addTile's path lookup
  // would silently collapse an unresolvable path to the nil UUID (index 0).
  internUuid(uuid) {
    return this.cellData.tiles.intern(uuid);
  }

  addLegacyUpgrade(legacyId, index) {
    this.legacyIds.set(legacyId, index);
  }

  getLegacyUpgrade(legacyId) {
    return this.legacyIds.get(legacyId);
  }

  getPath(index) {
    return this.records[index]?.path;
  }

  getSize(index) {
    return this.records[index]?.size;
  }

  getTerrainType(index) {
    return this.records[index]?.terrainType;
  }

  getPoiType(index) {
    return this.records[index]?.poiType;
  }
}
