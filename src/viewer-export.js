import {
  EXPORTED_VIEWER_ASSET_SOURCE,
  GENERATOR_ASSET_SOURCE,
  tileAssetUrl,
} from "./asset-config.js";
import {
  EXCAVATION_COMPOSITE_UIDS,
  EXCAVATION_CHUNKS_PER_SIDE,
  excavationChunkPath,
} from "./excavation-assets.js";
import portableViewerScript from "./generated/portable-viewer.js?raw";
import portableViewerStyle from "./style.css?raw";
import { packCells } from "./map-data-pack.js";
import { stripWebPMapData } from "./webp-seed.js";
import { composeMap } from "./renderer.js";

function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

function blobDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(reader.result), { once: true });
    reader.addEventListener("error", () => reject(reader.error), { once: true });
    reader.readAsDataURL(blob);
  });
}

function safeJson(value) {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

function escapeElementText(value, element) {
  return String(value).replace(new RegExp(`</${element}`, "gi"), `<\\/${element}`);
}

const EXPORTED_VIEWER_LICENSE = `MIT License

Copyright (c) 2026 KornPlays

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

export function viewerMarkup(data, viewerSource, {
  styleText = portableViewerStyle,
  scriptText = portableViewerScript,
  externalData = false,
} = {}) {
  if (typeof styleText !== "string" || typeof scriptText !== "string") {
    throw new Error("The portable viewer bundle is missing. Run npm run build:viewer before exporting.");
  }
  const markerLabels = [
    ["builderQuest", "Builder Quests", true], ["warehouse", "Warehouses", true],
    ["partUnlockStation", "Part Unlock Stations", true], ["ruin", "Ruins", false],
    ["mechanicStation", "Mechanic Stations", true], ["growlab", "Growlabs", true],
    ["packingStation", "Packing Stations", true], ["cagedFarmer", "Caged Farmers", false],
    ["pond", "Ponds", false],
  ];
  const toggles = markerLabels.map(([kind, label, checked]) =>
    `<label><input type="checkbox" data-marker-kind="${kind}"${checked ? " checked" : ""}> <span>${label}</span></label>`
  ).join("");
  const style = `<style>${escapeElementText(styleText, "style")}</style>`;
  const script = `<script>${escapeElementText(scriptText, "script")}<\/script>`;
  return `<!doctype html>
<!-- ${EXPORTED_VIEWER_LICENSE} -->
<html lang="en" class="map-viewer-expanded-open"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<meta name="description" content="Interactive Scrap Mechanic Chapter 2 world map">
<title>Scrap Mechanic Chapter 2 Map · Seed ${data.seed ?? "Unknown"}</title>
${style}</head>
<body class="map-viewer-expanded-open"><section id="map-viewer" class="map-viewer expanded">
<div class="map-viewer-bar"><div><h2>Map viewer</h2><p id="map-meta"></p></div><div class="map-viewer-actions">
<button id="upload-map" type="button">Upload map image</button><input id="map-file" class="visually-hidden" type="file"></div></div>
<p id="map-empty" class="map-empty">Opening map…</p><div id="map-viewport" class="map-viewport" hidden>
<div id="map-stage" class="map-stage"><img id="map-image" alt="Scrap Mechanic world map" draggable="false"></div>
<canvas id="map-detail-layer" class="map-detail-layer"></canvas><div id="map-markers" class="map-marker-layer"></div>
<div id="map-pin" class="map-pin" hidden><span id="map-pin-label" class="map-pin-label"></span><span class="map-pin-dot"></span></div>
<aside id="marker-details" class="marker-details" hidden><button id="marker-details-close" class="marker-details-close" type="button">×</button>
<div class="marker-details-heading"><span id="marker-details-icon" class="marker-details-symbol" aria-hidden="true"></span><div><small id="marker-details-kind"></small><h3 id="marker-details-title"></h3></div></div>
<div id="marker-details-rewards" hidden><h4 id="marker-details-list-title">Rewards</h4><ul id="marker-details-reward-list"></ul></div></aside>
<div id="viewer-settings" class="viewer-settings" hidden><div class="upscaling-settings"><strong>Tile upscaling</strong>
<div id="upscaling-options" class="upscaling-options">${["off", "low", "medium", "high"].map((mode) => `<label><input type="radio" name="upscaling" value="${mode}"> <span>${mode[0].toUpperCase() + mode.slice(1)}</span></label>`).join("")}</div>
<div id="upscaling-generate" hidden><button id="generate-detail-data" type="button">Generate detail data</button><small id="upscaling-unavailable"></small></div></div>
<strong>Map markers</strong>${toggles}<a class="viewer-source-link" href="https://github.com/KornPlays/sm_map_generator" target="_blank" rel="noopener noreferrer">Source code on GitHub</a></div>
<div class="map-controls"><a data-download-role="image" class="viewer-control-download" hidden title="Download map image" aria-label="Download map image"><svg class="download-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v11m0 0 4-4m-4 4-4-4M5 16v4h14v-4" /></svg></a><button id="viewer-zoom-in" type="button">+</button><button id="viewer-zoom-out" type="button">−</button>
<button id="viewer-expand" type="button">×</button><button id="viewer-settings-button" type="button">⚙</button></div></div>
<div id="missing" hidden></div><div class="viewer-legal">© 2026 KornPlays · Unofficial fan project · Scrap Mechanic belongs to Axolot Games</div></section><div id="portable-status" class="portable-status" hidden></div>
${externalData ? '<script src="map-data.js"><\/script>' : `<script id="sm-map-embedded-data">globalThis.SM_MAP_DATA=${safeJson(data)};globalThis.SM_VIEWER_SOURCE=${safeJson(viewerSource)};<\/script>`}
${script}</body></html>`;
}

function viewerDataScript(data, viewerSource = "") {
  return `globalThis.SM_MAP_DATA=${safeJson(data)};globalThis.SM_VIEWER_SOURCE=${safeJson(viewerSource)};\n`;
}

const CRC32_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  return crc >>> 0;
});

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ byte) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

function u16(view, offset, value) { view.setUint16(offset, value, true); }
function u32(view, offset, value) { view.setUint32(offset, value >>> 0, true); }

function zipStore(files) {
  const encoder = new TextEncoder();
  const locals = [];
  const centrals = [];
  let localOffset = 0;
  for (const file of files) {
    const name = encoder.encode(file.name);
    const data = file.data instanceof Uint8Array ? file.data : new Uint8Array(file.data);
    const crc = crc32(data);
    const local = new Uint8Array(30 + name.length + data.length);
    const localView = new DataView(local.buffer);
    u32(localView, 0, 0x04034b50); u16(localView, 4, 20); u16(localView, 6, 0x0800);
    u16(localView, 8, 0); u32(localView, 14, crc); u32(localView, 18, data.length); u32(localView, 22, data.length);
    u16(localView, 26, name.length); local.set(name, 30); local.set(data, 30 + name.length);
    locals.push(local);

    const central = new Uint8Array(46 + name.length);
    const centralView = new DataView(central.buffer);
    u32(centralView, 0, 0x02014b50); u16(centralView, 4, 20); u16(centralView, 6, 20); u16(centralView, 8, 0x0800);
    u16(centralView, 10, 0); u32(centralView, 16, crc); u32(centralView, 20, data.length); u32(centralView, 24, data.length);
    u16(centralView, 28, name.length); u32(centralView, 42, localOffset); central.set(name, 46);
    centrals.push(central);
    localOffset += local.length;
  }
  const centralSize = centrals.reduce((sum, item) => sum + item.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  u32(endView, 0, 0x06054b50); u16(endView, 8, files.length); u16(endView, 10, files.length);
  u32(endView, 12, centralSize); u32(endView, 16, localOffset);
  return new Blob([...locals, ...centrals, end], { type: "application/zip" });
}

async function fetchBytes(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not download ${url} (HTTP ${response.status}).`);
  return new Uint8Array(await response.arrayBuffer());
}

