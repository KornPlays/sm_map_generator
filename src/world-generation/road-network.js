// Road-graph construction: the visibility graph between road-connected POIs,
// Dijkstra-style shortest paths over it, and the physical road-node grid those
// paths get drawn onto. Ported from generate_roads.lua.
//
// The Lua's linear-scan "priority queue" (pick the minimum by scanning, remove
// by swapping with the last element) is reproduced exactly rather than replaced
// with a heap: swap-removal changes which element breaks a later tie, and ties
// are common here (many nodes share dist = Infinity), so a faster queue would
// walk edges in a different order and could draw a different road.

import { MASK_CLIFF, MASK_ROADCLIFF, MASK_ROADS, MASK_ROADS_SN, MASK_ROADS_WE, MASK_TERRAINTYPE, SHIFT_TERRAINTYPE, TYPE_AUTUMNFOREST, TYPE_BURNTFOREST, TYPE_DESERT, TYPE_FIELD, TYPE_FOREST, TYPE_LAKE, TYPE_MEADOW } from "./cell-data.js";
import { dist2 } from "./cell-data.js";
import { POI_TYPES } from "./poi-types.js";
import { luaMod } from "./lua-compat.js";

const P = POI_TYPES;

const TERRAIN_TRAVEL_COST = {
  [TYPE_MEADOW]: 3, [TYPE_FOREST]: 3, [TYPE_FIELD]: 3,
  [TYPE_BURNTFOREST]: 3, [TYPE_AUTUMNFOREST]: 3,
  [TYPE_LAKE]: 3, [TYPE_DESERT]: 3,
};

