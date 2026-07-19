export interface ImageDimensions {
  width: number;
  height: number;
}

/**
 * Pixel dimensions from an image's leading bytes, or undefined when the format
 * is unrecognised or the header is truncated. Header-only: no pixel decode, so
 * this stays cheap enough to run while building a message.
 */
export function readImageDimensions(bytes: Uint8Array): ImageDimensions | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return (
    readPng(bytes, view) ??
    readJpeg(bytes, view) ??
    readGif(bytes, view) ??
    readWebp(bytes, view) ??
    readBmp(bytes, view)
  );
}

function readBmp(bytes: Uint8Array, view: DataView): ImageDimensions | undefined {
  // 'BM', a 14-byte file header, then a DIB header opening with its own size
  // and the dimensions. Height is negative for top-down bitmaps.
  if (bytes.length < 26) return undefined;
  if (view.getUint16(0) !== 0x424d) return undefined;
  return {
    width: Math.abs(view.getInt32(18, true)),
    height: Math.abs(view.getInt32(22, true)),
  };
}

/**
 * WebP is a RIFF container holding one of three incompatible codecs, each of
 * which stores the dimensions somewhere different: 'VP8 ' (lossy), 'VP8L'
 * (lossless), 'VP8X' (extended — animation, alpha, ICC).
 */
function readWebp(bytes: Uint8Array, view: DataView): ImageDimensions | undefined {
  if (bytes.length < 30) return undefined;
  if (view.getUint32(0) !== 0x52494646 || view.getUint32(8) !== 0x57454250) return undefined;
  const codec = view.getUint32(12);
  if (codec === 0x56503820) {
    // Frame tag, then the 3-byte start code that precedes the dimensions.
    if (view.getUint8(23) !== 0x9d || view.getUint8(24) !== 0x01 || view.getUint8(25) !== 0x2a) {
      return undefined;
    }
    return {
      width: view.getUint16(26, true) & 0x3fff,
      height: view.getUint16(28, true) & 0x3fff,
    };
  }
  if (codec === 0x56503858) {
    // Flags and reserved bits, then the canvas size as 24-bit minus-one fields.
    return {
      width: readUint24LE(bytes, 24) + 1,
      height: readUint24LE(bytes, 27) + 1,
    };
  }
  if (codec === 0x5650384c) {
    // Signature byte, then both dimensions packed as 14-bit minus-one fields
    // into one little-endian word.
    if (view.getUint8(20) !== 0x2f) return undefined;
    const packed = view.getUint32(21, true);
    return {
      width: (packed & 0x3fff) + 1,
      height: ((packed >>> 14) & 0x3fff) + 1,
    };
  }
  return undefined;
}

function readUint24LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16);
}

function readGif(bytes: Uint8Array, view: DataView): ImageDimensions | undefined {
  // 'GIF87a' or 'GIF89a', then a little-endian logical screen descriptor.
  if (bytes.length < 10) return undefined;
  if (view.getUint32(0) !== 0x47494638) return undefined;
  return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
}

function readPng(bytes: Uint8Array, view: DataView): ImageDimensions | undefined {
  // \x89PNG\r\n\x1a\n, then a length-prefixed IHDR chunk whose first two
  // fields are the dimensions.
  if (bytes.length < 24) return undefined;
  if (view.getUint32(0) !== 0x89504e47 || view.getUint32(4) !== 0x0d0a1a0a) return undefined;
  if (view.getUint32(12) !== 0x49484452) return undefined;
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/**
 * Every SOF (start-of-frame) marker carries the dimensions, but which SOF a
 * file uses depends on its coding: baseline, progressive, arithmetic, lossless.
 * The FFC0-FFCF block is all SOF variants except these three.
 */
const JPEG_NON_SOF_MARKERS = new Set([0xc4, 0xc8, 0xcc]);

function readJpeg(bytes: Uint8Array, view: DataView): ImageDimensions | undefined {
  if (bytes.length < 4 || view.getUint16(0) !== 0xffd8) return undefined;
  let offset = 2;
  while (offset + 9 < bytes.length) {
    // Markers are FF-prefixed and may be preceded by any number of FF padding
    // bytes; anything else means the header is malformed.
    if (bytes[offset] !== 0xff) return undefined;
    const marker = bytes[offset + 1]!;
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    const length = view.getUint16(offset + 2);
    if (marker >= 0xc0 && marker <= 0xcf && !JPEG_NON_SOF_MARKERS.has(marker)) {
      return { width: view.getUint16(offset + 7), height: view.getUint16(offset + 5) };
    }
    if (length < 2) return undefined;
    offset += 2 + length;
  }
  return undefined;
}
