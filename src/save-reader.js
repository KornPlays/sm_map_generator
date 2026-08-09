const SQLITE_MAGIC = new TextEncoder().encode("SQLite format 3\0");
const REQUIRED_GAME_COLUMNS = new Set([
  "savegameversion",
  "flags",
  "seed",
  "gametick",
  "mods",
  "uniqueids",
]);

export class InvalidSaveError extends Error {
  constructor(message = "That is not a valid Scrap Mechanic .db save file.") {
    super(message);
    this.name = "InvalidSaveError";
  }
}

function fail(message) {
  throw new InvalidSaveError(message);
}

function readU16(bytes, offset) {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function readU32(bytes, offset) {
  return (
    bytes[offset] * 0x1000000 +
    (bytes[offset + 1] << 16) +
    (bytes[offset + 2] << 8) +
    bytes[offset + 3]
  );
}

function readVarint(bytes, offset) {
  let value = 0n;
  for (let index = 0; index < 9; index += 1) {
    if (offset + index >= bytes.length) fail("The SQLite record is truncated.");
    const byte = bytes[offset + index];
    if (index === 8) {
      value = (value << 8n) | BigInt(byte);
      return { value: Number(value), length: 9 };
    }
    value = (value << 7n) | BigInt(byte & 0x7f);
    if ((byte & 0x80) === 0) return { value: Number(value), length: index + 1 };
  }
  fail("The SQLite record contains an invalid varint.");
}

function integerFromBytes(bytes, offset, length) {
  let value = 0n;
  for (let index = 0; index < length; index += 1) {
    value = (value << 8n) | BigInt(bytes[offset + index]);
  }
  if (bytes[offset] & 0x80) value -= 1n << BigInt(length * 8);
  return value >= Number.MIN_SAFE_INTEGER && value <= Number.MAX_SAFE_INTEGER
    ? Number(value)
    : value;
}

function serialLength(serialType) {
  if (serialType === 0 || serialType === 8 || serialType === 9) return 0;
  if (serialType >= 1 && serialType <= 4) return serialType;
  if (serialType === 5) return 6;
  if (serialType === 6 || serialType === 7) return 8;
  if (serialType >= 12) return Math.floor((serialType - (serialType % 2 === 0 ? 12 : 13)) / 2);
  fail("The SQLite record uses a reserved serial type.");
}

function decodeRecord(payload) {
  const header = readVarint(payload, 0);
  const headerEnd = header.value;
  if (headerEnd < header.length || headerEnd > payload.length) fail("The SQLite record header is invalid.");

  const serialTypes = [];
  let headerOffset = header.length;
  while (headerOffset < headerEnd) {
    const serial = readVarint(payload, headerOffset);
    serialTypes.push(serial.value);
    headerOffset += serial.length;
  }
  if (headerOffset !== headerEnd) fail("The SQLite record header is malformed.");

  const decoder = new TextDecoder("utf-8", { fatal: false });
  const values = [];
  let bodyOffset = headerEnd;
  for (const serialType of serialTypes) {
    const length = serialLength(serialType);
    if (bodyOffset + length > payload.length) fail("The SQLite record body is truncated.");
    let value;
    if (serialType === 0) value = null;
    else if (serialType >= 1 && serialType <= 6) value = integerFromBytes(payload, bodyOffset, length);
    else if (serialType === 7) {
      value = new DataView(payload.buffer, payload.byteOffset + bodyOffset, 8).getFloat64(0, false);
    } else if (serialType === 8) value = 0;
    else if (serialType === 9) value = 1;
    else if (serialType % 2 === 0) value = payload.slice(bodyOffset, bodyOffset + length);
    else value = decoder.decode(payload.subarray(bodyOffset, bodyOffset + length));
    values.push(value);
    bodyOffset += length;
  }
  return values;
}

function parseColumnNames(sql) {
  const start = sql.indexOf("(");
  const end = sql.lastIndexOf(")");
  if (start < 0 || end <= start) return [];

  const definitions = [];
  let current = "";
  let depth = 0;
  let quote = null;
  for (const char of sql.slice(start + 1, end)) {
    if (quote) {
      current += char;
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'" || char === "`") {
      quote = char;
      current += char;
    } else if (char === "(") {
      depth += 1;
      current += char;
    } else if (char === ")") {
      depth -= 1;
      current += char;
    } else if (char === "," && depth === 0) {
      definitions.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  if (current.trim()) definitions.push(current.trim());

  return definitions
    .map((definition) => definition.match(/^\s*(?:["'`]([^"'`]+)["'`]|([^\s]+))/)?.slice(1).find(Boolean))
    .filter(Boolean)
    .map((name) => name.toLowerCase());
}

class SQLiteFile {
  constructor(file) {
    this.file = file;
    this.pageSize = 0;
    this.usableSize = 0;
    this.pageCount = 0;
    this.cache = new Map();
  }

  async initialize() {
    if (!this.file || this.file.size < 100) fail("The file is too small to be a SQLite save.");
    const header = new Uint8Array(await this.file.slice(0, 100).arrayBuffer());
    if (!SQLITE_MAGIC.every((byte, index) => header[index] === byte)) {
      fail("The file does not have a SQLite header.");
    }
    const encodedPageSize = readU16(header, 16);
    this.pageSize = encodedPageSize === 1 ? 65536 : encodedPageSize;
    if (
      this.pageSize < 512 ||
      this.pageSize > 65536 ||
      (this.pageSize & (this.pageSize - 1)) !== 0
    ) {
      fail("The SQLite page size is invalid.");
    }
    this.usableSize = this.pageSize - header[20];
    this.pageCount = Math.ceil(this.file.size / this.pageSize);
    if (this.usableSize < 480 || this.pageCount < 1) fail("The SQLite header is invalid.");
  }

  async page(number) {
    if (!Number.isInteger(number) || number < 1 || number > this.pageCount) {
      fail("The SQLite file references a page outside the database.");
    }
    if (!this.cache.has(number)) {
      this.cache.set(
        number,
        (async () => {
          const offset = (number - 1) * this.pageSize;
          const bytes = new Uint8Array(await this.file.slice(offset, offset + this.pageSize).arrayBuffer());
          if (bytes.length < Math.min(this.pageSize, this.file.size - offset)) {
            fail("The SQLite page is truncated.");
          }
          return bytes;
        })(),
      );
    }
    return this.cache.get(number);
  }

  localPayloadSize(payloadSize) {
    const maximum = this.usableSize - 35;
    if (payloadSize <= maximum) return payloadSize;
    const minimum = Math.floor(((this.usableSize - 12) * 32) / 255) - 23;
    const candidate = minimum + ((payloadSize - minimum) % (this.usableSize - 4));
    return candidate <= maximum ? candidate : minimum;
  }

  async payload(page, offset, payloadSize) {
    const localSize = this.localPayloadSize(payloadSize);
    if (offset + localSize > page.length) fail("The SQLite cell payload is truncated.");
    const output = new Uint8Array(payloadSize);
    output.set(page.subarray(offset, offset + localSize));
    let written = localSize;
    if (written === payloadSize) return output;
    if (offset + localSize + 4 > page.length) fail("The SQLite overflow pointer is missing.");

    let nextPage = readU32(page, offset + localSize);
    const visited = new Set();
    while (written < payloadSize) {
      if (visited.has(nextPage)) fail("The SQLite overflow chain contains a loop.");
      visited.add(nextPage);
      const overflow = await this.page(nextPage);
      nextPage = readU32(overflow, 0);
      const amount = Math.min(payloadSize - written, this.usableSize - 4);
      if (overflow.length < 4 + amount) fail("The SQLite overflow page is truncated.");
      output.set(overflow.subarray(4, 4 + amount), written);
      written += amount;
    }
    return output;
  }

  async tableRecords(rootPage) {
    const records = [];
    const pending = [rootPage];
    const visited = new Set();
    while (pending.length) {
      const pageNumber = pending.pop();
      if (visited.has(pageNumber)) fail("The SQLite table tree contains a loop.");
      visited.add(pageNumber);
      const page = await this.page(pageNumber);
      const headerOffset = pageNumber === 1 ? 100 : 0;
      const pageType = page[headerOffset];
      const cellCount = readU16(page, headerOffset + 3);
      if (cellCount > Math.floor(this.usableSize / 2)) fail("The SQLite page has an invalid cell count.");

      if (pageType === 0x05) {
        for (let index = 0; index < cellCount; index += 1) {
          const pointer = readU16(page, headerOffset + 12 + index * 2);
          if (pointer + 4 > page.length) fail("The SQLite interior cell is invalid.");
          pending.push(readU32(page, pointer));
        }
        pending.push(readU32(page, headerOffset + 8));
      } else if (pageType === 0x0d) {
        for (let index = 0; index < cellCount; index += 1) {
          const pointer = readU16(page, headerOffset + 8 + index * 2);
          const payloadLength = readVarint(page, pointer);
          const rowId = readVarint(page, pointer + payloadLength.length);
          const payloadOffset = pointer + payloadLength.length + rowId.length;
          records.push(decodeRecord(await this.payload(page, payloadOffset, payloadLength.value)));
        }
      } else {
        fail("The SQLite root is not a table b-tree.");
      }
      if (visited.size > this.pageCount) fail("The SQLite table tree is invalid.");
    }
    return records;
  }
}

export async function readScrapMechanicSeed(file) {
  try {
    const database = new SQLiteFile(file);
    await database.initialize();
    const schema = await database.tableRecords(1);
    const gameTable = schema.find(
      (row) =>
        String(row[0]).toLowerCase() === "table" &&
        String(row[1]).toLowerCase() === "game" &&
        String(row[2]).toLowerCase() === "game",
    );
    if (!gameTable || !Number.isInteger(gameTable[3]) || typeof gameTable[4] !== "string") {
      fail("The save does not contain Scrap Mechanic's Game table.");
    }

    const columns = parseColumnNames(gameTable[4]);
    if (![...REQUIRED_GAME_COLUMNS].every((column) => columns.includes(column))) {
      fail("The Game table does not match a Scrap Mechanic save.");
    }
    const seedIndex = columns.indexOf("seed");
    const rows = await database.tableRecords(gameTable[3]);
    const seed = rows[0]?.[seedIndex];
    if (!Number.isInteger(seed) || seed < -2147483648 || seed > 4294967295) {
      fail("The save does not contain a supported world seed.");
    }
    return seed < 0 ? seed + 4294967296 : seed;
  } catch (error) {
    if (error instanceof InvalidSaveError) throw error;
    console.error("Save parsing failed", error);
    throw new InvalidSaveError();
  }
}