function manhattan(a, b) {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

function visiblePair(points, aIndex, bIndex) {
  const a = points[aIndex];
  const b = points[bIndex];
  const midX = (a.x + b.x) / 2;
  const midY = (a.y + b.y) / 2;
  const radius2 = dist2(a.x, a.y, midX, midY);
  for (let index = 0; index < points.length; index += 1) {
    if (index === aIndex || index === bIndex) continue;
    const point = points[index];
    if (dist2(point.x, point.y, midX, midY) < radius2) return false;
  }
  return true;
}

// Every road-connected POI gets full edges to every other one it can "see"
// (no closer POI inside the circle through their midpoint) — O(n^2) but n is
// small (road-connected POIs only, a few dozen).
export function preparePoiRoadGraph(pois, roadPois) {
  for (const poi of pois) {
    if (poi.road) {
      roadPois.push(poi);
      poi.edges = [];
    }
  }
  for (let left = 0; left < roadPois.length - 1; left += 1) {
    for (let right = left + 1; right < roadPois.length; right += 1) {
      if (!visiblePair(roadPois, left, right)) continue;
      const a = roadPois[left];
      const b = roadPois[right];
      const levelDelta = Math.abs((a.cliffLevel ?? 0) - (b.cliffLevel ?? 0));
      const cost = manhattan(a, b) + levelDelta ** 2 * 10;
      a.edges.push({ n: b, cost });
      b.edges.push({ n: a, cost });
    }
  }
}

export function hasRoad(roadNodes, cellX, cellY) {
  const node = roadNodes.get(cellX, cellY);
  if (!node) return false;
  for (const edge of node.edges) if (edge.road) return true;
  return false;
}

// Monotonic call counter used instead of a per-call visited Set — a node is
// "visited in this scan" iff its _visitGen equals the generation this call
// was given. Safe to share across every graph writeDistancesInNodes ever
// scans (the small roadPois graph and the big road-node grid alike): the
// counter never repeats, so a stale tag from an earlier call — on this graph
// or any other — can never collide with the current one.
let visitGeneration = 0;

// Dijkstra with a linear-scan frontier instead of a heap, matching the Lua
// exactly (see module comment). Returns [distance to target, iteration count];
// the iteration count is unused by callers but kept for parity.
//
// `touched`, if given, collects every node whose dist left its caller-supplied
// starting value (Infinity by convention — see DrawRoads.addNode/route) during
// this call, so the caller can reset only those nodes before its next scan
// instead of the whole graph. Purely a bookkeeping aid: omitting it changes
// nothing about which nodes get relaxed or in what order.
export function writeDistancesInNodes(target, source, touched) {
  visitGeneration += 1;
  const generation = visitGeneration;
  source.dist = 0;
  if (touched) touched.push(source);
  const queue = [source];
  let targetDistance = Infinity;
  let iterations = 0;

  while (queue.length > 0) {
    let pick = null;
    let pickIndex = -1;
    for (let index = 0; index < queue.length; index += 1) {
      const candidate = queue[index];
      if (!pick || candidate.dist < pick.dist) {
        pick = candidate;
        pickIndex = index;
      }
    }
    queue[pickIndex] = queue[queue.length - 1];
    queue.pop();
    pick._visitGen = generation;

    for (const edge of pick.edges) {
      if (edge.n._visitGen === generation) continue;
      const proposed = pick.dist + edge.cost;
      if (proposed < edge.n.dist) {
        if (touched && edge.n.dist === Infinity) touched.push(edge.n);
        edge.n.dist = proposed;
        if (edge.n === target && proposed < targetDistance) targetDistance = proposed;
        if (proposed <= targetDistance) queue.push(edge.n);
      }
    }
    iterations += 1;
  }
  return [targetDistance, iterations];
}

function cheaperPathStep(node) {
  let chosen = null;
  for (const edge of node.edges) {
    if (!chosen || edge.n.dist < chosen.n.dist) chosen = edge;
  }
  return chosen;
}

// Walks the cheapest-dist path from start to destination through the POI
// visibility graph, recording each hop as a roadEdge and revising the edge cost
// in both directions to the manhattan-plus-cliff cost actually taken.
export function findRoadPath(roadPois, roadEdges, start, destination, log = () => {}) {
  for (const poi of roadPois) poi.dist = Infinity;
  writeDistancesInNodes(start, destination);
  let node = start;
  while (node !== destination) {
    const edge = cheaperPathStep(node);
    if (!edge) { log("No path found!"); break; }
    const following = edge.n;
    roadEdges.push({ a: node, b: following });
    const levelDelta = Math.abs((node.cliffLevel ?? 0) - (following.cliffLevel ?? 0));
    const revisedCost = manhattan(node, following) + levelDelta ** 2 * 10;
    edge.cost = revisedCost;
    for (const reverse of following.edges) {
      if (reverse.n === node) reverse.cost = revisedCost;
    }
    node = following;
  }
}

function includes(value, values) {
  return values.includes(value);
}

const ROAD_DECORATION_CYCLE = [P.ROAD_CHEMPOOL, P.ROAD_SCHEMATICSTATION, P.ROAD_KIOSK, P.ROAD_KIOSK];
const MEDIUM_TYPES = [P.MECHANICSTATION_MEDIUM, P.MECHANICSTATION_QUEST_MEDIUM, P.PACKINGSTATIONVEG_MEDIUM, P.PACKINGSTATIONFRUIT_MEDIUM];
const WAREHOUSE_TYPES = [P.WAREHOUSE2_LARGE, P.WAREHOUSE3_LARGE, P.WAREHOUSE4_LARGE, P.WAREHOUSE4_QUEST_LARGE];
const INLINE_TYPES = [P.ROAD_KIOSK, P.BUILDERQUEST_RESOURCECAR, P.ROAD_SCHEMATICSTATION, P.ROAD_CHEMPOOL, P.ROAD_RANDOM];
const XL_TYPES = [P.RUINCITY_XL, P.MEADOW_GROWLAB_SILODISTRICT_XL];

// nextRoadDecoration cycles across the whole drawRoads call the way the Lua's
// module-level upvalue does within one Lua VM's lifetime — reset per DrawRoads
// instance, which is created fresh once per generateCells() call.
export class DrawRoads {
  constructor(cellData, intNoise2d, simplexNoise2d, log = () => {}) {
    this.cellData = cellData;
    this.intNoise2d = intNoise2d;
    this.simplexNoise2d = simplexNoise2d;
    this.log = log;
    this.nextRoadDecoration = 0;
    this.randomRoadPoiCount = 0;
    // Reused across every route() call — see the reset there.
    this._routeTouched = [];
  }

  jitter(x, y) {
    const cellData = this.cellData;
    const seed = ((cellData.seed % 32768) + 32768) % 32768;
    return Math.abs(this.simplexNoise2d(
      (x + 256 * (seed + 53)) / 3.7,
      (y + 256 * (seed + 96)) / 3.7,
    )) * 50;
  }

  join(nodes, a, b, cost, road) {
    if (!a || !b) return;
    a.edges.push({ n: b, cost, road: Boolean(road) });
    b.edges.push({ n: a, cost, road: Boolean(road) });
  }

  joinEast(nodes, x, y, road) {
    const cellData = this.cellData;
    const a = nodes.get(x, y);
    const b = nodes.get(x + 1, y);
    if (!a || !b) return;
    const terrain = cellData.cornerTerrainType;
    const ci = cellData.cornerIndex.bind(cellData);
    const base = Math.max(
      TERRAIN_TRAVEL_COST[terrain[ci(x + 1, y)]],
      TERRAIN_TRAVEL_COST[terrain[ci(x + 1, y + 1)]],
    );
    const c = cellData.cliffLevel;
    const values = [c[ci(x, y)], c[ci(x, y + 1)], c[ci(x + 1, y)], c[ci(x + 1, y + 1)], c[ci(x + 2, y)], c[ci(x + 2, y + 1)]];
    const hi = Math.max(...values);
    const lo = Math.min(...values);
    this.join(nodes, a, b, base + (hi - lo) ** 2 * 5 + this.jitter(x + 0.5, y), road);
  }

  joinNorth(nodes, x, y, road) {
    const cellData = this.cellData;
    const a = nodes.get(x, y);
    const b = nodes.get(x, y + 1);
    if (!a || !b) return;
    const terrain = cellData.cornerTerrainType;
    const ci = cellData.cornerIndex.bind(cellData);
    const base = Math.max(
      TERRAIN_TRAVEL_COST[terrain[ci(x, y + 1)]],
      TERRAIN_TRAVEL_COST[terrain[ci(x + 1, y + 1)]],
    );
    const c = cellData.cliffLevel;
    const values = [c[ci(x, y)], c[ci(x + 1, y)], c[ci(x, y + 1)], c[ci(x + 1, y + 1)], c[ci(x, y + 2)], c[ci(x + 1, y + 2)]];
    const hi = Math.max(...values);
    const lo = Math.min(...values);
    this.join(nodes, a, b, base + (hi - lo) ** 2 * 5 + this.jitter(x, y + 0.5), road);
  }

  addOffsetNodes(nodes, poi, offsets) {
    for (const [dx, dy] of offsets) this.addNode(nodes, poi.x + dx, poi.y + dy);
  }

  addOffsetEdges(nodes, poi, offsets, north, road) {
    for (const [dx, dy] of offsets) {
      if (north) this.joinNorth(nodes, poi.x + dx, poi.y + dy, road);
      else this.joinEast(nodes, poi.x + dx, poi.y + dy, road);
    }
  }

  addNode(nodes, x, y) {
    // dist starts at Infinity (route()'s reset convention) so a node created
    // mid-scan — connectionPoint() can add one right before its route() call —
    // never needs a separate first-touch initialization path. _visitGen is
    // declared here too (rather than added the first time a scan tags the
    // node) purely so every node keeps the same shape from birth — adding a
    // property after the fact triggers a hidden-class transition in V8, and
    // this object gets read millions of times across a generation.
    nodes.set(x, y, { x, y, edges: [], dist: Infinity, _visitGen: 0 });
  }

  shortcut(nodes, x0, y0, x1, y1) {
    const a = nodes.get(x0, y0);
    const b = nodes.get(x1, y1);
    if (!a || !b) return;
    a.edges.push({ n: b, cost: 1, shortcut: true });
    b.edges.push({ n: a, cost: 1, shortcut: true });
  }

  configureRandomRoadPoi(poi, dx, dy) {
    if (poi.type !== P.RANDOM_PLACEHOLDER || !poi.road) return;
    poi.type = ROAD_DECORATION_CYCLE[this.nextRoadDecoration];
    this.nextRoadDecoration = (this.nextRoadDecoration + 1) % ROAD_DECORATION_CYCLE.length;
    poi.rotation = (Math.abs(dy) > Math.abs(dx) ? 1 : 0) + luaMod(this.intNoise2d(poi.x, poi.y, this.cellData.seed + 211), 2) * 2;
    poi.size = 1;
    poi.flat = false;
    // (nodes is bound at call sites of configureRandomRoadPoi via connectionPoint)
    return true;
  }

  connectionPoint(nodes, poi, other) {
    const dx = poi.x - other.x;
    const dy = poi.y - other.y;
    if (this.configureRandomRoadPoi(poi, dx, dy)) {
      this.addOffsetNodes(nodes, poi, [[-1, 0], [-1, -1], [0, -1]]);
      this.addOffsetEdges(nodes, poi, [[-2, -1], [-2, 0], [-1, -1], [0, -1]], false);
      this.addOffsetEdges(nodes, poi, [[-1, -2], [0, -2], [-1, -1], [-1, 0]], true);
      if (poi.terrainType !== TYPE_MEADOW) {
        this.addOffsetNodes(nodes, poi, [[-2, -2], [-1, -2], [0, -2], [1, -2], [-2, 1], [-1, 1], [0, 1], [1, 1], [-2, -1], [-2, 0], [1, -1], [1, 0]]);
        this.addOffsetEdges(nodes, poi, [[-3, -2], [-3, -1], [-3, 0], [-3, 1], [-2, -2], [-2, -1], [-2, 0], [-2, 1], [-1, -2], [-1, 1], [0, -2], [0, -1], [0, 1], [1, -2], [1, -1], [1, 0], [1, 1]], false);
        this.addOffsetEdges(nodes, poi, [[-2, -3], [-1, -3], [0, -3], [1, -3], [-2, -2], [-1, -2], [0, -2], [1, -2], [-2, -1], [1, -1], [-2, 0], [-1, 0], [1, 0], [-2, 1], [-1, 1], [0, 1], [1, 1]], true);
      }
      this.randomRoadPoiCount += 1;
    }

    if (poi.rotation == null && poi.type === P.BUILDERQUEST_RESOURCECAR) {
      poi.rotation = (Math.abs(dy) > Math.abs(dx) ? 1 : 0) + luaMod(this.intNoise2d(poi.x, poi.y, this.cellData.seed + 211), 2) * 2;
    }
    if (poi.rotation == null && includes(poi.type, MEDIUM_TYPES)) {
      poi.rotation = Math.abs(dy) > Math.abs(dx) ? (dx > 0 ? 3 : 1) : (dy > 0 ? 0 : 2);
    }
    if (poi.rotation == null && includes(poi.type, WAREHOUSE_TYPES)) {
      poi.rotation = (Math.abs(dy) > Math.abs(dx) ? 0 : 1) + luaMod(this.intNoise2d(poi.x, poi.y, this.cellData.seed + 211), 2) * 2;
    }

    if (includes(poi.type, INLINE_TYPES)) {
      if (!poi.roaded) {
        this.addNode(nodes, poi.x, poi.y);
        if (poi.rotation % 2 === 0) {
          this.joinEast(nodes, poi.x - 1, poi.y, true);
          this.joinEast(nodes, poi.x, poi.y, true);
        } else {
          this.joinNorth(nodes, poi.x, poi.y - 1, true);
          this.joinNorth(nodes, poi.x, poi.y, true);
        }
        poi.roaded = true;
      }
      if (poi.rotation % 2 === 0) return [dx > 0 ? -1 : 1, 0];
      return [0, dy > 0 ? -1 : 1];
    }

    if (includes(poi.type, MEDIUM_TYPES)) {
      const nodeSets = {
        0: [[-1, -1], [0, -1]], 1: [[0, -1], [0, 0]], 2: [[-1, 0], [0, 0]], 3: [[-1, -1], [-1, 0]],
      };
      if (!poi.roaded) {
        this.addOffsetNodes(nodes, poi, nodeSets[poi.rotation]);
        if (poi.rotation === 0) this.addOffsetEdges(nodes, poi, [[-2, -1], [-1, -1], [0, -1]], false, true);
        else if (poi.rotation === 1) this.addOffsetEdges(nodes, poi, [[0, -2], [0, -1], [0, 0]], true, true);
        else if (poi.rotation === 2) this.addOffsetEdges(nodes, poi, [[-2, 0], [-1, 0], [0, 0]], false, true);
        else this.addOffsetEdges(nodes, poi, [[-1, -2], [-1, -1], [-1, 0]], true, true);
        poi.roaded = true;
      }
      if (poi.rotation === 0) return [dx > 0 ? -2 : 1, -1];
      if (poi.rotation === 1) return [0, dy > 0 ? -2 : 1];
      if (poi.rotation === 2) return [dx > 0 ? -2 : 1, 0];
      return [-1, dy > 0 ? -2 : 1];
    }

    if (includes(poi.type, WAREHOUSE_TYPES)) {
      if (!poi.roaded) {
        if (poi.rotation % 2 === 0) {
          this.addOffsetNodes(nodes, poi, [[-1, -2], [0, 1]]);
          this.joinNorth(nodes, poi.x - 1, poi.y - 3, true);
          this.joinNorth(nodes, poi.x, poi.y + 1, true);
          this.shortcut(nodes, poi.x - 1, poi.y - 2, poi.x, poi.y + 1);
        } else {
          this.addOffsetNodes(nodes, poi, [[-2, 0], [1, -1]]);
          this.joinEast(nodes, poi.x - 3, poi.y, true);
          this.joinEast(nodes, poi.x + 1, poi.y - 1, true);
          this.shortcut(nodes, poi.x - 2, poi.y, poi.x + 1, poi.y - 1);
        }
        poi.roaded = true;
      }
      if (poi.rotation % 2 === 0) return [dy > 0 ? -1 : 0, dy > 0 ? -3 : 2];
      return [dx > 0 ? -3 : 2, dx > 0 ? 0 : -1];
    }

    if (includes(poi.type, XL_TYPES)) {
      if (!poi.roaded) {
        this.addOffsetNodes(nodes, poi, [[3, -1], [0, 3], [-4, 0], [-1, -4]]);
        this.joinEast(nodes, poi.x + 3, poi.y - 1, true);
        this.joinNorth(nodes, poi.x, poi.y + 3, true);
        this.joinEast(nodes, poi.x - 5, poi.y, true);
        this.joinNorth(nodes, poi.x - 1, poi.y - 5, true);
        this.shortcut(nodes, poi.x + 3, poi.y - 1, poi.x, poi.y + 3);
        this.shortcut(nodes, poi.x, poi.y + 3, poi.x - 4, poi.y);
        this.shortcut(nodes, poi.x - 4, poi.y, poi.x - 1, poi.y - 4);
        this.shortcut(nodes, poi.x - 1, poi.y - 4, poi.x + 3, poi.y - 1);
        poi.roaded = true;
      }
      if (dx > 0 && dx > Math.abs(dy)) return [-5, 0];
      if (dx < 0 && dx < -Math.abs(dy)) return [4, -1];
      if (dy > 0) return [-1, -5];
      return [0, 4];
    }

    if (poi.type === P.CAMP_LARGE) {
      if (!poi.roaded) {
        this.addNode(nodes, poi.x + 1, poi.y - 2);
        this.joinEast(nodes, poi.x + 1, poi.y - 2, true);
        this.joinNorth(nodes, poi.x + 1, poi.y - 3, true);
        poi.roaded = true;
      }
      if (dx > 0 || dy > 0) return [1, -3];
      return [2, -2];
    }
    if (poi.type === P.EXCAVATION_BRIDGE) {
      if (!poi.roaded) {
        this.addNode(nodes, poi.x, poi.y);
        this.joinEast(nodes, poi.x - 1, poi.y, true);
        poi.roaded = true;
      }
      return [-1, 0];
    }
    if (poi.type === P.BUILDERQUEST_WOCHOUSE) {
      poi.roaded = true;
      return [0, 1];
    }
    this.log("Error road connection", poi.type, poi.x, poi.y);
    return [0, 0];
  }

  route(nodes, x0, y0, x1, y1, aPoi, bPoi) {
    const a = nodes.get(x0, y0);
    const b = nodes.get(x1, y1);
    if (!a || !b) {
      this.log("Error finding road from", x0, y0, "to", x1, y1);
      if (!a) this.log("\ta is nil", aPoi.type, aPoi.terrainType);
      if (!b) this.log("\tb is nil", bPoi.type, bPoi.terrainType);
      return;
    }
    // Only nodes actually touched by a scan can hold a non-Infinity dist, so
    // resetting the previous scan's touched list (instead of walking the
    // whole grid every route() call) leaves the same invariant in place at a
    // fraction of the cost — this grid can run into the thousands of nodes
    // while a single route typically only touches a small fraction of them.
    for (const node of this._routeTouched) node.dist = Infinity;
    this._routeTouched.length = 0;
    writeDistancesInNodes(a, b, this._routeTouched);
    let node = a;
    let count = 0;
    while (node !== b) {
      const edge = cheaperPathStep(node);
      if (!edge) { this.log("No path found!"); break; }
      edge.cost = 1;
      edge.road = true;
      for (const reverse of edge.n.edges) {
        if (reverse.n === node) { reverse.cost = 1; reverse.road = true; break; }
      }
      node = edge.n;
      count += 1;
      if (count > 1000) { this.log("Road search path too long", x0, y0, x1, y1); break; }
    }
  }

  // The main entry point: builds the dense road-node grid, wires POI stub
  // geometry, and routes every roadEdge across it. Returns the grid with
  // non-road, non-shortcut edges stripped and now-empty nodes removed.
  run(roadEdges, pois, collisionIndex, nodesFactory) {
    const cellData = this.cellData;
    const { xMin, xMax, yMin, yMax } = cellData.bounds;
    const padding = cellData.padding;
    const minX = xMin + padding;
    const maxX = xMax - padding;
    const minY = yMin + padding;
    const maxY = yMax - padding;
    const nodes = nodesFactory();

    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        if (collisionIndex.collides(x, y, 1, pois)) continue;
        const nearby = collisionIndex.collides(x, y, 3, pois);
        const typeAtPoint = nearby
          ? (nearby.type === P.RANDOM_PLACEHOLDER ? nearby.terrainType : Math.floor(nearby.type / 100))
          : null;
        if (!nearby || typeAtPoint === TYPE_MEADOW) this.addNode(nodes, x, y);
      }
    }

    for (let y = minY; y <= maxY; y += 1) for (let x = minX; x <= maxX - 1; x += 1) this.joinEast(nodes, x, y);
    for (let y = minY; y <= maxY - 1; y += 1) for (let x = minX; x <= maxX; x += 1) this.joinNorth(nodes, x, y);

    for (const edge of roadEdges) {
      const [ax, ay] = this.connectionPoint(nodes, edge.a, edge.b);
      const [bx, by] = this.connectionPoint(nodes, edge.b, edge.a);
      if (edge.a.x + ax < edge.b.x + bx) {
        this.route(nodes, edge.a.x + ax, edge.a.y + ay, edge.b.x + bx, edge.b.y + by, edge.a, edge.b);
      } else {
        this.route(nodes, edge.b.x + bx, edge.b.y + by, edge.a.x + ax, edge.a.y + ay, edge.b, edge.a);
      }
    }
    this.log("Random road pois:", this.randomRoadPoiCount);

    for (let index = 0; index < nodes.nodes.length; index += 1) {
      const node = nodes.nodes[index];
      if (!node) continue;
      node.dist = undefined;
      node.edges = node.edges.filter((edge) => edge.road || edge.shortcut);
      if (node.edges.length === 0) nodes.nodes[index] = null;
    }
    return nodes;
  }
}

// hasRoad/straightRoadSpot-adjacent flag readers used by generate_cells.js.
export function roadCliffBits(cellData, x, y) {
  return cellData.flags[cellData.cellIndex(x, y)] & MASK_ROADCLIFF;
}
export { MASK_CLIFF, MASK_ROADCLIFF, MASK_ROADS, MASK_ROADS_SN, MASK_ROADS_WE, MASK_TERRAINTYPE, SHIFT_TERRAINTYPE };
