import { composeMap, prewarmTiles } from "./renderer.js";

self.addEventListener("message", async (event) => {
  // Sent while the world layout is still being generated, so the tile artwork is
  // downloaded in parallel instead of after the cells arrive.
  if (event.data?.type === "prewarm") {
    const { cellSize, baseUrl, assetSource } = event.data;
    prewarmTiles(cellSize, { baseUrl, assetSource });
    return;
  }
  if (event.data?.type !== "render") return;
  const { cells, cellSize, baseUrl, seed, assetSource, preview = true, quality = 0.85 } = event.data;
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
      // The finished pixels, handed over before they are encoded. Painting these
      // takes a few milliseconds where the WebP encode takes most of a second.
      onPreviewBitmap: ({ bitmap, width, height, missing }) => {
        self.postMessage({ type: "previewBitmap", bitmap, width, height, missing, seed }, [bitmap]);
      },
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
