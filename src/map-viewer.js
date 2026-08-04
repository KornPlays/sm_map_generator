import { readWebPSeed, seedFromFilename } from "./webp-seed.js";

const WORLD_MIN_X = -4095.62;
const WORLD_MAX_X = 4096.36;
const WORLD_MIN_Y = -3073.66;
const WORLD_MAX_Y = 3077.88;
const DATABASE_NAME = "sm-ch2-map-generator";
const DATABASE_VERSION = 1;
const LAST_MAP_KEY = "last-map";
const MARKER_DATA_VERSION = 5;
const MARKER_ORDER_KEY = "sm-map-marker-order";
const IS_TOUCH_DEVICE = "ontouchstart" in window || navigator.maxTouchPoints > 0;
const MIN_SAFE_SCALE = IS_TOUCH_DEVICE ? 0.15 : 0;
const MARKER_KIND_LABELS = {
  builderQuest: "Builder Quest",
  warehouse: "Warehouse",
  partUnlockStation: "Part Unlock Station",
  ruin: "Ruin",
  mechanicStation: "Mechanic Station",
  growlab: "Growlab",
  packingStation: "Packing Station",
  cagedFarmer: "Caged Farmer",
};

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.addEventListener("upgradeneeded", () => {
      if (!request.result.objectStoreNames.contains("maps")) request.result.createObjectStore("maps");
    });
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error || new Error("Browser storage is unavailable.")));
  });
}

async function readLastMap() {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = database.transaction("maps", "readonly").objectStore("maps").get(LAST_MAP_KEY);
    request.addEventListener("success", () => resolve(request.result || null));
    request.addEventListener("error", () => reject(request.error || new Error("The saved map could not be read.")));
  }).finally(() => database.close());
}

async function writeLastMap(map) {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = database.transaction("maps", "readwrite").objectStore("maps").put(map, LAST_MAP_KEY);
    request.addEventListener("success", () => resolve());
    request.addEventListener("error", () => reject(request.error || new Error("The map could not be saved in this browser.")));
  }).finally(() => database.close());
}

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

