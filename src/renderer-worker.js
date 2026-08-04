import { composeMap } from "./renderer.js";

self.addEventListener("message", async (event) => {
  if (event.data?.type !== "render") return;
  const { cells, cellSize, baseUrl, seed } = event.data;
  const progress = (message, percent) => {
    self.postMessage({ type: "progress", message, percent });
  };

  try {
    const rendered = await composeMap(cells, cellSize, progress, { baseUrl, seed });
    self.postMessage({ type: "result", ...rendered, seed });
  } catch (error) {
    self.postMessage({
      type: "error",
      message: error?.message || String(error),
      stack: error?.stack,
    });
  }
});
