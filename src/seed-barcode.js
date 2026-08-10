// A compact visual fallback for map files whose WebP metadata was stripped by
// another service. It intentionally uses a fixed corner and a checksum rather
// than OCR: no large dependency, no network request, and a corrupted label can
// never be mistaken for a valid world seed.
const BARCODE_COLUMNS = 12;
const BARCODE_ROWS = 4;
const BARCODE_MAGIC = 0xa7;

function crc8(bytes) {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 0x80) ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
    }
  }
  return crc;
}

export function seedBarcodeBytes(seed) {
  const value = seed >>> 0;
  const payload = [
    BARCODE_MAGIC,
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ];
  return [...payload, crc8(payload)];
}

export function seedFromBarcodeBytes(bytes) {
  if (!Array.isArray(bytes) || bytes.length !== 6 || bytes[0] !== BARCODE_MAGIC) return null;
  if (crc8(bytes.slice(0, 5)) !== bytes[5]) return null;
  return ((bytes[1] * 0x1000000) + (bytes[2] << 16) + (bytes[3] << 8) + bytes[4]) >>> 0;
}

export function seedBarcodeMetrics(width, height, cellSize) {
  // 3 px modules at 25 px/cell remain readable after normal WebP compression.
  // Capping at 6 keeps the mark discreet on 50 and 100 px/cell maps.
  const module = Math.max(2, Math.min(6, Math.round(cellSize * 0.12)));
  const margin = Math.max(2, Math.round(cellSize * 0.16));
  return {
    x: margin,
    y: height - margin - BARCODE_ROWS * module,
    width: BARCODE_COLUMNS * module,
    height: BARCODE_ROWS * module,
    module,
  };
}

function bitAt(bytes, index) {
  const byte = bytes[Math.floor(index / 8)];
  return (byte >>> (7 - (index & 7))) & 1;
}

export function drawSeedBarcode(context, width, height, cellSize, seed) {
  const metrics = seedBarcodeMetrics(width, height, cellSize);
  const bytes = seedBarcodeBytes(seed);
  context.fillStyle = "rgba(244, 242, 233, 0.96)";
  for (let row = 0; row < BARCODE_ROWS; row += 1) {
    for (let column = 0; column < BARCODE_COLUMNS; column += 1) {
      if (!bitAt(bytes, row * BARCODE_COLUMNS + column)) continue;
      context.fillRect(
        metrics.x + column * metrics.module,
        metrics.y + row * metrics.module,
        metrics.module,
        metrics.module,
      );
    }
  }
  return metrics;
}

function createScratchCanvas(width, height) {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(width, height);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function readBarcodeBytes(pixels, pixelWidth, pixelHeight, cropX, cropY, metrics, offsetX, offsetY) {
  const bytes = new Array(6).fill(0);
  for (let row = 0; row < BARCODE_ROWS; row += 1) {
    for (let column = 0; column < BARCODE_COLUMNS; column += 1) {
      const centerX = Math.round(metrics.x + offsetX + (column + 0.5) * metrics.module) - cropX;
      const centerY = Math.round(metrics.y + offsetY + (row + 0.5) * metrics.module) - cropY;
      const sampleRadius = metrics.module >= 5 ? 1 : 0;
      let brightness = 0;
      let samples = 0;
      for (let y = centerY - sampleRadius; y <= centerY + sampleRadius; y += 1) {
        for (let x = centerX - sampleRadius; x <= centerX + sampleRadius; x += 1) {
          if (x < 0 || y < 0 || x >= pixelWidth || y >= pixelHeight) return null;
          const index = (y * pixelWidth + x) * 4;
          brightness += pixels[index] * 0.2126 + pixels[index + 1] * 0.7152 + pixels[index + 2] * 0.0722;
          samples += 1;
        }
      }
      if (brightness / samples > 132) bytes[Math.floor((row * BARCODE_COLUMNS + column) / 8)] |= 1 << (7 - ((row * BARCODE_COLUMNS + column) & 7));
    }
  }
  return bytes;
}

export function seedFromBarcodePixels(
  pixels,
  pixelWidth,
  pixelHeight,
  cropX,
  cropY,
  imageWidth,
  imageHeight,
) {
  const cellFromWidth = imageWidth / 128;
  const cellFromHeight = imageHeight / 96;
  const cellSize = (cellFromWidth + cellFromHeight) / 2;
  if (!Number.isFinite(cellSize) || cellSize < 4 || Math.abs(cellFromWidth - cellFromHeight) > cellSize * 0.025) return null;

  const maxModule = 8;
  const normal = seedBarcodeMetrics(imageWidth, imageHeight, cellSize).module;
  const candidates = [...new Set([normal, ...Array.from({ length: maxModule }, (_, index) => index + 1)])];
  for (const module of candidates) {
    const metrics = {
      ...seedBarcodeMetrics(imageWidth, imageHeight, cellSize),
      module,
      width: BARCODE_COLUMNS * module,
      height: BARCODE_ROWS * module,
      y: imageHeight - Math.max(2, Math.round(cellSize * 0.16)) - BARCODE_ROWS * module,
    };
    for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
      for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
        const bytes = readBarcodeBytes(
          pixels, pixelWidth, pixelHeight, cropX, cropY, metrics, offsetX, offsetY,
        );
        const seed = seedFromBarcodeBytes(bytes);
        if (Number.isInteger(seed)) return seed;
      }
    }
  }
  return null;
}

// Returns null for an ordinary image, an edited/cropped map, or a barcode that
// no longer passes its checksum. Only a real generated map reaches a seed.
export async function readSeedBarcode(blob) {
  if (!(blob instanceof Blob) || typeof createImageBitmap !== "function") return null;
  let bitmap;
  try {
    bitmap = await createImageBitmap(blob);
    const cellSize = ((bitmap.width / 128) + (bitmap.height / 96)) / 2;
    if (!Number.isFinite(cellSize) || cellSize < 4) return null;

    const maxModule = 8;
    const cropHeight = Math.min(bitmap.height, Math.ceil(cellSize * 0.16) + BARCODE_ROWS * maxModule + 5);
    const cropWidth = Math.min(bitmap.width, Math.ceil(cellSize * 0.16) + BARCODE_COLUMNS * maxModule + 5);
    const cropY = bitmap.height - cropHeight;
    const canvas = createScratchCanvas(cropWidth, cropHeight);
    const context = canvas.getContext("2d", { alpha: false, willReadFrequently: true });
    context.imageSmoothingEnabled = false;
    context.drawImage(bitmap, 0, cropY, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);
    const pixels = context.getImageData(0, 0, cropWidth, cropHeight).data;

    return seedFromBarcodePixels(
      pixels, cropWidth, cropHeight, 0, cropY, bitmap.width, bitmap.height,
    );
  } catch {
    return null;
  } finally {
    bitmap?.close?.();
  }
}
