// Sparse grid of road-pathfinding nodes: roadNodes[y][x] in the Lua, which is a
// dense 2D table over the cell range holding either a node or nil. Node shape
// matches the Lua exactly: { x, y, edges: [{ n: otherNode, cost, road, shortcut }] }.
export class RoadNodeGrid {
  constructor(cellData) {
    this.cellData = cellData;
    this.nodes = new Array(cellData.cellWidth * cellData.cellHeight).fill(null);
  }

  get(x, y) {
    if (!this.cellData.insideCellBounds(x, y)) return null;
    return this.nodes[this.cellData.cellIndex(x, y)];
  }

  set(x, y, node) {
    this.nodes[this.cellData.cellIndex(x, y)] = node;
  }

  ensure(x, y) {
    const existing = this.get(x, y);
    if (existing) return existing;
    const node = { x, y, edges: [] };
    this.set(x, y, node);
    return node;
  }
}
