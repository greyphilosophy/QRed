import { concatenate, MAX_SEAL_TEXT_BYTES, strictUtf8, utf8 } from "./sealFormat.js";

// Signed page-body format 1. Coordinates are relative to the original visible
// page, before footer scaling. The VQ codebook is fixed, built into QRed, and
// identified in the payload; it is never trained on or fetched for a document.
export const MAX_VISUAL_TILES = 4096;
export const TILE_SIZE = 4;
export const CODEBOOK_ID = 1;
export const CODEBOOK = (() => {
  const tiles = Array.from({ length: 16 }, (_, i) => new Uint8Array(16).fill(i * 17));
  const pairs = [[0, 255], [0, 136], [119, 255], [34, 102], [102, 170], [170, 238]];
  // Integer normals keep codebook reconstruction deterministic across engines.
  const normals = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
  for (const [nx, ny] of normals) for (let edge = -2; edge <= 2; edge++) for (const [low, high] of pairs) {
    const tile = new Uint8Array(16);
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
      const distance = nx * (2 * x - 3) + ny * (2 * y - 3) - edge * 2;
      tile[y * 4 + x] = distance < 0 ? low : distance > 0 ? high : Math.round((low + high) / 2);
    }
    tiles.push(tile);
  }
  return tiles;
})();

function varint(value) {
  const bytes = [];
  do { bytes.push((value & 127) | (value >= 128 ? 128 : 0)); value = Math.floor(value / 128); } while (value);
  return new Uint8Array(bytes);
}
function word(value) { const bytes = new Uint8Array(2); new DataView(bytes.buffer).setUint16(0, value); return bytes; }
function dimension(value) {
  if (!Number.isFinite(value) || value <= 0 || value > 65535) throw new Error("Unsupported page dimensions");
  return Math.max(1, Math.round(value));
}
function quantize(value, maximum) { return Math.round(Math.max(0, Math.min(1, value)) * maximum); }

export function encodePageEvidence({ text = "", width, height, blank = false, layout = null, visual = null }) {
  const textBytes = utf8.encode(text);
  const mode = layout?.mode || 0;
  if (textBytes.length > MAX_SEAL_TEXT_BYTES || ![0, 1, 2, 3].includes(mode)) throw new Error("Invalid page evidence");
  if (blank && (text || visual || mode) || !blank && !text.trim() && !visual) throw new Error("A nonblank page needs text or a visual reference");
  const parts = [new Uint8Array([1, (blank ? 1 : 0) | (visual ? 2 : 0) | (mode << 2)]),
    word(dimension(width)), word(dimension(height)), varint(textBytes.length), textBytes];
  if (mode) {
    const lines = layout.lines;
    if (!text.trim() || !lines.length || lines.length > 65535 || lines.length !== text.split("\n").filter(line => line.trim()).length) throw new Error("Line positions do not match page text");
    parts.push(varint(lines.length));
    for (const line of lines) {
      if (![line.x, line.y, ...(mode === 3 ? [line.width, line.height] : [])].every(Number.isFinite)) throw new Error("Invalid line position");
      if (mode === 1) parts.push(new Uint8Array([(Math.min(15, Math.floor(Math.max(0, line.x) * 16)) << 4) | Math.min(15, Math.floor(Math.max(0, line.y) * 16))]));
      else if (mode === 2) parts.push(new Uint8Array([quantize(line.x, 255), quantize(line.y, 255)]));
      else parts.push(...[line.x, line.y, line.width, line.height].map(value => word(quantize(value, 65535))));
    }
  }
  if (visual) {
    const { columns, rows, indices } = visual;
    if (visual.codebook !== CODEBOOK_ID || !Number.isInteger(columns) || !Number.isInteger(rows) ||
      columns < 1 || columns > 255 || rows < 1 || rows > 255 || columns * rows > MAX_VISUAL_TILES ||
      !(indices instanceof Uint8Array) || indices.length !== columns * rows) throw new Error("Invalid visual reference");
    parts.push(new Uint8Array([CODEBOOK_ID, columns, rows]), indices);
  }
  const bytes = concatenate(parts);
  if (bytes.length > MAX_SEAL_TEXT_BYTES) throw new Error("Page evidence exceeds the 8 MiB limit");
  return bytes;
}

