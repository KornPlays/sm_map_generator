// Cross-checks the JavaScript primitives layer against the Lua the shipping
// generator actually runs. Both are driven with the same inputs and every result
// must match exactly — these functions sit underneath the whole world layout, so
// a single disagreement would move tiles.
//
// Usage: node scripts/verify-primitives.mjs [iterations]

import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { LuaFactory, LuaLibraries } from "wasmoon";

import { FAST_PATH_PRELUDE } from "../src/lua-fastpath.js";
import { band, bnot, bor, intNoise2d, lshift, LuaJitRandom, rshift, tobit } from "../src/world-generation/lua-compat.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const iterations = Number(process.argv[2] ?? 20000);

const factory = new LuaFactory(pathToFileURL(resolve(root, "public/vendor/wasmoon.wasm")).href);
const engine = await factory.createEngine({ enableProxy: false, openStandardLibs: false });
engine.global.loadLibrary(LuaLibraries.Base);
engine.global.loadLibrary(LuaLibraries.Table);
engine.global.loadLibrary(LuaLibraries.String);
engine.global.loadLibrary(LuaLibraries.Math);
await engine.doString(FAST_PATH_PRELUDE);

// A deterministic input stream, so a failure is always reproducible.
let streamState = 0x2f6e2b1 >>> 0;
function nextInput() {
  streamState = (Math.imul(streamState, 1664525) + 1013904223) >>> 0;
  return streamState;
}

const failures = [];
function check(label, expected, actual, inputs) {
  if (Object.is(expected, actual)) return;
  if (failures.length < 10) {
    failures.push(`${label}(${inputs.join(", ")}) -> lua ${expected}, js ${actual}`);
  }
}

// --- bit library ------------------------------------------------------------
const luaBits = await engine.doString(`
  return function(a, b, shift)
    return { _sm_tobit(a), _sm_band(a, b), _sm_bor(a, b), _sm_bnot(a),
             _sm_lshift(a, shift), _sm_rshift(a, shift) }
  end
`);
for (let index = 0; index < iterations; index += 1) {
  const a = nextInput() | 0;
  const b = nextInput() | 0;
  const shift = nextInput() & 31;
  // wasmoon hands Lua sequences back as 0-indexed JavaScript arrays.
  const lua = luaBits(a, b, shift);
  check("tobit", lua[0], tobit(a), [a]);
  check("band", lua[1], band(a, b), [a, b]);
  check("bor", lua[2], bor(a, b), [a, b]);
  check("bnot", lua[3], bnot(a), [a]);
  check("lshift", lua[4], lshift(a, shift), [a, shift]);
  check("rshift", lua[5], rshift(a, shift), [a, shift]);
}

// --- integer noise ----------------------------------------------------------
const luaNoise = await engine.doString("return function(x, y, seed) return _sm_int_noise(x, y, seed) end");
for (let index = 0; index < iterations; index += 1) {
  // Cover the coordinate range the generator actually uses plus wide values.
  const x = index % 2 ? (nextInput() % 300) - 150 : nextInput() | 0;
  const y = index % 2 ? (nextInput() % 300) - 150 : nextInput() | 0;
  const seed = nextInput() >>> 0;
  check("intNoise2d", luaNoise(x, y, seed), intNoise2d(x, y, seed), [x, y, seed]);
}

// --- PRNG -------------------------------------------------------------------
const luaSeed = await engine.doString("return function(seed) _sm_randomseed(seed) end");
const luaRandom = await engine.doString("return function(lo, hi) return _sm_random(lo, hi) end");
for (const seed of [0, 1, 999, 123456789, 760487397, 4294967295]) {
  luaSeed(seed);
  const js = new LuaJitRandom();
  js.seed(seed);
  for (let index = 0; index < 500; index += 1) {
    const lower = 1 + (index % 7);
    const upper = lower + (index % 13);
    check("random", luaRandom(lower, upper), js.integer(lower, upper), [seed, lower, upper]);
  }
}

engine.global.close();

if (failures.length) {
  console.error(`FAILED — ${failures.length} mismatch(es):`);
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}
console.log(`primitives match Lua exactly (${iterations.toLocaleString()} iterations per bit op and noise, 3,000 PRNG draws)`);
