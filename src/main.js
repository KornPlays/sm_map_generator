import "./style.css";
import { composeMap } from "./renderer.js";
import { setupMapViewer } from "./map-viewer.js";
import { InvalidSaveError, readScrapMechanicSeed } from "./save-reader.js";
import { downloadLocalViewer, downloadOriginalViewer } from "./viewer-export.js";

const form = document.querySelector("#generator-form");
const seedInput = document.querySelector("#seed");
const sizeInput = document.querySelector("#cell-size");
const generateButton = document.querySelector("#generate");
const uploadButton = document.querySelector("#upload-save");
const saveInput = document.querySelector("#save-file");
const cancelButton = document.querySelector("#cancel");
const status = document.querySelector("#status");
const statusTitle = document.querySelector("#status-title");
const statusText = document.querySelector("#status-text");
const progressBar = document.querySelector("#progress-bar");
const progressTrack = document.querySelector("#progress-track");
const missing = document.querySelector("#missing");
const mapViewerElement = document.querySelector("#map-viewer");
// The download menu exists twice: beside the upload button and in the floating
// map controls. Both copies drive the same exports.
const downloadViewerMenus = [...document.querySelectorAll("[data-download-menu]")];
const downloadViewerOriginals = [...document.querySelectorAll('[data-download-role="original"]')];
const downloadViewerLocals = [...document.querySelectorAll('[data-download-role="local"]')];

let activeController = null;
let activeWorker = null;
let activeSeed = null;

function abortError() {
  return new DOMException("Map generation was cancelled.", "AbortError");
}

function setStatus(title, message, kind = "working", percent = 0) {
  status.hidden = false;
  status.dataset.kind = kind;
  statusTitle.textContent = title;
  statusText.textContent = message;
  const boundedPercent = Math.max(0, Math.min(100, Math.round(percent)));
  progressBar.style.width = `${boundedPercent}%`;
  progressTrack.setAttribute("aria-valuenow", String(boundedPercent));
  progressTrack.setAttribute("aria-valuetext", `${boundedPercent}% — ${message}`);
}

const mapViewer = setupMapViewer({
  onWarning(message) {
    setStatus("Map viewer", message, "error");
  },
  resolveMapData: generateMapData,
});
const lastMapRestore = mapViewer.restoreLastMap();

async function exportMapViewer(kind) {
  const map = mapViewer.getCurrentMap();
  if (map?.previewBlob && !map?.blob) {
    setStatus(
      "The map image is still encoding",
      "The viewer is ready, but the full-resolution image is still being written. Try again in a moment.",
      "error",
    );
    return;
  }
  if (!map?.blob || !map?.previewBlob) {
    setStatus("No map to export", "Generate or upload a map first.", "error");
    return;
  }
  if (!map.cells?.length) {
    setStatus(
      "Tile detail is unavailable",
      "Open viewer settings and generate the cell layout before exporting this map viewer.",
      "error",
    );
    return;
  }

  const exportButtons = [...downloadViewerOriginals, ...downloadViewerLocals];
  const activeButtons = kind === "local" ? downloadViewerLocals : downloadViewerOriginals;
  const originalLabels = activeButtons.map((button) => button.innerHTML);
  for (const button of exportButtons) button.disabled = true;
  for (const button of activeButtons) button.textContent = "Preparing…";
  for (const menu of downloadViewerMenus) menu.open = false;
  setStatus(
    "Preparing map viewer",
    kind === "local"
      ? "Collecting the map, viewer, and only the tile assets this world uses…"
      : "Embedding the map and viewer data into one HTML file…",
    "working",
    35,
  );

  try {
    if (kind === "local") {
      await downloadLocalViewer(map, (message, completed, total) => {
        const progress = total ? 35 + (completed / total) * 55 : 45;
        setStatus("Preparing self-hosted map viewer", message, "working", progress);
      });
      setStatus(
        "Self-hosted viewer downloaded",
        "Extract the ZIP and open index.html directly, or serve the folder from any static web host.",
        "done",
        100,
      );
    } else {
      await downloadOriginalViewer(map, (message, completed, total) => {
        const progress = total ? 35 + (completed / total) * 55 : 45;
        setStatus("Preparing standalone map viewer", message, "working", progress);
      });
      setStatus(
        "Map viewer downloaded",
        "Open the HTML file in a browser. Its tile detail uses the configured public asset source.",
        "done",
        100,
      );
    }
  } catch (error) {
    console.error(error);
    setStatus("Map viewer export failed", error?.message || String(error), "error");
  } finally {
    activeButtons.forEach((button, index) => { button.innerHTML = originalLabels[index]; });
    for (const button of exportButtons) button.disabled = false;
  }
}

