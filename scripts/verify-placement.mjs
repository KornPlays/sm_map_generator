// Cross-checks the ported placement helpers against the Lua they replace.
//
// collides and closestPoi decide where every point of interest lands, and
// shuffle draws from the PRNG in an order the world depends on, so all three are
// driven from identical inputs on both sides and must agree exactly.
//
// Usage: node scripts/verify-placement.mjs [poi sets]

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { LuaFactory, LuaLibraries } from "wasmoon";

import { FAST_PATH_PRELUDE } from "../src/lua-fastpath.js";
import { CollisionIndex, closestPoi, shuffle } from "../src/world-generation/placement.js";
import { LuaJitRandom } from "../src/world-generation/lua-compat.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const setCount = Number(process.argv[2] ?? 40);
const luaDir = resolve(root, "public/runtime/lua");

const factory = new LuaFactory(pathToFileURL(resolve(root, "public/vendor/wasmoon.wasm")).href);
const engine = await factory.createEngine({ enableProxy: false, openStandardLibs: false });
engine.global.loadLibrary(LuaLibraries.Base);
engine.global.loadLibrary(LuaLibraries.Table);
engine.global.loadLibrary(LuaLibraries.String);
engine.global.loadLibrary(LuaLibraries.Math);
await engine.doString(FAST_PATH_PRELUDE);
await engine.doString(`
math.random = _sm_random
math.randomseed = _sm_randomseed
TYPE_MEADOW, TYPE_FOREST, TYPE_DESERT, TYPE_FIELD = 1, 2, 3, 4
TYPE_BURNTFOREST, TYPE_AUTUMNFOREST, TYPE_LAKE = 5, 6, 8
`);
await engine.doString(await readFile(resolve(luaDir, "util.lua"), "utf8"));
await engine.doString(await readFile(resolve(luaDir, "overworld/overworld_util.lua"), "utf8"));

// Both sides build the same POI set from the same stream, so only scalars cross
// the boundary.
await engine.doString(`
local TERRAINS = { 1, 2, 3, 4, 5, 6, 8 }
local SIZES = { 1, 1, 1, 2, 2, 3, 4, 8 }
function buildPois(seedValue, count)
    local state = seedValue % 4294967296
    local function nextValue()
        state = (state * 1664525 + 1013904223) % 4294967296
        return state
    end
    local pois = {}
    for index = 1, count do
        pois[index] = {
            x = nextValue() % 145 - 72,
            y = nextValue() % 113 - 56,
            size = SIZES[nextValue() % 8 + 1],
            terrainType = TERRAINS[nextValue() % 7 + 1]
        }
    end
    return pois
end
`);

const TERRAINS = [1, 2, 3, 4, 5, 6, 8];
const SIZES = [1, 1, 1, 2, 2, 3, 4, 8];
function buildPois(seedValue, count) {
  let state = seedValue % 4294967296;
  const nextValue = () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state;
  };
  const pois = [];
  for (let index = 0; index < count; index += 1) {
    pois.push({
      x: (nextValue() % 145) - 72,
      y: (nextValue() % 113) - 56,
      size: SIZES[nextValue() % 8],
      terrainType: TERRAINS[nextValue() % 7],
    });
  }
  return pois;
}

const failures = [];
const note = (text) => { if (failures.length < 10) failures.push(text); };

const luaCollides = await engine.doString(`
  return function(seedValue, count, x, y, size)
    local pois = _cachedPois
    if _cachedKey ~= seedValue .. ":" .. count then
      pois = buildPois(seedValue, count); _cachedPois = pois
      _cachedKey = seedValue .. ":" .. count
    end
    local hit = collides(x, y, size, pois)
    if hit == nil then return -1 end
    for index = 1, #pois do if pois[index] == hit then return index end end
    return -2
  end
`);
const luaClosest = await engine.doString(`
  return function(seedValue, count, x, y)
    local pois = _cachedPois
    if _cachedKey ~= seedValue .. ":" .. count then
      pois = buildPois(seedValue, count); _cachedPois = pois
      _cachedKey = seedValue .. ":" .. count
    end
    local winner = closestPoi(pois, x, y)
    for index = 1, #pois do if pois[index] == winner then return index end end
    return -1
  end
`);

const index = new CollisionIndex();
let collisionChecks = 0;
let closestChecks = 0;
for (let set = 0; set < setCount; set += 1) {
  const seedValue = 12345 + set * 7919;
  const count = 1 + (set * 13) % 260;
  const pois = buildPois(seedValue, count);
  index.invalidate();

  // Row-major sweeps, matching how the generator actually queries.
  for (let y = -56; y <= 56; y += 7) {
    for (let x = -72; x <= 72; x += 5) {
      for (const size of [1, 2, 3, 4, 8]) {
        const hit = index.collides(x, y, size, pois);
        const jsIndex = hit === null ? -1 : pois.indexOf(hit) + 1;
        const luaIndex = luaCollides(seedValue, count, x, y, size);
        collisionChecks += 1;
        if (jsIndex !== luaIndex) {
          note(`collides(set ${set}, ${x}, ${y}, size ${size}) -> lua ${luaIndex}, js ${jsIndex}`);
        }
      }
      const winner = closestPoi(pois, x, y);
      const jsWinner = winner === null ? -1 : pois.indexOf(winner) + 1;
      const luaWinner = luaClosest(seedValue, count, x, y);
      closestChecks += 1;
      if (jsWinner !== luaWinner) {
        note(`closestPoi(set ${set}, ${x}, ${y}) -> lua ${luaWinner}, js ${jsWinner}`);
      }
    }
  }
}

// shuffle draws from the PRNG; the resulting order and the number of draws must
// both match or every later random decision diverges.
const luaShuffle = await engine.doString(`
  return function(seedValue, count)
    math.randomseed(seedValue)
    local values = {}
    for index = 1, count do values[index] = index end
    shuffle(values)
    return table.concat(values, ",")
  end
`);
let shuffleChecks = 0;
for (const seed of [0, 1, 999, 123456789, 760487397]) {
  for (const count of [1, 2, 5, 17, 64, 243]) {
    const random = new LuaJitRandom();
    random.seed(seed);
    const values = Array.from({ length: count }, (_, i) => i + 1);
    shuffle(random, values);
    const js = values.join(",");
    const lua = luaShuffle(seed, count);
    shuffleChecks += 1;
    if (js !== lua) note(`shuffle(seed ${seed}, n ${count}) diverged`);
  }
}

engine.global.close();

if (failures.length) {
  console.error(`FAILED — ${failures.length} mismatch(es):`);
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}
console.log(
  `placement matches Lua exactly (${collisionChecks.toLocaleString()} collides, `
  + `${closestChecks.toLocaleString()} closestPoi, ${shuffleChecks} shuffles)`,
);
