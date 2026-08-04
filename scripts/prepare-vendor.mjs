import { copyFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
mkdirSync(resolve(root, "public/vendor"), { recursive: true });
copyFileSync(
  resolve(root, "node_modules/wasmoon/dist/glue.wasm"),
  resolve(root, "public/vendor/wasmoon.wasm"),
);
