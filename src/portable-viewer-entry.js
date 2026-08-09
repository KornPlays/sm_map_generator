import { setupMapViewer } from "./map-viewer.js";
import { unpackCells } from "./map-data-pack.js";
import { composeMap } from "./renderer.js";
import { readStoredMap, writeStoredMap, renderCacheKey } from "./map-store.js";
import PortableRenderWorker from "./renderer-worker.js?worker&inline";

function status(message) {
  const notice = document.querySelector("#portable-status");
  if (!notice) return;
  notice.hidden = !message;
  notice.textContent = message || "";
}

// A map exported at 100 px/cell embeds a 50 px/cell picture instead, because the
// full-resolution one is around 20 MB before base64 inflates it by a third. The
// exported file rebuilds the original resolution for itself from the cell layout
// it carries, using tile artwork the browser caches, and keeps the result so
// later openings are instant.
async function upgradeToFullResolution(viewer, data, cells) {
  const cacheKey = renderCacheKey(data.seed, data.cellSize);
  try {
    const cached = await readStoredMap(cacheKey);
    if (cached?.blob instanceof Blob && cached.cellSize === data.cellSize) {
      await viewer.attachMapBlob(cached.blob, { persist: false });
      return;
    }
  } catch {
    // A file:// page gets an opaque origin in some browsers and has no storage.
    // Rendering still works, it just cannot be kept for next time.
  }

  status(`Generating the ${data.cellSize} px/cell download image…`);
  let rendered;
  try {
    rendered = await new Promise((resolve, reject) => {
      let worker;
      try {
        worker = new PortableRenderWorker();
      } catch {
        resolve(composeMap(cells, data.cellSize, () => {}, {
          seed: data.seed,
          assetSource: data.assetSource,
          preview: false,
          pace: "fast",
        }));
        return;
      }
      worker.addEventListener("message", (event) => {
        if (event.data?.type === "progress") {
          status(`${event.data.message} (${Math.round(event.data.percent)}%)`);
        } else if (event.data?.type === "result") {
          worker.terminate();
          resolve(event.data);
        } else if (event.data?.type === "error") {
          worker.terminate();
          reject(new Error(event.data.message || "The full-resolution image could not be generated."));
        }
      });
      worker.addEventListener("error", (event) => {
        worker.terminate();
        reject(event.error || new Error(event.message || "The map renderer stopped unexpectedly."));
      }, { once: true });
      worker.postMessage({
        type: "render",
        cells,
        cellSize: data.cellSize,
        baseUrl: document.baseURI,
        seed: data.seed,
        assetSource: data.assetSource,
        preview: false,
      });
    });
  } catch (error) {
    // The embedded image remains usable for viewing, but it is deliberately
    // never offered as the higher-resolution download.
    console.warn("The full-resolution image could not be rebuilt:", error);
    status("The full-resolution download could not be generated. Reload to try again.");
    return;
  }

  await viewer.attachMapBlob(rendered.blob, { persist: false });
  status("");
  try {
    await writeStoredMap(cacheKey, { blob: rendered.blob, seed: data.seed, cellSize: data.cellSize, savedAt: Date.now() });
  } catch {
    // Same as above: without storage the render simply repeats next time.
  }
}

async function start() {
  const data = globalThis.SM_MAP_DATA;
  if (!data) throw new Error("This viewer file does not contain map data.");
  const cells = unpackCells(data.cells);
  const viewer = setupMapViewer({ onWarning: status });
  const options = {
    details: data.details,
    size: data.size,
    seed: data.seed,
    cells,
    mapMarkers: data.markers,
    assetSource: data.assetSource,
  };

  if (typeof data.image === "string") {
    // Single-file export: the display image travels as base64. Convert it once,
    // then drop the data script so the string does not sit in the heap while the
    // user pans.
    const imageSource = data.image;
    data.image = null;
    data.cells = null;
    delete globalThis.SM_MAP_DATA;
    document.querySelector("#sm-map-embedded-data")?.remove();
    const blob = await fetch(imageSource).then((response) => response.blob());
    if (data.cellSize > data.imageCellSize) {
      // The embedded image is a display preview, not a valid substitute for
      // the requested download resolution. Keep download disabled until the
      // exact target image has been rendered or restored from browser storage.
      viewer.showMapPreview(blob, data.name, options);
      upgradeToFullResolution(viewer, data, cells);
    } else {
      viewer.showMapBlobs(blob, blob, data.name, { ...options, size: blob.size });
    }
  } else {
    // Self-hosted export: the images sit beside the HTML as ordinary files.
    viewer.showMapUrl(data.map, data.preview, data.name, options);
  }

  document.querySelector("#viewer-expand")?.remove();
  document.querySelector("#upload-map")?.remove();
  document.querySelector("#map-file")?.remove();
}

start().catch((error) => {
  console.error(error);
  status(error.message || String(error));
});
