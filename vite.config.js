import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  worker: {
    format: "es",
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2020",
  },
});
