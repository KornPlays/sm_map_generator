const PERMUTATION = new Uint8Array([
  151, 160, 137, 91, 90, 15, 131, 13, 201, 95, 96, 53, 194, 233, 7, 225,
  140, 36, 103, 30, 69, 142, 8, 99, 37, 240, 21, 10, 23, 190, 6, 148,
  247, 120, 234, 75, 0, 26, 197, 62, 94, 252, 219, 203, 117, 35, 11, 32,
  57, 177, 33, 88, 237, 149, 56, 87, 174, 20, 125, 136, 171, 168, 68, 175,
  74, 165, 71, 134, 139, 48, 27, 166, 77, 146, 158, 231, 83, 111, 229, 122,
  60, 211, 133, 230, 220, 105, 92, 41, 55, 46, 245, 40, 244, 102, 143, 54,
  65, 25, 63, 161, 1, 216, 80, 73, 209, 76, 132, 187, 208, 89, 18, 169,
  200, 196, 135, 130, 116, 188, 159, 86, 164, 100, 109, 198, 173, 186, 3,
  64, 52, 217, 226, 250, 124, 123, 5, 202, 38, 147, 118, 126, 255, 82, 85,
  212, 207, 206, 59, 227, 47, 16, 58, 17, 182, 189, 28, 42, 223, 183, 170,
  213, 119, 248, 152, 2, 44, 154, 163, 70, 221, 153, 101, 155, 167, 43,
  172, 9, 129, 22, 39, 253, 19, 98, 108, 110, 79, 113, 224, 232, 178, 185,
  112, 104, 218, 246, 97, 228, 251, 34, 242, 193, 238, 210, 144, 12, 191,
  179, 162, 241, 81, 51, 145, 235, 249, 14, 239, 107, 49, 192, 214, 31,
  181, 199, 106, 157, 184, 84, 204, 176, 115, 121, 50, 45, 127, 4, 150,
  254, 138, 236, 205, 93, 222, 114, 67, 29, 24, 72, 243, 141, 128, 195,
  78, 66, 215, 61, 156, 180,
]);

const f32 = Math.fround;
const F2 = f32(0.3660253882408142);
const G2 = f32(0.21132487058639526);
const TWO_G2_MINUS_ONE = f32(0.5773502588272095);
const SCALE = f32(45.23065185546875);

const add = (a, b) => f32(f32(a) + f32(b));
const sub = (a, b) => f32(f32(a) - f32(b));
const mul = (a, b) => f32(f32(a) * f32(b));

function gradient(hash, x, y) {
  hash &= 63;
  let u = hash < 4 ? x : y;
  let v = hash < 4 ? y : x;
  if (hash & 1) u = f32(-u);
  v = mul(v, hash & 2 ? -2 : 2);
  return add(u, v);
}

function contribution(hash, x, y) {
  let amount = sub(sub(0.5, mul(x, x)), mul(y, y));
  if (amount < 0) return f32(0);
  amount = mul(amount, amount);
  return mul(mul(amount, amount), gradient(hash, x, y));
}

// Float32 operations and the fixed permutation table intentionally mirror the
// simplexNoise2d implementation embedded in ScrapMechanic.exe.
export function simplexNoise2d(rawX, rawY) {
  const x = f32(rawX);
  const y = f32(rawY);
  const skew = mul(add(x, y), F2);
  const i = Math.floor(add(x, skew));
  const j = Math.floor(add(y, skew));
  const unskew = mul(i + j, G2);
  const x0 = sub(x, sub(i, unskew));
  const y0 = sub(y, sub(j, unskew));
  const i1 = x0 > y0 ? 1 : 0;
  const j1 = x0 > y0 ? 0 : 1;
  const x1 = add(sub(x0, i1), G2);
  const y1 = add(sub(y0, j1), G2);
  const x2 = sub(x0, TWO_G2_MINUS_ONE);
  const y2 = sub(y0, TWO_G2_MINUS_ONE);

  const h0 = PERMUTATION[(i + PERMUTATION[j & 255]) & 255];
  const h1 = PERMUTATION[(i + i1 + PERMUTATION[(j + j1) & 255]) & 255];
  const h2 = PERMUTATION[(i + 1 + PERMUTATION[(j + 1) & 255]) & 255];
  return mul(
    add(add(contribution(h0, x0, y0), contribution(h1, x1, y1)), contribution(h2, x2, y2)),
    SCALE,
  );
}

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
