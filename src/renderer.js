import { embedWebPMapData } from "./webp-seed.js";
import { GENERATOR_ASSET_SOURCE, TILE_ASSET_REVISION } from "./asset-config.js";
import { EXCAVATION_COMPOSITE_UIDS } from "./excavation-assets.js";
import { drawSeedBarcode, seedBarcodeMetrics } from "./seed-barcode.js";

const BOUNDS = { xMin: -64, xMax: 63, yMin: -48, yMax: 47 };
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

// Yielding exists to keep the page interactive while the fallback path composes
// the map on the UI thread. Inside a worker there is no UI to unblock, and the
// wait is actively harmful: browsers clamp worker timers to roughly one second
// once the tab is hidden, so a backgrounded render used to spend minutes parked
// in these gaps. Cancellation there terminates the worker outright.
const composingOnUiThread = typeof document !== "undefined";

// How often the draw loop hands the thread back. "fast" is for renders the user
// is waiting on; "gentle" is for the exported viewer upgrading its map in the
// background, where tile-detail decoding is competing for the same thread and
// staying smooth matters more than finishing early.
const PACE_BATCHES = { fast: 8, gentle: 2 };
const PACE_REST_MS = { fast: 0, gentle: 26 };

// A hidden tab runs no animation frames and clamps timers to about a second, so
// both of the obvious ways to hand back the thread stall a background render.
// A message port task is exempt from that throttling, which keeps the render
// moving while the tab is away — and there is no UI to be considerate towards
// then either, so the gentle pace drops its rest.
let yieldPort = null;
function messageTask() {
  return new Promise((resolve) => {
    if (!yieldPort) yieldPort = new MessageChannel();
    yieldPort.port1.onmessage = () => resolve();
    yieldPort.port2.postMessage(0);
  });
}

async function yieldThread(signal, pace = "fast") {
  throwIfAborted(signal);
  if (!composingOnUiThread) return;
  const rest = PACE_REST_MS[pace] ?? 0;
  const hidden = typeof document !== "undefined" && document.hidden;
  if (hidden || typeof MessageChannel === "undefined") {
    if (hidden) await messageTask();
    else await new Promise((resolve) => setTimeout(resolve, rest));
  } else if (rest) {
    await new Promise((resolve) => setTimeout(resolve, rest));
  } else if (typeof requestAnimationFrame === "function") {
    await new Promise((resolve) => requestAnimationFrame(resolve));
  } else {
    await messageTask();
  }
  throwIfAborted(signal);
}

// Tile artwork is fetched and decoded ahead of the draw that consumes it, so one
// tile's network round trip overlaps the decode and blit of its predecessors.
// The window is bounded to keep peak memory at a handful of bitmaps rather than
// the whole library, which matters next to a canvas that can reach 500 MB.
const PREFETCH_WINDOW = 12;

function prefetchQueue(count, load) {
  const pending = new Map();
  const start = (index) => {
    if (index >= count || pending.has(index)) return;
    const promise = load(index);
    // Mark the rejection handled so a failure several tiles ahead of the draw
    // cursor does not surface as an unhandled rejection. Awaiting the stored
    // promise still throws.
    promise.catch(() => {});
    pending.set(index, promise);
  };
  for (let index = 0; index < Math.min(PREFETCH_WINDOW, count); index += 1) start(index);
  return (index) => {
    const promise = pending.get(index);
    pending.delete(index);
    start(index + PREFETCH_WINDOW);
    return promise;
  };
}

function delay(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(resolve, milliseconds);
    signal?.addEventListener("abort", () => {
      clearTimeout(timeout);
      reject(new DOMException("Map generation was cancelled.", "AbortError"));
    }, { once: true });
  });
}

function tileLoadError(url, cause) {
  const error = new Error(`The tile image could not be decoded: ${url.href}`, { cause });
  error.name = "TileAssetError";
  error.code = "TILE_ASSET_LOAD_FAILED";
  return error;
}

// Which tiles a world needs is only known once its cells exist, but the whole
// tier is a few megabytes and any world uses most of it. Fetching it while the
// Lua pass is still running takes the tile downloads off the critical path: by
// the time the cells arrive the artwork is already in hand.
const warmedTiles = new Map();

