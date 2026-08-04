import { composeMap } from "./renderer.js";
import { findMapMarkers } from "./builder-quests.js";

let generatorPromise;

async function loadGenerator(baseUrl) {
  if (!generatorPromise) {
    generatorPromise = (async () => {
      globalThis.__SM_MAP_BASE_URL = baseUrl;
      return import("./generator.js");
    })();
  }
  return generatorPromise;
}

self.addEventListener("message", async (event) => {
  if (event.data?.type !== "generate" && event.data?.type !== "generate-markers") return;
  const { seed, cellSize, baseUrl } = event.data;
  const progress = (message, percent) => {
    self.postMessage({ type: "progress", message, percent });
  };

  try {
    const { generateCells } = await loadGenerator(baseUrl);
    const cells = await generateCells(seed, progress);
    const mapMarkers = findMapMarkers(cells);
    if (event.data.type === "generate-markers") {
      self.postMessage({ type: "markers", seed, mapMarkers });
      return;
    }
    if (typeof OffscreenCanvas === "undefined") {
      self.postMessage({ type: "cells", cells, mapMarkers });
      return;
    }
    const rendered = await composeMap(cells, cellSize, progress, { baseUrl, seed });
    self.postMessage({ type: "result", ...rendered, seed, mapMarkers });
  } catch (error) {
    self.postMessage({
      type: "error",
      message: error?.message || String(error),
      stack: error?.stack,
    });
  }
});
