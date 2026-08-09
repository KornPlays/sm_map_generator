// The exported viewer carries the whole cell layout, so how it is written
// decides most of the file size. Cells reference roughly 250 distinct tile UUIDs
// between them, and a UUID is 36 characters, so repeating them 12,288 times
// costs about 440 KB on its own. Hoisting them into a lookup table and writing
// each cell as a numeric row cuts the layout to roughly a third of that.
export function packCells(cells) {
  const uids = [];
  const uidIndex = new Map();
  const rows = [];
  for (const cell of cells || []) {
    let index = uidIndex.get(cell.uid);
    if (index === undefined) {
      index = uids.length;
      uids.push(cell.uid);
      uidIndex.set(cell.uid, index);
    }
    rows.push([
      cell.x,
      cell.y,
      index,
      cell.size,
      cell.rotation,
      cell.group,
      cell.terrainType,
      Number.isFinite(cell.originX) ? cell.originX : cell.x,
      Number.isFinite(cell.originY) ? cell.originY : cell.y,
    ]);
  }
  return { uids, rows };
}

export function unpackCells(packed) {
  if (Array.isArray(packed)) return packed;
  if (!packed?.rows || !packed?.uids) return [];
  return packed.rows.map(([x, y, uid, size, rotation, group, terrainType, originX, originY]) => ({
    x,
    y,
    uid: packed.uids[uid],
    size,
    rotation,
    group,
    terrainType,
    originX,
    originY,
  }));
}
