import "./style.css";
import { composeMap } from "./renderer.js";
import { setupMapViewer } from "./map-viewer.js";
import { InvalidSaveError, readScrapMechanicSeed } from "./save-reader.js";

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
  resolveMarkers: generateMapMarkers,
});
const lastMapRestore = mapViewer.restoreLastMap();

function setGenerating(generating) {
  form.dataset.generating = String(generating);
  seedInput.disabled = generating;
  sizeInput.disabled = generating;
  uploadButton.disabled = generating;
  generateButton.hidden = generating;
  cancelButton.hidden = !generating;
  mapViewerElement.hidden = generating;
  if (!generating) requestAnimationFrame(() => mapViewer.fitMap());
}

function cleanSeed(value) {
  const trimmed = value.trimStart();
  const negative = trimmed.startsWith("-");
  const digits = value.replace(/\D/g, "").slice(0, 10);
  return `${negative && digits ? "-" : ""}${digits}`;
}

seedInput.addEventListener("beforeinput", (event) => {
  if (!event.data || event.inputType.startsWith("delete")) return;
  const selectionStart = seedInput.selectionStart ?? seedInput.value.length;
  const selectionEnd = seedInput.selectionEnd ?? selectionStart;
  const replacingAll = selectionStart === 0 && selectionEnd === seedInput.value.length;
  const isLeadingMinus =
    event.data === "-" && selectionStart === 0 && (!seedInput.value.includes("-") || replacingAll);
  if (!/^\d+$/.test(event.data) && !isLeadingMinus) event.preventDefault();
});

seedInput.addEventListener("input", () => {
  const cleaned = cleanSeed(seedInput.value);
  if (seedInput.value !== cleaned) seedInput.value = cleaned;
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
    setStatus(
      `Seed ${seed} found`,
      `${file.name} is a valid Scrap Mechanic save. It is ready to generate.`,
      "done",
      100,
    );
  } catch (error) {
    console.error(error);
    seedInput.value = previousSeed;
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

function generateInWorker(seed, cellSize, signal, onProgress) {
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
          rendererWorker = new Worker(new URL("./renderer-worker.js", import.meta.url), { type: "module" });
          activeWorker = rendererWorker;
          rendererWorker.addEventListener("error", (renderError) => {
            finish(reject, new Error(renderError.message || "The background map renderer stopped unexpectedly."));
          });
          rendererWorker.addEventListener("message", (renderEvent) => {
            const renderMessage = renderEvent.data;
            if (renderMessage?.type === "progress") {
              onProgress(renderMessage.message, renderMessage.percent);
            } else if (renderMessage?.type === "result") {
              finish(resolve, { ...renderMessage, mapMarkers: message.mapMarkers });
            } else if (renderMessage?.type === "error") {
              finish(reject, new Error(renderMessage.message || "Map rendering failed."));
            }
          });
          rendererWorker.postMessage({
            type: "render",
            cells: message.cells,
            cellSize,
            baseUrl: document.baseURI,
            seed,
          });
          return;
        }

        // Older browsers without OffscreenCanvas still keep Lua generation
        // off the UI thread; only the final composition falls back here.
        try {
          const rendered = await composeMap(message.cells, cellSize, onProgress, {
            baseUrl: document.baseURI,
            signal,
            seed,
          });
          finish(resolve, { ...rendered, seed, mapMarkers: message.mapMarkers });
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

function generateMapMarkers(seed) {
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
        resolve(event.data.mapMarkers || []);
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
  const seed = Number(seedText);
  const cellSize = Number(sizeInput.value);
  if (!seedText || seedText === "-" || !Number.isInteger(seed) || seed < -2147483648 || seed > 2147483647) {
    setStatus(
      "A valid seed is required",
      "Enter a whole-number seed between -2,147,483,648 and 2,147,483,647, or upload a Scrap Mechanic save.",
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
    const rendered = await generateInWorker(seed, cellSize, controller.signal, update);
    controller.signal.throwIfAborted();
    await mapViewer.showMap(rendered.blob, `scrap-mechanic-ch2-${seed}.webp`, {
      seed,
      mapMarkers: rendered.mapMarkers,
    });
    generatedMap = true;
    if (rendered.missing.length) {
      missing.hidden = false;
      missing.textContent = `${rendered.missing.length} tile image${rendered.missing.length === 1 ? " is" : "s are"} missing: ${rendered.missing.join(", ")}`;
    }
    setStatus(
      `Map generated from seed ${seed}`,
      "Finished entirely on your device. The WebP is ready to download.",
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
