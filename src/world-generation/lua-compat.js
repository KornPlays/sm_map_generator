// Primitives layer of the JavaScript world generator.
//
// The world layout is currently produced by running the game's own Lua through
// wasmoon. Porting that to JavaScript has to reproduce it exactly, so this module
// holds the pieces the Lua sits on: LuaJIT's bit library, the integer noise baked
// into ScrapMechanic.exe, and LuaJIT's PRNG. Every function here is checked
// against the running Lua implementation by scripts/verify-primitives.mjs.
//
// Nothing in the shipping generator imports this yet — the Lua path remains the
// only one in use until the port is complete and the seed hashes match.

// ---------------------------------------------------------------------------
// Lua's % operator
// ---------------------------------------------------------------------------
// Lua's % is a floored modulo: the result always has the same sign as the
// divisor. JavaScript's % is a truncated remainder: the result has the same
// sign as the dividend. They agree whenever the dividend is non-negative, and
// disagree whenever it isn't — which every `intNoise2d(...) % n` in this port
// hits constantly, since intNoise2d returns the full signed 32-bit range.
// Every site in the generation code that mods a value which can be negative
// must go through this rather than the bare `%` operator.
export function luaMod(value, divisor) {
  const remainder = value % divisor;
  return remainder < 0 ? remainder + divisor : remainder;
}

// ---------------------------------------------------------------------------
// LuaJIT bit library
// ---------------------------------------------------------------------------
// LuaJIT's operators work on signed 32-bit integers, which is exactly what
// JavaScript's bitwise operators already do, so these are direct.

export function tobit(value) {
  return value | 0;
}

export function band(...values) {
  let result = -1;
  for (const value of values) result &= value | 0;
  return result | 0;
}

export function bor(...values) {
  let result = 0;
  for (const value of values) result |= value | 0;
  return result | 0;
}

export function bnot(value) {
  return ~value;
}

export function lshift(value, shift) {
  return (value | 0) << (shift & 31);
}

export function rshift(value, shift) {
  return (value >>> (shift & 31)) | 0;
}

// ---------------------------------------------------------------------------
// sm.noise.intNoise2d
// ---------------------------------------------------------------------------

function arithmeticShift(value, count) {
  return (value | 0) >> count;
}

function mix32(value) {
  value >>>= 0;
  value = (((value << 15) >>> 0) + (~value >>> 0)) >>> 0;
  value = (value ^ arithmeticShift(value, 12)) >>> 0;
  value = Math.imul(value, 5) >>> 0;
  value = (value ^ arithmeticShift(value, 4)) >>> 0;
  return Math.imul(value, 0x809) >>> 0;
}

// Mirrors the intNoise2d implementation embedded in ScrapMechanic.exe.
export function intNoise2d(rawX, rawY, rawSeed) {
  const x = Math.trunc(rawX) >>> 0;
  const y = Math.trunc(rawY) >>> 0;
  const seed = Math.trunc(rawSeed) >>> 0;
  let value = mix32(y);
  value = mix32(((value ^ arithmeticShift(value, 16)) + x) >>> 0);
  value = mix32(((value ^ arithmeticShift(value, 16)) + seed) >>> 0);
  const signed = value | 0;
  return (signed ^ (signed >> 16)) | 0;
}

// ---------------------------------------------------------------------------
// math.random / math.randomseed
// ---------------------------------------------------------------------------

const MASK_64 = (1n << 64n) - 1n;
const DOUBLE_MANTISSA = 0x000fffffffffffffn;
const DOUBLE_ONE = 0x3ff0000000000000n;
const STEP_PARAMETERS = [
  [63n, 31n, 18n],
  [58n, 19n, 28n],
  [55n, 24n, 7n],
  [47n, 21n, 8n],
];

// LuaJIT's period-2^223 Tausworthe PRNG. BigInt keeps every 64-bit operation
// exact, including the bit-pattern conversion math.random() relies on. It is
// only stepped a few thousand times per world, so the BigInt cost is immaterial
// next to getting the bits right.
export class LuaJitRandom {
  constructor() {
    this.state = [0n, 0n, 0n, 0n];
    this.buffer = new ArrayBuffer(8);
    this.view = new DataView(this.buffer);
  }

  seed(initialValue) {
    let value = Number(initialValue);
    let shifts = 0x11090601;
    for (let index = 0; index < 4; index += 1) {
      const minimum = 1n << BigInt(shifts & 255);
      shifts >>>= 8;
      value = value * Math.PI + Math.E;
      this.view.setFloat64(0, value, true);
      let bits = this.view.getBigUint64(0, true);
      if (bits < minimum) bits += minimum;
      this.state[index] = bits & MASK_64;
    }
    for (let index = 0; index < 10; index += 1) this.step();
  }

  step() {
    let result = 0n;
    for (let index = 0; index < 4; index += 1) {
      const [k, q, s] = STEP_PARAMETERS[index];
      let value = this.state[index];
      value =
        ((((value << q) & MASK_64) ^ value) >> (k - s)) ^
        (((value & ((MASK_64 << (64n - k)) & MASK_64)) << s) & MASK_64);
      value &= MASK_64;
      this.state[index] = value;
      result ^= value;
    }
    return result & MASK_64;
  }

  random() {
    const bits = (this.step() & DOUBLE_MANTISSA) | DOUBLE_ONE;
    this.view.setBigUint64(0, bits, true);
    return this.view.getFloat64(0, true) - 1;
  }

  integer(minimum, maximum) {
    return Math.floor(this.random() * (maximum - minimum + 1)) + minimum;
  }
}
