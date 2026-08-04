import { composeMap } from "./renderer.js";

let generatorPromise;

async function loadGenerator(baseUrl) {
  if (!generatorPromise) {
    generatorPromise = (async () => {
      globalThis.__SM_MAP_BASE_URL = baseUrl;
      if (!globalThis.fengari) {
        await import(/* @vite-ignore */ new URL("vendor/fengari-web.js", baseUrl).href);
      }
      return import("./generator.js");
    })();
  }
  return generatorPromise;
}

self.addEventListener("message", async (event) => {
  if (event.data?.type !== "generate") return;
  const { seed, cellSize, baseUrl } = event.data;
  const progress = (message, percent) => {
    self.postMessage({ type: "progress", message, percent });
  };

  try {
    const { generateCells } = await loadGenerator(baseUrl);
    const cells = await generateCells(seed, progress);
    if (typeof OffscreenCanvas === "undefined") {
      self.postMessage({ type: "cells", cells });
      return;
    }
    const rendered = await composeMap(cells, cellSize, progress, { baseUrl });
    self.postMessage({ type: "result", ...rendered });
  } catch (error) {
    self.postMessage({
      type: "error",
      message: error?.message || String(error),
      stack: error?.stack,
    });
  }
});
