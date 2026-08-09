// One IndexedDB store backs both the generator's "last map" slot and the
// exported viewer's cache of maps it has rendered for itself. Browsers give a
// file:// page an opaque origin, so an exported viewer opened from disk may not
// have storage at all — every call here is expected to be wrapped in a fallback
// by the caller rather than treated as fatal.
const DATABASE_NAME = "sm-ch2-map-generator";
const DATABASE_VERSION = 1;

export const LAST_MAP_KEY = "last-map";

export function renderCacheKey(seed, cellSize) {
  return `render:${seed}:${cellSize}`;
}

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

export async function readStoredMap(key) {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = database.transaction("maps", "readonly").objectStore("maps").get(key);
    request.addEventListener("success", () => resolve(request.result || null));
    request.addEventListener("error", () => reject(request.error || new Error("The saved map could not be read.")));
  }).finally(() => database.close());
}

export async function writeStoredMap(key, value) {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = database.transaction("maps", "readwrite").objectStore("maps").put(value, key);
    request.addEventListener("success", () => resolve());
    request.addEventListener("error", () => reject(request.error || new Error("The map could not be saved in this browser.")));
  }).finally(() => database.close());
}