export function decodePageEvidence(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 7 || bytes.length > MAX_SEAL_TEXT_BYTES) throw new Error("Invalid page evidence length");
  let offset = 0;
  const read = size => {
    if (offset + size > bytes.length) throw new Error("Truncated page evidence");
    const part = bytes.subarray(offset, offset + size); offset += size; return part;
  };
  const byte = () => read(1)[0];
  const uint16 = () => { const part = read(2); return part[0] * 256 + part[1]; };
  const uint = () => {
    let value = 0, multiplier = 1;
    for (let i = 0; i < 4; i++) {
      const next = byte(); value += (next & 127) * multiplier;
      if (next < 128) { if (i && next === 0) throw new Error("Noncanonical page length"); return value; }
      multiplier *= 128;
    }
    throw new Error("Invalid page length");
  };
  if (byte() !== 1) throw new Error("Unsupported page evidence format");
  const flags = byte();
  if (flags & ~15) throw new Error("Unsupported page evidence flags");
  const blank = Boolean(flags & 1), mode = flags >> 2;
  const width = uint16(), height = uint16();
  if (!width || !height) throw new Error("Invalid page dimensions");
  const text = strictUtf8.decode(read(uint()));
  let layout = null, visual = null;
  if (mode) {
    const count = uint();
    if (!count || count !== text.split("\n").filter(line => line.trim()).length || count > 65535) throw new Error("Line positions do not match page text");
    const lines = Array.from({ length: count }, () => {
      if (mode === 1) { const packed = byte(); return { x: (packed >> 4) / 16, y: (packed & 15) / 16, width: 1 / 16, height: 1 / 16 }; }
      if (mode === 2) return { x: byte() / 255, y: byte() / 255 };
      return { x: uint16() / 65535, y: uint16() / 65535, width: uint16() / 65535, height: uint16() / 65535 };
    });
    layout = { mode, lines };
  }
  if (flags & 2) {
    const codebook = byte(), columns = byte(), rows = byte();
    if (codebook !== CODEBOOK_ID || !columns || !rows || columns * rows > MAX_VISUAL_TILES) throw new Error("Unsupported visual reference");
    visual = { codebook, columns, rows, indices: read(columns * rows).slice() };
  }
  if (offset !== bytes.length || blank && (text || layout || visual) || !blank && !text.trim() && !visual) throw new Error("Invalid page evidence");
  return { text, width, height, blank, layout, visual };
}

// Area averaging preserves the overall ink/shade of a cell before VQ. Avoid
// point sampling, which can miss narrow rules and turn tiny marks into white.
export function encodeVisualReference(image, columns, rows) {
  const width = columns * TILE_SIZE, height = rows * TILE_SIZE;
  if (!Number.isInteger(columns) || !Number.isInteger(rows) || columns < 1 || rows < 1 || columns > 255 || rows > 255 || columns * rows > MAX_VISUAL_TILES) throw new Error("Invalid reference resolution");
  const samples = new Float32Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const left = x * image.width / width, right = (x + 1) * image.width / width;
    const top = y * image.height / height, bottom = (y + 1) * image.height / height;
    let sum = 0;
    for (let sy = Math.floor(top); sy < Math.ceil(bottom); sy++) for (let sx = Math.floor(left); sx < Math.ceil(right); sx++) {
      const weight = (Math.min(sx + 1, right) - Math.max(sx, left)) * (Math.min(sy + 1, bottom) - Math.max(sy, top));
      const i = (sy * image.width + sx) * 4;
      const gray = (image.data[i] * 77 + image.data[i + 1] * 150 + image.data[i + 2] * 29) / 256;
      sum += (255 + (gray - 255) * image.data[i + 3] / 255) * weight;
    }
    samples[y * width + x] = sum / ((right - left) * (bottom - top));
  }
  const indices = new Uint8Array(columns * rows), block = new Float32Array(16);
  for (let row = 0; row < rows; row++) for (let column = 0; column < columns; column++) {
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) block[y * 4 + x] = samples[(row * 4 + y) * width + column * 4 + x];
    let best = 0, distance = Infinity;
    for (let index = 0; index < CODEBOOK.length; index++) {
      let error = 0;
      for (let i = 0; i < 16 && error < distance; i++) error += (block[i] - CODEBOOK[index][i]) ** 2;
      if (error < distance) { best = index; distance = error; }
    }
    indices[row * columns + column] = best;
  }
  return { codebook: CODEBOOK_ID, columns, rows, indices };
}

export function renderVisualReference(visual) {
  const { codebook, columns, rows, indices } = visual;
  if (codebook !== CODEBOOK_ID || columns < 1 || rows < 1 || columns * rows > MAX_VISUAL_TILES || indices.length !== columns * rows) throw new Error("Invalid visual reference");
  const width = columns * 4, height = rows * 4, data = new Uint8ClampedArray(width * height * 4);
  for (let row = 0; row < rows; row++) for (let column = 0; column < columns; column++) {
    const tile = CODEBOOK[indices[row * columns + column]];
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
      const pixel = ((row * 4 + y) * width + column * 4 + x) * 4;
      data[pixel] = data[pixel + 1] = data[pixel + 2] = tile[y * 4 + x]; data[pixel + 3] = 255;
    }
  }
  return { width, height, data };
}