function requiredAssetPaths(map) {
  const paths = new Set();
  for (const tier of [50, 100, 200]) {
    for (const cell of map.cells || []) {
      if (cell.size > 1 && EXCAVATION_COMPOSITE_UIDS.has(cell.uid)) continue;
      const relative = cell.size === 1 ? `tiles/${cell.uid}.webp` : `${cell.uid}.webp`;
      paths.add(`detail/${tier}/${relative}`);
    }
    for (let row = 0; row < EXCAVATION_CHUNKS_PER_SIDE; row += 1) {
      for (let column = 0; column < EXCAVATION_CHUNKS_PER_SIDE; column += 1) {
        paths.add(`detail/${tier}/${excavationChunkPath(column, row)}`);
      }
    }
  }
  return [...paths];
}

async function concurrentMap(items, limit, callback) {
  const output = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      output[index] = await callback(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return output;
}

// A 100 px/cell image is around 20 MB before base64 adds a third on top, which
// no single HTML file should carry. Everything at or below this renders sharply
// enough for the viewer's own display, and anything above it is rebuilt by the
// exported file in the background from the cell layout it already has.
const MAX_EMBEDDED_CELL_SIZE = 50;

function mapCellSize(map) {
  const width = map?.details?.width;
  return Number.isFinite(width) && width > 0 ? Math.round(width / 128) : 25;
}

// The exported viewer displays this image immediately, so it has to be in the
// file. Below the cap the generated image is reused as-is with its metadata
// chunks stripped; above it a smaller one is composed here so the download stays
// small without giving up a usable picture on first open.
async function embeddedMapImage(map, cellSize, embedCellSize, onProgress) {
  if (embedCellSize >= cellSize) return stripWebPMapData(map.blob);
  onProgress(`Rendering a ${embedCellSize} px/cell image to embed…`, 0, 1);
  const rendered = await composeMap(map.cells, embedCellSize, (message, percent) => {
    onProgress(message, percent, 100);
  }, { seed: map.seed, preview: false, quality: 0.86 });
  return rendered.blob;
}

export async function downloadOriginalViewer(map, onProgress = () => {}) {
  const cellSize = mapCellSize(map);
  const embedCellSize = Math.min(cellSize, MAX_EMBEDDED_CELL_SIZE);
  const image = await embeddedMapImage(map, cellSize, embedCellSize, onProgress);
  onProgress("Writing the viewer file…", 1, 1);
  const data = {
    name: map.name,
    seed: map.seed,
    cells: packCells(map.cells),
    markers: map.markers,
    image: await blobDataUrl(image),
    imageCellSize: embedCellSize,
    cellSize,
    details: map.details,
    size: image.size,
    assetSource: EXPORTED_VIEWER_ASSET_SOURCE,
  };
  const html = viewerMarkup(data, "", { styleText: portableViewerStyle, scriptText: portableViewerScript });
  saveBlob(new Blob([html], { type: "text/html;charset=utf-8" }), `scrap-mechanic-ch2-${map.seed ?? "map"}-viewer.html`);
}

export async function downloadLocalViewer(map, onProgress = () => {}) {
  const data = {
    name: map.name,
    seed: map.seed,
    cells: packCells(map.cells),
    markers: map.markers,
    map: "map.webp",
    preview: "preview.webp",
    details: map.details,
    size: map.blob.size,
    assetSource: "assets/",
  };
  const files = [
    { name: "index.html", data: new TextEncoder().encode(viewerMarkup(data, "", { styleText: portableViewerStyle, scriptText: portableViewerScript, externalData: true })) },
    { name: "map-data.js", data: new TextEncoder().encode(viewerDataScript(data)) },
    { name: "map.webp", data: new Uint8Array(await map.blob.arrayBuffer()) },
    { name: "preview.webp", data: new Uint8Array(await map.previewBlob.arrayBuffer()) },
  ];
  const assetPaths = requiredAssetPaths(map);
  let completedAssets = 0;
  const assets = await concurrentMap(assetPaths, 12, async (path) => {
    const data = await fetchBytes(tileAssetUrl(path, document.baseURI, GENERATOR_ASSET_SOURCE));
    completedAssets += 1;
    if (completedAssets % 10 === 0 || completedAssets === assetPaths.length) {
      onProgress(
        `Downloading viewer assets… ${completedAssets.toLocaleString()} / ${assetPaths.length.toLocaleString()}`,
        completedAssets,
        assetPaths.length,
      );
    }
    return { name: `assets/${path}`, data };
  });
  files.push(...assets);
  onProgress("Packaging the self-hosted viewer…", assetPaths.length, assetPaths.length);
  saveBlob(zipStore(files), `scrap-mechanic-ch2-${map.seed ?? "map"}-viewer.zip`);
}
