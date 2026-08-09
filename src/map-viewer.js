import { readWebPMapData, seedFromFilename } from "./webp-seed.js";
import { createTileDetailLayer } from "./tile-detail-layer.js";
import { GENERATOR_ASSET_SOURCE } from "./asset-config.js";
import { applyMarkerGlyph } from "./marker-icons.js";
import { LAST_MAP_KEY, readStoredMap, writeStoredMap } from "./map-store.js";

const WORLD_MIN_X = -4095.62;
const WORLD_MAX_X = 4096.36;
const WORLD_MIN_Y = -3073.66;
const WORLD_MAX_Y = 3077.88;
const MARKER_DATA_VERSION = 9;
const MARKER_ORDER_KEY = "sm-map-marker-order";
const POND_VISIBILITY_KEY = "sm-map-show-pond-v2";
const MIN_SAFE_SCALE = 0;
// Matching marker titles stack after this fraction of their screen areas overlap.
const MARKER_CLUSTER_OVERLAP = 0.25;
const MARKER_SCREEN_SIZE = 28;
const MARKER_KIND_LABELS = {
  builderQuest: "Builder Quest",
  warehouse: "Warehouse",
  partUnlockStation: "Part Unlock Station",
  ruin: "Ruin",
  mechanicStation: "Mechanic Station",
  growlab: "Growlab",
  packingStation: "Packing Station",
  cagedFarmer: "Caged Farmer",
  pond: "Pond",
  cluster: "Marker group",
};

function formatSize(bytes) {
  return `${(bytes / 1048576).toFixed(1)} MiB`;
}

function imageDetails(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.addEventListener("load", () => {
      const details = { width: image.naturalWidth, height: image.naturalHeight };
      URL.revokeObjectURL(url);
      resolve(details);
    }, { once: true });
    image.addEventListener("error", () => {
      URL.revokeObjectURL(url);
      reject(new Error("That file is not a readable WebP map image."));
    }, { once: true });
    image.src = url;
  });
}

async function createViewerPreview(blob, details) {
  const target = { width: 128 * 25, height: 96 * 25 };
  if (details.width === target.width && details.height === target.height) return blob;
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = target.width;
    canvas.height = target.height;
    const context = canvas.getContext("2d", { alpha: false });
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(bitmap, 0, 0, target.width, target.height);
    return await new Promise((resolve, reject) => canvas.toBlob(
      (preview) => preview ? resolve(preview) : reject(new Error("The map preview could not be created.")),
      "image/webp",
      0.88,
    ));
  } finally {
    bitmap.close?.();
  }
}