for (const button of downloadViewerOriginals) {
  button.addEventListener("click", () => exportMapViewer("original"));
}
for (const button of downloadViewerLocals) {
  button.addEventListener("click", () => exportMapViewer("local"));
}

function showMapViewer() {
  if (!mapViewerElement.hidden) return;
  mapViewerElement.hidden = false;
  requestAnimationFrame(() => mapViewer.fitMap());
}

function setGenerating(generating) {
  form.dataset.generating = String(generating);
  seedInput.disabled = generating;
  sizeInput.disabled = generating;
  uploadButton.disabled = generating;
  generateButton.hidden = generating;
  cancelButton.hidden = !generating;
  // The viewer is revealed as soon as the preview image exists, which happens
  // well before the full-resolution download has finished encoding.
  if (generating) mapViewerElement.hidden = true;
  else showMapViewer();
}

function cleanSeed(value) {
  return value.replace(/\D/g, "").slice(0, 10);
}

function updateSeedUrl(seedText) {
  const url = new URL(window.location.href);
  if (seedText) url.searchParams.set("seed", seedText);
  else url.searchParams.delete("seed");
  history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
}

function initialSeedFromUrl() {
  const value = new URL(window.location.href).searchParams.get("seed");
  if (!value || !/^\d{1,10}$/.test(value)) return null;
  const seed = Number(value);
  return Number.isInteger(seed) && seed >= 0 && seed <= 4294967295 ? String(seed) : null;
}

seedInput.addEventListener("beforeinput", (event) => {
  if (!event.data || event.inputType.startsWith("delete")) return;
  if (!/^\d+$/.test(event.data)) event.preventDefault();
});

seedInput.addEventListener("input", () => {
  const cleaned = cleanSeed(seedInput.value);
  if (seedInput.value !== cleaned) seedInput.value = cleaned;
  updateSeedUrl(cleaned);
});

uploadButton.addEventListener("click", () => saveInput.click());

saveInput.addEventListener("change", async () => {
  const file = saveInput.files?.[0];
  if (!file) return;
  const previousSeed = seedInput.value;
  uploadButton.disabled = true;
  uploadButton.textContent = "Reading…";
  setStatus("Reading save file", `Finding the world seed in ${file.name}…`, "working", 25);
  try {
    const seed = await readScrapMechanicSeed(file);
    seedInput.value = String(seed);
    updateSeedUrl(seedInput.value);
    setStatus(
      `Seed ${seed} found`,
      `${file.name} is a valid Scrap Mechanic save. It is ready to generate.`,
      "done",
      100,
    );
  } catch (error) {
    console.error(error);
    seedInput.value = previousSeed;
    updateSeedUrl(previousSeed);
    setStatus(
      "Could not read that save",
      error instanceof InvalidSaveError
        ? "That is not a valid Scrap Mechanic .db save file."
        : "The save could not be read in this browser.",
      "error",
    );
  } finally {
    saveInput.value = "";
    uploadButton.disabled = false;
    uploadButton.textContent = "Upload save";
  }
});

