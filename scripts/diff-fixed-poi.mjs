// One-off diagnostic: diffs poi-catalog-data.js's FIXED_POIS positionally
// against the real `fixed` table in generate_cells.lua, field by field.
import { LuaFactory } from "wasmoon";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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
  lines[#lines+1] = table.concat(parts, "|")
end
return table.concat(lines, "\\n")
`;
const luaOut = (await e.doString(luaScript)).split("\n").map((line) => line.split("|"));
e.global.close();

const { FIXED_POIS } = await import(pathToFileURL(resolve(root, "src/world-generation/poi-catalog-data.js")).href);
const FIELD_NAMES = ["refName", "x", "y", "type", "size", "road", "flat", "rotation", "terrainType", "cliffLevel", "index", "forceFlat", "elevationSmoothing"];

let mismatches = 0;
for (let row = 0; row < Math.max(luaOut.length, FIXED_POIS.length); row += 1) {
  const luaRow = luaOut[row];
  const jsRow = FIXED_POIS[row];
  if (!luaRow || !jsRow) { console.log(`row ${row + 1}: MISSING on ${!luaRow ? "lua" : "js"} side`); mismatches += 1; continue; }
  for (let field = 0; field < 13; field += 1) {
    if (field === 0 || field === 3) continue; // refName/type: skip (strings/POI-constants, not the numeric bug class)
    const luaValue = luaRow[field];
    const jsValue = jsRow[field] === undefined || jsRow[field] === null ? "NIL" : String(jsRow[field]);
    if (luaValue !== jsValue) {
      console.log(`row ${row + 1} field ${FIELD_NAMES[field]}: lua=${luaValue} js=${jsValue}`);
      mismatches += 1;
    }
  }
}
console.log(mismatches ? `${mismatches} mismatches` : "ALL FIELDS MATCH");
