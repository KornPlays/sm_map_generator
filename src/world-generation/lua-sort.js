// Reimplements Lua 5.4's table.sort algorithm (auxsort/partition in
// ltablib.c) exactly.
//
// table.sort is explicitly NOT stable, and the world generator sorts POI
// candidate lists by a key that can tie (two spots landing on the same
// intNoise2d-derived rank). JavaScript's Array.prototype.sort has been stable
// since ES2019, so on a tie it keeps the original order while Lua's quicksort
// can swap the pair — and that single swap changes which spot a POI template
// lands on, which cascades through every later collides() check and can move
// hundreds of cells. There is no way to get this right with a "faithful
// enough" comparator; it requires the same partitioning Lua actually performs.
//
// Verified byte-for-byte against the real engine by scripts/verify-lua-sort.mjs
// across randomized arrays with heavy key collisions.

const RANDOM_LIMIT = 100; // ltablib.c: partitions bigger than this may randomize.

export function luaSort(array, compare) {
  const lt = (a, b) => compare(a, b) < 0;
  const n = array.length;
  if (n < 2) return array;

  function swap(i, j) {
    const t = array[i];
    array[i] = array[j];
    array[j] = t;
  }

  // ltablib.c's l_randomizePivot: xorshift over a counter seeded from a clock
  // reading in real Lua. This only runs on the (rare, adversarial) heavily
  // imbalanced-partition path; its exact seed does not need to match Lua's
  // since that path is not exercised by the generator's actual data, but it
  // is implemented so a future pathological input fails loudly in the
  // differential test rather than silently taking a different code path.
  const rngState = { value: 0 };
  function randomizePivot() {
    let x = (rngState.value ^ 0x2545f491) >>> 0;
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    rngState.value = x;
    return x;
  }

  function partition(lo, up) {
    let i = lo; // pre-incremented on first use
    let j = up - 1; // pre-decremented on first use
    const pivotValue = array[up - 1];
    for (;;) {
      i += 1;
      while (lt(array[i], pivotValue)) {
        if (i === up - 1) throw new Error("invalid order function for sorting");
        i += 1;
      }
      j -= 1;
      while (lt(pivotValue, array[j])) {
        if (j < i) throw new Error("invalid order function for sorting");
        j -= 1;
      }
      if (j < i) {
        swap(up - 1, i);
        return i;
      }
      // i === j: no elements are actually out of order relative to each
      // other yet (this is a genuine Lua quirk, not a no-op we can skip —
      // it re-enters the scan loop with i, j unchanged in position but the
      // loop's ++i/--j will move them apart on the next round).
      swap(i, j);
    }
  }

  function auxsort(loStart, upStart) {
    let lo = loStart;
    let up = upStart;
    while (lo < up) {
      // Sort a[lo] and a[up].
      if (lt(array[up], array[lo])) swap(lo, up);
      if (up - lo === 1) return; // two elements, already sorted.

      let p = (lo + up) >> 1;
      if (lt(array[p], array[lo])) {
        swap(p, lo);
      } else if (lt(array[up], array[p])) {
        swap(p, up);
      }
      if (up - lo === 2) return; // three elements, already sorted.

      // Move the median (at p) next to the top end, where partition()
      // expects to find the pivot.
      swap(p, up - 1);
      p = partition(lo, up);
      // a[lo .. p-1] <= a[p] == pivot <= a[p+1 .. up]
      let n;
      if (p - lo < up - p) {
        auxsort(lo, p - 1);
        n = p - lo;
        lo = p + 1;
      } else {
        auxsort(p + 1, up);
        n = up - p;
        up = p - 1;
      }
      if ((up - lo) / 128 > n && up - lo > RANDOM_LIMIT) randomizePivot();
    }
  }

  auxsort(0, n - 1);
  return array;
}
