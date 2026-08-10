// Inserts the fixed excavation sub-world into the generated cell grid. Ported
// from excavation_island.lua, using the rotation helpers from placement.js.

import { rotateLocal2, findGroupIdFromNeighbor } from "./placement.js";

function excavationExtent(world) {
  let minX = 1000;
  let maxX = -1000;
  let minY = 1000;
  let maxY = -1000;
  for (const cell of world.cellData) {
    if (cell.x < minX) minX = cell.x;
    if (cell.x > maxX) maxX = cell.x;
    if (cell.y < minY) minY = cell.y;
    if (cell.y > maxY) maxY = cell.y;
  }
  return [maxX - minX, maxY - minY];
}

function rotatedCells(cells, rotation) {
  if (rotation === 0) return cells;
  const output = cells.map((cell) => {
    const [x, y] = rotateLocal2(rotation, cell.x, cell.y, -1, -1);
    return {
      x,
      y,
      path: cell.path,
      rotation: (cell.rotation + rotation) % 4,
      offsetX: cell.offsetX,
      offsetY: cell.offsetY,
    };
  });
  output.sort((left, right) => (left.y - right.y) || (left.x - right.x));
  return output;
}

export function injectExcavation(cellData, metadata, excavationWorld, specification) {
  const [width, height] = excavationExtent(excavationWorld);
  const originX = specification.x + Math.ceil(width / 2);
  const originY = specification.y + Math.ceil(height / 2);
  const cells = rotatedCells(excavationWorld.cellData, specification.rotation);

  for (const cell of cells) {
    const x = originX + cell.x;
    const y = originY + cell.y;
    const uuid = metadata[cell.path]?.uid;
    const uidIndex = cellData.tiles.intern(uuid ?? "00000000-0000-0000-0000-000000000000");
    let group = findGroupIdFromNeighbor(cellData, uidIndex, cell, originX, originY);
    if (group == null) {
      cellData.groupIdCount += 1;
      group = cellData.groupIdCount;
    }
    const index = cellData.cellIndex(x, y);
    cellData.uid[index] = uidIndex;
    cellData.xOffset[index] = cell.offsetX;
    cellData.yOffset[index] = cell.offsetY;
    cellData.rotation[index] = cell.rotation;
    cellData.groupId[index] = group;
  }

  for (const corner of excavationWorld.cornerData) {
    const x = originX + corner.x;
    const y = originY + corner.y;
    const index = cellData.cornerIndex(x, y);
    cellData.cornerTerrainType[index] = corner.type;
    cellData.elevation[index] = 0;
    cellData.cliffLevel[index] = 0;
  }
}
