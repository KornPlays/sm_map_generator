import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const seed = Number(process.argv[2] ?? 760487397);

globalThis.document = { baseURI: pathToFileURL(`${resolve(root, "public")}/`).href };
globalThis.requestAnimationFrame = (callback) => setImmediate(callback);
globalThis.fetch = async (input) => {
  try {
    const bytes = await readFile(fileURLToPath(String(input)));
    return new Response(bytes, { status: 200 });
  } catch {
    return new Response(null, { status: 404 });
  }
};

const { generateCells } = await import("../src/generator.js");
const cells = await generateCells(seed);
const multiOrigins = new Map();
for (const cell of cells) {
  if (cell.size <= 1) continue;
  if (!Number.isInteger(cell.originX) || !Number.isInteger(cell.originY)) {
    throw new Error(`Multi-cell tile ${cell.uid} has no integer origin.`);
  }
  if (
    cell.x < cell.originX || cell.x >= cell.originX + cell.size ||
    cell.y < cell.originY || cell.y >= cell.originY + cell.size
  ) {
    throw new Error(`Cell ${cell.x},${cell.y} is outside ${cell.uid}'s declared origin.`);
  }
  const key = `${cell.group}:${cell.uid}`;
  const origin = `${cell.originX},${cell.originY}`;
  if (multiOrigins.has(key) && multiOrigins.get(key) !== origin) {
    throw new Error(`Multi-cell group ${key} contains conflicting origins.`);
  }
  multiOrigins.set(key, origin);
}
if (process.argv.includes("--dump")) {
  const outputIndex = process.argv.indexOf("--output");
  const serialized = JSON.stringify(cells);
  if (outputIndex >= 0 && process.argv[outputIndex + 1]) {
    await writeFile(process.argv[outputIndex + 1], serialized);
  } else {
    process.stdout.write(serialized);
  }
} else {
  const canonical = cells
    .map((cell) =>
      [cell.x, cell.y, cell.uid, cell.size, cell.rotation, cell.group, cell.terrainType].join("\t"),
    )
    .join("\n");

  console.log(
    JSON.stringify({
      seed,
      cells: cells.length,
      sha256: createHash("sha256").update(canonical).digest("hex"),
    }),
  );
}
