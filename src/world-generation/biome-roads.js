// Selector for road tiles that cross biome boundaries. Ported from
// biome_roads.lua. The tile identifiers are asset paths encoding which road
// edges and biome corners each piece covers; decodePath below reads that
// encoding exactly as the Lua pattern match did.

import { TYPE_AUTUMNFOREST, TYPE_BURNTFOREST, TYPE_DESERT, TYPE_FIELD, TYPE_FOREST, TYPE_LAKE } from "./cell-data.js";
import { MASK_ROADS } from "./cell-data.js";

const TERRAIN_BY_NAME = {
  Forest: TYPE_FOREST,
  Desert: TYPE_DESERT,
  Field: TYPE_FIELD,
  BurntForest: TYPE_BURNTFOREST,
  AutumnForest: TYPE_AUTUMNFOREST,
  Lake: TYPE_LAKE,
};

const SOURCE_PATHS = [
  "$SURVIVAL_DATA/Terrain/Tiles/roads_biomes/Road(0101)_Forest(1001)_01.tile",
  "$SURVIVAL_DATA/Terrain/Tiles/roads_biomes/Road(0001)_Forest(1111)_01.tile",
  "$SURVIVAL_DATA/Terrain/Tiles/roads_biomes/Road(0011)_Forest(1111)_01.tile",
  "$SURVIVAL_DATA/Terrain/Tiles/roads_biomes/Road(0101)_Forest(1111)_01.tile",
  "$SURVIVAL_DATA/Terrain/Tiles/roads_biomes/Road(0111)_Forest(1111)_01.tile",
  "$SURVIVAL_DATA/Terrain/Tiles/roads_biomes/Road(1111)_Forest(1111)_01.tile",
  "$SURVIVAL_DATA/Terrain/Tiles/roads_biomes/Road(0101)_Forest(0010)_01.tile",
  "$SURVIVAL_DATA/Terrain/Tiles/roads_biomes/Road(0101)_Forest(0001)_01.tile",
  "$SURVIVAL_DATA/Terrain/Tiles/roads_biomes/Road(0101)_Forest(1011)_01.tile",
  "$SURVIVAL_DATA/Terrain/Tiles/roads_biomes/Road(0101)_Forest(0111)_01.tile",
  "$SURVIVAL_DATA/Terrain/Tiles/roads_biomes/Road(0101)_Forest(0011)_01.tile",
  "$SURVIVAL_DATA/Terrain/Tiles/roads_biomes/Road(0011)_Forest(0001)_01.tile",
  "$SURVIVAL_DATA/Terrain/Tiles/roads_biomes/Road(0011)_Forest(1110)_01.tile",
  "$SURVIVAL_DATA/Terrain/Tiles/roads_biomes/Road(0011)_Forest(1100)_01.tile",
  "$SURVIVAL_DATA/Terrain/Tiles/roads_biomes/Road(0011)_Forest(0110)_01.tile",
  "$SURVIVAL_DATA/Terrain/Tiles/roads_biomes/Road(0101)_Desert(1001)_01.tile",
  "$SURVIVAL_DATA/Terrain/Tiles/roads_biomes/Road(0101)_Desert(1001)_02.tile",
  "$SURVIVAL_DATA/Terrain/Tiles/roads_biomes/Road(0011)_Desert(1111)_01.tile",
  "$SURVIVAL_DATA/Terrain/Tiles/roads_biomes/Road(0011)_Desert(1111)_02.tile",
  "$SURVIVAL_DATA/Terrain/Tiles/roads_biomes/Road(0101)_Desert(1111)_01.tile",
  "$SURVIVAL_DATA/Terrain/Tiles/roads_biomes/Road(0101)_Desert(1111)_02.tile",
  "$SURVIVAL_DATA/Terrain/Tiles/roads_biomes/Road(0101)_Desert(1111)_03.tile",
  "$SURVIVAL_DATA/Terrain/Tiles/roads_biomes/Road(0101)_Desert(0010)_01.tile",
  "$SURVIVAL_DATA/Terrain/Tiles/roads_biomes/Road(0101)_Desert(0001)_01.tile",
  "$SURVIVAL_DATA/Terrain/Tiles/roads_biomes/Road(0101)_Field(1001)_01.tile",
  "$SURVIVAL_DATA/Terrain/Tiles/roads_biomes/Road(0011)_Field(1111)_01.tile",
  "$SURVIVAL_DATA/Terrain/Tiles/roads_biomes/Road(0101)_Field(1111)_01.tile",
  "$SURVIVAL_DATA/Terrain/Tiles/roads_biomes/Road(0101)_BurntForest(1001)_01.tile",
  "$SURVIVAL_DATA/Terrain/Tiles/roads_biomes/Road(0011)_BurntForest(1111)_01.tile",
  "$SURVIVAL_DATA/Terrain/Tiles/roads_biomes/Road(0101)_BurntForest(1111)_01.tile",
  "$SURVIVAL_DATA/Terrain/Tiles/roads_biomes/Road(0101)_AutumnForest(1001)_01.tile",
  "$SURVIVAL_DATA/Terrain/Tiles/roads_biomes/Road(0011)_AutumnForest(1111)_01.tile",
  "$SURVIVAL_DATA/Terrain/Tiles/roads_biomes/Road(0101)_AutumnForest(1111)_01.tile",
  "$SURVIVAL_DATA/Terrain/Tiles/roads_biomes/Road(0101)_Lake(1001)_01.tile",
  "$SURVIVAL_DATA/Terrain/Tiles/roads_biomes/Road(0101)_Lake(1001)_02.tile",
  "$SURVIVAL_DATA/Terrain/Tiles/roads_biomes/Road(0101)_Lake(1001)_03.tile",
  "$SURVIVAL_DATA/Terrain/Tiles/roads_biomes/Road(0101)_Lake(1111)_01.tile",
  "$SURVIVAL_DATA/Terrain/Tiles/roads_biomes/Road(0101)_Lake(1111)_02.tile",
  "$SURVIVAL_DATA/Terrain/Tiles/roads_biomes/Road(0011)_Lake(0001)_01.tile",
  "$SURVIVAL_DATA/Terrain/Tiles/roads_biomes/Road(0011)_Lake(0110)_01.tile",
  "$SURVIVAL_DATA/Terrain/Tiles/roads_biomes/Road(0011)_Lake(1100)_01.tile",
  "$SURVIVAL_DATA/Terrain/Tiles/roads_biomes/Road(0011)_Lake(1110)_01.tile",
  "$SURVIVAL_DATA/Terrain/Tiles/roads_biomes/Road(0101)_Lake(0001)_01.tile",
  "$SURVIVAL_DATA/Terrain/Tiles/roads_biomes/Road(0101)_Lake(0010)_01.tile",
  "$SURVIVAL_DATA/Terrain/Tiles/roads_biomes/Road(0101)_Lake(0011)_01.tile",
  "$SURVIVAL_DATA/Terrain/Tiles/roads_biomes/Road(0101)_Lake(0011)_02.tile",
];

