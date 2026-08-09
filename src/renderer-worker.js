import { composeMap } from "./renderer.js";

self.addEventListener("message", async (event) => {
  if (event.data?.type !== "render") return;
  const { cells, cellSize, baseUrl, seed, assetSource, preview = true, quality = 0.92 } = event.data;
  const progress = (message, percent) => {
    self.postMessage({ type: "progress", message, percent });
  };

  try {
    const rendered = await composeMap(cells, cellSize, progress, {
      baseUrl,
      seed,
      assetSource,
      preview,
      quality,
      // Handed over before the full-resolution encode finishes so the page can
      // show the finished map while the download image is still being written.
      onPreview: (preview) => self.postMessage({ type: "preview", ...preview, seed }),
    });
    self.postMessage({ type: "result", ...rendered, seed });
  } catch (error) {
    self.postMessage({
      type: "error",
      message: error?.message || String(error),
      code: error?.code || null,
      stack: error?.stack,
    });
  }
});
