import { GENERATOR_ASSET_SOURCE, tileAssetUrl, TILE_ASSET_REVISION } from "./asset-config.js";
import { EXCAVATION_COMPOSITE_UIDS, excavationDetailPlacements } from "./excavation-assets.js";

const BASE_CELL_PX = 25;
const MAX_DECODED_TILES = 192;
const PERSISTENT_CACHE = `sm-map-tiles-${TILE_ASSET_REVISION}`;
const X_MIN = -64;
const Y_MAX = 47;
const EXCAVATION_DETAIL_PLACEMENTS = excavationDetailPlacements();
const THRESHOLDS = {
  low: [[200, 200], [100, 100], [50, 50]],
  medium: [[150, 200], [75, 100], [38, 50]],
  high: [[100, 200], [50, 100], [25, 50]],
};

function detailTier(mode, screenPixelsPerCell, originalCellPixels) {
  // Off displays the generated image itself and never paints a tile overlay.
  if (mode === "off") return null;
  for (const [threshold, tier] of THRESHOLDS[mode] || THRESHOLDS.low) {
    if (screenPixelsPerCell >= threshold) return tier;
  }
  return null;
}

function rotateDraw(context, image, x, y, pixels, turns) {
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

function prepareCells(cells) {
  const singles = new Map();
  const groups = new Map();
  for (const cell of cells || []) {
    if (cell.size === 1) {
      singles.set(`${cell.x},${cell.y}`, cell);
      continue;
    }
    const key = `${cell.group}:${cell.uid}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(cell);
  }
  const multis = [];
  for (const members of groups.values()) {
    const first = members[0];
    if (EXCAVATION_COMPOSITE_UIDS.has(first.uid)) continue;
    multis.push({
      uid: first.uid,
      size: first.size,
      rotation: first.rotation,
      x: Number.isFinite(first.originX) ? first.originX : Math.min(...members.map((cell) => cell.x)),
      y: Number.isFinite(first.originY) ? first.originY : Math.min(...members.map((cell) => cell.y)),
    });
  }
  return { singles, multis };
}

function decodeImage(url, anonymous = false) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = "async";
    if (anonymous) image.crossOrigin = "anonymous";
    image.addEventListener("load", () => resolve(image), { once: true });
    image.addEventListener("error", () => reject(new Error(`Could not load ${url}`)), { once: true });
    image.src = url;
  });
}

async function decodeBlob(blob) {
  if (typeof globalThis.createImageBitmap === "function") {
    return { image: await createImageBitmap(blob), objectUrl: null };
  }
  const objectUrl = URL.createObjectURL(blob);
  try {
    return { image: await decodeImage(objectUrl), objectUrl };
  } catch (error) {
    URL.revokeObjectURL(objectUrl);
    throw error;
  }
}

function releaseImage(image) {
  if (!image) return;
  if (typeof image.close === "function") image.close();
  else image.src = "";
}

async function decodePackedBase64(encoded, byteLength) {
  const output = new Uint8Array(byteLength);
  // Keep chunks aligned to four base64 characters and yield regularly so a
  // low-end browser never has to decode a multi-megabyte string in one task.
  const chunkCharacters = 256 * 1024;
  let outputOffset = 0;
  let chunkNumber = 0;
  for (let start = 0; start < encoded.length; start += chunkCharacters) {
    const binary = atob(encoded.slice(start, start + chunkCharacters));
    for (let index = 0; index < binary.length; index += 1) {
      output[outputOffset + index] = binary.charCodeAt(index);
    }
    outputOffset += binary.length;
    chunkNumber += 1;
    if (chunkNumber % 4 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return output;
}

async function cachedImage(url) {
  if (!globalThis.caches || location.protocol === "file:") return { image: await decodeImage(url), objectUrl: null };
  try {
    const cache = await caches.open(PERSISTENT_CACHE);
    let response = await cache.match(url);
    if (!response) {
      response = await fetch(url, { mode: "cors", credentials: "omit" });
      if (!response.ok || (response.headers.get("content-type") || "").includes("text/html")) {
        throw new Error(`Tile request returned ${response.status}`);
      }
      // Decoding the visible tile is latency-sensitive; persisting it can
      // finish independently and serves the next visit.
      cache.put(url, response.clone()).catch(() => {});
    }
    return await decodeBlob(await response.blob());
  } catch {
    // Cross-origin sources without CORS can still be displayed and use the
    // browser's normal HTTP cache; they simply cannot be copied into Cache API.
    return { image: await decodeImage(url), objectUrl: null };
  }
}

export function createTileDetailLayer({ canvas, viewport, baseUrl = document.baseURI, onQualityChange } = {}) {
  const context = canvas.getContext("2d", { alpha: true });
  let source = GENERATOR_ASSET_SOURCE;
  const storedQuality = localStorage.getItem("sm-map-upscaling");
  const mobileDefault = globalThis.matchMedia?.("(pointer: coarse)").matches || (globalThis.navigator?.maxTouchPoints || 0) > 0;
  // A choice the player has already made always wins. New viewers start with
  // high detail on desktop and a gentler medium mode on touch devices.
  let quality = storedQuality || (mobileDefault ? "medium" : "high");
  if (!THRESHOLDS[quality] && quality !== "off") quality = mobileDefault ? "medium" : "high";
  let cellData = prepareCells([]);
  let originalCellPixels = BASE_CELL_PX;
  let hasCells = false;
  let view = { panX: 0, panY: 0, scale: 1 };
  let renderedView = null;
  let frame = 0;
  let settleTimer = 0;
  let generation = 0;
  let loadEpoch = 0;
  let renderNumber = 0;
  let activeLoads = 0;
  let requestedTier = null;
  let useTierPacks = false;
  const loadQueue = [];
  // Image decoding is CPU-heavy in standalone file viewers. A deliberately
  // small queue keeps pointer/zoom input responsive while the browser decodes
  // visible tiles in the background.
  const logicalCores = Math.max(2, globalThis.navigator?.hardwareConcurrency || 4);
  const maxConcurrentLoads = mobileDefault
    ? Math.max(2, Math.min(4, Math.floor(logicalCores / 2)))
    : Math.max(6, Math.min(10, logicalCores));
  const imageCache = new Map();
  const tierPackCache = new Map();

  function pumpLoadQueue() {
    while (activeLoads < maxConcurrentLoads && loadQueue.length) {
      const item = loadQueue.shift();
      if (item.record) item.record.queueItem = null;
      if (item.epoch !== loadEpoch || item.tier !== requestedTier) {
        item.reject(new DOMException("Tile load cancelled", "AbortError"));
        continue;
      }
      activeLoads += 1;
      item.task().then(item.resolve, item.reject).finally(() => {
        activeLoads -= 1;
        pumpLoadQueue();
      });
    }
  }

  function queueLoad(task, epoch, tier, record) {
    return new Promise((resolve, reject) => {
      const item = { task, epoch, tier, record, priority: record.priority, resolve, reject };
      record.queueItem = item;
      loadQueue.push(item);
    });
  }

  function prioritizeVisibleLoads() {
    const retained = [];
    for (const item of loadQueue) {
      if (
        item.epoch !== loadEpoch ||
        item.tier !== requestedTier ||
        item.record?.lastUsed !== renderNumber
      ) {
        if (item.record) item.record.queueItem = null;
        item.reject(new DOMException("Tile load cancelled", "AbortError"));
      } else {
        item.priority = item.record.priority;
        retained.push(item);
      }
    }
    retained.sort((left, right) => left.priority - right.priority);
    loadQueue.splice(0, loadQueue.length, ...retained);
    pumpLoadQueue();
  }

  function imagePath(placement, tier) {
    return tileAssetUrl(relativeImagePath(placement, tier), baseUrl, source).href;
  }

  function packedImagePath(placement) {
    if (placement.assetPath) return placement.assetPath;
    return placement.size === 1
      ? `tiles/${placement.uid}.webp`
      : `${placement.uid}.webp`;
  }

  function shouldUseTierPacks() {
    return Boolean(globalThis.__SM_TILE_PACKS__ && Object.keys(globalThis.__SM_TILE_PACKS__).length);
  }

  function loadTierPack(tier) {
    let promise = tierPackCache.get(tier);
    if (promise) return promise;
    const registry = globalThis.__SM_TILE_PACKS__ ||= {};
    const embedded = registry[String(tier)];
    if (embedded?.files) {
      promise = Promise.resolve(embedded);
      tierPackCache.set(tier, promise);
      return promise;
    }
    promise = Promise.reject(new Error(`This viewer does not contain tile tier ${tier}.`));
    tierPackCache.set(tier, promise);
    return promise;
  }

  async function loadPackedImage(placement, tier) {
    const pack = await loadTierPack(tier);
    const path = packedImagePath(placement);
    const packedFile = pack.files[path];
    if (!packedFile) throw new Error(`Tile is missing from tier ${tier} pack.`);
    const bytes = packedFile instanceof Uint8Array
      ? packedFile
      : await decodePackedBase64(packedFile[1], packedFile[0]);
    // Retain the much smaller compressed bytes so a pruned image can be decoded
    // again without keeping the larger base64 string or using the network.
    pack.files[path] = bytes;
    return decodeBlob(new Blob([bytes], { type: "image/webp" }));
  }

  function relativeImagePath(placement, tier) {
    if (placement.assetPath) return `detail/${tier}/${placement.assetPath}`;
    return placement.size === 1
      ? `detail/${tier}/tiles/${placement.uid}.webp`
      : `detail/${tier}/${placement.uid}.webp`;
  }

  function loadImage(placement, tier, priority) {
    const url = imagePath(placement, tier);
    let record = imageCache.get(url);
    if (record) {
      const alreadyUsedThisFrame = record.lastUsed === renderNumber;
      record.lastUsed = renderNumber;
      record.priority = alreadyUsedThisFrame ? Math.min(record.priority, priority) : priority;
      if (record.queueItem) record.queueItem.priority = record.priority;
      return record;
    }
    record = {
      image: null,
      objectUrl: null,
      failed: false,
      lastUsed: renderNumber,
      priority,
      queueItem: null,
      promise: null,
    };
    const epoch = loadEpoch;
    const load = () => useTierPacks
      ? loadPackedImage(placement, tier).catch(() => cachedImage(url))
      : cachedImage(url);
    record.promise = queueLoad(load, epoch, tier, record).then(({ image, objectUrl }) => {
      if (epoch !== loadEpoch || imageCache.get(url) !== record) {
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        releaseImage(image);
        return record;
      }
      record.image = image;
      record.objectUrl = objectUrl;
      schedule();
      return record;
    }).catch((error) => {
      if (epoch !== loadEpoch || imageCache.get(url) !== record) return record;
      if (error?.name === "AbortError") {
        imageCache.delete(url);
        return record;
      }
      record.failed = true;
      schedule();
      return record;
    });
    imageCache.set(url, record);
    return record;
  }

  function releaseRecord(record) {
    if (record.objectUrl) URL.revokeObjectURL(record.objectUrl);
    releaseImage(record.image);
  }

  function pruneCache() {
    if (imageCache.size <= MAX_DECODED_TILES) return;
    const candidates = [...imageCache.entries()]
      .filter(([, record]) => record.lastUsed !== renderNumber && (record.image || record.failed))
      .sort((left, right) => left[1].lastUsed - right[1].lastUsed);
    for (const [url, record] of candidates) {
      if (imageCache.size <= MAX_DECODED_TILES) break;
      releaseRecord(record);
      imageCache.delete(url);
    }
  }

  function clearDecodedCache() {
    generation += 1;
    loadEpoch += 1;
    for (const record of imageCache.values()) releaseRecord(record);
    imageCache.clear();
    pumpLoadQueue();
  }

  function stopDetailWork() {
    clearTimeout(settleTimer);
    settleTimer = 0;
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    clearDecodedCache();
    canvas.style.opacity = "0";
    canvas.style.transform = "none";
    canvas.dataset.ready = "false";
    renderedView = null;
    context.clearRect(0, 0, canvas.width, canvas.height);
  }

  function visible(placement, stageLeft, stageTop, stageRight, stageBottom) {
    const left = (placement.x - X_MIN) * BASE_CELL_PX;
    const top = (Y_MAX - (placement.y + placement.size - 1)) * BASE_CELL_PX;
    const extent = placement.size * BASE_CELL_PX;
    return left < stageRight && left + extent > stageLeft && top < stageBottom && top + extent > stageTop;
  }

  function drawPlacement(placement, record) {
    if (!record.image) return;
    const stageX = (placement.x - X_MIN) * BASE_CELL_PX;
    const stageY = (Y_MAX - (placement.y + placement.size - 1)) * BASE_CELL_PX;
    const x = view.panX + stageX * view.scale;
    const y = view.panY + stageY * view.scale;
    const pixels = placement.size * BASE_CELL_PX * view.scale;
    rotateDraw(context, record.image, x, y, pixels, placement.rotation || 0);
  }

  function visiblePlacements(width, height) {
    const margin = BASE_CELL_PX * 2;
    const stageLeft = (-view.panX - margin) / view.scale;
    const stageTop = (-view.panY - margin) / view.scale;
    const stageRight = (width - view.panX + margin) / view.scale;
    const stageBottom = (height - view.panY + margin) / view.scale;
    const xStart = Math.max(-64, Math.floor(stageLeft / BASE_CELL_PX) + X_MIN);
    const xEnd = Math.min(63, Math.ceil(stageRight / BASE_CELL_PX) + X_MIN);
    const yStart = Math.max(-48, Y_MAX - Math.ceil(stageBottom / BASE_CELL_PX));
    const yEnd = Math.min(47, Y_MAX - Math.floor(stageTop / BASE_CELL_PX));
    const placements = [];
    for (const excavation of EXCAVATION_DETAIL_PLACEMENTS) {
      if (visible(excavation, stageLeft, stageTop, stageRight, stageBottom)) placements.push(excavation);
    }
    for (let y = yStart; y <= yEnd; y += 1) {
      for (let x = xStart; x <= xEnd; x += 1) {
        const cell = cellData.singles.get(`${x},${y}`);
        if (cell) placements.push({ ...cell, size: 1 });
      }
    }
    for (const placement of cellData.multis) {
      if (visible(placement, stageLeft, stageTop, stageRight, stageBottom)) placements.push(placement);
    }
    return placements;
  }

  function placementPriority(placement, width, height) {
    const stageX = (placement.x - X_MIN + placement.size / 2) * BASE_CELL_PX;
    const stageY = (Y_MAX - placement.y - placement.size / 2 + 1) * BASE_CELL_PX;
    const screenX = view.panX + stageX * view.scale;
    const screenY = view.panY + stageY * view.scale;
    return (screenX - width / 2) ** 2 + (screenY - height / 2) ** 2;
  }

  function render() {
    frame = 0;
    renderNumber += 1;
    const width = Math.max(1, viewport.clientWidth);
    const height = Math.max(1, viewport.clientHeight);
    const maximumPixelRatio = mobileDefault ? 1 : 1.5;
    const pixelRatio = Math.min(maximumPixelRatio, Math.max(1, globalThis.devicePixelRatio || 1));
    const canvasWidth = Math.round(width * pixelRatio);
    const canvasHeight = Math.round(height * pixelRatio);
    if (canvas.width !== canvasWidth || canvas.height !== canvasHeight) {
      canvas.width = canvasWidth;
      canvas.height = canvasHeight;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
    }
    const tier = detailTier(quality, BASE_CELL_PX * view.scale, originalCellPixels);
    requestedTier = tier;
    if (!hasCells || !tier) {
      prioritizeVisibleLoads();
      canvas.style.opacity = "0";
      canvas.dataset.ready = "false";
      renderedView = null;
      return;
    }
    canvas.dataset.detailTier = String(tier);
    const placements = visiblePlacements(width, height);
    const records = placements.map((placement) => (
      loadImage(placement, tier, placementPriority(placement, width, height))
    ));
    // Requests for the latest viewport always jump ahead of pending work from
    // the previous pan position; no stale off-screen queue is allowed to drain.
    prioritizeVisibleLoads();
    // Never display a half-updated checkerboard. The base map remains visible
    // until every visible high-detail tile has decoded, then the frame swaps in.
    if (records.some((record) => !record.image && !record.failed)) {
      if (canvas.dataset.ready !== "true") canvas.style.opacity = "0";
      return;
    }
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    context.clearRect(0, 0, width, height);
    for (let index = 0; index < placements.length; index += 1) drawPlacement(placements[index], records[index]);
    canvas.style.transform = "none";
    renderedView = { ...view };
    canvas.dataset.ready = "true";
    canvas.style.opacity = "1";
    pruneCache();
  }

  function schedule() {
    if (!frame) frame = requestAnimationFrame(render);
  }

  function followViewImmediately() {
    if (!renderedView || canvas.dataset.ready !== "true") return;
    const ratio = view.scale / renderedView.scale;
    const translateX = view.panX - renderedView.panX * ratio;
    const translateY = view.panY - renderedView.panY * ratio;
    canvas.style.transformOrigin = "0 0";
    canvas.style.transform = `translate(${translateX}px, ${translateY}px) scale(${ratio})`;
  }

  function scheduleSettledRender() {
    clearTimeout(settleTimer);
    // Wait until the wheel/pinch/pan gesture has actually settled. The last
    // complete canvas follows the gesture with a GPU transform in the meantime.
    settleTimer = setTimeout(schedule, 55);
  }

  return {
    setCells(cells) {
      hasCells = Array.isArray(cells) && cells.length > 0;
      cellData = prepareCells(cells || []);
      schedule();
    },
    setView(nextView) {
      const previousTier = detailTier(quality, BASE_CELL_PX * view.scale, originalCellPixels);
      view = nextView;
      followViewImmediately();
      const nextTier = detailTier(quality, BASE_CELL_PX * view.scale, originalCellPixels);
      // Start fetching immediately on a quality-boundary crossing. Ordinary
      // pan/zoom frames remain debounced so low-end devices stay responsive.
      if (nextTier !== previousTier || nextTier !== requestedTier) schedule();
      else scheduleSettledRender();
    },
    setQuality(nextQuality) {
      const fallback = mobileDefault ? "medium" : "high";
      const resolvedQuality = (THRESHOLDS[nextQuality] || nextQuality === "off") ? nextQuality : fallback;
      if (resolvedQuality === quality) return;
      quality = resolvedQuality;
      localStorage.setItem("sm-map-upscaling", quality);
      onQualityChange?.(quality);
      stopDetailWork();
      schedule();
    },
    getQuality: () => quality,
    setOriginalCellSize(cellPixels) {
      const supportedTiers = [25, 50, 100, 200];
      const requested = Number.isFinite(cellPixels) ? cellPixels : BASE_CELL_PX;
      originalCellPixels = supportedTiers.reduce((closest, tier) =>
        Math.abs(tier - requested) < Math.abs(closest - requested) ? tier : closest
      , BASE_CELL_PX);
      stopDetailWork();
      schedule();
    },
    setSource(nextSource) {
      source = nextSource || GENERATOR_ASSET_SOURCE;
      useTierPacks = shouldUseTierPacks();
      tierPackCache.clear();
      clearDecodedCache();
      schedule();
    },
    clear() {
      hasCells = false;
      cellData = prepareCells([]);
      stopDetailWork();
    },
    resize: schedule,
  };
}