export function prewarmTiles(cellSize, {
  baseUrl = defaultBaseUrl(),
  assetSource = GENERATOR_ASSET_SOURCE,
  concurrency = 12,
} = {}) {
  const tier = cellSize <= 50 ? 50 : cellSize <= 100 ? 100 : 200;
  return (async () => {
    let metadata;
    try {
      const response = await fetch(publicUrl("runtime/data/tile_metadata.json", baseUrl));
      if (!response.ok) return;
      metadata = await response.json();
    } catch {
      return;
    }
    const paths = new Set(["excavation_island_special.webp"]);
    for (const entry of Object.values(metadata)) {
      if (!entry?.uid) continue;
      paths.add(entry.size > 1 ? `${entry.uid}.webp` : `tiles/${entry.uid}.webp`);
    }
    const list = [...paths].map((path) => `${assetSource}detail/${tier}/${path}`);
    let next = 0;
    const pump = async () => {
      while (next < list.length) {
        const path = list[next];
        next += 1;
        const url = publicUrl(path, baseUrl);
        url.searchParams.set("v", TILE_ASSET_REVISION);
        const pending = (async () => {
          try {
            // Tile responses are immutable and revisioned, so the browser's
            // native HTTP cache is both safe and much faster than an extra
            // Cache Storage lookup/read for every individual image.
            const response = await fetch(url, { cache: "force-cache" });
            if (!response.ok) return null;
            const contentType = response.headers.get("content-type") || "";
            if (contentType.toLowerCase().includes("text/html")) return null;
            const blob = await response.blob();
            if (!blob.size) return null;
            return blob;
          } catch {
            // A warm-up miss is harmless: the render fetches it the usual way.
            return null;
          }
        })();
        warmedTiles.set(path, pending);
        await pending;
      }
    };
    await Promise.all(Array.from({ length: concurrency }, pump));
  })();
}

function releaseWarmedTiles() {
  warmedTiles.clear();
}

async function loadBitmap(path, baseUrl, signal) {
  const warmed = warmedTiles.get(path);
  if (warmed) {
    warmedTiles.delete(path);
    const blob = await warmed;
    if (blob) return await createImageBitmap(blob);
  }
  const url = publicUrl(path, baseUrl);
  url.searchParams.set("v", TILE_ASSET_REVISION);

  const retryDelays = [0, 80, 250, 750];
  let lastError = null;
  for (let attempt = 0; attempt < retryDelays.length; attempt += 1) {
    if (retryDelays[attempt]) await delay(retryDelays[attempt], signal);
    throwIfAborted(signal);
    try {
      const response = await fetch(url, { signal, cache: attempt ? "reload" : "force-cache" });
      if (response.status === 404 || response.status === 410) return null;
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const contentType = response.headers.get("content-type") || "";
      if (contentType.toLowerCase().includes("text/html")) return null;
      const blob = await response.blob();
      if (!blob.size) throw new Error("The response was empty.");
      return await createImageBitmap(blob);
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      lastError = error;
    }
  }
  throw tileLoadError(url, lastError);
}

function position(x, y, cellSize) {
  return [(x - BOUNDS.xMin) * cellSize, (BOUNDS.yMax - y) * cellSize];
}

// Quarter turns, so the matrix entries are exactly 0 and ±1 rather than the
// 6e-17 that cos/sin return for π/2. Setting the matrix outright also skips the
// save/restore pair, which matters across the ~12,000 tiles a map draws.
const QUARTER_TURNS = [[1, 0], [0, -1], [-1, 0], [0, 1]];

// Smoothing is only meaningful when the artwork is being rescaled. Where a tile
// lands on the canvas at its own size — every tile at 50 and 100 px/cell, since
// the source tier is chosen to match — the sample points sit exactly on source
// texels and filtering is a no-op that costs about 3x the blit time. Verified
// pixel-identical for 1:1 draws at all four rotations.
function setScaleFiltering(context, sourcePixels, destinationPixels) {
  const rescaling = sourcePixels !== destinationPixels;
  context.imageSmoothingEnabled = rescaling;
  if (rescaling) context.imageSmoothingQuality = "high";
}

