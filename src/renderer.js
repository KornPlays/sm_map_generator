const BOUNDS = { xMin: -64, xMax: 63, yMin: -48, yMax: 47 };
const EXCAVATION_SPECIAL_UIDS = new Set([
  "ba31a522-7659-4ec5-b933-8b83960c57f2",
  "bf0ba240-416f-4f32-b87d-3a445919e72a",
]);

function defaultBaseUrl() {
  return typeof document === "undefined" ? self.location.href : document.baseURI;
}

function publicUrl(path, baseUrl) {
  return new URL(path, baseUrl);
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw new DOMException("Map generation was cancelled.", "AbortError");
}

async function yieldThread(signal) {
  throwIfAborted(signal);
  await new Promise((resolve) => {
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(resolve);
    else setTimeout(resolve, 0);
  });
  throwIfAborted(signal);
}

async function loadBitmap(path, cache, baseUrl, signal) {
  if (!cache.has(path)) {
    cache.set(
      path,
      (async () => {
        const response = await fetch(publicUrl(path, baseUrl), { signal });
        if (!response.ok) return null;
        return createImageBitmap(await response.blob());
      })(),
    );
  }
  return cache.get(path);
}

function position(x, y, cellSize) {
  return [(x - BOUNDS.xMin) * cellSize, (BOUNDS.yMax - y) * cellSize];
}

function drawRotated(context, image, x, y, pixels, turns) {
  context.save();
  context.translate(x + pixels / 2, y + pixels / 2);
  context.rotate((-turns * Math.PI) / 2);
  context.drawImage(image, -pixels / 2, -pixels / 2, pixels, pixels);
  context.restore();
}

function createCanvas(width, height) {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(width, height);
  if (typeof document !== "undefined") {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }
  throw new Error("This browser does not support map rendering in a background worker.");
}

function canvasBlob(canvas, type, quality) {
  if (typeof canvas.convertToBlob === "function") {
    return canvas.convertToBlob({ type, quality });
  }
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error(`This browser could not encode ${type}.`))),
      type,
      quality,
    );
  });
}

export async function composeMap(
  cells,
  cellSize,
  onProgress = () => {},
  { baseUrl = defaultBaseUrl(), signal } = {},
) {
  const width = (BOUNDS.xMax - BOUNDS.xMin + 1) * cellSize;
  const height = (BOUNDS.yMax - BOUNDS.yMin + 1) * cellSize;
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("Could not create the map canvas.");
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";

  const cache = new Map();
  const missing = new Set();
  try {
    context.fillStyle = "rgb(0, 186, 242)";
    context.fillRect(0, 0, width, height);

    onProgress("Preparing water and terrain artwork…", 36);
    const lakeCounts = new Map();
    for (const cell of cells) {
      if (cell.size === 1 && cell.terrainType === 8) {
        lakeCounts.set(cell.uid, (lakeCounts.get(cell.uid) ?? 0) + 1);
      }
    }
    const rankedLakes = [...lakeCounts.entries()].sort((left, right) => right[1] - left[1]);
    let ocean = null;
    for (const [uid] of rankedLakes) {
      ocean = await loadBitmap(`assets/tiles/${uid}.webp`, cache, baseUrl, signal);
      if (ocean) break;
    }
    if (ocean) {
      const oceanRows = Math.ceil(height / cellSize);
      for (let row = 0, y = 0; y < height; row += 1, y += cellSize) {
        for (let x = 0; x < width; x += cellSize) {
          context.drawImage(ocean, x, y, cellSize, cellSize);
        }
        if (row % 12 === 0) {
          onProgress(`Painting the ocean… ${Math.min(row + 1, oceanRows)} / ${oceanRows} rows`, 38);
          await yieldThread(signal);
        }
      }
    }

    const excavation = await loadBitmap("assets/excavation_island_special.webp", cache, baseUrl, signal);
    if (excavation) {
      const [x, y] = position(32, 47, cellSize);
      context.drawImage(excavation, x, y, 32 * cellSize, 32 * cellSize);
    }

    const singleCells = cells.filter((cell) => cell.size === 1);
    onProgress(`Drawing terrain tiles… 0 / ${singleCells.length.toLocaleString()}`, 42);
    for (let index = 0; index < singleCells.length; index += 1) {
      const cell = singleCells[index];
      const image = await loadBitmap(`assets/tiles/${cell.uid}.webp`, cache, baseUrl, signal);
      if (image) {
        const [x, y] = position(cell.x, cell.y, cellSize);
        drawRotated(context, image, x, y, cellSize, cell.rotation);
      } else {
        missing.add(cell.uid);
      }
      if (index % 300 === 0) {
        const finished = index + 1;
        const percent = 42 + Math.round((finished / singleCells.length) * 36);
        onProgress(
          `Drawing terrain tiles… ${finished.toLocaleString()} / ${singleCells.length.toLocaleString()}`,
          percent,
        );
        await yieldThread(signal);
      }
    }

    onProgress("Placing landmarks and multi-cell terrain…", 80);
    const groups = new Map();
    for (const cell of cells) {
      if (cell.size <= 1) continue;
      const key = `${cell.group}:${cell.uid}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(cell);
    }
    let groupIndex = 0;
    for (const members of groups.values()) {
      const { uid, size, rotation } = members[0];
      // The calibrated 32x32 excavation image replaces these two raw 16x16
      // source captures. They are stitching inputs, not standalone overlays.
      if (!EXCAVATION_SPECIAL_UIDS.has(uid)) {
        const image = await loadBitmap(`assets/${uid}.webp`, cache, baseUrl, signal);
        if (!image) {
          missing.add(uid);
        } else {
          const originX = Math.min(...members.map((cell) => cell.x));
          const originY = Math.min(...members.map((cell) => cell.y));
          const [x, y] = position(originX, originY + size - 1, cellSize);
          drawRotated(context, image, x, y, size * cellSize, rotation);
        }
      }
      groupIndex += 1;
      if (groupIndex % 30 === 0) await yieldThread(signal);
    }

    onProgress("Encoding the downloadable WebP image…", 90);
    await yieldThread(signal);
    const blob = await canvasBlob(canvas, "image/webp", 0.92);
    throwIfAborted(signal);
    onProgress("Finishing the preview…", 97);
    return { blob, width, height, missing: [...missing].sort() };
  } finally {
    canvas.width = 1;
    canvas.height = 1;
    const bitmaps = await Promise.allSettled(cache.values());
    for (const result of bitmaps) {
      if (result.status === "fulfilled") result.value?.close?.();
    }
  }
}

export async function drawPreview(blob, width, height, previewCanvas, signal) {
  throwIfAborted(signal);
  const bitmap = await createImageBitmap(blob);
  try {
    throwIfAborted(signal);
    const previewScale = Math.min(1, 1600 / width);
    previewCanvas.width = Math.round(width * previewScale);
    previewCanvas.height = Math.round(height * previewScale);
    const preview = previewCanvas.getContext("2d", { alpha: false });
    if (!preview) throw new Error("Could not create the map preview canvas.");
    preview.imageSmoothingEnabled = true;
    preview.imageSmoothingQuality = "high";
    preview.drawImage(bitmap, 0, 0, previewCanvas.width, previewCanvas.height);
  } finally {
    bitmap.close?.();
  }
}