const PATH_PATTERN = /Road\((\d)(\d)(\d)(\d)\)_(\D+)\((\d)(\d)(\d)(\d)\)/;

function shifted(sequence, turns) {
  const output = new Array(4);
  for (let index = 0; index < 4; index += 1) output[index] = sequence[(index + turns) % 4];
  return output;
}

function packedKey(roads, corners) {
  let key = (roads[0] << 19) | (roads[1] << 18) | (roads[2] << 17) | (roads[3] << 16);
  key |= (corners[0] > 1 ? corners[0] : 0) << 12;
  key |= (corners[1] > 1 ? corners[1] : 0) << 8;
  key |= (corners[2] > 1 ? corners[2] : 0) << 4;
  key |= corners[3] > 1 ? corners[3] : 0;
  return key;
}

function decodePath(path) {
  const match = PATH_PATTERN.exec(path);
  const [, s, w, n, e, biome, se, sw, nw, ne] = match;
  const terrain = TERRAIN_BY_NAME[biome];
  if (!terrain) throw new Error(`Unknown biome road terrain: ${biome}`);
  return [
    [Number(s), Number(w), Number(n), Number(e)],
    [Number(se) * terrain, Number(sw) * terrain, Number(nw) * terrain, Number(ne) * terrain],
    terrain,
  ];
}

export class BiomeRoads {
  constructor(catalog) {
    this.catalog = catalog;
    this.choices = new Map();
  }

  init() {
    this.choices.clear();
    for (const path of SOURCE_PATHS) {
      const [roads, corners, terrain] = decodePath(path);
      for (let rotation = 0; rotation < 4; rotation += 1) {
        const key = packedKey(shifted(roads, rotation), shifted(corners, rotation));
        let entry = this.choices.get(key);
        if (!entry) {
          entry = { tiles: [], rotation, terrainType: terrain };
          this.choices.set(key, entry);
        }
        entry.tiles.push(this.catalog.addTile(null, path, null, null));
      }
    }
  }

  calculateIndex(cellData, cornerTerrainType, x, y) {
    const flags = cellData.flags[cellData.cellIndex(x, y)];
    const roads = (((flags & MASK_ROADS) >> 8) << 16) >>> 0;
    const corners = [
      cornerTerrainType[cellData.cornerIndex(x + 1, y)],
      cornerTerrainType[cellData.cornerIndex(x, y)],
      cornerTerrainType[cellData.cornerIndex(x, y + 1)],
      cornerTerrainType[cellData.cornerIndex(x + 1, y + 1)],
    ];
    return (roads | packedKey([0, 0, 0, 0], corners)) | 0;
  }

  getTile(cellData, cornerTerrainType, x, y) {
    return this.choices.get(this.calculateIndex(cellData, cornerTerrainType, x, y));
  }
}