function generateInWorker(seed, cellSize, signal, onProgress, onPreview) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./generator-worker.js", import.meta.url), { type: "module" });
    let rendererWorker = null;
    activeWorker = worker;
    let settled = false;

    const cleanup = () => {
      signal.removeEventListener("abort", handleAbort);
      worker.terminate();
      rendererWorker?.terminate();
      if (activeWorker === worker || activeWorker === rendererWorker) activeWorker = null;
    };
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const handleAbort = () => finish(reject, abortError());
    signal.addEventListener("abort", handleAbort, { once: true });

    worker.addEventListener("error", (event) => {
      finish(reject, new Error(event.message || "The background map generator stopped unexpectedly."));
    });
    worker.addEventListener("message", async (event) => {
      const message = event.data;
      if (message?.type === "progress") {
        onProgress(message.message, message.percent);
      } else if (message?.type === "result") {
        finish(resolve, message);
      } else if (message?.type === "cells") {
        // Release the Lua WebAssembly heap before allocating the large render
        // canvas. Keeping generation and rendering in separate workers lowers
        // the peak even when the browser cannot return WASM pages to the OS.
        worker.terminate();
        if (activeWorker === worker) activeWorker = null;
        if (typeof OffscreenCanvas !== "undefined") {
          const waitUntilVisible = () => new Promise((visibleResolve, visibleReject) => {
            if (!document.hidden) {
              visibleResolve();
              return;
            }
            onProgress("Tile decoding paused until this tab is active…", 34);
            const cleanupVisibility = () => {
              document.removeEventListener("visibilitychange", handleVisibility);
              signal.removeEventListener("abort", handleVisibilityAbort);
            };
            const handleVisibility = () => {
              if (document.hidden) return;
              cleanupVisibility();
              visibleResolve();
            };
            const handleVisibilityAbort = () => {
              cleanupVisibility();
              visibleReject(abortError());
            };
            document.addEventListener("visibilitychange", handleVisibility);
            signal.addEventListener("abort", handleVisibilityAbort, { once: true });
          });
          const startRenderer = (attempt = 0) => {
            if (settled || signal.aborted) return;
            rendererWorker = new Worker(new URL("./renderer-worker.js", import.meta.url), { type: "module" });
            activeWorker = rendererWorker;
            rendererWorker.addEventListener("error", (renderError) => {
              finish(reject, new Error(renderError.message || "The background map renderer stopped unexpectedly."));
            });
            rendererWorker.addEventListener("message", (renderEvent) => {
              const renderMessage = renderEvent.data;
              if (renderMessage?.type === "progress") {
                onProgress(renderMessage.message, renderMessage.percent);
              } else if (renderMessage?.type === "preview") {
                if (!settled && !signal.aborted) {
                  onPreview({ ...renderMessage, cells: message.cells, mapMarkers: message.mapMarkers });
                }
              } else if (renderMessage?.type === "result") {
                finish(resolve, { ...renderMessage, cells: message.cells, mapMarkers: message.mapMarkers });
              } else if (renderMessage?.type === "error") {
                if (renderMessage.code === "TILE_ASSET_LOAD_FAILED" && attempt < 1) {
                  rendererWorker.terminate();
                  if (activeWorker === rendererWorker) activeWorker = null;
                  waitUntilVisible().then(() => {
                    if (settled || signal.aborted) return;
                    onProgress("Retrying tile artwork after a temporary decoding failure…", 34);
                    startRenderer(attempt + 1);
                  }, (error) => finish(reject, error));
                  return;
                }
                const error = new Error(renderMessage.message || "Map rendering failed.");
                error.code = renderMessage.code;
                finish(reject, error);
              }
            });
            rendererWorker.postMessage({
              type: "render",
              cells: message.cells,
              cellSize,
              baseUrl: document.baseURI,
              seed,
            });
          };
          startRenderer();
          return;
        }

        // Older browsers without OffscreenCanvas still keep Lua generation
        // off the UI thread; only the final composition falls back here.
        try {
          const rendered = await composeMap(message.cells, cellSize, onProgress, {
            baseUrl: document.baseURI,
            signal,
            seed,
            onPreview: (preview) => onPreview({
              ...preview,
              seed,
              cells: message.cells,
              mapMarkers: message.mapMarkers,
            }),
          });
          finish(resolve, { ...rendered, seed, cells: message.cells, mapMarkers: message.mapMarkers });
        } catch (error) {
          finish(reject, error);
        }
      } else if (message?.type === "error") {
        finish(reject, new Error(message.message || "Map generation failed."));
      }
    });

    worker.postMessage({
      type: "generate",
      seed,
      cellSize,
      baseUrl: document.baseURI,
    });
  });
}