export function setupMapViewer({ onWarning, resolveMapData } = {}) {
  const viewer = document.querySelector("#map-viewer");
  const viewport = document.querySelector("#map-viewport");
  const stage = document.querySelector("#map-stage");
  const image = document.querySelector("#map-image");
  const detailCanvas = document.querySelector("#map-detail-layer");
  const pin = document.querySelector("#map-pin");
  const pinLabel = document.querySelector("#map-pin-label");
  const markerLayer = document.querySelector("#map-markers");
  const empty = document.querySelector("#map-empty");
  const meta = document.querySelector("#map-meta");
  const uploadButton = document.querySelector("#upload-map");
  const fileInput = document.querySelector("#map-file");
  // The page carries two copies of the download menu — one beside the upload
  // button, one in the floating map controls — and the exported viewer carries a
  // bare download link with no menu around it. Everything here works off the
  // whole set so the copies cannot drift apart.
  const downloadLinks = [...document.querySelectorAll('[data-download-role="image"]')];
  const downloadMenus = [...document.querySelectorAll("[data-download-menu]")];
  const zoomInButton = document.querySelector("#viewer-zoom-in");
  const zoomOutButton = document.querySelector("#viewer-zoom-out");
  const expandButton = document.querySelector("#viewer-expand");
  const settingsButton = document.querySelector("#viewer-settings-button");
  const settingsPanel = document.querySelector("#viewer-settings");
  const markerToggles = [...document.querySelectorAll("[data-marker-kind]")];
  const markerDetails = document.querySelector("#marker-details");
  const markerDetailsClose = document.querySelector("#marker-details-close");
  const markerDetailsIcon = document.querySelector("#marker-details-icon");
  const markerDetailsKind = document.querySelector("#marker-details-kind");
  const markerDetailsTitle = document.querySelector("#marker-details-title");
  const markerDetailsRewards = document.querySelector("#marker-details-rewards");
  const markerDetailsListTitle = document.querySelector("#marker-details-list-title");
  const markerDetailsRewardList = document.querySelector("#marker-details-reward-list");
  const upscalingOptions = document.querySelector("#upscaling-options");
  const upscalingInputs = [...document.querySelectorAll('input[name="upscaling"]')];
  const upscalingGenerate = document.querySelector("#upscaling-generate");
  const generateDetailDataButton = document.querySelector("#generate-detail-data");
  const upscalingUnavailable = document.querySelector("#upscaling-unavailable");

  let imageWidth = 0;
  let imageHeight = 0;
  let scale = 1;
  let minimumScale = 0.01;
  let panX = 0;
  let panY = 0;
  let mapUrl = null;
  let downloadUrl = null;
  let mapUrlOwned = false;
  let downloadUrlOwned = false;
  let currentMapSource = null;
  let mapSuspended = false;
  let pinnedPixel = null;
  let mapMarkerElements = [];
  let transformFrame = 0;
  let markerPressOrder = 0;
  const hoveredLabelMarkers = new Set();
  const focusedLabelMarkers = new Set();
  const markerKinds = markerToggles.map((input) => input.dataset.markerKind);
  let savedMarkerOrder = [];
  try {
    const parsed = JSON.parse(localStorage.getItem(MARKER_ORDER_KEY) || "[]");
    if (Array.isArray(parsed)) savedMarkerOrder = parsed.filter((kind) => markerKinds.includes(kind));
  } catch {
    savedMarkerOrder = [];
  }
  const markerOrder = [
    ...new Set([...savedMarkerOrder, ...markerKinds]),
  ];
  const markerVisibility = Object.fromEntries(markerToggles.map((input) => {
    const kind = input.dataset.markerKind;
    const storageKey = kind === "pond" ? POND_VISIBILITY_KEY : `sm-map-show-${kind}`;
    const stored = localStorage.getItem(storageKey);
    const defaultVisible = kind !== "ruin" && kind !== "cagedFarmer" && kind !== "pond";
    return [kind, stored === null ? defaultVisible : stored === "true"];
  }));
  const pointers = new Map();
  let drag = null;
  let pinchDistance = null;
  let suppressPin = false;
  const detailLayer = createTileDetailLayer({
    canvas: detailCanvas,
    viewport,
    onQualityChange: updateBaseMapImage,
  });

  function updateBaseMapImage(quality = detailLayer.getQuality()) {
    // With tile detail disabled the original generated image is the base.
    // Enabled modes use the lightweight 25px preview underneath their detail
    // canvas so the full-resolution WebP never competes with tile decoding.
    // A freshly generated map has no full-resolution image until its encode
    // finishes, so the preview stands in until attachMapBlob swaps it.
    const sourceUrl = (quality === "off" ? downloadUrl : mapUrl) || mapUrl;
    if (!sourceUrl) return;
    let resolvedUrl = sourceUrl;
    try { resolvedUrl = new URL(sourceUrl, document.baseURI).href; } catch { /* data/blob URL */ }
    if (image.src !== resolvedUrl) image.src = sourceUrl;
  }

  function clampPan() {
    const displayedWidth = imageWidth * scale;
    const displayedHeight = imageHeight * scale;
    if (displayedWidth <= viewport.clientWidth) panX = (viewport.clientWidth - displayedWidth) / 2;
    else panX = Math.min(0, Math.max(viewport.clientWidth - displayedWidth, panX));
    if (displayedHeight <= viewport.clientHeight) panY = (viewport.clientHeight - displayedHeight) / 2;
    else panY = Math.min(0, Math.max(viewport.clientHeight - displayedHeight, panY));
  }

  function applyTransform() {
    clampPan();
    updateBaseMapImage();
    stage.style.transform = `translate(${panX}px, ${panY}px) scale(${scale})`;
    if (pinnedPixel) {
      pin.style.left = `${panX + pinnedPixel.x * scale}px`;
      pin.style.top = `${panY + pinnedPixel.y * scale}px`;
    }
    for (const marker of mapMarkerElements) {
      const pixelX = Number(marker.dataset.pixelX);
      const pixelY = Number(marker.dataset.pixelY);
      marker.style.left = `${panX + pixelX * scale}px`;
      marker.style.top = `${panY + pixelY * scale}px`;
    }
    clusterOverlappingMarkers();
    detailLayer.setView({ panX, panY, scale });
  }

  function scheduleTransform() {
    if (transformFrame) return;
    transformFrame = requestAnimationFrame(() => {
      transformFrame = 0;
      applyTransform();
    });
  }

  function fitMap() {
    if (!imageWidth || !imageHeight) return;
    const containScale = Math.min(viewport.clientWidth / imageWidth, viewport.clientHeight / imageHeight);
    minimumScale = Math.max(containScale, MIN_SAFE_SCALE);
    scale = minimumScale;
    panX = (viewport.clientWidth - imageWidth * scale) / 2;
    panY = (viewport.clientHeight - imageHeight * scale) / 2;
    applyTransform();
  }

  function zoomAround(x, y, factor) {
    if (!imageWidth) return;
    const imageX = (x - panX) / scale;
    const imageY = (y - panY) / scale;
    scale = Math.max(minimumScale, Math.min(scale * factor, 16));
    panX = x - imageX * scale;
    panY = y - imageY * scale;
    applyTransform();
  }

  function placePin(x, y) {
    const imageX = (x - panX) / scale;
    const imageY = (y - panY) / scale;
    if (imageX < 0 || imageY < 0 || imageX > imageWidth || imageY > imageHeight) return;
    pinnedPixel = { x: imageX, y: imageY };
    const worldX = WORLD_MIN_X + (imageX / imageWidth) * (WORLD_MAX_X - WORLD_MIN_X);
    const worldY = WORLD_MAX_Y - (imageY / imageHeight) * (WORLD_MAX_Y - WORLD_MIN_Y);
    pinLabel.textContent = `${worldX.toFixed(1)}, ${worldY.toFixed(1)}`;
    pin.hidden = false;
    applyTransform();
  }

  function removePin() {
    pinnedPixel = null;
    pin.hidden = true;
  }

  function showMarkerDetails(marker) {
    markerDetailsIcon.textContent = "";
    markerDetailsIcon.dataset.icon = marker.iconKind || "dot";
    markerDetailsIcon.dataset.theme = marker.theme || "default";
    applyMarkerGlyph(markerDetailsIcon, marker.iconKind || "dot");
    markerDetailsKind.textContent = MARKER_KIND_LABELS[marker.kind] || "Map marker";
    markerDetailsTitle.textContent = marker.title;
    markerDetailsListTitle.textContent = marker.listTitle || "Rewards";
    markerDetailsRewardList.replaceChildren();
    for (const reward of marker.rewards || []) {
      const item = document.createElement("li");
      item.textContent = reward;
      markerDetailsRewardList.appendChild(item);
    }
    markerDetailsRewards.hidden = !marker.rewards?.length;
    markerDetails.hidden = false;
  }

  function applyMarkerVisibility() {
    for (const element of mapMarkerElements) {
      element.hidden = markerVisibility[element.dataset.kind] === false;
    }
    scheduleTransform();
  }

  function applyMarkerOrder() {
    for (const element of mapMarkerElements) {
      const categoryOrder = markerOrder.indexOf(element.dataset.kind) + 1;
      const pressedOrder = Number(element.dataset.pressedOrder || 0);
      element.style.zIndex = String(categoryOrder * 100000 + pressedOrder);
    }
  }

  function clusterOverlappingMarkers() {
    const candidates = mapMarkerElements.filter((element) => !element.hidden);
    for (const element of mapMarkerElements) {
      element.classList.remove("clustered-away", "cluster-representative");
      element.querySelector(".map-marker-count")?.remove();
      element._clusterMarker = null;
      element.title = element._mapMarker?.title || "Map marker";
      if (element._label) element._label.textContent = element.title;
      element.setAttribute("aria-label", element.title);
    }
    if (candidates.length < 2) return;
    const parent = candidates.map((_, index) => index);
    const find = (index) => {
      while (parent[index] !== index) {
        parent[index] = parent[parent[index]];
        index = parent[index];
      }
      return index;
    };
    const unite = (left, right) => {
      left = find(left);
      right = find(right);
      if (left !== right) parent[right] = left;
    };
    const buckets = new Map();
    for (let index = 0; index < candidates.length; index += 1) {
      const element = candidates[index];
      const x = Number.parseFloat(element.style.left);
      const y = Number.parseFloat(element.style.top);
      const bucketX = Math.floor(x / MARKER_SCREEN_SIZE);
      const bucketY = Math.floor(y / MARKER_SCREEN_SIZE);
      for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
        for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
          for (const otherIndex of buckets.get(`${bucketX + offsetX},${bucketY + offsetY}`) || []) {
            const other = candidates[otherIndex];
            if (element._mapMarker.title !== other._mapMarker.title) continue;
            const overlapX = Math.max(0, MARKER_SCREEN_SIZE - Math.abs(x - Number.parseFloat(other.style.left)));
            const overlapY = Math.max(0, MARKER_SCREEN_SIZE - Math.abs(y - Number.parseFloat(other.style.top)));
            if ((overlapX * overlapY) / (MARKER_SCREEN_SIZE ** 2) >= MARKER_CLUSTER_OVERLAP) unite(index, otherIndex);
          }
        }
      }
      const key = `${bucketX},${bucketY}`;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(index);
    }
    const groups = new Map();
    candidates.forEach((element, index) => {
      const root = find(index);
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root).push(element);
    });
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      const representative = group.reduce((front, element) =>
        Number(element.style.zIndex || 0) > Number(front.style.zIndex || 0) ? element : front
      );
      const x = Math.round(group.reduce((sum, element) => sum + Number.parseFloat(element.style.left), 0) / group.length);
      const y = Math.round(group.reduce((sum, element) => sum + Number.parseFloat(element.style.top), 0) / group.length);
      for (const element of group) {
        if (element !== representative) element.classList.add("clustered-away");
      }
      representative.classList.add("cluster-representative");
      representative.style.left = `${x}px`;
      representative.style.top = `${y}px`;
      const badge = document.createElement("span");
      badge.className = "map-marker-count";
      badge.textContent = String(group.length);
      representative.appendChild(badge);
      representative.title = `${representative._mapMarker.title} (${group.length}x)`;
      if (representative._label) representative._label.textContent = representative.title;
      representative.setAttribute("aria-label", representative.title);
      representative._clusterMarker = { ...representative._mapMarker };
    }
  }

  function bringMarkerKindToFront(kind) {
    const currentIndex = markerOrder.indexOf(kind);
    if (currentIndex >= 0) markerOrder.splice(currentIndex, 1);
    markerOrder.push(kind);
    localStorage.setItem(MARKER_ORDER_KEY, JSON.stringify(markerOrder));
    applyMarkerOrder();
    scheduleTransform();
  }

  function setMarkerLabelActive(element, active, source) {
    const collection = source === "focus" ? focusedLabelMarkers : hoveredLabelMarkers;
    if (active) collection.add(element);
    else collection.delete(element);
    markerLayer.classList.toggle(
      "marker-label-active",
      hoveredLabelMarkers.size > 0 || focusedLabelMarkers.size > 0,
    );
  }

  function renderMapMarkers(markers) {
    markerLayer.replaceChildren();
    mapMarkerElements = [];
    hoveredLabelMarkers.clear();
    focusedLabelMarkers.clear();
    markerLayer.classList.remove("marker-label-active");
    markerDetails.hidden = true;
    for (const marker of markers || []) {
      const element = document.createElement("button");
      element.type = "button";
      element.className = `map-marker map-marker-${marker.kind}`;
      element.dataset.pixelX = String(((marker.x - WORLD_MIN_X) / (WORLD_MAX_X - WORLD_MIN_X)) * imageWidth);
      element.dataset.pixelY = String(((WORLD_MAX_Y - marker.y) / (WORLD_MAX_Y - WORLD_MIN_Y)) * imageHeight);
      element.dataset.kind = marker.kind;
      element.dataset.pressedOrder = "0";
      element.dataset.theme = marker.theme || "default";
      element._mapMarker = marker;
      element.title = marker.title;
      element.setAttribute("aria-label", marker.title);
      const icon = document.createElement("span");
      icon.className = "map-marker-symbol";
      icon.dataset.icon = marker.iconKind || "dot";
      applyMarkerGlyph(icon, marker.iconKind || "dot");
      const label = document.createElement("span");
      label.className = "map-marker-label";
      label.textContent = marker.title;
      element._label = label;
      element.append(icon, label);
      element.addEventListener("pointerdown", () => {
        bringMarkerKindToFront(marker.kind);
        markerPressOrder += 1;
        element.dataset.pressedOrder = String(markerPressOrder);
        applyMarkerOrder();
      });
      element.addEventListener("pointerenter", () => setMarkerLabelActive(element, true, "hover"));
      element.addEventListener("pointerleave", () => setMarkerLabelActive(element, false, "hover"));
      element.addEventListener("focus", () => setMarkerLabelActive(element, true, "focus"));
      element.addEventListener("blur", () => setMarkerLabelActive(element, false, "focus"));
      element.addEventListener("click", (event) => {
        event.stopPropagation();
        showMarkerDetails(element._clusterMarker || marker);
      });
      markerLayer.appendChild(element);
      mapMarkerElements.push(element);
    }
    applyMarkerVisibility();
    applyMarkerOrder();
    applyTransform();
  }

  function pointerDistance() {
    const [first, second] = [...pointers.values()];
    return Math.hypot(first.x - second.x, first.y - second.y);
  }

  function pointerMidpoint() {
    const [first, second] = [...pointers.values()];
    return { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
  }

  function updateUpscalingAvailability() {
    const hasCells = Boolean(currentMapSource?.cells?.length);
    upscalingOptions.hidden = !hasCells;
    upscalingGenerate.hidden = hasCells;
    if (hasCells) return;
    const canGenerate = Number.isInteger(currentMapSource?.seed) && Boolean(resolveMapData);
    generateDetailDataButton.disabled = !canGenerate;
    upscalingUnavailable.textContent = canGenerate
      ? "This map has no embedded cell layout. Generate it once from the saved seed to enable tile detail."
      : "This image has no cell layout or readable seed, so adaptive tile detail is unavailable.";
  }

  function releaseObjectUrls() {
    if (mapUrl && mapUrlOwned) URL.revokeObjectURL(mapUrl);
    if (downloadUrl && downloadUrlOwned) URL.revokeObjectURL(downloadUrl);
  }

  // While the download image is still being encoded every menu shows only its
  // progress; the export options reappear together with the map image link.
  function setDownloadEncoding(encoding) {
    for (const menu of downloadMenus) {
      if (encoding) menu.dataset.encoding = "true";
      else delete menu.dataset.encoding;
    }
    for (const link of downloadLinks) {
      link.toggleAttribute("aria-disabled", encoding);
      link.title = encoding ? "Full-resolution map image is still generating" : "Download map image";
      // Generator links live inside a menu whose encoding panel replaces them.
      // The portable viewer has a bare control, which stays visible so clicking
      // it can explain why the target-resolution download is not ready yet.
      if (!link.closest("[data-download-menu]")) link.hidden = false;
    }
  }

  function setMapSource(blob, previewBlob, name, details, seed, markers, cells, assetSource, {
    mapSource = null,
    previewSource = null,
    size = blob?.size || 0,
  } = {}) {
    releaseObjectUrls();
    currentMapSource = { blob, previewBlob, mapSource, previewSource, size, name, details, seed, markers, cells, assetSource };
    mapSuspended = false;
    mapUrlOwned = !previewSource;
    // A freshly generated map arrives as soon as its viewer-sized preview is
    // encoded; the full-resolution download image follows through
    // attachMapBlob once the browser has finished writing it.
    const hasDownload = Boolean(mapSource || blob);
    downloadUrlOwned = hasDownload && !mapSource;
    mapUrl = previewSource || URL.createObjectURL(previewBlob);
    downloadUrl = hasDownload ? mapSource || URL.createObjectURL(blob) : null;
    imageWidth = 128 * 25;
    imageHeight = 96 * 25;
    updateBaseMapImage();
    image.style.width = `${imageWidth}px`;
    image.style.height = `${imageHeight}px`;
    empty.hidden = true;
    viewport.hidden = false;
    for (const link of downloadLinks) {
      link.hidden = !hasDownload;
      if (hasDownload) link.href = downloadUrl;
      else link.removeAttribute("href");
      link.download = name || "scrap-mechanic-map.webp";
    }
    for (const menu of downloadMenus) menu.hidden = false;
    setDownloadEncoding(!hasDownload);
    const seedLabel = Number.isInteger(seed) ? `Seed ${seed} · ` : "";
    const sizeLabel = size ? ` · ${formatSize(size)}` : "";
    meta.textContent = `${seedLabel}${details.width.toLocaleString()} × ${details.height.toLocaleString()}${sizeLabel} · ${name || "map.webp"}`;
    removePin();
    detailLayer.setOriginalCellSize(details.width / 128);
    detailLayer.setSource(assetSource || GENERATOR_ASSET_SOURCE);
    detailLayer.setCells(cells);
    updateUpscalingAvailability();
    renderMapMarkers(markers);
    requestAnimationFrame(fitMap);
  }

  function suspendMap() {
    if (!mapUrl || !currentMapSource) return false;
    releaseObjectUrls();
    mapUrl = null;
    downloadUrl = null;
    mapUrlOwned = false;
    downloadUrlOwned = false;
    image.removeAttribute("src");
    for (const link of downloadLinks) link.removeAttribute("href");
    detailLayer.clear();
    mapSuspended = true;
    return true;
  }

  function resumeMap() {
    if (!mapSuspended || !currentMapSource || mapUrl) return;
    const hasDownload = Boolean(currentMapSource.mapSource || currentMapSource.blob);
    mapUrlOwned = !currentMapSource.previewSource;
    downloadUrlOwned = hasDownload && !currentMapSource.mapSource;
    mapUrl = currentMapSource.previewSource || URL.createObjectURL(currentMapSource.previewBlob);
    downloadUrl = hasDownload
      ? currentMapSource.mapSource || URL.createObjectURL(currentMapSource.blob)
      : null;
    updateBaseMapImage();
    for (const link of downloadLinks) {
      link.hidden = !hasDownload;
      if (hasDownload) link.href = downloadUrl;
    }
    setDownloadEncoding(!hasDownload);
    detailLayer.setSource(currentMapSource.assetSource || GENERATOR_ASSET_SOURCE);
    detailLayer.setCells(currentMapSource.cells);
    mapSuspended = false;
    requestAnimationFrame(fitMap);
  }

  async function showMap(blob, name, {
    persist = true,
    seed = null,
    cells = null,
    previewBlob = null,
    mapMarkers = null,
    builderQuests = null,
    assetSource = GENERATOR_ASSET_SOURCE,
  } = {}) {
    if (!(blob instanceof Blob)) throw new Error("The selected map could not be read.");
    const metadata = await readWebPMapData(blob);
    const details = metadata.width && metadata.height
      ? { width: metadata.width, height: metadata.height }
      : await imageDetails(blob);
    const resolvedSeed = Number.isInteger(seed) ? seed : metadata.seed ?? seedFromFilename(name);
    let resolvedCells = Array.isArray(cells) ? cells : metadata.cells;
    let resolvedMarkers = mapMarkers ?? builderQuests;
    const markersNeedRefresh = !Array.isArray(resolvedMarkers) || resolvedMarkers.some(
      (marker) => !marker?.kind || !marker?.title || !marker?.iconKind,
    );
    const cellsNeedRefresh = !resolvedCells?.length || resolvedCells.some(
      (cell) => cell?.size > 1 && (!Number.isFinite(cell.originX) || !Number.isFinite(cell.originY)),
    );
    if ((markersNeedRefresh || cellsNeedRefresh) && Number.isInteger(resolvedSeed) && resolveMapData) {
      try {
        const generated = await resolveMapData(resolvedSeed);
        if (cellsNeedRefresh) resolvedCells = generated.cells;
        if (markersNeedRefresh) resolvedMarkers = generated.mapMarkers;
      } catch (error) {
        console.error(error);
        onWarning?.("The map opened, but its structure markers could not be generated.");
      }
    }
    resolvedMarkers ??= [];
    const resolvedPreview = previewBlob instanceof Blob
      ? previewBlob
      : metadata.previewBlob instanceof Blob
        ? metadata.previewBlob
        : await createViewerPreview(blob, details);
    setMapSource(blob, resolvedPreview, name, details, resolvedSeed, resolvedMarkers, resolvedCells || [], assetSource);
    if (!persist) return details;
    try {
      await writeStoredMap(LAST_MAP_KEY, {
        blob,
        name: name || "scrap-mechanic-map.webp",
        seed: resolvedSeed,
        cells: resolvedCells,
        previewBlob: resolvedPreview,
        assetSource,
        mapMarkers: resolvedMarkers,
        markerDataVersion: MARKER_DATA_VERSION,
        savedAt: Date.now(),
      });
    } catch (error) {
      console.error(error);
      onWarning?.("The map opened, but this browser could not save it for next time.");
    }
    return details;
  }

  function showMapUrl(mapSource, previewSource, name, {
    details = { width: 128 * 25, height: 96 * 25 },
    size = 0,
    seed = null,
    cells = [],
    mapMarkers = [],
    assetSource = GENERATOR_ASSET_SOURCE,
  } = {}) {
    setMapSource(null, null, name, details, seed, mapMarkers, cells, assetSource, {
      mapSource,
      previewSource,
      size,
    });
    return details;
  }

  function showMapBlobs(blob, previewBlob, name, {
    details = { width: 128 * 25, height: 96 * 25 },
    size = blob?.size || 0,
    seed = null,
    cells = [],
    mapMarkers = [],
    assetSource = GENERATOR_ASSET_SOURCE,
  } = {}) {
    setMapSource(blob, previewBlob, name, details, seed, mapMarkers, cells, assetSource, { size });
    return details;
  }

  // Shows a map from its viewer-sized preview alone. The download image is
  // supplied later through attachMapBlob, which is also what persists the map.
  function showMapPreview(previewBlob, name, {
    details = { width: 128 * 25, height: 96 * 25 },
    seed = null,
    cells = [],
    mapMarkers = [],
    assetSource = GENERATOR_ASSET_SOURCE,
  } = {}) {
    setMapSource(null, previewBlob, name, details, seed, mapMarkers, cells, assetSource, { size: 0 });
    return details;
  }

  async function attachMapBlob(blob, { persist = true } = {}) {
    if (!(blob instanceof Blob) || !currentMapSource) return;
    currentMapSource.blob = blob;
    currentMapSource.size = blob.size;
    if (!mapSuspended) {
      if (downloadUrl && downloadUrlOwned) URL.revokeObjectURL(downloadUrl);
      downloadUrl = URL.createObjectURL(blob);
      downloadUrlOwned = true;
      for (const link of downloadLinks) {
        link.href = downloadUrl;
        link.hidden = false;
      }
      setDownloadEncoding(false);
      // With tile detail off the base layer is the full-resolution image, which
      // only exists now.
      updateBaseMapImage();
    }
    const { details, seed, name } = currentMapSource;
    const seedLabel = Number.isInteger(seed) ? `Seed ${seed} · ` : "";
    meta.textContent = `${seedLabel}${details.width.toLocaleString()} × ${details.height.toLocaleString()} · ${formatSize(blob.size)} · ${name || "map.webp"}`;
    if (!persist) return;
    try {
      await writeStoredMap(LAST_MAP_KEY, {
        blob,
        name: name || "scrap-mechanic-map.webp",
        seed,
        cells: currentMapSource.cells,
        previewBlob: currentMapSource.previewBlob,
        assetSource: currentMapSource.assetSource,
        mapMarkers: currentMapSource.markers,
        markerDataVersion: MARKER_DATA_VERSION,
        savedAt: Date.now(),
      });
    } catch (error) {
      console.error(error);
      onWarning?.("The map opened, but this browser could not save it for next time.");
    }
  }

  async function restoreLastMap() {
    try {
      const saved = await readStoredMap(LAST_MAP_KEY);
      if (saved?.blob instanceof Blob) {
        const markersAreCurrent = saved.markerDataVersion === MARKER_DATA_VERSION;
        const cellsHaveOrigins = Array.isArray(saved.cells) && saved.cells.length > 0 && saved.cells.every(
          (cell) => cell?.size <= 1 || (Number.isFinite(cell.originX) && Number.isFinite(cell.originY)),
        );
        await showMap(saved.blob, saved.name, {
          persist: false,
          seed: saved.seed,
          cells: saved.cells,
          previewBlob: saved.previewBlob,
          assetSource: saved.assetSource || GENERATOR_ASSET_SOURCE,
          mapMarkers: markersAreCurrent ? saved.mapMarkers : null,
          builderQuests: markersAreCurrent ? saved.builderQuests : null,
        });
        // Upgrade older cached maps once so their partially-overwritten
        // multi-cell tiles retain the corrected origins on future reloads.
        if (!cellsHaveOrigins && currentMapSource?.cells?.length) {
          await writeStoredMap(LAST_MAP_KEY, {
            ...saved,
            cells: currentMapSource.cells,
            mapMarkers: currentMapSource.markers,
            markerDataVersion: MARKER_DATA_VERSION,
            savedAt: Date.now(),
          });
        }
        return true;
      }
    } catch (error) {
      console.warn("Could not restore the previous map:", error);
    }
    return false;
  }

  uploadButton.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    fileInput.value = "";
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".webp") && file.type !== "image/webp") {
      onWarning?.("Choose a generated map image (.webp).");
      return;
    }
    uploadButton.disabled = true;
    uploadButton.textContent = "Opening…";
    try {
      await showMap(file, file.name);
    } catch (error) {
      onWarning?.(error.message || "That map image could not be opened.");
    } finally {
      uploadButton.disabled = false;
      uploadButton.textContent = "Upload map image";
    }
  });

  viewport.addEventListener("wheel", (event) => {
    event.preventDefault();
    const rect = viewport.getBoundingClientRect();
    zoomAround(event.clientX - rect.left, event.clientY - rect.top, event.deltaY < 0 ? 1.15 : 1 / 1.15);
  }, { passive: false });

  viewport.addEventListener("pointerdown", (event) => {
    const markerButton = event.target.closest(".map-marker");
    const blockedControl = event.target.closest("button, a, summary, .viewer-settings, .marker-details");
    // Marker buttons remain tappable, but touch pointers also need to reach
    // the viewport so a pinch can begin with either finger on a marker.
    if (blockedControl && !(markerButton && event.pointerType === "touch")) return;
    viewport.setPointerCapture(event.pointerId);
    const rect = viewport.getBoundingClientRect();
    pointers.set(event.pointerId, { x: event.clientX - rect.left, y: event.clientY - rect.top });
    if (pointers.size === 1) {
      drag = { x: event.clientX, y: event.clientY, panX, panY, moved: false };
      // A single marker tap still opens its details through the button click;
      // it should not also leave a coordinate pin underneath the marker.
      suppressPin = Boolean(markerButton);
      viewport.classList.add("grabbing");
    } else if (pointers.size === 2) {
      pinchDistance = pointerDistance();
      drag = null;
      suppressPin = true;
      viewport.classList.remove("grabbing");
    }
  });

  viewport.addEventListener("pointermove", (event) => {
    if (!pointers.has(event.pointerId)) return;
    const rect = viewport.getBoundingClientRect();
    pointers.set(event.pointerId, { x: event.clientX - rect.left, y: event.clientY - rect.top });
    if (pointers.size >= 2) {
      const distance = pointerDistance();
      if (pinchDistance) {
        const midpoint = pointerMidpoint();
        zoomAround(midpoint.x, midpoint.y, distance / pinchDistance);
      }
      pinchDistance = distance;
      suppressPin = true;
    } else if (drag) {
      const deltaX = event.clientX - drag.x;
      const deltaY = event.clientY - drag.y;
      if (Math.abs(deltaX) > 4 || Math.abs(deltaY) > 4) drag.moved = true;
      panX = drag.panX + deltaX;
      panY = drag.panY + deltaY;
      scheduleTransform();
    }
  });

  function endPointer(event) {
    if (!pointers.has(event.pointerId)) return;
    const rect = viewport.getBoundingClientRect();
    const location = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    const wasClick = pointers.size === 1 && drag && !drag.moved && !suppressPin;
    pointers.delete(event.pointerId);
    if (pointers.size === 1) {
      const remaining = [...pointers.values()][0];
      drag = { x: remaining.x + rect.left, y: remaining.y + rect.top, panX, panY, moved: true };
      pinchDistance = null;
      viewport.classList.add("grabbing");
    } else {
      drag = null;
      pinchDistance = null;
      viewport.classList.remove("grabbing");
    }
    if (wasClick) placePin(location.x, location.y);
  }

  viewport.addEventListener("pointerup", endPointer);
  viewport.addEventListener("pointercancel", endPointer);
  pin.addEventListener("pointerdown", (event) => event.stopPropagation());
  pin.addEventListener("click", (event) => {
    event.stopPropagation();
    removePin();
  });
  for (const link of downloadLinks) {
    link.addEventListener("click", (event) => {
      if (!downloadUrl) {
        event.preventDefault();
        onWarning?.("The full-resolution map image is still generating. Try again in a moment.");
        return;
      }
      for (const menu of downloadMenus) menu.open = false;
    });
  }
  zoomInButton.addEventListener("click", () => zoomAround(viewport.clientWidth / 2, viewport.clientHeight / 2, 1.3));
  zoomOutButton.addEventListener("click", () => zoomAround(viewport.clientWidth / 2, viewport.clientHeight / 2, 1 / 1.3));
  expandButton.addEventListener("click", () => {
    const expanded = viewer.classList.toggle("expanded");
    document.body.classList.toggle("map-viewer-expanded-open", expanded);
    document.documentElement.classList.toggle("map-viewer-expanded-open", expanded);
    expandButton.innerHTML = expanded
      ? "×"
      : '<svg class="expand-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5" /></svg>';
    expandButton.title = expanded ? "Close expanded map view" : "Open expanded map view";
    expandButton.setAttribute("aria-label", expandButton.title);
    requestAnimationFrame(fitMap);
  });
  markerDetailsClose.addEventListener("click", () => { markerDetails.hidden = true; });
  for (const input of markerToggles) {
    const kind = input.dataset.markerKind;
    input.checked = markerVisibility[kind];
    input.addEventListener("change", () => {
      markerVisibility[kind] = input.checked;
      const storageKey = kind === "pond" ? POND_VISIBILITY_KEY : `sm-map-show-${kind}`;
      localStorage.setItem(storageKey, String(input.checked));
      bringMarkerKindToFront(kind);
      applyMarkerVisibility();
      if (!input.checked && markerDetailsKind.textContent === MARKER_KIND_LABELS[kind]) {
        markerDetails.hidden = true;
      }
    });
  }
  const savedUpscaling = detailLayer.getQuality();
  for (const input of upscalingInputs) {
    input.checked = input.value === savedUpscaling;
    input.addEventListener("change", () => {
      if (input.checked) detailLayer.setQuality(input.value);
    });
  }
  generateDetailDataButton.addEventListener("click", async () => {
    if (!currentMapSource || !Number.isInteger(currentMapSource.seed) || !resolveMapData) return;
    generateDetailDataButton.disabled = true;
    generateDetailDataButton.textContent = "Generating…";
    try {
      const generated = await resolveMapData(currentMapSource.seed);
      currentMapSource.cells = generated.cells || [];
      currentMapSource.markers = generated.mapMarkers || currentMapSource.markers;
      detailLayer.setCells(currentMapSource.cells);
      renderMapMarkers(currentMapSource.markers);
      updateUpscalingAvailability();
      await writeStoredMap(LAST_MAP_KEY, {
        ...currentMapSource,
        mapMarkers: currentMapSource.markers,
        markerDataVersion: MARKER_DATA_VERSION,
        savedAt: Date.now(),
      });
    } catch (error) {
      console.error(error);
      onWarning?.("The cell layout could not be generated from this map's seed.");
    } finally {
      generateDetailDataButton.disabled = false;
      generateDetailDataButton.textContent = "Generate detail data";
    }
  });
  settingsButton.addEventListener("click", (event) => {
    event.stopPropagation();
    settingsPanel.hidden = !settingsPanel.hidden;
    settingsButton.classList.toggle("active", !settingsPanel.hidden);
  });
  document.addEventListener("click", (event) => {
    if (!settingsPanel.hidden && !settingsPanel.contains(event.target) && event.target !== settingsButton) {
      settingsPanel.hidden = true;
      settingsButton.classList.remove("active");
    }
    // Two copies of the menu can be open at once otherwise, since <details>
    // never closes itself on an outside click.
    for (const menu of downloadMenus) {
      if (menu.open && !menu.contains(event.target)) menu.open = false;
    }
  });
  window.addEventListener("resize", () => {
    fitMap();
    detailLayer.resize();
  });

  return {
    showMap,
    showMapUrl,
    showMapBlobs,
    showMapPreview,
    attachMapBlob,
    restoreLastMap,
    fitMap,
    suspendMap,
    resumeMap,
    getCurrentMap: () => currentMapSource,
    getUpscalingQuality: () => detailLayer.getQuality(),
  };
}
