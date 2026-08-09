# World generator maintenance

The browser generator has one stable public contract:

```text
generateCells(seed) -> [{ x, y, uid, size, rotation, group, terrainType }, ...]
```

The seed is an unsigned 32-bit integer from 0 to 4,294,967,295. The playable map is 128 × 96 cells and a
valid result currently contains 12,288 populated cells. Array order is part of
the contract because generation consumes a deterministic LuaJIT-compatible
random stream.

## Current structure

- `src/generator.js` owns the runtime boundary and converts the result to plain
  JavaScript objects.
- `src/world-generation/poi-types.js` contains declarative POI identifiers.
- `src/noise.js` and `src/luajit-random.js` provide deterministic primitives.
- `public/runtime/data/` contains declarative terrain, POI, start-area, tile,
  and excavation-layout compatibility data.
- `public/runtime/lua/` contains the project-authored generation passes used by
  the WebAssembly Lua runtime.

The road graph, terrain processing, biome selection, POI placement, and
top-level generation stages are split into reusable project-owned modules and
declarative catalogs. No original game Lua source file is intentionally loaded
or shipped by the browser generator.

## Safe migration process

1. Make one focused change to a generation stage or declarative catalog.
2. Keep random calls and iteration order stable unless intentionally changing
   the generated worlds.
3. Run the golden-seed checks before committing.
4. Add a new golden seed whenever a bug exposes an untested branch.

## Golden outputs

Run:

```bash
npm run test:generator -- 1337
npm run test:generator -- 760487397
npm run test:generator -- 169246597
```

Expected SHA-256 values:

| Seed | Cells | SHA-256 |
| ---: | ---: | --- |
| 1337 | 12,288 | `4dadf6b1072b6e7c4083c2a92d8802fa7396fb9089dfcccd404515a0d4dbdc25` |
| 760487397 | 12,288 | `54dd58a2768ace2bf37ec3b8daaaa54f251d9341ae56f5c1d5e8f1e4d08bb6db` |
| 169246597 | 12,288 | `134816a91611be03ba208abf9437b98db1bd7c1c0b962d15224e6fb327ea76be` |

An exact hash match means every emitted tile, position, size, rotation, group,
terrain type, and row order stayed the same.
