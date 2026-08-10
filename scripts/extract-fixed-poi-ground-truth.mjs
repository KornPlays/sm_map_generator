// One-off diagnostic (not part of the port test suite): dumps the real `fixed`
// POI table from generate_cells.lua as a plain string, sidestepping wasmoon's
// nil-marshalling ambiguity, so it can be diffed against poi-catalog-data.js.
import { LuaFactory } from "wasmoon";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const f = new LuaFactory();
const e = await f.createEngine();
await e.doString("ExcavationIsland={x=32,y=16}; TYPE_MEADOW,TYPE_FOREST,TYPE_DESERT,TYPE_FIELD=1,2,3,4; TYPE_BURNTFOREST,TYPE_AUTUMNFOREST,TYPE_LAKE=5,6,8");
const src = readFileSync(resolve(root, "public/runtime/lua/overworld/generate_cells.lua"), "utf8");
const start = src.indexOf("local fixed={");
const end = src.indexOf("}\n\tfor _,s in ipairs(fixed)", start);
const fixedLiteral = src.slice(start + "local fixed=".length, end + 1);

const luaScript = `
local fixed = ${fixedLiteral}
local lines = {}
for i, s in ipairs(fixed) do
  local parts = {}
  for n = 1, 13 do
    local v = s[n]
    parts[n] = v == nil and "NIL" or tostring(v)
  end
  lines[#lines+1] = i .. ": " .. table.concat(parts, "|")
end
return table.concat(lines, "\\n")
`;
const out = await e.doString(luaScript);
console.log(out);
e.global.close();
