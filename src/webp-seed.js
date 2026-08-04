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
  const value = String(seed | 0);
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

export async function embedWebPSeed(blob, seed, width, height) {
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
    if (chunk.type === "XMP ") continue;
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
  outputChunks.push(makeChunk("XMP ", makeXmp(seed)));

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

export async function readWebPSeed(blob) {
  try {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const chunks = parseChunks(bytes);
    const decoder = new TextDecoder();
    for (const chunk of chunks) {
      if (chunk.type !== "XMP ") continue;
      const xmp = decoder.decode(bytes.subarray(chunk.offset + 8, chunk.offset + 8 + chunk.size));
      const match = xmp.match(/sm:WorldSeed=["'](-?\d+)["']/) ?? xmp.match(/<sm:WorldSeed>(-?\d+)<\/sm:WorldSeed>/);
      if (!match) continue;
      const seed = Number(match[1]);
      if (Number.isInteger(seed) && seed >= -2147483648 && seed <= 2147483647) return seed;
    }
  } catch {
    return null;
  }
  return null;
}

export function seedFromFilename(name) {
  const match = String(name || "").match(/(?:scrap-mechanic-ch2-|seed[-_ ]?)(-?\d+)/i);
  if (!match) return null;
  const seed = Number(match[1]);
  return Number.isInteger(seed) && seed >= -2147483648 && seed <= 2147483647 ? seed : null;
}
