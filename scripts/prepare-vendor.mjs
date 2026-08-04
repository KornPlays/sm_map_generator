import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const source = readFileSync(
  resolve(root, "node_modules/fengari-web/dist/fengari-web.bundle.js"),
  "utf8",
);
const wrapped = `globalThis.fengari = (() => {
  const module = { exports: {} };
  const exports = module.exports;
  ${source}
  return module.exports;
})();
`;

mkdirSync(resolve(root, "public/vendor"), { recursive: true });
writeFileSync(resolve(root, "public/vendor/fengari-web.js"), wrapped);
