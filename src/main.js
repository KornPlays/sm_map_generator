import "./style.css";
import { composeMap, drawPreview } from "./renderer.js";
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
const result = document.querySelector("#result");
const preview = document.querySelector("#preview");
const download = document.querySelector("#download");
const dimensions = document.querySelector("#dimensions");
const missing = document.querySelector("#missing");

let downloadUrl = null;
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
  progressBar.style.width = `${Math.max(0, Math.min(100, percent))}%`;
}

function setGenerating(generating) {
  form.dataset.generating = String(generating);
  seedInput.disabled = generating;
  sizeInput.disabled = generating;
  uploadButton.disabled = generating;
  generateButton.hidden = generating;
  cancelButton.hidden = !generating;
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
    activeWorker = worker;
    let settled = false;

    const cleanup = () => {
      signal.removeEventListener("abort", handleAbort);
      worker.terminate();
      if (activeWorker === worker) activeWorker = null;
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
        // Older browsers without OffscreenCanvas still keep Lua generation
        // off the UI thread; only the final composition falls back here.
        cleanup();
        try {
          const rendered = await composeMap(message.cells, cellSize, onProgress, {
            baseUrl: document.baseURI,
            signal,
          });
          if (!settled) {
            settled = true;
            resolve(rendered);
          }
        } catch (error) {
          if (!settled) {
            settled = true;
            reject(error);
          }
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
  activeController = controller;
  activeSeed = seed;
  setGenerating(true);
  result.hidden = true;
  missing.hidden = true;
  if (downloadUrl) URL.revokeObjectURL(downloadUrl);
  downloadUrl = null;
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
    await drawPreview(rendered.blob, rendered.width, rendered.height, preview, controller.signal);
    downloadUrl = URL.createObjectURL(rendered.blob);
    download.href = downloadUrl;
    download.download = `scrap-mechanic-ch2-${seed}.webp`;
    dimensions.textContent = `${rendered.width.toLocaleString()} × ${rendered.height.toLocaleString()} · ${(rendered.blob.size / 1048576).toFixed(1)} MiB`;
    if (rendered.missing.length) {
      missing.hidden = false;
      missing.textContent = `${rendered.missing.length} tile image${rendered.missing.length === 1 ? " is" : "s are"} missing: ${rendered.missing.join(", ")}`;
    }
    result.hidden = false;
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
    if (activeController === controller) {
      activeController = null;
      activeSeed = null;
      setGenerating(false);
    }
  }
});
