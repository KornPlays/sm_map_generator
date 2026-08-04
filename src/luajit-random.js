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
// exact, including the bit-pattern conversion used by math.random().
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