function generateMapData(seed) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./generator-worker.js", import.meta.url), { type: "module" });
    const cleanup = () => worker.terminate();
    worker.addEventListener("error", (event) => {
      cleanup();
      reject(new Error(event.message || "The marker generator stopped unexpectedly."));
    });
    worker.addEventListener("message", (event) => {
      if (event.data?.type === "markers") {
        cleanup();
        resolve({ cells: event.data.cells || [], mapMarkers: event.data.mapMarkers || [] });
      } else if (event.data?.type === "error") {
        cleanup();
        reject(new Error(event.data.message || "Map markers could not be generated."));
      }
    });
    worker.postMessage({ type: "generate-markers", seed, baseUrl: document.baseURI });
  });
}

cancelButton.addEventListener("click", () => {
  if (!activeController) return;
  setStatus(
    `Cancelling seed ${activeSeed}…`,
    "Stopping the background generator and releasing its map data.",
    "working",
    0,
  );
  activeWorker?.terminate();
  activeController.abort();
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const seedText = cleanSeed(seedInput.value);
  seedInput.value = seedText;
  updateSeedUrl(seedText);
  const seed = Number(seedText);
  const cellSize = Number(sizeInput.value);
  if (!seedText || !Number.isInteger(seed) || seed < 0 || seed > 4294967295) {
    setStatus(
      "A valid seed is required",
      "Enter a whole-number seed between 0 and 4,294,967,295, or upload a Scrap Mechanic save.",
      "error",
    );
    seedInput.focus();
    return;
  }

  const controller = new AbortController();
  await lastMapRestore;
  const suspendedMap = mapViewer.suspendMap();
  let generatedMap = false;
  activeController = controller;
  activeSeed = seed;
  setGenerating(true);
  missing.hidden = true;
  setStatus(
    `Generating seed ${seed}`,
    "Generating the map, this may take up to a few minutes…",
    "working",
    3,
  );

  try {
    const update = (message, percent) => {
      setStatus(`Generating seed ${seed}`, message, "working", percent);
    };
    // The viewer renders from the preview image, so the finished map is shown
    // and can be explored while the browser is still encoding the much larger
    // download image.
    const showPreview = (preview) => {
      mapViewer.showMapPreview(preview.previewBlob, `scrap-mechanic-ch2-${seed}.webp`, {
        details: { width: preview.width, height: preview.height },
        seed,
        cells: preview.cells,
        mapMarkers: preview.mapMarkers,
      });
      generatedMap = true;
      showMapViewer();
      if (preview.missing.length) {
        missing.hidden = false;
        missing.textContent = `${preview.missing.length} tile image${preview.missing.length === 1 ? " is" : "s are"} missing: ${preview.missing.join(", ")}`;
      }
    };
    const rendered = await generateInWorker(seed, cellSize, controller.signal, update, showPreview);
    controller.signal.throwIfAborted();
    await mapViewer.attachMapBlob(rendered.blob);
    setStatus(
      `Map generated from seed ${seed}`,
      "Finished entirely on your device. The map image is ready to download.",
      "done",
      100,
    );
  } catch (error) {
    if (error?.name === "AbortError") {
      setStatus(`Seed ${seed} cancelled`, "Nothing was uploaded or saved.", "cancelled");
    } else {
      console.error(error);
      setStatus("Map generation failed", error?.message || String(error), "error");
    }
  } finally {
    if (suspendedMap && !generatedMap) mapViewer.resumeMap();
    if (activeController === controller) {
      activeController = null;
      activeSeed = null;
      setGenerating(false);
    }
  }
});

const linkedSeed = initialSeedFromUrl();
if (linkedSeed !== null) {
  seedInput.value = linkedSeed;
  lastMapRestore.then(() => {
    const restoredSeed = mapViewer.getCurrentMap()?.seed;
    if (restoredSeed === Number(linkedSeed)) return;
    requestAnimationFrame(() => form.requestSubmit());
  });
}
