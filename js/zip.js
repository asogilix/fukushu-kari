const MAX_UINT32 = 0xffffffff;
const UTF8 = 0x0800;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) {
    value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  }
  return value;
});

function updateCrc(crc, bytes) {
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255];
  return crc;
}

export const crc32 = bytes => (updateCrc(MAX_UINT32, bytes) ^ MAX_UINT32) >>> 0;

async function blobCrc(blob) {
  let crc = MAX_UINT32;
  for await (const chunk of blob.stream()) crc = updateCrc(crc, chunk);
  return (crc ^ MAX_UINT32) >>> 0;
}

function header(size, signature) {
  const view = new DataView(new ArrayBuffer(size));
  view.setUint32(0, signature, true);
  return view;
}

function checkSize(size) {
  if (size >= MAX_UINT32) throw new Error('バックアップが大きすぎます。');
}

export async function writeZip(entries, onProgress = () => {}) {
  if (entries.length >= 0xffff) throw new Error('バックアップするファイルが多すぎます。');
  const files = [];
  const directory = [];
  const names = new Set();
  let offset = 0;
  let directorySize = 0;

  for (const [name, blob] of entries) {
    const path = encoder.encode(name);
    if (!path.length || path.length > 0xffff || names.has(name)) {
      throw new Error('バックアップのファイル名が正しくありません。');
    }
    names.add(name);
    checkSize(offset + 30 + path.length + blob.size);
    const crc = await blobCrc(blob);
    const local = header(30, 0x04034b50);
    local.setUint16(4, 20, true);
    local.setUint16(6, UTF8, true);
    local.setUint16(12, 33, true); // 1980-01-01
    local.setUint32(14, crc, true);
    local.setUint32(18, blob.size, true);
    local.setUint32(22, blob.size, true);
    local.setUint16(26, path.length, true);
    files.push(local.buffer, path, blob);

    const central = header(46, 0x02014b50);
    central.setUint16(4, 20, true);
    central.setUint16(6, 20, true);
    central.setUint16(8, UTF8, true);
    central.setUint16(14, 33, true);
    central.setUint32(16, crc, true);
    central.setUint32(20, blob.size, true);
    central.setUint32(24, blob.size, true);
    central.setUint16(28, path.length, true);
    central.setUint32(42, offset, true);
    directory.push(central.buffer, path);
    directorySize += 46 + path.length;
    offset += 30 + path.length + blob.size;
    onProgress(names.size, entries.length);
  }

  checkSize(offset + directorySize + 22);
  const end = header(22, 0x06054b50);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, directorySize, true);
  end.setUint32(16, offset, true);
  return new Blob([...files, ...directory, end.buffer], { type: 'application/zip' });
}

function requireZip(condition) {
  if (!condition) throw new Error('バックアップの形式が違うか、ファイルが壊れています。');
}

async function readHeader(blob, start, size) {
  requireZip(start + size <= blob.size);
  return new DataView(await blob.slice(start, start + size).arrayBuffer());
}

function zipFooter(tail) {
  for (let index = tail.byteLength - 22; index >= 0; index--) {
    if (tail.getUint32(index, true) === 0x06054b50 &&
        index + 22 + tail.getUint16(index + 20, true) === tail.byteLength) return index;
  }
  requireZip(false);
}

export async function readZip(blob, onProgress = () => {}) {
  checkSize(blob.size);
  const tailStart = Math.max(0, blob.size - 22 - 0xffff);
  const tail = await readHeader(blob, tailStart, blob.size - tailStart);
  const end = zipFooter(tail);
  const count = tail.getUint16(end + 10, true);
  const directorySize = tail.getUint32(end + 12, true);
  const directoryStart = tail.getUint32(end + 16, true);
  requireZip(tail.getUint16(end + 4, true) === 0 && tail.getUint16(end + 6, true) === 0 &&
    tail.getUint16(end + 8, true) === count && directorySize <= 32 * 1024 * 1024 &&
    directoryStart + directorySize === tailStart + end);
  const directory = await readHeader(blob, directoryStart, directorySize);
  const entries = new Map();
  let index = 0;

  for (let item = 0; item < count; item++) {
    requireZip(index + 46 <= directorySize && directory.getUint32(index, true) === 0x02014b50);
    const flags = directory.getUint16(index + 8, true);
    const crc = directory.getUint32(index + 16, true);
    const size = directory.getUint32(index + 24, true);
    const nameSize = directory.getUint16(index + 28, true);
    const extraSize = directory.getUint16(index + 30, true);
    const commentSize = directory.getUint16(index + 32, true);
    const start = directory.getUint32(index + 42, true);
    const nameStart = index + 46;
    requireZip((flags === UTF8 || flags === 0) && directory.getUint16(index + 10, true) === 0 &&
      directory.getUint16(index + 34, true) === 0 && directory.getUint32(index + 20, true) === size);
    index = nameStart + nameSize + extraSize + commentSize;
    requireZip(nameSize > 0 && index <= directorySize && start + 30 + nameSize <= directoryStart);
    const name = decoder.decode(new Uint8Array(directory.buffer, nameStart, nameSize));
    requireZip(!entries.has(name));

    const local = await readHeader(blob, start, 30 + nameSize);
    requireZip(local.getUint32(0, true) === 0x04034b50 && local.getUint16(6, true) === flags &&
      local.getUint16(8, true) === 0 && local.getUint32(14, true) === crc &&
      local.getUint32(18, true) === size && local.getUint32(22, true) === size &&
      local.getUint16(26, true) === nameSize &&
      decoder.decode(new Uint8Array(local.buffer, 30, nameSize)) === name);
    const dataStart = start + 30 + nameSize + local.getUint16(28, true);
    requireZip(dataStart + size <= directoryStart);
    const content = blob.slice(dataStart, dataStart + size);
    requireZip(await blobCrc(content) === crc);
    entries.set(name, content);
    onProgress(item + 1, count);
  }
  requireZip(index === directorySize);
  return entries;
}
