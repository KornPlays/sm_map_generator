const RIFF_HEADER_SIZE = 12;
const XMP_FLAG = 0x04;

function fourCC(bytes, offset) {
  return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
}

function writeFourCC(bytes, offset, value) {
  for (let index = 0; index < 4; index += 1) bytes[offset + index] = value.charCodeAt(index);
}

function readU32(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24);
}

function writeU24(bytes, offset, value) {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
}

function writeU32(bytes, offset, value) {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
  bytes[offset + 3] = (value >>> 24) & 0xff;
}

function parseChunks(bytes) {
  if (
    bytes.length < RIFF_HEADER_SIZE ||
    fourCC(bytes, 0) !== "RIFF" ||
    fourCC(bytes, 8) !== "WEBP"
  ) {
    throw new Error("The generated image is not a valid WebP file.");
  }
  const chunks = [];
  let offset = RIFF_HEADER_SIZE;
  while (offset + 8 <= bytes.length) {
    const type = fourCC(bytes, offset);
    const size = readU32(bytes, offset + 4) >>> 0;
    const end = offset + 8 + size + (size & 1);
    if (end > bytes.length) break;
    chunks.push({ type, offset, size, end });
    offset = end;
  }
  return chunks;
}

function makeChunk(type, payload) {
  const chunk = new Uint8Array(8 + payload.length + (payload.length & 1));
  writeFourCC(chunk, 0, type);
  writeU32(chunk, 4, payload.length);
  chunk.set(payload, 8);
  return chunk;
}

function makeXmp(seed) {
  const value = String(seed >>> 0);
  return new TextEncoder().encode(
    `<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>` +
      `<x:xmpmeta xmlns:x="adobe:ns:meta/">` +
      `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">` +
      `<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" ` +
      `xmlns:xmp="http://ns.adobe.com/xap/1.0/" ` +
      `xmlns:sm="https://sm.kornplays.com/ns/map/1.0/" ` +
      `sm:WorldSeed="${value}" xmp:CreatorTool="Scrap Mechanic Chapter 2 Browser Map Generator">` +
      `<dc:description><rdf:Alt><rdf:li xml:lang="x-default">Scrap Mechanic Chapter 2 world map — seed ${value}</rdf:li></rdf:Alt></dc:description>` +
      `</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`,
  );
}

const MAP_DATA_MAGIC = "SMM3";
const LEGACY_MAP_DATA_MAGIC = "SMM2";
const MAP_DATA_HEADER = 13;
const MAP_DATA_ROW = 27;
const LEGACY_MAP_DATA_ROW = 25;

function uuidToBytes(uuid, output, offset) {
  const hex = String(uuid).replaceAll("-", "");
  for (let index = 0; index < 16; index += 1) {
    output[offset + index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16) || 0;
  }
}