export function setupMapViewer({ onWarning, resolveMarkers } = {}) {
  const viewer = document.querySelector("#map-viewer");
  const viewport = document.querySelector("#map-viewport");
  const stage = document.querySelector("#map-stage");
  const image = document.querySelector("#map-image");
  const pin = document.querySelector("#map-pin");
  const pinLabel = document.querySelector("#map-pin-label");
  const markerLayer = document.querySelector("#map-markers");
  const empty = document.querySelector("#map-empty");
  const meta = document.querySelector("#map-meta");
  const uploadButton = document.querySelector("#upload-map");
  const fileInput = document.querySelector("#map-file");
  const download = document.querySelector("#download");
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

  let imageWidth = 0;
  let imageHeight = 0;
  let scale = 1;
  let minimumScale = 0.01;
  let panX = 0;
  let panY = 0;
  let mapUrl = null;
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
    const stored = localStorage.getItem(`sm-map-show-${kind}`);
    const defaultVisible = kind !== "ruin" && kind !== "cagedFarmer";
    return [kind, stored === null ? defaultVisible : stored === "true"];
  }));
  const pointers = new Map();
  let drag = null;
  let pinchDistance = null;
  let suppressPin = false;

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
    scale = Math.max(minimumScale, Math.min(scale * factor, 8));
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
    markerDetailsIcon.src = new URL(marker.icon, document.baseURI).href;
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
  }

  function applyMarkerOrder() {
    for (const element of mapMarkerElements) {
      const categoryOrder = markerOrder.indexOf(element.dataset.kind) + 1;
      const pressedOrder = Number(element.dataset.pressedOrder || 0);
      element.style.zIndex = String(categoryOrder * 100000 + pressedOrder);
    }
  }

  function bringMarkerKindToFront(kind) {
    const currentIndex = markerOrder.indexOf(kind);
    if (currentIndex >= 0) markerOrder.splice(currentIndex, 1);
    markerOrder.push(kind);
    localStorage.setItem(MARKER_ORDER_KEY, JSON.stringify(markerOrder));
    applyMarkerOrder();
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
      element.title = marker.title;
      element.setAttribute("aria-label", marker.title);
      const icon = document.createElement("img");
      icon.src = new URL(marker.icon, document.baseURI).href;
      icon.alt = "";
      const label = document.createElement("span");
      label.textContent = marker.title;
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
        showMarkerDetails(marker);
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

  function setMapSource(blob, name, details, seed, markers) {
    if (mapUrl) URL.revokeObjectURL(mapUrl);
    currentMapSource = { blob, name, details, seed, markers };
    mapSuspended = false;
    mapUrl = URL.createObjectURL(blob);
    imageWidth = details.width;
    imageHeight = details.height;
    image.src = mapUrl;
    image.style.width = `${imageWidth}px`;
    image.style.height = `${imageHeight}px`;
    empty.hidden = true;
    viewport.hidden = false;
    download.hidden = false;
    download.href = mapUrl;
    download.download = name || "scrap-mechanic-map.webp";
    const seedLabel = Number.isInteger(seed) ? `Seed ${seed} · ` : "";
    meta.textContent = `${seedLabel}${imageWidth.toLocaleString()} × ${imageHeight.toLocaleString()} · ${formatSize(blob.size)} · ${name || "map.webp"}`;
    removePin();
    renderMapMarkers(markers);
    requestAnimationFrame(fitMap);
  }

  function suspendMap() {
    if (!mapUrl || !currentMapSource) return false;
    URL.revokeObjectURL(mapUrl);
    mapUrl = null;
    image.removeAttribute("src");
    download.removeAttribute("href");
    mapSuspended = true;
    return true;
  }

  function resumeMap() {
    if (!mapSuspended || !currentMapSource || mapUrl) return;
    mapUrl = URL.createObjectURL(currentMapSource.blob);
    image.src = mapUrl;
    download.href = mapUrl;
    mapSuspended = false;
    requestAnimationFrame(fitMap);
  }

  async function showMap(blob, name, { persist = true, seed = null, mapMarkers = null, builderQuests = null } = {}) {
    if (!(blob instanceof Blob)) throw new Error("The selected map could not be read.");
    const [details, metadataSeed] = await Promise.all([imageDetails(blob), readWebPSeed(blob)]);
    const resolvedSeed = Number.isInteger(seed) ? seed : metadataSeed ?? seedFromFilename(name);
    let resolvedMarkers = mapMarkers ?? builderQuests;
    const markersNeedRefresh = !Array.isArray(resolvedMarkers) || resolvedMarkers.some(
      (marker) => !marker?.kind || !marker?.title || !marker?.icon,
    );
    if (markersNeedRefresh && Number.isInteger(resolvedSeed) && resolveMarkers) {
      try {
        resolvedMarkers = await resolveMarkers(resolvedSeed);
      } catch (error) {
        console.error(error);
        onWarning?.("The map opened, but its structure markers could not be generated.");
      }
    }
    resolvedMarkers ??= [];
    setMapSource(blob, name, details, resolvedSeed, resolvedMarkers);
    if (!persist) return details;
    try {
      await writeLastMap({
        blob,
        name: name || "scrap-mechanic-map.webp",
        seed: resolvedSeed,
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

  async function restoreLastMap() {
    try {
      const saved = await readLastMap();
      if (saved?.blob instanceof Blob) {
        const markersAreCurrent = saved.markerDataVersion === MARKER_DATA_VERSION;
        await showMap(saved.blob, saved.name, {
          persist: false,
          seed: saved.seed,
          mapMarkers: markersAreCurrent ? saved.mapMarkers : null,
          builderQuests: markersAreCurrent ? saved.builderQuests : null,
        });
      }
    } catch (error) {
      console.warn("Could not restore the previous map:", error);
    }
  }

  uploadButton.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    fileInput.value = "";
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".webp") && file.type !== "image/webp") {
      onWarning?.("Choose a generated .webp map image.");
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
      uploadButton.textContent = "Upload map WebP";
    }
  });

  viewport.addEventListener("wheel", (event) => {
    event.preventDefault();
    const rect = viewport.getBoundingClientRect();
    zoomAround(event.clientX - rect.left, event.clientY - rect.top, event.deltaY < 0 ? 1.15 : 1 / 1.15);
  }, { passive: false });

  viewport.addEventListener("pointerdown", (event) => {
    if (event.target.closest("button, .viewer-settings, .marker-details, .map-marker")) return;
    viewport.setPointerCapture(event.pointerId);
    const rect = viewport.getBoundingClientRect();
    pointers.set(event.pointerId, { x: event.clientX - rect.left, y: event.clientY - rect.top });
    if (pointers.size === 1) {
      drag = { x: event.clientX, y: event.clientY, panX, panY, moved: false };
      suppressPin = false;
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
  zoomInButton.addEventListener("click", () => zoomAround(viewport.clientWidth / 2, viewport.clientHeight / 2, 1.3));
  zoomOutButton.addEventListener("click", () => zoomAround(viewport.clientWidth / 2, viewport.clientHeight / 2, 1 / 1.3));
  expandButton.addEventListener("click", () => {
    const expanded = viewer.classList.toggle("expanded");
    document.body.classList.toggle("map-viewer-expanded-open", expanded);
    document.documentElement.classList.toggle("map-viewer-expanded-open", expanded);
    expandButton.textContent = expanded ? "×" : "⤢";
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
      localStorage.setItem(`sm-map-show-${kind}`, String(input.checked));
      bringMarkerKindToFront(kind);
      applyMarkerVisibility();
      if (!input.checked && markerDetailsKind.textContent === MARKER_KIND_LABELS[kind]) {
        markerDetails.hidden = true;
      }
    });
  }
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
  });
  window.addEventListener("resize", fitMap);

  return { showMap, restoreLastMap, fitMap, suspendMap, resumeMap };
}
