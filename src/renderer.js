import { embedWebPSeed } from "./webp-seed.js";

const BOUNDS = { xMin: -64, xMax: 63, yMin: -48, yMax: 47 };
const EXCAVATION_SPECIAL_UIDS = new Set([
  "ba31a522-7659-4ec5-b933-8b83960c57f2",
  "bf0ba240-416f-4f32-b87d-3a445919e72a",
]);
const EXCAVATION_BOUNDS = { xMin: 32, xMax: 63, yMin: 16, yMax: 47 };

function isInsideExcavationComposite(cell) {
  return cell.x >= EXCAVATION_BOUNDS.xMin && cell.x <= EXCAVATION_BOUNDS.xMax
    && cell.y >= EXCAVATION_BOUNDS.yMin && cell.y <= EXCAVATION_BOUNDS.yMax;
}

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

async function loadBitmap(path, baseUrl, signal) {
  const response = await fetch(publicUrl(path, baseUrl), { signal });
  if (!response.ok) return null;
  return createImageBitmap(await response.blob());
}

function position(x, y, cellSize) {
  return [(x - BOUNDS.xMin) * cellSize, (BOUNDS.yMax - y) * cellSize];
}

function drawRotated(context, image, x, y, pixels, turns) {
  if ((turns & 3) === 0) {
    context.drawImage(image, x, y, pixels, pixels);
    return;
  }
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

function drawSeedStamp(context, width, height, cellSize, seed) {
  if (!Number.isInteger(seed)) return;
  const label = `Seed ${seed}`;
  const fontSize = Math.max(14, Math.round(cellSize * 0.75));
  const paddingX = Math.max(6, Math.round(cellSize * 0.18));
  const paddingY = Math.max(4, Math.round(cellSize * 0.12));
  const margin = Math.max(6, Math.round(cellSize * 0.16));
  context.save();
  context.font = `700 ${fontSize}px ui-monospace, SFMono-Regular, Consolas, monospace`;
  context.textBaseline = "middle";
  const textWidth = context.measureText(label).width;
  const boxWidth = Math.ceil(textWidth + paddingX * 2);
  const boxHeight = Math.ceil(fontSize + paddingY * 2);
  const x = margin;
  const y = height - boxHeight - margin;
  context.fillStyle = "rgba(8, 12, 9, 0.82)";
  context.fillRect(x, y, boxWidth, boxHeight);
  context.fillStyle = "rgba(244, 242, 233, 0.96)";
  context.fillText(label, x + paddingX, y + boxHeight / 2);
  context.restore();
}

export async function composeMap(
  cells,
  cellSize,
  onProgress = () => {},
  { baseUrl = defaultBaseUrl(), signal, seed = null } = {},
) {
  const width = (BOUNDS.xMax - BOUNDS.xMin + 1) * cellSize;
  const height = (BOUNDS.yMax - BOUNDS.yMin + 1) * cellSize;
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("Could not create the map canvas.");
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";

  const missing = new Set();
  const openBitmaps = new Set();
  const openBitmap = async (path) => {
    const bitmap = await loadBitmap(path, baseUrl, signal);
    if (bitmap) openBitmaps.add(bitmap);
    return bitmap;
  };
  const closeBitmap = (bitmap) => {
    if (!bitmap) return;
    openBitmaps.delete(bitmap);
    bitmap.close?.();
  };
  try {
    context.fillStyle = "rgb(0, 186, 242)";
    context.fillRect(0, 0, width, height);

    onProgress("Preparing map artwork…", 33);
    const singleGroups = new Map();
    const multiGroups = new Map();
    const lakeCounts = new Map();
    for (const cell of cells) {
      if (cell.size === 1) {
        if (!singleGroups.has(cell.uid)) singleGroups.set(cell.uid, []);
        singleGroups.get(cell.uid).push(cell);
        if (cell.terrainType === 8) {
          lakeCounts.set(cell.uid, (lakeCounts.get(cell.uid) ?? 0) + 1);
        }
      } else {
        const key = `${cell.group}:${cell.uid}`;
        if (!multiGroups.has(key)) multiGroups.set(key, []);
        multiGroups.get(key).push(cell);
      }
    }
    const rankedLakes = [...lakeCounts.entries()].sort((left, right) => right[1] - left[1]);

    let ocean = null;
    let oceanUid = null;
    for (const [uid] of rankedLakes) {
      ocean = await openBitmap(`assets/tiles/${uid}.webp`);
      if (ocean) {
        oceanUid = uid;
        break;
      }
    }
    if (ocean) {
      onProgress("Painting the ocean…", 45);
      const tileCanvas = createCanvas(cellSize, cellSize);
      const tileContext = tileCanvas.getContext("2d", { alpha: false });
      tileContext.imageSmoothingEnabled = true;
      tileContext.imageSmoothingQuality = "high";
      tileContext.drawImage(ocean, 0, 0, cellSize, cellSize);
      const pattern = context.createPattern(tileCanvas, "repeat");
      if (pattern) {
        context.fillStyle = pattern;
        context.fillRect(0, 0, width, height);
      } else {
        for (let y = 0; y < height; y += cellSize) {
          for (let x = 0; x < width; x += cellSize) context.drawImage(ocean, x, y, cellSize, cellSize);
        }
      }
      tileCanvas.width = 1;
      tileCanvas.height = 1;
    }

    const excavation = await openBitmap("assets/excavation_island_special.webp");
    if (excavation) {
      const [x, y] = position(32, 47, cellSize);
      context.drawImage(excavation, x, y, 32 * cellSize, 32 * cellSize);
    }
    closeBitmap(excavation);

    // The ocean pattern already covers ordinary water cells. Water inside the
    // 32x32 excavation composite must still be repainted afterward, because
    // those cells intentionally mask parts of the calibrated island image.
    let terrainTotal = 0;
    for (const [uid, members] of singleGroups) {
      if (uid !== oceanUid) terrainTotal += members.length;
      else for (const cell of members) terrainTotal += Number(isInsideExcavationComposite(cell));
    }
    let terrainFinished = 0;
    const terrainEntries = [...singleGroups.entries()];
    const terrainBatchSize = 4;
    onProgress(`Drawing terrain tiles… 0 / ${terrainTotal.toLocaleString()}`, 48);
    for (let offset = 0; offset < terrainEntries.length; offset += terrainBatchSize) {
      const batch = terrainEntries.slice(offset, offset + terrainBatchSize);
      const images = await Promise.all(batch.map(([uid]) => (
        uid === oceanUid ? ocean : openBitmap(`assets/tiles/${uid}.webp`)
      )));
      for (let batchIndex = 0; batchIndex < batch.length; batchIndex += 1) {
        const [uid, members] = batch[batchIndex];
        const image = images[batchIndex];
        for (const cell of members) {
          if (uid === oceanUid && !isInsideExcavationComposite(cell)) continue;
          if (image) {
            const [x, y] = position(cell.x, cell.y, cellSize);
            drawRotated(context, image, x, y, cellSize, cell.rotation);
          } else {
            missing.add(uid);
          }
          terrainFinished += 1;
        }
        if (image !== ocean) closeBitmap(image);
      }
      const percent = 48 + Math.round((terrainFinished / terrainTotal) * 33);
      onProgress(
        `Drawing terrain tiles… ${terrainFinished.toLocaleString()} / ${terrainTotal.toLocaleString()}`,
        percent,
      );
      await yieldThread(signal);
    }
    closeBitmap(ocean);

    onProgress("Placing landmarks and multi-cell terrain…", 82);
    let groupIndex = 0;
    for (const members of multiGroups.values()) {
      const { uid, size, rotation } = members[0];
      // The calibrated 32x32 excavation image replaces these two raw 16x16
      // source captures. They are stitching inputs, not standalone overlays.
      if (!EXCAVATION_SPECIAL_UIDS.has(uid)) {
        const image = missing.has(uid) ? null : await openBitmap(`assets/${uid}.webp`);
        if (!image) {
          missing.add(uid);
        } else {
          const originX = Math.min(...members.map((cell) => cell.x));
          const originY = Math.min(...members.map((cell) => cell.y));
          const [x, y] = position(originX, originY + size - 1, cellSize);
          drawRotated(context, image, x, y, size * cellSize, rotation);
        }
        closeBitmap(image);
      }
      groupIndex += 1;
      if (groupIndex % 30 === 0) await yieldThread(signal);
    }

    drawSeedStamp(context, width, height, cellSize, seed);
    onProgress("Encoding the downloadable WebP image…", 90);
    await yieldThread(signal);
    const encoded = await canvasBlob(canvas, "image/webp", 0.92);
    const blob = Number.isInteger(seed) ? await embedWebPSeed(encoded, seed, width, height) : encoded;
    throwIfAborted(signal);
    onProgress("Finishing the preview…", 97);
    return { blob, width, height, missing: [...missing].sort() };
  } finally {
    canvas.width = 1;
    canvas.height = 1;
    for (const bitmap of openBitmaps) bitmap.close?.();
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