function drawRotated(context, image, x, y, pixels, turns) {
  const turn = turns & 3;
  if (turn === 0) {
    context.drawImage(image, x, y, pixels, pixels);
    return;
  }
  const [cos, sin] = QUARTER_TURNS[turn];
  const half = pixels / 2;
  context.setTransform(cos, sin, -sin, cos, x + half, y + half);
  context.drawImage(image, -half, -half, pixels, pixels);
  context.setTransform(1, 0, 0, 1, 0, 0);
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
  const paddingX = Math.max(3, Math.round(cellSize * 0.18));
  const paddingY = Math.max(2, Math.round(cellSize * 0.12));
  context.save();
  context.font = `700 ${fontSize}px ui-monospace, SFMono-Regular, Consolas, monospace`;
  context.textBaseline = "middle";
  const textWidth = context.measureText(label).width;
  const barcode = seedBarcodeMetrics(width, height, cellSize);
  const boxWidth = Math.ceil(Math.max(textWidth, barcode.width) + paddingX * 2);
  const boxHeight = Math.ceil(fontSize + paddingY * 2 + barcode.height + paddingY);
  const x = barcode.x - paddingX;
  const y = barcode.y - paddingY - fontSize - paddingY;
  context.fillStyle = "rgba(8, 12, 9, 0.82)";
  context.fillRect(x, y, boxWidth, boxHeight);
  drawSeedBarcode(context, width, height, cellSize, seed);
  context.fillStyle = "rgba(244, 242, 233, 0.96)";
  context.fillText(label, barcode.x, y + paddingY + fontSize / 2);
  context.restore();
}