function bytesToUuid(bytes, offset) {
  let hex = "";
  for (let index = 0; index < 16; index += 1) hex += bytes[offset + index].toString(16).padStart(2, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function expandCells(rows) {
  if (!Array.isArray(rows)) return null;
  return rows.map(([x, y, uid, size, rotation, group, terrainType, originX, originY]) => ({
    x, y, uid, size, rotation, group, terrainType, originX, originY,
  }));
}

function makeMapData(seed, cells) {
  const rows = cells || [];
  const output = new Uint8Array(MAP_DATA_HEADER + rows.length * MAP_DATA_ROW);
  writeFourCC(output, 0, MAP_DATA_MAGIC);
  const view = new DataView(output.buffer);
  view.setUint8(4, Number.isInteger(seed) ? 1 : 0);
  view.setUint32(5, Number.isInteger(seed) ? seed >>> 0 : 0, true);
  view.setUint32(9, rows.length, true);
  let offset = MAP_DATA_HEADER;
  for (const cell of rows) {
    view.setInt8(offset, cell.x);
    view.setInt8(offset + 1, cell.y);
    uuidToBytes(cell.uid, output, offset + 2);
    view.setUint8(offset + 18, cell.size);
    view.setUint8(offset + 19, cell.rotation);
    view.setUint32(offset + 20, cell.group >>> 0, true);
    view.setUint8(offset + 24, cell.terrainType);
    view.setInt8(offset + 25, Number.isFinite(cell.originX) ? cell.originX : cell.x);
    view.setInt8(offset + 26, Number.isFinite(cell.originY) ? cell.originY : cell.y);
    offset += MAP_DATA_ROW;
  }
  return output;
}

function readMapData(bytes, offset, size) {
  const payload = bytes.subarray(offset, offset + size);
  const magic = payload.length >= MAP_DATA_HEADER ? fourCC(payload, 0) : "";
  if (magic === MAP_DATA_MAGIC || magic === LEGACY_MAP_DATA_MAGIC) {
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const seed = view.getUint8(4) ? view.getUint32(5, true) : null;
    const count = view.getUint32(9, true);
    const rowSize = magic === MAP_DATA_MAGIC ? MAP_DATA_ROW : LEGACY_MAP_DATA_ROW;
    if (MAP_DATA_HEADER + count * rowSize > payload.length) throw new Error("Invalid map metadata length.");
    const cells = [];
    let cursor = MAP_DATA_HEADER;
    for (let index = 0; index < count; index += 1) {
      const cell = {
        x: view.getInt8(cursor),
        y: view.getInt8(cursor + 1),
        uid: bytesToUuid(payload, cursor + 2),
        size: view.getUint8(cursor + 18),
        rotation: view.getUint8(cursor + 19),
        group: view.getUint32(cursor + 20, true),
        terrainType: view.getUint8(cursor + 24),
      };
      if (magic === MAP_DATA_MAGIC) {
        cell.originX = view.getInt8(cursor + 25);
        cell.originY = view.getInt8(cursor + 26);
      }
      cells.push(cell);
      cursor += rowSize;
    }
    return { seed, cells };
  }
  const parsed = JSON.parse(new TextDecoder().decode(payload));
  if (parsed?.version !== 1) return { seed: null, cells: null };
  return {
    seed: Number.isInteger(parsed.seed) && parsed.seed >= -2147483648 && parsed.seed <= 4294967295
      ? parsed.seed >>> 0
      : null,
    cells: expandCells(parsed.cells),
  };
}

export async function embedWebPMapData(blob, {
  seed = null,
  width,
  height,
  cells = [],
  previewBlob = null,
}) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const chunks = parseChunks(bytes);
  const outputChunks = [];
  let hasExtendedHeader = false;
  let featureFlags = XMP_FLAG;
  if (chunks.some((chunk) => chunk.type === "ALPH")) featureFlags |= 0x10;
  if (chunks.some((chunk) => chunk.type === "ICCP")) featureFlags |= 0x20;
  if (chunks.some((chunk) => chunk.type === "EXIF")) featureFlags |= 0x08;
  if (chunks.some((chunk) => chunk.type === "ANIM" || chunk.type === "ANMF")) featureFlags |= 0x02;

  for (const chunk of chunks) {
    if (chunk.type === "XMP " || chunk.type === "SMAP" || chunk.type === "SMPR") continue;
    const raw = bytes.slice(chunk.offset, chunk.end);
    if (chunk.type === "VP8X" && chunk.size >= 10) {
      raw[8] |= XMP_FLAG;
      hasExtendedHeader = true;
    }
    outputChunks.push(raw);
  }

  if (!hasExtendedHeader) {
    const extended = new Uint8Array(10);
    extended[0] = featureFlags;
    writeU24(extended, 4, width - 1);
    writeU24(extended, 7, height - 1);
    outputChunks.unshift(makeChunk("VP8X", extended));
  }
  outputChunks.push(makeChunk("SMAP", makeMapData(seed, cells)));
  if (previewBlob instanceof Blob) {
    outputChunks.push(makeChunk("SMPR", new Uint8Array(await previewBlob.arrayBuffer())));
  }
  if (Number.isInteger(seed)) outputChunks.push(makeChunk("XMP ", makeXmp(seed)));

  const totalLength = RIFF_HEADER_SIZE + outputChunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const output = new Uint8Array(totalLength);
  writeFourCC(output, 0, "RIFF");
  writeU32(output, 4, totalLength - 8);
  writeFourCC(output, 8, "WEBP");
  let offset = RIFF_HEADER_SIZE;
  for (const chunk of outputChunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return new Blob([output], { type: "image/webp" });
}

export function embedWebPSeed(blob, seed, width, height) {
  return embedWebPMapData(blob, { seed, width, height, cells: [] });
}

// Removes the cell layout, embedded preview, and XMP packet that the generator
// writes into every map it produces. The exported viewer carries the layout as
// script data already, so leaving those chunks inside the image it embeds would
// duplicate several megabytes before base64 inflates them by another third.
export async function stripWebPMapData(blob) {
  try {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const chunks = parseChunks(bytes);
    const outputChunks = [];
    for (const chunk of chunks) {
      if (chunk.type === "XMP " || chunk.type === "SMAP" || chunk.type === "SMPR") continue;
      const raw = bytes.slice(chunk.offset, chunk.end);
      if (chunk.type === "VP8X" && chunk.size >= 10) raw[8] &= ~XMP_FLAG;
      outputChunks.push(raw);
    }
    const totalLength = RIFF_HEADER_SIZE + outputChunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const output = new Uint8Array(totalLength);
    writeFourCC(output, 0, "RIFF");
    writeU32(output, 4, totalLength - 8);
    writeFourCC(output, 8, "WEBP");
    let offset = RIFF_HEADER_SIZE;
    for (const chunk of outputChunks) {
      output.set(chunk, offset);
      offset += chunk.length;
    }
    return new Blob([output], { type: "image/webp" });
  } catch {
    return blob;
  }
}

export async function readWebPMapData(blob) {
  try {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const chunks = parseChunks(bytes);
    const decoder = new TextDecoder();
    let seed = null;
    let cells = null;
    let previewBlob = null;
    let width = null;
    let height = null;
    for (const chunk of chunks) {
      if (chunk.type === "VP8X" && chunk.size >= 10) {
        const payload = chunk.offset + 8;
        width = bytes[payload + 4] | (bytes[payload + 5] << 8) | (bytes[payload + 6] << 16);
        height = bytes[payload + 7] | (bytes[payload + 8] << 8) | (bytes[payload + 9] << 16);
        width += 1;
        height += 1;
      } else if (chunk.type === "SMAP") {
        const parsed = readMapData(bytes, chunk.offset + 8, chunk.size);
        seed = parsed.seed;
        cells = parsed.cells;
      } else if (chunk.type === "SMPR") {
        previewBlob = new Blob([
          bytes.slice(chunk.offset + 8, chunk.offset + 8 + chunk.size),
        ], { type: "image/webp" });
      } else if (chunk.type === "XMP " && seed === null) {
        const xmp = decoder.decode(bytes.subarray(chunk.offset + 8, chunk.offset + 8 + chunk.size));
        const match = xmp.match(/sm:WorldSeed=["'](\d+)["']/) ?? xmp.match(/<sm:WorldSeed>(\d+)<\/sm:WorldSeed>/);
        if (match) {
          const found = Number(match[1]);
          if (Number.isInteger(found) && found >= 0 && found <= 4294967295) seed = found;
        }
      }
    }
    return { seed, cells, previewBlob, width, height };
  } catch {
    return { seed: null, cells: null, previewBlob: null, width: null, height: null };
  }
}

export async function readWebPSeed(blob) {
  return (await readWebPMapData(blob)).seed;
}

export function seedFromFilename(name) {
  const match = String(name || "").match(/(?:scrap-mechanic-ch2-|seed[-_ ]?)(\d+)/i);
  if (!match) return null;
  const seed = Number(match[1]);
  return Number.isInteger(seed) && seed >= 0 && seed <= 4294967295 ? seed : null;
}
