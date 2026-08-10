// The fixed POI placement data for the Chapter 2 overworld: hand-authored
// story/quest locations plus the template lists that get distributed onto
// procedurally chosen spots. Ported from the `fixed`, `large`, and `must`
// tables in createPoiCatalog() in generate_cells.lua — this is world content,
// not an algorithm, so it is kept as inert data separate from the code that
// places it.

import { POI_TYPES } from "./poi-types.js";
import { TYPE_FIELD, TYPE_FOREST } from "./cell-data.js";

const P = POI_TYPES;

export const EXCAVATION_ISLAND = { x: 32, y: 16, rotation: 0 };

// [refName, x, y, type, size, road, flat, rotation, terrainType, cliffLevel, index, forceFlat, elevationSmoothing]
export const FIXED_POIS = [
  ["crashArea", -36, -40, P.CRASHSITE_AREA, 20, false, false, null, null, 0],
  ["crashExit", -35, -30, P.ROAD_RANDOM, 1, true, false, 1, TYPE_FOREST, 0, 3],
  ["mechanic", -29, -26, P.MECHANICSTATION_QUEST_MEDIUM, 2, true, true, null, TYPE_FOREST, 0],
  [null, -16, -16, P.HIDEOUT_XL, 8, false, true, 0, null, 0, null, true],
  [null, -12, -29, P.AUTUMNFOREST_CLEARRUINSQUEST_MEDIUM, 2, false, true, null, null, 0],
  [null, -33, 23, P.BUNK_BURIAL_QUEST_MEDIUM, 2, false, true],
  [null, -38, -17, P.MEADOW_GROWLAB_QUEST_LARGE, 4, false, true, 1, null, null, null, null, 4],
  ["warehouseQuest", 32, -12, P.WAREHOUSE4_QUEST_LARGE, 4, true, true, null, null, null, null, null, 4],
  ["packing1", -17, -23, P.PACKINGSTATIONVEG_MEDIUM, 2, true, true, null, null, 0],
  ["packing2", 10, 10, P.PACKINGSTATIONFRUIT_MEDIUM, 2, true, true],
  ["wocHouse", -23, -25, P.BUILDERQUEST_WOCHOUSE, 1, true, false, 0],
  ["ruinCity", 0, 15, P.RUINCITY_XL, 8, true, true, 0, null, null, null, true],
  [null, 8, -2, P.MEADOW_GROWLAB_SILODISTRICT_XL, 8, true, true, 2, null, null, null, true],
  [null, -41, 18, P.BURNTFOREST_GROWLAB_FROZEN_LARGE, 4, false, true, null, null, null, null, null, 4],
  [null, -13, 29, P.FOREST_GROWLAB_STATION_LARGE, 4, false, true, null, null, null, null, null, 4],
  [null, -60, 44, P.LAKE_GROWLAB_ISLAND_XL, 8, false, true, null, null, null, null, true],
  [null, 5, -23, P.DESERT_GROWLAB_CLIFFTOP_LARGE, 4, false, true, null, null, null, null, null, 4],
  ["resourceCar", -30, -20, P.BUILDERQUEST_RESOURCECAR, 1, true, true],
  [null, -48, 36, P.CRASHEDSHIP_LARGE, 4, false, true, 3],
  ["campLarge", -31, 0, P.CAMP_LARGE, 4, true, true, 3, null, null, null, null, 4],
  [null, 24, -20, P.LABYRINTH_MEDIUM, 2, false, true, null, TYPE_FIELD],
  [null, 12, 24, P.MECHANICSTATION_MEDIUM, 2, true, true],
  [null, -26, -22, P.SERVICE_ELEVATOR, 1, false, true, 2],
  [null, EXCAVATION_ISLAND.x + 16, EXCAVATION_ISLAND.y + 16, P.EXCAVATION, 32, null, true, null, null, 0],
  ["excavationBridge", EXCAVATION_ISLAND.x - 1, EXCAVATION_ISLAND.y + 18, P.EXCAVATION_BRIDGE, 1, true, true, 0, null, 0],
];

// [type, index, road=false when explicitly false]
export const LARGE_TEMPLATES_SOURCE = [
  [P.WAREHOUSE2_LARGE, 1],
  [P.WAREHOUSE2_LARGE, 2],
  [P.WAREHOUSE2_LARGE, 3],
  [P.BURNTFOREST_FARMBOTSCRAPYARD_LARGE, 1, false],
  [P.WAREHOUSE2_LARGE, 4],
  [P.WAREHOUSE3_LARGE, 1],
  [P.BURNTFOREST_FARMBOTSCRAPYARD_LARGE, 2, false],
  [P.WAREHOUSE3_LARGE, 1],
  [P.WAREHOUSE4_LARGE, 1],
  [P.WAREHOUSE4_LARGE, 1],
];

// [type, size, rotation, road, flat, chemicalIndex(1-3, resolved via a shuffle)]
export const MUST_TEMPLATES_SOURCE = [
  [P.BUILDERQUEST_CARDBOARDPOOP, 1, 0, false, false],
  [P.BURNTFOREST_BUILDERQUEST_TOTEBOTKEY, 1, 0, false, false],
  [P.FIELD_BUILDERQUEST_CORNHEART, 1, 0, false, false],
  [P.CHEMLAKE_MEDIUM, 2, null, false, true, 1],
  [P.FIELD_BUILDERQUEST_COZYBED, 1, 0, false, false],
  [P.BUILDERQUEST_XYLOPHONE, 1, 0, false, false],
  [P.BUILDERQUEST_BEESUIT, 1, 0, false, false],
  [P.DESERT_BUILDERQUEST_BIGFAN, 1, 0, false, false],
  [P.CHEMLAKE_MEDIUM, 2, null, false, true, 2],
  [P.BUILDERQUEST_CAROUSEL, 1, 0, false, false],
  [P.BURNTFOREST_BUILDERQUEST_CATAPULT_MEDIUM, 2, 0, false, false],
  [P.BUILDERQUEST_CROWBAR, 1, 0, false, false],
  [P.BUILDERQUEST_COMPASS, 1, 0, false, false],
  [P.DESERT_BUILDERQUEST_GARDEN, 1, 0, false, false],
  [P.CHEMLAKE_MEDIUM, 2, null, false, true, 3],
  [P.FOREST_BUILDERQUEST_SAWBLADEARM, 1, 0, false, false],
  [P.AUTUMNFOREST_BUILDERQUEST_POPCORN, 1, 0, false, false],
  [P.AUTUMNFOREST_BUILDERQUEST_MUSICBOX_MEDIUM, 2, 0, false, false],
  [P.BUILDERQUEST_NICEHOUSE_MEDIUM, 2, 0, false, false],
  [P.BUILDERQUEST_SLEDGEHAMMER_MEDIUM, 2, 0, false, true],
  [P.BUILDERQUEST_STEELBRIDGE_MEDIUM, 2, 0, false, true],
  [P.BUILDERQUEST_BAGUETTE_MEDIUM, 2, 0, false, true],
  [P.OILLAKE_MEDIUM, 2, null, false, true],
];