export async function composeMap(
  cells,
  cellSize,
  onProgress = () => {},
  {
    baseUrl = defaultBaseUrl(),
    signal,
    seed = null,
    onPreview = () => {},
    // Handed the downscaled pixels before they are encoded. Displaying those
    // costs about 5 ms where the WebP encode costs ~750 ms, and they are the
    // very same pixels, so the page can paint the finished map that much sooner.
    onPreviewBitmap = null,
    assetSource = GENERATOR_ASSET_SOURCE,
    // Either a pace name or a function returning one, so a long background
    // render can speed up or ease off as the viewer's settings change under it.
    pace = "fast",
    // The exported viewer already has a display image and only needs the
    // full-resolution one, so it skips the second encode entirely.
    preview = true,
    // Lowered only for the stand-in picture the exported viewer embeds, which is
    // displayed at half its own resolution and is never the real download.
    // The source captures are already WebP quality 85. Encoding the assembled
    // map at the same quality avoids spending most of the render time chasing
    // detail that no longer exists in the input tiles.
    quality = 0.85,
  } = {},
) {
  const currentPace = () => (typeof pace === "function" ? pace() : pace) || "fast";
  const width = (BOUNDS.xMax - BOUNDS.xMin + 1) * cellSize;
  const height = (BOUNDS.yMax - BOUNDS.yMin + 1) * cellSize;
  // Every tier is derived from the same 200 px capture library. Matching the
  // source tier to the output avoids decoding 200 px artwork for a 25/50 px map.
  const renderTier = cellSize <= 50 ? 50 : cellSize <= 100 ? 100 : 200;
  let activeRenderTier = renderTier;
  const fallbackTiers = [...new Set([renderTier, 200, 100, 50])];
  const assetPath = (tier, path) => `${assetSource}detail/${tier}/${path}`;
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("Could not create the map canvas.");
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";

  const missing = new Set();
  const openBitmaps = new Set();
  // Prefetching means decodes can still land after the run has been torn down by
  // an error or a cancellation. Those late arrivals are closed on the spot
  // rather than being added to a set nothing will drain again.
  let disposed = false;
  const openBitmap = async (path, selectWorkingTier = false) => {
    const tiers = [...new Set([activeRenderTier, ...fallbackTiers])];
    for (const tier of tiers) {
      const bitmap = await loadBitmap(assetPath(tier, path), baseUrl, signal);
      if (!bitmap) continue;
      if (disposed) {
        bitmap.close?.();
        return null;
      }
      if (selectWorkingTier) activeRenderTier = tier;
      openBitmaps.add(bitmap);
      return bitmap;
    }
    // Compatibility with deployments made before the 50/100/200 directories
    // were introduced. It also prevents a partially updated host from yielding
    // a completely blue map.
    const legacy = await loadBitmap(`${assetSource}${path}`, baseUrl, signal);
    if (legacy && disposed) {
      legacy.close?.();
      return null;
    }
    if (legacy) openBitmaps.add(legacy);
    return legacy;
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
      ocean = await openBitmap(`tiles/${uid}.webp`, true);
      if (ocean) {
        oceanUid = uid;
        break;
      }
    }
    if (!ocean) {
      const error = new Error("The map's tile artwork could not be loaded. Rendering will be retried.");
      error.code = "TILE_ASSET_LOAD_FAILED";
      throw error;
    }
    if (ocean) {
      onProgress("Painting the ocean…", 45);
      const tileCanvas = createCanvas(cellSize, cellSize);
      const tileContext = tileCanvas.getContext("2d", { alpha: false });
      setScaleFiltering(tileContext, ocean.width, cellSize);
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

    const excavation = await openBitmap("excavation_island_special.webp");
    if (excavation) {
      const [x, y] = position(32, 47, cellSize);
      setScaleFiltering(context, excavation.width, 32 * cellSize);
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
    onProgress(`Drawing terrain tiles… 0 / ${terrainTotal.toLocaleString()}`, 48);
    const takeTerrain = prefetchQueue(terrainEntries.length, (index) => {
      const uid = terrainEntries[index][0];
      return uid === oceanUid ? Promise.resolve(ocean) : openBitmap(`tiles/${uid}.webp`);
    });
    for (let index = 0; index < terrainEntries.length; index += 1) {
      const [uid, members] = terrainEntries[index];
      const image = await takeTerrain(index);
      // Both tests are constant across the group, so they are lifted out of the
      // per-cell loop that runs about 12,000 times per map.
      const oceanGroup = uid === oceanUid;
      if (!image) missing.add(uid);
      else setScaleFiltering(context, image.width, cellSize);
      for (const cell of members) {
        if (oceanGroup && !isInsideExcavationComposite(cell)) continue;
        if (image) {
          drawRotated(
            context,
            image,
            (cell.x - BOUNDS.xMin) * cellSize,
            (BOUNDS.yMax - cell.y) * cellSize,
            cellSize,
            cell.rotation,
          );
        }
        terrainFinished += 1;
      }
      if (image !== ocean) closeBitmap(image);
      const activePace = currentPace();
      const batchSize = PACE_BATCHES[activePace] ?? PACE_BATCHES.fast;
      if (index % batchSize === batchSize - 1 || index === terrainEntries.length - 1) {
        const percent = 48 + Math.round((terrainFinished / terrainTotal) * 33);
        onProgress(
          `Drawing terrain tiles… ${terrainFinished.toLocaleString()} / ${terrainTotal.toLocaleString()}`,
          percent,
        );
        await yieldThread(signal, activePace);
      }
    }
    closeBitmap(ocean);

    onProgress("Placing landmarks and multi-cell terrain…", 82);
    // The calibrated 32x32 excavation image already contains the raw island
    // halves and its correctly cropped bridge. Those source captures are
    // stitching inputs, not standalone overlays.
    const multiGroupList = [...multiGroups.values()].filter(
      (members) => !EXCAVATION_COMPOSITE_UIDS.has(members[0].uid),
    );
    // Landmarks repeat the same artwork across many placements, and the groups
    // must still be painted in cell order because a later tile may overlap an
    // earlier one. Decoding each distinct image once and drawing from that cache
    // keeps the order intact while removing the duplicate fetches and decodes.
    const landmarkImages = new Map();
    const landmarkUids = [...new Set(multiGroupList.map((members) => members[0].uid))];
    const takeLandmark = prefetchQueue(
      landmarkUids.length,
      (index) => openBitmap(`${landmarkUids[index]}.webp`),
    );
    for (let index = 0; index < landmarkUids.length; index += 1) {
      const image = await takeLandmark(index);
      if (image) landmarkImages.set(landmarkUids[index], image);
      else missing.add(landmarkUids[index]);
    }
    let groupIndex = 0;
    for (const members of multiGroupList) {
      const { uid, size, rotation } = members[0];
      const image = landmarkImages.get(uid);
      if (image) {
        setScaleFiltering(context, image.width, size * cellSize);
        const originX = Number.isFinite(members[0].originX)
          ? members[0].originX
          : Math.min(...members.map((cell) => cell.x));
        const originY = Number.isFinite(members[0].originY)
          ? members[0].originY
          : Math.min(...members.map((cell) => cell.y));
        const [x, y] = position(originX, originY + size - 1, cellSize);
        drawRotated(context, image, x, y, size * cellSize, rotation);
      }
      groupIndex += 1;
      if (groupIndex % 30 === 0) await yieldThread(signal, currentPace());
    }
    for (const image of landmarkImages.values()) closeBitmap(image);

    const expectedAssets = singleGroups.size + [...multiGroups.values()].filter(
      (members) => !EXCAVATION_COMPOSITE_UIDS.has(members[0].uid),
    ).length;
    const missingLimit = Math.max(8, Math.ceil(expectedAssets * 0.05));
    if (missing.size >= missingLimit) {
      const error = new Error(
        `${missing.size} tile images failed to load. The incomplete map was discarded and rendering will be retried.`,
      );
      error.code = "TILE_ASSET_LOAD_FAILED";
      throw error;
    }

    const missingAssets = [...missing].sort();
    drawSeedStamp(context, width, height, cellSize, seed);
    onProgress("Encoding the map image…", 86);
    await yieldThread(signal, currentPace());
    // Encoding cost scales with pixel count: the viewer-sized image takes a
    // couple of seconds while the full-resolution one takes tens of seconds at
    // 100 px/cell. Browsers run canvas encodes on a single background thread and
    // serve them in order, so the small one is encoded and handed over first —
    // the viewer only ever renders the preview, which lets the map be explored
    // while the download image is still being written.
    let previewBlob = null;
    if (preview) {
      const previewCanvas = createCanvas(128 * 25, 96 * 25);
      const previewContext = previewCanvas.getContext("2d", { alpha: false });
      previewContext.imageSmoothingEnabled = true;
      previewContext.imageSmoothingQuality = "high";
      previewContext.drawImage(canvas, 0, 0, previewCanvas.width, previewCanvas.height);
      if (onPreviewBitmap) {
        // transferToImageBitmap hands the pixels over without copying them, but
        // leaves the canvas blank, so the encode below needs them drawn again.
        // That repaint costs far less than the copy and happens after the page
        // already has the picture.
        const transferable = typeof previewCanvas.transferToImageBitmap === "function";
        const bitmap = transferable
          ? previewCanvas.transferToImageBitmap()
          : await createImageBitmap(previewCanvas);
        throwIfAborted(signal);
        await onPreviewBitmap({ bitmap, width, height, missing: missingAssets });
        if (transferable) {
          setScaleFiltering(previewContext, width, previewCanvas.width);
          previewContext.drawImage(canvas, 0, 0, previewCanvas.width, previewCanvas.height);
        }
      }
      previewBlob = await canvasBlob(previewCanvas, "image/webp", 0.88);
      previewCanvas.width = 1;
      previewCanvas.height = 1;
      throwIfAborted(signal);
      await onPreview({ previewBlob, width, height, missing: missingAssets });
    }

    onProgress("Encoding the full-resolution download…", 92);
    const encoded = await canvasBlob(canvas, "image/webp", quality);
    const blob = await embedWebPMapData(encoded, {
      seed,
      width,
      height,
      cells,
      previewBlob,
    });
    throwIfAborted(signal);
    onProgress("Finishing the download image…", 99);
    return { blob, previewBlob, width, height, missing: missingAssets };
  } finally {
    disposed = true;
    releaseWarmedTiles();
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
