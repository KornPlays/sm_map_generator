// Cross-checks lua-sort.js against the real engine's table.sort, specifically
// on inputs with heavy key collisions — the case where an unstable sort's exact
// behavior matters and where a "close enough" comparator-based sort silently
// disagrees with Lua.
//
// Usage: node scripts/verify-lua-sort.mjs [trials]

import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { LuaFactory, LuaLibraries } from "wasmoon";

import { luaSort } from "../src/world-generation/lua-sort.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const trials = Number(process.argv[2] ?? 400);

const factory = new LuaFactory(pathToFileURL(resolve(root, "public/vendor/wasmoon.wasm")).href);
const engine = await factory.createEngine({ enableProxy: false, openStandardLibs: false });
engine.global.loadLibrary(LuaLibraries.Base);
engine.global.loadLibrary(LuaLibraries.Table);
engine.global.loadLibrary(LuaLibraries.Math);

const luaSortByKey = await engine.doString(`
  return function(values, keys)
    -- keys[i] corresponds to values[i]; sort values by ascending key, using
    -- table.sort so its real (unstable) algorithm runs, exactly as
    -- generate_cells.lua's table.sort(spots, function(a,b) ... end) does.
    local indexed = {}
    for i = 1, #values do indexed[i] = { v = values[i], k = keys[i] } end
    table.sort(indexed, function(a, b) return a.k < b.k end)
    local out = {}
    for i = 1, #indexed do out[i] = indexed[i].v end
    return out
  end
`);

let streamState = 0xdeadbeef >>> 0;
function nextInput() {
  streamState = (Math.imul(streamState, 1664525) + 1013904223) >>> 0;
  return streamState;
}

const failures = [];
let checkedTrials = 0;
let tieTrials = 0;

for (let trial = 0; trial < trials; trial += 1) {
  const size = 2 + (nextInput() % 60);
  // A small key range forces frequent ties, which is exactly the regime the
  // world generator hits (intNoise2d(...) % 75 or % 24 over a few dozen spots).
  const keyRange = 1 + (nextInput() % 8);
  const values = Array.from({ length: size }, (_, i) => i); // identity payload = original index
  const keys = values.map(() => nextInput() % keyRange);
  const hasTie = new Set(keys).size < keys.length;
  if (hasTie) tieTrials += 1;

  const jsValues = values.slice();
  luaSort(jsValues, (a, b) => keys[a] - keys[b]);

  // eslint-disable-next-line no-await-in-loop
  const luaValues = await luaSortByKey(values, keys);

  checkedTrials += 1;
  const jsStr = jsValues.join(",");
  const luaStr = luaValues.join(",");
  if (jsStr !== luaStr) {
    if (failures.length < 8) {
      failures.push(`trial ${trial} (size ${size}, keyRange ${keyRange}): lua=[${luaStr}] js=[${jsStr}] keys=[${keys.join(",")}]`);
    }
  }
}

engine.global.close();

console.log(`${checkedTrials} trials, ${tieTrials} with at least one tie`);
if (failures.length) {
  console.error(`FAILED — mismatches found:`);
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}
console.log("luaSort matches Lua's table.sort exactly, including tie order");
