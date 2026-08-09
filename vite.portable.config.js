import { defineConfig } from "vite";
import { resolve } from "node:path";

// A classic IIFE works when an exported viewer is opened directly with file://.
export default defineConfig({
  publicDir: false,
  build: {
    outDir: "src/generated",
    emptyOutDir: true,
    target: "es2020",
    lib: {
      entry: resolve(import.meta.dirname, "src/portable-viewer-entry.js"),
      formats: ["iife"],
      name: "SMPortableViewer",
      fileName: () => "portable-viewer.js",
    },
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
  },
});
